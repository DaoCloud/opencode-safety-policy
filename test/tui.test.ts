import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { SetModeInput, Status, TestInput, TestResult } from "../rpc"
import plugin from "../tui"

type Command = { slash?: unknown; palette?: unknown; run: (input?: string) => unknown }
type Toast = { title?: string; message: string; variant?: string; sessionID?: string }
type Server = {
  status?: () => Promise<Status>
  setMode?: (input: SetModeInput) => Promise<Status>
  test?: (input: TestInput) => Promise<TestResult>
}

function setup(server: Server = {}) {
  const toasts: Toast[] = []
  const alerts: Array<{ title: string; message: string }> = []
  const calls: Array<[string, unknown]> = []
  const listeners = new Map<string, (event: unknown) => void>()
  let layer: (() => { mode?: string; commands?: readonly Command[] }) | undefined
  const ctx = {
    client: {
      rpc: () => ({
        status: async (input: unknown) => {
          calls.push(["status", input])
          return (server.status ?? (async () => ({ mode: "strict", source: "default", locked: false })))()
        },
        setMode: async (input: SetModeInput) => {
          calls.push(["setMode", input])
          return (server.setMode ?? (async ({ mode }) => ({ mode, source: "runtime", locked: false })))(input)
        },
        test: async (input: TestInput) => {
          calls.push(["test", input])
          return (server.test ?? (async () => ({ mode: "strict", decision: "allow", atoms: [] })))(input)
        },
      }),
    },
    keymap: { layer: (factory: typeof layer) => void (layer = factory) },
    ui: {
      toast: { show: (options: Toast) => void toasts.push(options) },
      dialog: { alert: async (options: { title: string; message: string }) => void alerts.push(options) },
    },
    data: {
      on: (type: string, handler: (event: unknown) => void) => {
        listeners.set(type, handler)
        return () => void listeners.delete(type)
      },
    },
  } as unknown as Plugin.Context
  const cleanup = plugin.setup(ctx)
  const command = () => layer!().commands![0]!
  const run = (input?: string) => command().run(input)
  return { toasts, alerts, calls, listeners, cleanup, layer: () => layer!(), command, run }
}

