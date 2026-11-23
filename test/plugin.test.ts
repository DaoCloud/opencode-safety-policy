import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { registerPermissionHook } from "../src/hooks/permission"
import { createMarkers, MARKER_TTL_MS, registerToolHooks } from "../src/hooks/tool"
import { createPolicy, type Policy } from "../src/policy"
import type { CompiledRule } from "../src/rules/matcher"
import { PLUGIN_DIR } from "../src/rules/self-protect"
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

interface Evaluation {
  sessionID?: string
  action: string
  resources: string[]
  effect?: "allow" | "ask" | "deny"
  metadata?: Record<string, unknown>
  source?: { type: "tool"; messageID: string; id: string }
}

async function setup(init: { options?: unknown; mode?: Mode; policy?: Policy; directory?: string; home?: string } = {}) {
  const fake = fakeContext({ directory: init.directory })
  const clock = { t: 1_000_000 }
  const env = init.mode ? { [MODE_ENV]: init.mode } : {}
  const home = init.home ?? "/home/u"
  const policy = init.policy ?? createPolicy({ options: init.options ?? {}, storage: fake.ctx.storage, env, home, now: () => clock.t })
  const markers = createMarkers(() => clock.t)
  await registerToolHooks(fake.ctx, { policy, markers })
  await registerPermissionHook(fake.ctx, { policy, markers })
  return {
    ...fake,
    clock,
    markers,
    before: (event: Call) => fake.fire("tool.execute.before", event),
    after: (event: Call) => fake.fire("tool.execute.after", { ...event, status: "completed", result: { output: "" } }),
    /** Fires `permission.evaluate` like OpenCode after the saved rules allowed the request, and returns the event. */
    evaluate: async (input: Evaluation) => {
      const event: Evaluation & { agent: string; message?: string } = { sessionID: "ses_1", agent: "build", effect: "allow", ...input }
      await fake.fire("permission.evaluate", event)
      return event
    },
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

  test("off mode skips the rules", async () => {
    const s = await setup({ mode: "off" })
    await s.before(call("shell", { command: "rm -rf /var" }))
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
      home: "/home/u",
      mode: { resolve: async () => ({ mode: "strict", source: "default", locked: false }), setMode: async () => { throw new Error("unused") } },
      load: () => ({ options: {}, rules: { severity: [], deny: [bad], ask: [], allow: [] }, readOnly: new Map(), protect: { roots: [], exempt: [] } }),
    }
    const s = await setup({ policy })
    await expect(s.before(call("shell", { command: "ls" }))).rejects.toThrow("[safety-policy:policy-error] boom")
  })
})

describe("evaluate", () => {
  const source = (id: string) => ({ type: "tool" as const, messageID: "msg_1", id })

  test("forces the built-in prompt for a marked shell call that a saved rule allows", async () => {
    const s = await setup()
    const event = call("shell", { command: "rm /tmp/x" })
    await s.before(event)
    const request = { action: "shell", resources: ["rm /tmp/x"], source: source(event.id) }
    expect(await s.evaluate(request)).toMatchObject({ effect: "ask", message: expect.stringMatching(/^\[safety-policy:rm-local\] \S/) })
    expect((await s.evaluate({ ...request, effect: "deny" })).effect).toBe("deny")
    await s.after(event)
    expect((await s.evaluate(request)).effect).toBe("allow")
  })

  test("matches nested Code Mode calls by session and command text", async () => {
    const s = await setup()
    await s.before(call("shell", { command: "ls && rm /tmp/x" }))
    const nested = { action: "shell", source: source("call_execute") }
    expect((await s.evaluate({ ...nested, resources: ["ls", "rm /tmp/x"] })).effect).toBe("ask")
    expect((await s.evaluate({ ...nested, resources: ["rm /tmp/y"] })).effect).toBe("allow")
    expect((await s.evaluate({ ...nested, resources: [] })).effect).toBe("allow")
    expect((await s.evaluate({ ...nested, resources: ["rm /tmp/x"], sessionID: "ses_2" })).effect).toBe("allow")
  })

  test("locks the plugin's own prompts to ask", async () => {
    const s = await setup()
    const resources = ["[safety-policy:mcp-write] reason", "$ srv_write {}"]
    expect(await s.evaluate({ action: "shell", resources, metadata: { safetyPolicy: true } })).toMatchObject({ effect: "ask", message: resources[0] })
  })

  test.each([".opencode/agent/a.md", "sub/opencode.jsonc", "/home/u/.config/opencode/x.json", `${PLUGIN_DIR}/index.ts`])(
    "denies edits to %s",
    async (resource) => {
      const s = await setup()
      const event = await s.evaluate({ action: "edit", resources: ["src/a.ts", resource] })
      expect(event).toMatchObject({ effect: "deny", message: expect.stringMatching(/^\[safety-policy:self-protect\] \S/) })
    },
  )

  test("allows other edits, the plan directory and reads", async () => {
    const s = await setup()
    const requests = [
      { action: "edit", resources: ["src/a.ts"] },
      { action: "edit", resources: ["/home/u/.opencode/plan/p.md"] },
      { action: "read", resources: ["opencode.json"] },
      { action: "external_directory", resources: ["/home/u/.config/opencode/*"] },
    ]
    for (const request of requests) expect((await s.evaluate(request)).effect).toBe("allow")
  })

  test("resolves symlinks against the session directory", async () => {
    const home = path.join(root, "home")
    mkdirSync(path.join(home, ".config/opencode"), { recursive: true })
    mkdirSync(path.join(root, "proj"))
    symlinkSync(path.join(home, ".config/opencode"), path.join(root, "proj/cfg"))
    const s = await setup({ directory: path.join(root, "proj"), home })
    expect((await s.evaluate({ action: "edit", resources: ["cfg/x.json"] })).effect).toBe("deny")
  })
})

describe("self-protection", () => {
  const rm = { command: "rm ~/.config/opencode/opencode.json" }

  test("applies in off mode unless alwaysProtectSelf is false", async () => {
    const off = await setup({ mode: "off" })
    await expect(off.before(call("shell", rm))).rejects.toThrow("[safety-policy:self-protect]")
    expect((await off.evaluate({ action: "edit", resources: ["opencode.json"] })).effect).toBe("deny")

    const disabled = await setup({ mode: "off", options: { alwaysProtectSelf: false } })
    await disabled.before(call("shell", rm))
    expect((await disabled.evaluate({ action: "edit", resources: ["opencode.json"] })).effect).toBe("allow")
  })

  test("alwaysProtectSelf only affects off mode", async () => {
    const s = await setup({ options: { alwaysProtectSelf: false } })
    await expect(s.before(call("shell", { command: "echo x > .opencode/a" }))).rejects.toThrow("[safety-policy:self-protect]")
    expect((await s.evaluate({ action: "edit", resources: ["opencode.json"] })).effect).toBe("deny")
  })

  test("a broken config denies edits except in off mode", async () => {
    const s = await setup({ options: { mode: "bogus" } })
    const event = await s.evaluate({ action: "edit", resources: ["src/a.ts"] })
    expect(event).toMatchObject({ effect: "deny", message: expect.stringMatching(/^\[safety-policy:config-error\] .*mode/) })
    const off = await setup({ options: { mode: "bogus" }, mode: "off" })
    expect((await off.evaluate({ action: "edit", resources: ["opencode.json"] })).effect).toBe("allow")
  })
})
