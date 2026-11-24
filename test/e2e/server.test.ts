/** P0 end to end through a real `opencode serve`: shell guard, approvals, SSH, self-protection, modes, Code Mode. */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  E2E_ENABLED,
  expectAllowed,
  expectAsked,
  expectDenied,
  Harness,
  safetyPermissions,
  STUB_MARK,
} from "./harness"

setDefaultTimeout(180_000)

let h: Harness

beforeAll(async () => {
  if (!E2E_ENABLED) return
  h = new Harness()
  await h.start()
})

afterAll(async () => {
  await h?.dispose()
})

async function status(directory?: string) {
  const res = await h.rpc("status", {}, directory)
  expect(res.status).toBe(200)
  return res.body.output
}

/** Other locations cache the mode for up to a second (design 6), so poll until it propagates. */
async function eventually(directory: string, expected: Record<string, unknown>) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const current = await status(directory)
    if (Object.entries(expected).every(([key, value]) => current[key] === value)) return
    await Bun.sleep(200)
  }
  expect(await status(directory)).toMatchObject(expected)
}

async function setMode(mode: string, ttlMs?: number) {
  const res = await h.rpc("setMode", ttlMs === undefined ? { mode } : { mode, ttlMs })
  expect(res.status).toBe(200)
  return res.body.output
}

describe.skipIf(!E2E_ENABLED)("shell guard", () => {
  test("denies destructive local commands without running them", async () => {
    expectDenied(await h.shell("rm -rf /data"), "rm-system-path")
    expectDenied(await h.shell("rm -rf etc", { workdir: "/" }), "rm-system-path")
    expectDenied(await h.shell("kubectl delete ns prod"), "k8s-delete-namespace")
    expectDenied(await h.shell("docker stop c1"), "container-destroy")
  })

  test("asks once for a local rm and runs it after approval", async () => {
    const file = h.write("tmp/a.txt", "x")
    const call = await h.shell(`rm ${file}`)
    expectAsked(call, "rm-local")
    expect(call.result).toContain(`${STUB_MARK} rm ${file}`)
  })

  test("asks again after Always", async () => {
    const file = h.write("tmp/b.txt", "x")
    const first = await h.shell(`rm ${file}`, { reply: "always" })
    expectAsked(first, "rm-local")
    const second = await h.shell(`rm ${file}`, { reply: "always", sessionID: first.sessionID })
    expectAsked(second, "rm-local")
    expect(second.result).toContain(`${STUB_MARK} rm ${file}`)
  })

  test("guards ssh by the remote command", async () => {
    expectDenied(await h.shell(`ssh n1 "kubectl delete ns prod"`), "k8s-delete-namespace")
    expectDenied(await h.shell(`ssh sw "nv config apply"`), "nvue-apply")
    expectAsked(await h.shell("ssh n1 foo-bar"), "unknown-remote-command")
    const uptime = await h.shell("ssh n1 uptime")
    expectAllowed(uptime)
    expect(uptime.result).toContain(`${STUB_MARK} ssh n1 uptime`)
  })
})

describe.skipIf(!E2E_ENABLED)("self-protection", () => {
  test("denies writing opencode.json through the write tool and the shell", async () => {
    const file = path.join(h.project, "opencode.json")
    const before = readFileSync(file, "utf8")
    const write = await h.call("write", { path: file, content: "{}" })
    expect(write.result).toContain("[safety-policy:self-protect]")
    expectDenied(await h.shell("echo {} > opencode.json"), "self-protect")
    expect(readFileSync(file, "utf8")).toBe(before)
  })
})

