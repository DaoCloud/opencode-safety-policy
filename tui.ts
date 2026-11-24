/**
 * TUI entry: the user-only `/safety` command (design 5.3). It calls the Server RPC and reports through toasts, and
 * shows `/safety test` in a dialog, so it never writes to `session_inbox` and is not a tool the Agent can call. It also
 * toasts the reason of prompts forced by this plugin, because the TUI approval dialog does not render `message`.
 *
 * Imports are type-only except the RPC contract and the report text: `@opencode/plugin/tui` pulls in Solid, and
 * `src/state` pulls in the rule loaders.
 */

import type { Plugin } from "@opencode/plugin/tui"
import definition, { type SetModeInput, type Status, type TestInput, type TestResult } from "./rpc"
import { formatTest } from "./src/report"

const TITLE = "安全策略"
const USAGE = "用法：/safety [status | strict | relaxed | off [--ttl 30m] | test <命令>]，TTL 单位为 s、m、h"
const UNITS = { s: 1_000, m: 60_000, h: 3_600_000 }

type Request = { method: "status" } | { method: "setMode"; input: SetModeInput } | { method: "test"; input: TestInput }

function parse(input = ""): Request | undefined {
  const test = /^test(?:\s+([\s\S]+))?$/.exec(input.trim())
  if (test) {
    const command = unquote(test[1] ?? "")
    return command ? { method: "test", input: { command } } : undefined
  }
  const [mode, flag, ttl, ...rest] = input.trim().split(/\s+/).filter(Boolean)
  if (mode === undefined || (mode === "status" && flag === undefined)) return { method: "status" }
  if (mode !== "strict" && mode !== "relaxed" && mode !== "off") return
  if (flag === undefined) return { method: "setMode", input: { mode } }
  const match = flag === "--ttl" && rest.length === 0 ? /^(\d+)([smh])$/.exec(ttl ?? "") : null
  if (!match) return
  const ttlMs = Number(match[1]) * UNITS[match[2] as keyof typeof UNITS]
  if (ttlMs < 1 || ttlMs > Number.MAX_SAFE_INTEGER) return
  return { method: "setMode", input: { mode, ttlMs } }
}

/** Unwraps `"<cmd>"` or `'<cmd>'` without the same quote inside; anything else is the command as typed. */
function unquote(text: string): string {
  const quote = text[0]
  if (quote !== '"' && quote !== "'") return text
  const inner = text.slice(1, -1)
  return text.length >= 2 && text.endsWith(quote) && !inner.includes(quote) ? inner.trim() : text
}

function describe(status: Status): string {
  const notes = [`source: ${status.source}`]
  if (status.locked) notes.push("已被环境变量锁定")
  if (status.expiresAt !== undefined) {
    const seconds = Math.max(0, Math.ceil((status.expiresAt - Date.now()) / 1_000))
    notes.push(seconds < 60 ? `${seconds} 秒后回落` : `${Math.ceil(seconds / 60)} 分钟后回落`)
  }
  return `当前模式：${status.mode}（${notes.join("，")}）${status.recent ? `；${recent(status.recent)}` : ""}`
}

function recent({ deny, ask, rules }: NonNullable<Status["recent"]>): string {
  if (deny + ask === 0) return "最近 24 小时无拦截"
  const top = rules.map(({ ruleId, count }) => `${ruleId} ×${count}`).join("，")
  return `最近 24 小时：拒绝 ${deny} 次，需确认 ${ask} 次（${top}）`
}

// RPC errors reject with a plain `{ type, message, data }` object, other failures with an Error.
function reason(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message)
  return String(error)
}

const plugin: Plugin.Definition = {
  id: "opencode-safety-policy",
  setup(ctx) {
    const rpc = ctx.client.rpc(definition)
    const toast = (message: string, variant: "info" | "success" | "warning" | "error", sessionID?: string) =>
      ctx.ui.toast.show({ title: TITLE, message, variant, ...(sessionID === undefined ? {} : { sessionID }) })

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-safety-policy.safety",
          title: "Safety policy",
          description: "查看或切换安全策略模式",
          palette: true,
          slash: { name: "safety", arguments: true },
          run: async (input?: string) => {
            const request = parse(input)
            if (!request) return toast(USAGE, "warning")
            try {
              if (request.method === "status") toast(describe((await rpc.status({})) as Status), "info")
              else if (request.method === "setMode")
                toast(describe((await rpc.setMode(request.input)) as Status), "success")
              else {
                const result = (await rpc.test(request.input)) as TestResult
                await ctx.ui.dialog.alert({ title: TITLE, message: formatTest(request.input.command, result) })
              }
            } catch (error) {
              toast(reason(error), "error")
            }
          },
        },
      ],
    }))

    const off = ctx.data.on("permission.asked", (event) => {
      const { message, sessionID } = event.data
      if (message?.startsWith("[safety-policy:")) toast(message, "warning", sessionID)
    })
    return () => off()
  },
}

export default plugin
