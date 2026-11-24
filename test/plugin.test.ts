import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import plugin from "../index"
import definition from "../rpc"
import { createAudit, type Audit } from "../src/audit"
import { registerPermissionHook } from "../src/hooks/permission"
import { createMarkers, MARKER_TTL_MS, registerToolHooks } from "../src/hooks/tool"
import { createPolicy, type Policy } from "../src/policy"
import type { CompiledRule } from "../src/rules/matcher"
import { PLUGIN_DIR, protectedPaths } from "../src/rules/self-protect"
import { createRpcHandlers } from "../src/rpc-handlers"
import { LOCK_ENV, MODE_ENV } from "../src/state"
import { BLOCK_PREFIX, createStats } from "../src/stats"
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

/** An audit log whose pending writes can be awaited. */
function tracked(audit: Audit) {
  const pending: Promise<void>[] = []
  return {
    write(entry: Parameters<Audit["write"]>[0]) {
      const done = audit.write(entry)
      pending.push(done)
      return done
    },
    settled: () => Promise.all(pending),
  }
}

function auditLines(file: string) {
  return readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))
}

async function setup(init: { options?: unknown; mode?: Mode; policy?: Policy; directory?: string; home?: string } = {}) {
  const fake = fakeContext({ directory: init.directory })
  const clock = { t: 1_000_000 }
  const env = init.mode ? { [MODE_ENV]: init.mode } : {}
  const home = init.home ?? "/home/u"
  const policy = init.policy ?? createPolicy({ options: init.options ?? {}, storage: fake.ctx.storage, env, home, now: () => clock.t })
  const markers = createMarkers(() => clock.t)
  const stats = createStats(fake.ctx.storage, () => clock.t)
  const audit = tracked(createAudit(policy.auditLogPath, fake.ctx.location.directory, () => clock.t))
  await registerToolHooks(fake.ctx, { policy, markers, stats, audit })
  await registerPermissionHook(fake.ctx, { policy, markers, stats, audit })
  return {
    ...fake,
    clock,
    markers,
    stats,
    audit,
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
      decision: "ask",
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

  test("marks safe commands as allowed and leaves malformed input to the tool", async () => {
    const s = await setup()
    const safe = call("shell", { command: "ls -la" })
    await s.before(safe)
    expect(s.markers.get("ses_1", safe.id)).toMatchObject({ command: "ls -la", decision: "allow" })
    for (const input of [{ command: 1 }, undefined]) {
      const event = call("shell", input)
      await s.before(event)
      expect(s.markers.get("ses_1", event.id)).toBeUndefined()
    }
    expect(s.asserts).toEqual([])
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
      load: () => ({
        options: {},
        rules: { severity: [], deny: [bad], ask: [], allow: [] },
        readOnly: new Map(),
        protect: protectedPaths({ home: "/home/u", env: {} }),
      }),
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

  test("denies a shell command that execute.before did not check", async () => {
    const s = await setup()
    const ls = call("shell", { command: "ls" })
    const rm = call("shell", { command: "rm /tmp/x" })
    await s.before(ls)
    await s.before(rm)
    const rewritten = [
      { action: "shell", resources: ["ls", "rm -rf /etc"], source: source(ls.id) },
      { action: "shell", resources: ["rm /tmp/x", "rm -rf /etc"], source: source(rm.id) },
      { action: "shell", resources: ["rm -rf /etc"], source: source("call_execute") },
      { action: "shell", resources: ["rm -rf /etc"] },
    ]
    const denied = { effect: "deny", message: expect.stringMatching(/^\[safety-policy:rm-system-path\] \S/) }
    for (const request of rewritten) expect(await s.evaluate(request)).toMatchObject(denied)
    expect(await s.stats.recent()).toMatchObject({ deny: 4 })
    expect((await s.evaluate({ action: "shell", resources: ["ls"], source: source(ls.id) })).effect).toBe("allow")
    expect((await s.evaluate({ action: "shell", resources: ["rm /tmp/y"], source: source(ls.id) })).effect).toBe("allow")
  })

  test("re-checks in the current mode, self-protection in off mode too", async () => {
    const off = await setup({ mode: "off" })
    expect((await off.evaluate({ action: "shell", resources: ["rm -rf /var"] })).effect).toBe("allow")
    expect(await off.evaluate({ action: "shell", resources: ["echo x > opencode.json"] })).toMatchObject({
      effect: "deny",
      message: expect.stringMatching(/^\[safety-policy:self-protect\] \S/),
    })
    const disabled = await setup({ mode: "off", options: { alwaysProtectSelf: false } })
    expect((await disabled.evaluate({ action: "shell", resources: ["echo x > opencode.json"] })).effect).toBe("allow")
  })

  test("does not re-check parts of a checked command out of their context", async () => {
    // In a protected location, `touch a` alone would be denied, but it runs in its workdir.
    const s = await setup({ directory: "/home/u/.config/opencode" })
    const workdir = call("shell", { workdir: "/tmp/w", command: "touch a" })
    await s.before(workdir)
    const effect = async (resource: string, id: string) =>
      (await s.evaluate({ action: "shell", resources: [resource], source: source(id) })).effect
    expect(await effect("touch a", workdir.id)).toBe("allow")
    expect(await effect("touch a", "call_execute")).toBe("allow")
    expect(await effect("touch b", workdir.id)).toBe("deny")
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

  describe("webfetch", () => {
    const options = { protectedEndpoints: { bmcCidrs: ["10.0.0.0/24"] } }
    const RESET = "https://bmc1/redfish/v1/Systems/1/Actions/ComputerSystem.Reset"
    const fetch = (url: string, method?: string, extra: Record<string, unknown> = {}) => ({
      action: "webfetch",
      resources: [url],
      metadata: { ...(method && { method }), url, ...extra },
    })

    test.each<[Mode, string, string, string]>([
      ["strict", RESET, "POST", "redfish-power-reset"],
      ["relaxed", RESET, "POST", "redfish-power-reset"],
      ["strict", "https://bmc1/redfish/v1/Systems/1", "PATCH", "redfish-boot-override"],
      ["strict", "http://10.0.0.5/api", "DELETE", "protected-endpoint-write"],
      ["relaxed", "http://10.0.0.5/api", "PROPPATCH", "protected-endpoint-write"],
      ["relaxed", "https://ufm/ufmRestV2/actions", "post", "ufm-rest-write"],
    ])("%s denies %s %s", async (mode, url, method, ruleId) => {
      const s = await setup({ options, mode })
      const event = await s.evaluate({ ...fetch(url, method), effect: "ask" })
      expect(event.effect).toBe("deny")
      expect(event.message).toStartWith(`[safety-policy:${ruleId}] `)
    })

    test("denies a redirect hop to a protected endpoint", async () => {
      const s = await setup({ options })
      const hop = fetch("http://10.0.0.5/x", "POST", { redirectedFrom: "https://example.com/r" })
      expect((await s.evaluate(hop)).effect).toBe("deny")
    })

    test("leaves reads, other hosts, off mode and denied requests alone", async () => {
      const s = await setup({ options })
      const requests = [
        fetch(RESET),
        fetch(RESET, "HEAD"),
        { action: "webfetch", resources: [RESET], metadata: { url: RESET, format: "markdown" } },
        fetch("https://example.com/x", "POST"),
        fetch("http://10.0.1.5/x", "PUT"),
      ]
      for (const request of requests) expect((await s.evaluate({ ...request, effect: "ask" })).effect).toBe("ask")
      const off = await setup({ options, mode: "off" })
      expect((await off.evaluate(fetch(RESET, "POST"))).effect).toBe("allow")
      const denied = await s.evaluate({ ...fetch("https://example.com/x"), effect: "deny" })
      expect(denied.message).toBeUndefined()
    })

    test("a broken config denies a write", async () => {
      const s = await setup({ options: { mode: "bogus" } })
      const event = await s.evaluate(fetch("https://example.com/x", "POST"))
      expect(event.message).toStartWith("[safety-policy:config-error]")
      expect((await s.evaluate(fetch("https://example.com/x"))).effect).toBe("allow")
    })

    test("denies every method to the local Server API, in off mode too", async () => {
      // A port of this process is a Server port (every port is where they cannot be found).
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
      try {
        const s = await setup({ mode: "off" })
        const message = expect.stringMatching(/^\[safety-policy:self-protect\] 禁止调用本机/)
        const base = `127.0.0.1:${server.port}`
        const api = [fetch(`http://${base}/api/info`), fetch(`http://localhost:${server.port}/api/rpc/x`, "POST")]
        for (const request of api)
          expect(await s.evaluate({ ...request, effect: "ask" })).toMatchObject({ effect: "deny", message })
        for (const url of [`http://${base}/`, "https://example.com/api/x"])
          expect((await s.evaluate(fetch(url))).effect).toBe("allow")
      } finally {
        await server.stop(true)
      }
    })
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

  test("denies reads, edits and grep of Server credentials and the database", async () => {
    const message = expect.stringMatching(/^\[safety-policy:self-protect\] 禁止读写 OpenCode Server 凭据与数据库/)
    const s = await setup({ mode: "off" })
    const denied = [
      { action: "read", resources: ["/home/u/.local/state/opencode/service.json"] },
      { action: "read", resources: ["src/a.ts", "/proc/1/environ"] },
      { action: "edit", resources: ["/home/u/.config/opencode/service.json"] },
      { action: "edit", resources: ["/home/u/.local/share/opencode/opencode.db-wal"] },
      { action: "grep", resources: ["password"], metadata: { path: "/home/u/.local/state/opencode/service.json" } },
    ]
    for (const request of denied) expect(await s.evaluate(request)).toMatchObject({ effect: "deny", message })
    const inside = await setup({ directory: "/home/u/.local/state/opencode" })
    expect((await inside.evaluate({ action: "read", resources: ["service.json"] })).effect).toBe("deny")
    const allowed = [
      { action: "read", resources: ["service.json"] },
      { action: "grep", resources: ["x"], metadata: { path: "/home/u/.local/state/opencode" } },
      { action: "grep", resources: ["x"], metadata: {} },
    ]
    for (const request of allowed) expect((await s.evaluate(request)).effect).toBe("allow")
    const disabled = await setup({ mode: "off", options: { alwaysProtectSelf: false } })
    expect((await disabled.evaluate(denied[0]!)).effect).toBe("allow")
  })

  test("a broken config denies edits except in off mode", async () => {
    const s = await setup({ options: { mode: "bogus" } })
    const event = await s.evaluate({ action: "edit", resources: ["src/a.ts"] })
    expect(event).toMatchObject({ effect: "deny", message: expect.stringMatching(/^\[safety-policy:config-error\] .*mode/) })
    const off = await setup({ options: { mode: "bogus" }, mode: "off" })
    expect((await off.evaluate({ action: "edit", resources: ["opencode.json"] })).effect).toBe("allow")
  })
})

describe("entry", () => {
  async function load(options: Record<string, unknown> = {}) {
    const fake = fakeContext({ options })
    await plugin.setup(fake.ctx)
    return { ...fake, rpc: (method: string, input: unknown) => fake.call(definition.id, method, input) }
  }

  test("registers the hooks and the rpc", async () => {
    const s = await load()
    expect([...s.hooks.keys()].sort()).toEqual(["permission.evaluate", "tool.execute.after", "tool.execute.before"])
    expect(s.rpcs.map((item) => item.definition.id)).toEqual(["opencode-safety-policy"])
  })

  test("the hooks share markers and follow the mode set over rpc", async () => {
    const s = await load()
    await s.rpc("setMode", { mode: "strict" })
    await expect(s.fire("tool.execute.before", call("shell", { command: "rm -rf /etc" }))).rejects.toThrow("[safety-policy:rm-system-path]")
    const event = call("shell", { command: "rm /tmp/x" })
    await s.fire("tool.execute.before", event)
    const evaluation = {
      sessionID: "ses_1",
      agent: "build",
      action: "shell",
      resources: ["rm /tmp/x"],
      effect: "allow",
      source: { type: "tool", messageID: "msg_1", id: event.id },
    }
    await s.fire("permission.evaluate", evaluation)
    expect(evaluation.effect).toBe("ask")
    await s.rpc("setMode", { mode: "off" })
    await s.fire("tool.execute.before", call("shell", { command: "rm -rf /var" }))
  })

  test("passes the options to the policy", async () => {
    const s = await load({ mode: "bogus" })
    await s.rpc("setMode", { mode: "strict" })
    await expect(s.fire("tool.execute.before", call("shell", { command: "ls" }))).rejects.toThrow("[safety-policy:config-error]")
  })
})

describe("rpc", () => {
  const NONE = { deny: 0, ask: 0, rules: [] }

  async function setupRpc(env: Record<string, string> = {}, options: unknown = {}) {
    const fake = fakeContext({ directory: root })
    const clock = { t: 1_000_000 }
    const policy = createPolicy({ options, storage: fake.ctx.storage, env, home: "/home/u", now: () => clock.t })
    const stats = createStats(fake.ctx.storage, () => clock.t)
    const audit = tracked(createAudit(policy.auditLogPath, fake.ctx.location.directory, () => clock.t))
    const directory = fake.ctx.location.directory
    await fake.ctx.rpc.register(definition, createRpcHandlers({ policy, stats, audit, directory }))
    const blocks = () => [...fake.data.keys()].filter((key) => key.startsWith(BLOCK_PREFIX))
    const rpc = (method: string, input: unknown) => fake.call(definition.id, method, input)
    return { ...fake, clock, stats, audit, blocks, rpc }
  }

  test("status reports the mode without an expiry", async () => {
    const s = await setupRpc()
    expect(await s.rpc("status", {})).toStrictEqual({ mode: "strict", source: "default", locked: false, recent: NONE })
  })

  test("setMode returns the new status and a TTL falls back", async () => {
    const s = await setupRpc({ [MODE_ENV]: "relaxed" })
    const expiresAt = s.clock.t + 60_000
    expect(await s.rpc("setMode", { mode: "off", ttlMs: 60_000 })).toStrictEqual({ mode: "off", source: "runtime", locked: false, expiresAt })
    const status = { mode: "off", source: "runtime", locked: false, expiresAt, recent: NONE }
    expect(await s.rpc("status", {})).toStrictEqual(status)
    s.clock.t = expiresAt
    expect(await s.rpc("status", {})).toStrictEqual({ mode: "relaxed", source: "env", locked: false, recent: NONE })
    expect(await s.rpc("setMode", { mode: "strict" })).toStrictEqual({ mode: "strict", source: "runtime", locked: false })
  })

  test("setMode is audited, a refused one is not", async () => {
    const file = path.join(root, "audit-mode.jsonl")
    const s = await setupRpc({}, { auditLogPath: file })
    await s.rpc("setMode", { mode: "off", ttlMs: 60_000 })
    await s.rpc("setMode", { mode: "strict" })
    const locked = await setupRpc({ [LOCK_ENV]: "strict" }, { auditLogPath: file })
    await expect(locked.rpc("setMode", { mode: "off" })).rejects.toMatchObject({ type: "locked" })
    await Promise.all([s.audit.settled(), locked.audit.settled()])
    const common = { time: new Date(s.clock.t).toISOString(), directory: s.ctx.location.directory }
    expect(auditLines(file)).toEqual([
      { ...common, event: "mode", mode: "off", ttlMs: 60_000 },
      { ...common, event: "mode", mode: "strict" },
    ])
  })

  test("setMode is refused with a declared error under the lock", async () => {
    const s = await setupRpc({ [LOCK_ENV]: "strict" })
    await expect(s.rpc("setMode", { mode: "off" })).rejects.toEqual({
      type: "locked",
      message: expect.stringContaining(LOCK_ENV),
      data: { mode: "strict" },
    })
    expect(s.data.size).toBe(0)
    expect(await s.rpc("status", {})).toStrictEqual({ mode: "strict", source: "lock", locked: true, recent: NONE })
  })

  test("status reports the recent blocks and omits them when they cannot be read", async () => {
    const s = await setupRpc()
    await s.stats.record("deny", "rm-system-path")
    await s.stats.record("ask", "rm-local")
    expect((await s.rpc("status", {})) as object).toMatchObject({
      recent: { deny: 1, ask: 1, rules: [{ ruleId: "rm-local", count: 1 }, { ruleId: "rm-system-path", count: 1 }] },
    })
    ;(s.ctx.storage as { scan: unknown }).scan = async () => {
      throw new Error("disk I/O error")
    }
    expect(await s.rpc("status", {})).toStrictEqual({ mode: "strict", source: "default", locked: false })
  })

  test("test dry-runs a shell call in the current mode without counting it", async () => {
    const s = await setupRpc()
    expect(await s.rpc("test", { command: `ssh n1 "sudo bash -c 'rm -rf /data/*'" && ls` })).toStrictEqual({
      mode: "strict",
      decision: "deny",
      ruleId: "rm-system-path",
      reason: expect.any(String),
      atoms: [
        {
          argv: ["rm", "-rf", "/data/*"],
          isRemote: true,
          targetHost: "n1",
          wrapperChain: ["ssh", "sudo", "bash -c"],
          decision: "deny",
          ruleId: "rm-system-path",
          reason: expect.any(String),
        },
        { argv: ["ls"], isRemote: false, wrapperChain: [], decision: "allow" },
      ],
    })
    expect(await s.rpc("test", { command: "rm -rf etc", workdir: "/" })).toMatchObject({ ruleId: "rm-system-path" })
    expect(await s.rpc("test", { command: "rm -rf etc" })).toMatchObject({ decision: "ask" })
    await s.rpc("setMode", { mode: "off" })
    expect(await s.rpc("test", { command: "rm -rf /data" })).toMatchObject({ mode: "off", decision: "allow" })
    const result = await s.rpc("test", { command: "echo x > opencode.json" })
    expect(result).toMatchObject({ mode: "off", ruleId: "self-protect" })
    expect(s.blocks()).toEqual([])
  })

  test("test reports config errors like the hooks", async () => {
    const s = await setupRpc({}, { mode: "bogus" })
    expect(await s.rpc("test", { command: "ls" })).toStrictEqual({
      mode: "strict",
      decision: "deny",
      ruleId: "config-error",
      reason: expect.stringContaining("mode"),
      atoms: [],
    })
    await s.rpc("setMode", { mode: "off" })
    expect(await s.rpc("test", { command: "rm -rf /data" })).toStrictEqual({ mode: "off", decision: "allow", atoms: [] })
  })
})

describe("audit", () => {
  const source = (id: string) => ({ type: "tool" as const, messageID: "msg_1", id })

  test("logs each deny and ask with its context, and no allowed call", async () => {
    const file = path.join(root, "audit-hooks.jsonl")
    const s = await setup({ options: { auditLogPath: file } })
    const rm = call("shell", { command: "rm -rf /data" })
    await expect(s.before(rm)).rejects.toThrow("[safety-policy:rm-system-path]")
    const ask = call("shell", { command: "rm /tmp/x", workdir: "/tmp" })
    await s.before(ask)
    await s.before(call("shell", { command: "ls" }))
    const marked = { action: "shell", resources: ["rm /tmp/x"], source: source(ask.id) }
    expect((await s.evaluate(marked)).effect).toBe("ask")
    const edit = { action: "edit", resources: ["src/a.ts", "opencode.json"], source: source("call_edit") }
    expect((await s.evaluate(edit)).effect).toBe("deny")
    const secret = "/home/u/.config/opencode/service.json"
    expect((await s.evaluate({ action: "read", resources: [secret] })).effect).toBe("deny")
    await s.audit.settled()
    const common = { time: new Date(s.clock.t).toISOString(), sessionID: "ses_1", directory: s.ctx.location.directory }
    const reason = expect.stringMatching(/\S/)
    const protect = { ...common, event: "deny", ruleId: "self-protect", reason }
    const shell = { ...common, reason, tool: "shell" }
    expect(auditLines(file)).toEqual([
      { ...shell, event: "deny", ruleId: "rm-system-path", input: "rm -rf /data", callID: rm.id },
      { ...shell, event: "ask", ruleId: "rm-local", input: "rm /tmp/x", callID: ask.id, workdir: "/tmp" },
      { ...protect, input: "src/a.ts\nopencode.json", permission: "edit", callID: "call_edit" },
      { ...protect, input: secret, permission: "read" },
    ])
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("logs non-shell tools with their JSON input, and config errors", async () => {
    const file = path.join(root, "audit-tools.jsonl")
    const relaxed = await setup({ mode: "relaxed", options: { auditLogPath: file } })
    const remove = call("opencode_worktree_remove", { directory: "/repo/wt", force: true })
    await relaxed.before(remove)
    await relaxed.audit.settled()
    const input = '{"directory":"/repo/wt","force":true}'
    expect(auditLines(file)).toMatchObject([{ event: "ask", ruleId: "worktree-remove-force", input, tool: remove.tool }])
    const broken = await setup({ options: { auditLogPath: file, rulesFile: [path.join(root, "missing-rules.json")] } })
    await expect(broken.before(call("shell", { command: "ls" }))).rejects.toThrow("[safety-policy:config-error]")
    await broken.audit.settled()
    expect(auditLines(file)[1]).toMatchObject({ event: "deny", ruleId: "config-error", input: "ls", tool: "shell" })
  })

  test("truncates a long input", async () => {
    const file = path.join(root, "audit-long.jsonl")
    const s = await setup({ options: { auditLogPath: file } })
    const command = `rm -rf /data ${"x".repeat(5000)}`
    await expect(s.before(call("shell", { command }))).rejects.toThrow()
    await s.audit.settled()
    expect(auditLines(file)[0].input).toBe(`${command.slice(0, 4096)}…`)
  })

  test("keeps the order of the writes", async () => {
    const file = path.join(root, "audit-order.jsonl")
    const audit = createAudit(file, root)
    const order = Array.from({ length: 50 }, (_, i) => i)
    await Promise.all(order.map((ttlMs) => audit.write({ event: "mode", mode: "off", ttlMs })))
    expect(auditLines(file).map((line) => line.ttlMs)).toEqual(order)
  })

  test("an unwritable log never changes a decision", async () => {
    const s = await setup({ options: { auditLogPath: path.join(root, "missing", "audit.jsonl") } })
    await expect(s.before(call("shell", { command: "rm -rf /data" }))).rejects.toThrow("[safety-policy:rm-system-path]")
    const ask = call("shell", { command: "rm /tmp/x" })
    await s.before(ask)
    expect((await s.evaluate({ action: "shell", resources: ["rm /tmp/x"], source: source(ask.id) })).effect).toBe("ask")
    expect((await s.evaluate({ action: "edit", resources: ["opencode.json"] })).effect).toBe("deny")
    await s.audit.settled()
    expect(await s.stats.recent()).toMatchObject({ deny: 2, ask: 1 })
  })
})

describe("stats", () => {
  test("count the denies and asks of both hooks once", async () => {
    const s = await setup({ options: { protectedEndpoints: { bmcCidrs: ["10.0.0.0/24"] } } })
    await expect(s.before(call("shell", { command: "rm -rf /etc" }))).rejects.toThrow()
    await expect(s.before(call("shell", { command: "rm -rf /var" }))).rejects.toThrow()
    const marked = call("shell", { command: "rm /tmp/x" })
    await s.before(marked)
    const source = { type: "tool" as const, messageID: "msg_1", id: marked.id }
    const evaluation = { action: "shell", resources: ["rm /tmp/x"], source }
    expect((await s.evaluate(evaluation)).effect).toBe("ask")
    expect((await s.evaluate({ action: "edit", resources: ["opencode.json"] })).effect).toBe("deny")
    const post = { action: "webfetch", resources: ["http://10.0.0.5/api"], metadata: { method: "POST" } }
    expect((await s.evaluate(post)).effect).toBe("deny")
    expect(await s.stats.recent()).toEqual({
      deny: 4,
      ask: 1,
      rules: [
        { ruleId: "rm-system-path", count: 2 },
        { ruleId: "protected-endpoint-write", count: 1 },
        { ruleId: "rm-local", count: 1 },
      ],
    })
  })

  test("count config errors and non-shell asks", async () => {
    const broken = await setup({ options: { mode: "bogus" } })
    await expect(broken.before(call("shell", { command: "ls" }))).rejects.toThrow("[safety-policy:config-error]")
    expect((await broken.evaluate({ action: "edit", resources: ["src/a.ts"] })).effect).toBe("deny")
    expect(await broken.stats.recent()).toEqual({ deny: 2, ask: 0, rules: [{ ruleId: "config-error", count: 2 }] })

    const relaxed = await setup({ mode: "relaxed" })
    await relaxed.before(call("opencode_worktree_remove", { directory: "/repo/wt", force: true }))
    const rules = [{ ruleId: "worktree-remove-force", count: 1 }]
    expect(await relaxed.stats.recent()).toEqual({ deny: 0, ask: 1, rules })
  })

  test("a failing write never changes a decision", async () => {
    const s = await setup()
    ;(s.ctx.storage as { set: unknown }).set = () => {
      throw new Error("disk full")
    }
    await expect(s.before(call("shell", { command: "rm -rf /etc" }))).rejects.toThrow("[safety-policy:rm-system-path]")
    const marked = call("shell", { command: "rm /tmp/x" })
    await s.before(marked)
    expect(s.markers.get("ses_1", marked.id)).toBeDefined()
    expect((await s.evaluate({ action: "edit", resources: ["opencode.json"] })).effect).toBe("deny")
  })
})