describe("/safety", () => {
  test("is a slash command with arguments in the palette", () => {
    const s = setup()
    // The default base mode is unreachable while the slash autocomplete or the palette is open.
    expect(s.layer().mode).toBe("global")
    expect(s.command()).toMatchObject({ slash: { name: "safety", arguments: true }, palette: true })
  })

  test.each([undefined, "", "status", "  status  "])("shows the status for %p", async (input) => {
    const s = setup()
    await s.run(input)
    expect(s.calls).toEqual([["status", {}]])
    expect(s.toasts).toEqual([{ title: "安全策略", message: "当前模式：strict（source: default）", variant: "info" }])
  })

  test("shows the lock and the remaining TTL", async () => {
    const locked = setup({ status: async () => ({ mode: "strict", source: "lock", locked: true }) })
    await locked.run("status")
    expect(locked.toasts[0]?.message).toBe("当前模式：strict（source: lock，已被环境变量锁定）")

    const ttl = setup({ status: async () => ({ mode: "off", source: "runtime", locked: false, expiresAt: Date.now() + 14.5 * 60_000 }) })
    await ttl.run()
    expect(ttl.toasts[0]?.message).toBe("当前模式：off（source: runtime，15 分钟后回落）")

    const short = setup({ status: async () => ({ mode: "off", source: "runtime", locked: false, expiresAt: Date.now() + 30_000 }) })
    await short.run()
    expect(short.toasts[0]?.message).toBe("当前模式：off（source: runtime，30 秒后回落）")
  })

  test.each([
    ["strict", { mode: "strict" }],
    ["relaxed", { mode: "relaxed" }],
    [" off ", { mode: "off" }],
    ["relaxed --ttl 30m", { mode: "relaxed", ttlMs: 30 * 60_000 }],
    ["off   --ttl 15m", { mode: "off", ttlMs: 15 * 60_000 }],
    ["off --ttl 45s", { mode: "off", ttlMs: 45_000 }],
    ["strict --ttl 2h", { mode: "strict", ttlMs: 2 * 3_600_000 }],
  ])("switches the mode for %p", async (input, expected) => {
    const s = setup()
    await s.run(input)
    expect(s.calls).toEqual([["setMode", expected]])
    expect(s.toasts).toEqual([{ title: "安全策略", message: `当前模式：${expected.mode}（source: runtime）`, variant: "success" }])
  })

  test.each([
    "bogus",
    "status now",
    "test",
    "test   ",
    `test ""`,
    "testing ls",
    "off 15m",
    "off --ttl",
    "off --ttl 15",
    "off --ttl 0m",
    "off --ttl 1d",
    "off --ttl -5m",
    "off --ttl 15m extra",
    "off --ttl=15m",
    "off --for 15m",
    `off --ttl ${"9".repeat(20)}h`,
  ])("shows the usage for %p", async (input) => {
    const s = setup()
    await s.run(input)
    expect(s.calls).toEqual([])
    expect(s.toasts).toEqual([{ title: "安全策略", message: expect.stringContaining("用法：/safety"), variant: "warning" }])
  })

  test("shows the recent blocks", async () => {
    const status: Status = { mode: "strict", source: "default", locked: false, recent: { deny: 0, ask: 0, rules: [] } }
    const none = setup({ status: async () => status })
    await none.run()
    expect(none.toasts[0]?.message).toBe("当前模式：strict（source: default）；最近 24 小时无拦截")

    const rules = [
      { ruleId: "rm-system-path", count: 2 },
      { ruleId: "rm-local", count: 1 },
    ]
    const some = setup({ status: async () => ({ ...status, recent: { deny: 2, ask: 1, rules } }) })
    await some.run()
    expect(some.toasts[0]?.message).toBe(
      "当前模式：strict（source: default）；最近 24 小时：拒绝 2 次，需确认 1 次（rm-system-path ×2，rm-local ×1）",
    )
  })

  test("test shows the dry run in a dialog", async () => {
    const command = `ssh n1 "sudo bash -c 'rm -rf /data/*'" && ls 'a b'`
    const reason = "禁止删除根目录或系统关键目录"
    const result: TestResult = {
      mode: "strict",
      decision: "deny",
      ruleId: "rm-system-path",
      reason,
      atoms: [
        {
          argv: ["rm", "-rf", "/data/*"],
          isRemote: true,
          targetHost: "n1",
          wrapperChain: ["ssh", "sudo", "bash -c"],
          decision: "deny",
          ruleId: "rm-system-path",
          reason,
        },
        { argv: ["ls", "a b"], isRemote: false, wrapperChain: [], decision: "allow" },
      ],
    }
    const s = setup({ test: async () => result })
    await s.run(`test ${command}`)
    expect(s.calls).toEqual([["test", { command }]])
    expect(s.toasts).toEqual([])
    expect(s.alerts).toEqual([
      {
        title: "安全策略",
        message: [
          `命令：${command}`,
          "模式：strict",
          `结果：deny [rm-system-path] ${reason}`,
          "",
          "1. rm -rf /data/*",
          "   位置：远端 n1",
          "   拆壳链：ssh → sudo → bash -c",
          `   判定：deny [rm-system-path] ${reason}`,
          "",
          "2. ls 'a b'",
          "   位置：本机",
          "   判定：allow",
        ].join("\n"),
      },
    ])
  })

  test.each([
    [`test "rm -rf /"`, "rm -rf /"],
    [`test ' ssh n1 "rm x" '`, `ssh n1 "rm x"`],
    [`test "a" && echo "b"`, `"a" && echo "b"`],
    [`test "x`, `"x`],
    ["  test   ls  -la  ", "ls  -la"],
  ])("test unquotes %p only when it is one quoted word", async (input, command) => {
    const s = setup()
    await s.run(input)
    expect(s.calls).toEqual([["test", { command }]])
  })

  test("shows why the server refused", async () => {
    const message = "安全模式已被 OPENCODE_SAFETY_LOCK_MODE 锁定为 strict，不能切换"
    const s = setup({ setMode: () => Promise.reject({ type: "locked", message, data: { mode: "strict" } }) })
    await s.run("off")
    expect(s.toasts).toEqual([{ title: "安全策略", message, variant: "error" }])

    const down = setup({ status: () => Promise.reject(new Error("RPC is unavailable")) })
    await down.run()
    expect(down.toasts).toEqual([{ title: "安全策略", message: "RPC is unavailable", variant: "error" }])

    const test = setup({ test: () => Promise.reject(new Error("RPC is unavailable")) })
    await test.run("test ls")
    expect(test.alerts).toEqual([])
    expect(test.toasts).toEqual([{ title: "安全策略", message: "RPC is unavailable", variant: "error" }])
  })
})

describe("permission.asked", () => {
  test("shows the reason of a prompt forced by this plugin", () => {
    const s = setup()
    const asked = (message?: string) => s.listeners.get("permission.asked")?.({ data: { sessionID: "ses_1", message } })
    asked("[safety-policy:rm-local] 删除文件")
    asked("other plugin")
    asked(undefined)
    expect(s.toasts).toEqual([{ title: "安全策略", message: "[safety-policy:rm-local] 删除文件", variant: "warning", sessionID: "ses_1" }])
  })

  test("cleanup unsubscribes", async () => {
    const s = setup()
    const cleanup = await s.cleanup
    expect(typeof cleanup).toBe("function")
    await (cleanup as () => unknown)()
    expect(s.listeners.size).toBe(0)
  })
})
