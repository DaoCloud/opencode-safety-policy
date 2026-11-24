import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { SetModeInput, Status } from "../rpc"
import plugin from "../tui"

type Command = { slash?: unknown; palette?: unknown; run: (input?: string) => unknown }
type Toast = { title?: string; message: string; variant?: string; sessionID?: string }

function setup(server: { status?: () => Promise<Status>; setMode?: (input: SetModeInput) => Promise<Status> } = {}) {
  const toasts: Toast[] = []
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
      }),
    },
    keymap: { layer: (factory: typeof layer) => void (layer = factory) },
    ui: { toast: { show: (options: Toast) => void toasts.push(options) } },
    data: {
      on: (type: string, handler: (event: unknown) => void) => {
        listeners.set(type, handler)
        return () => void listeners.delete(type)
      },
    },
  } as unknown as Plugin.Context
  const cleanup = plugin.setup(ctx)
  const command = () => layer!().commands![0]!
  return { toasts, calls, listeners, cleanup, layer: () => layer!(), command, run: (input?: string) => command().run(input) }
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
    "test ls",
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

  test("shows why the server refused", async () => {
    const message = "安全模式已被 OPENCODE_SAFETY_LOCK_MODE 锁定为 strict，不能切换"
    const s = setup({ setMode: () => Promise.reject({ type: "locked", message, data: { mode: "strict" } }) })
    await s.run("off")
    expect(s.toasts).toEqual([{ title: "安全策略", message, variant: "error" }])

    const down = setup({ status: () => Promise.reject(new Error("RPC is unavailable")) })
    await down.run()
    expect(down.toasts).toEqual([{ title: "安全策略", message: "RPC is unavailable", variant: "error" }])
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
