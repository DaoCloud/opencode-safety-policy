import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createMarkers, MARKER_TTL_MS, registerToolHooks } from "../src/hooks/tool"
import { createPolicy, type Policy } from "../src/policy"
import type { CompiledRule } from "../src/rules/matcher"
import { MODE_ENV } from "../src/state"
import type { Mode } from "../src/types"
import { fakeContext } from "./helpers/fake-context"

let root: string

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "ocsp-plugin-"))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

let seq = 0

function call(tool: string, input: unknown) {
  return { tool, sessionID: "ses_1", agent: "build", messageID: "msg_1", id: `call_${++seq}`, input }
}

type Call = ReturnType<typeof call>

async function setup(init: { options?: unknown; mode?: Mode; policy?: Policy } = {}) {
  const fake = fakeContext()
  const clock = { t: 1_000_000 }
  const env = init.mode ? { [MODE_ENV]: init.mode } : {}
  const policy = init.policy ?? createPolicy({ options: init.options ?? {}, storage: fake.ctx.storage, env, now: () => clock.t })
  const markers = createMarkers(() => clock.t)
  await registerToolHooks(fake.ctx, { policy, markers, home: "/home/u" })
  return {
    ...fake,
    clock,
    markers,
    before: (event: Call) => fake.fire("tool.execute.before", event),
    after: (event: Call) => fake.fire("tool.execute.after", { ...event, status: "completed", result: { output: "" } }),
  }
}

describe("shell", () => {
  test("denies with the rule id and reason", async () => {
    const s = await setup()
    await expect(s.before(call("shell", { command: "rm -rf /etc" }))).rejects.toThrow(/^\[safety-policy:rm-system-path\] \S/)
  })

  test("resolves relative paths against workdir", async () => {
    const s = await setup()
    await expect(s.before(call("shell", { workdir: "/", command: "rm -rf etc" }))).rejects.toThrow("[safety-policy:rm-system-path]")
  })

  test("marks an ask until execute.after without prompting itself", async () => {
    const s = await setup()
    const event = call("shell", { command: "rm /tmp/x" })
    await s.before(event)
    expect(s.markers.get("ses_1", event.id)).toMatchObject({
      sessionID: "ses_1",
      callID: event.id,
      command: "rm /tmp/x",
      ruleId: "rm-local",
      expiresAt: s.clock.t + MARKER_TTL_MS,
    })
    expect(s.markers.get("ses_2", event.id)).toBeUndefined()
    await s.after(event)
    expect(s.markers.get("ses_1", event.id)).toBeUndefined()
    expect(s.asserts).toEqual([])
  })

  test("markers expire after the TTL", async () => {
    const s = await setup()
    const event = call("shell", { command: "rm /tmp/x" })
    await s.before(event)
    s.clock.t += MARKER_TTL_MS - 1
    expect(s.markers.get("ses_1", event.id)).toBeDefined()
    s.clock.t += 1
    expect(s.markers.get("ses_1", event.id)).toBeUndefined()
  })

  test("allows safe commands and leaves malformed input to the tool", async () => {
    const s = await setup()
    for (const input of [{ command: "ls -la" }, { command: 1 }, undefined]) {
      const event = call("shell", input)
      await s.before(event)
      expect(s.markers.get("ses_1", event.id)).toBeUndefined()
    }
  })

  test("off mode allows everything", async () => {
    const s = await setup({ mode: "off" })
    await s.before(call("shell", { command: "rm -rf /etc" }))
  })
})

describe("other tools", () => {
  const force = { directory: "/repo/wt", force: true }

  test("strict denies forced worktree removal", async () => {
    const s = await setup()
    await expect(s.before(call("opencode_worktree_remove", force))).rejects.toThrow("[safety-policy:worktree-remove-force]")
    await s.before(call("opencode_worktree_remove", { directory: "/repo/wt" }))
    expect(s.asserts).toEqual([])
  })

  test("ask prompts through permission.assert without save or source", async () => {
    const s = await setup({ mode: "relaxed" })
    await s.before(call("opencode_worktree_remove", force))
    expect(s.asserts).toStrictEqual([
      {
        sessionID: "ses_1",
        agent: "build",
        action: "shell",
        resources: [expect.stringMatching(/^\[safety-policy:worktree-remove-force\] \S/), `$ opencode_worktree_remove ${JSON.stringify(force)}`],
        metadata: { safetyPolicy: true },
      },
    ])
  })

  test("a rejected prompt propagates", async () => {
    const s = await setup({ mode: "relaxed" })
    const rejected = new Error("rejected by user")
    s.control.assertError = rejected
    await expect(s.before(call("opencode_worktree_remove", force))).rejects.toBe(rejected)
  })

  test("rules apply to a tool only when their command lists its id", async () => {
    const s = await setup({
      options: {
        extraDeny: [
          { id: "prod-db-drop", command: "prod_db_execute", pattern: "DROP TABLE" },
          { id: "any-drop", pattern: "DROP" },
        ],
        extraAsk: [{ id: "mcp-write", command: "srv_write" }],
      },
    })
    await expect(s.before(call("prod_db_execute", { sql: "DROP TABLE users" }))).rejects.toThrow("[safety-policy:prod-db-drop]")
    await s.before(call("prod_db_execute", { sql: "SELECT 1" }))
    await s.before(call("edit", { filePath: "/repo/a.sql", newString: "DROP TABLE users" }))
    expect(s.asserts).toEqual([])

    await s.before(call("srv_write", { data: "x".repeat(1000) }))
    const summary = s.asserts[0]!.resources[1]!
    expect(summary.startsWith('$ srv_write {"data":"xxx')).toBe(true)
    expect(summary.length).toBeLessThan(300)
  })
})

describe("fail closed", () => {
  test("invalid options deny every tool except in off mode", async () => {
    const s = await setup({ options: { mode: "bogus" } })
    await expect(s.before(call("read", { filePath: "/repo/a" }))).rejects.toThrow(/^\[safety-policy:config-error\] .*mode/)
    await expect(s.before(call("shell", { command: "ls" }))).rejects.toThrow("[safety-policy:config-error]")

    const off = await setup({ options: { mode: "bogus" }, mode: "off" })
    await off.before(call("read", { filePath: "/repo/a" }))
  })

  test("a broken rulesFile denies until it is fixed", async () => {
    const file = path.join(root, "rules.json")
    writeFileSync(file, "{")
    const s = await setup({ options: { rulesFile: [file] } })
    await expect(s.before(call("read", { filePath: "/repo/a" }))).rejects.toThrow(`[safety-policy:config-error] ${file}`)
    writeFileSync(file, JSON.stringify({ rules: [] }))
    await s.before(call("read", { filePath: "/repo/a" }))
  })

  test("a failing evaluation denies", async () => {
    const bad = { rule: { id: "bad", pattern: "x" }, regex: { test: () => { throw new Error("boom") } } } as unknown as CompiledRule
    const policy: Policy = {
      mode: { resolve: async () => ({ mode: "strict", source: "default", locked: false }), setMode: async () => { throw new Error("unused") } },
      load: () => ({ options: {}, rules: { severity: [], deny: [bad], ask: [], allow: [] }, readOnly: new Map() }),
    }
    const s = await setup({ policy })
    await expect(s.before(call("shell", { command: "ls" }))).rejects.toThrow("[safety-policy:policy-error] boom")
  })
})