describe.skipIf(!E2E_ENABLED)("modes", () => {
  test("relaxed with a TTL asks for high risk, keeps critical denied, then falls back to strict", async () => {
    expect(await setMode("relaxed", 5_000)).toMatchObject({ mode: "relaxed", source: "runtime", locked: false })
    const asked = await h.shell("docker stop c1")
    expectAsked(asked, "container-destroy")
    expect(asked.result).toContain(`${STUB_MARK} docker stop c1`)
    expectDenied(await h.shell("rm -rf /data"), "rm-system-path")
    await eventually(h.project, { mode: "strict", locked: false })
    expectDenied(await h.shell("docker stop c1"), "container-destroy")
  })

  test("off allows rule hits but keeps self-protection", async () => {
    await setMode("off")
    const kubectl = await h.shell("kubectl delete ns prod")
    expectAllowed(kubectl)
    expect(kubectl.result).toContain(`${STUB_MARK} kubectl delete ns prod`)
    expectDenied(await h.shell("echo {} > opencode.json"), "self-protect")
    await setMode("strict")
  })

  test("the mode is shared across directories and survives a restart", async () => {
    await setMode("relaxed")
    expect(await status(h.project2)).toMatchObject({ mode: "relaxed", source: "runtime" })
    await h.start()
    expect(await status()).toMatchObject({ mode: "relaxed", source: "runtime" })
    expect(await status(h.project2)).toMatchObject({ mode: "relaxed", source: "runtime" })
    await setMode("strict")
    await eventually(h.project2, { mode: "strict" })
  })
})

describe.skipIf(!E2E_ENABLED)("code mode", () => {
  beforeAll(async () => {
    await h.start({ OPENCODE_FLAGS: "full_codemode" })
  })

  test("a denied nested call does not run even when the code catches the error", async () => {
    const code = [
      "const out = {}",
      'try { out.rm = await tools.shell({ command: "rm -rf /data" }) } catch (e) { out.error = String(e?.message ?? e) }',
      'out.after = await tools.shell({ command: "echo AFTER" })',
      "return out",
    ].join("\n")
    const call = await h.call("execute", { code })
    expect(call.result).toContain("[safety-policy:rm-system-path]")
    expect(call.result).not.toContain(STUB_MARK)
    expect(call.result).toContain("AFTER")
    expect(safetyPermissions(call.permissions)).toEqual([])
  })

  test("a nested local rm asks once", async () => {
    const file = h.write("tmp/c.txt", "x")
    const call = await h.call("execute", { code: `return await tools.shell({ command: "rm ${file}" })` })
    expectAsked(call, "rm-local")
    expect(call.result).toContain(`${STUB_MARK} rm ${file}`)
  })

  test("worktree_remove with force is denied", async () => {
    const directory = path.join(h.project, "wt")
    const code = [
      `try { return await tools.opencode.worktree_remove({ directory: "${directory}", force: true }) }`,
      "catch (e) { return String(e?.message ?? e) }",
    ].join("\n")
    const call = await h.call("execute", { code })
    expect(call.result).toContain("[safety-policy:worktree-remove-force]")
    expect(safetyPermissions(call.permissions)).toEqual([])
  })
})

describe.skipIf(!E2E_ENABLED)("lock", () => {
  beforeAll(async () => {
    await h.start({ OPENCODE_SAFETY_LOCK_MODE: "strict" })
  })

  test("refuses to switch the mode", async () => {
    const res = await h.rpc("setMode", { mode: "off" })
    expect(JSON.stringify(res.body)).toContain("锁定为 strict")
    expect(await status()).toMatchObject({ mode: "strict", source: "lock", locked: true })
    expectDenied(await h.shell("kubectl delete ns prod"), "k8s-delete-namespace")
  })
})

describe.skipIf(!E2E_ENABLED)("session hygiene", () => {
  test("leaves no inbox entries and no extra model turns", async () => {
    for (const [sessionID, directory] of h.sessions) {
      const inbox = await h.api("GET", `/api/session/${sessionID}/inbox`, undefined, directory)
      expect(inbox.data).toEqual([])
    }
    await Bun.sleep(1_000)
    expect(h.requests.filter((r) => r.tools.length).length).toBe(h.expectedTurns)
  })
})
