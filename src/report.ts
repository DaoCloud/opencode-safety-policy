/**
 * Arguments and result text of `/safety` (design 5.3), shared by the TUI, the server-side command and `cli.ts`. Imports
 * are type-only, so the TUI can load it without the rule loaders.
 */

import type { SetModeInput, Status, TestInput, TestResult } from "../rpc"

export const USAGE = "用法：/safety [status | strict | relaxed | off [--ttl 30m] | test <命令>]，TTL 单位为 s、m、h"
const UNITS = { s: 1_000, m: 60_000, h: 3_600_000 }

export type SafetyRequest =
  | { method: "status" }
  | { method: "setMode"; input: SetModeInput }
  | { method: "test"; input: TestInput }

/** Parses the arguments of `/safety`; `undefined` means show the usage. */
export function parseCommand(input = ""): SafetyRequest | undefined {
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

export function formatStatus(status: Status): string {
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

type Verdict = Pick<TestResult, "decision" | "ruleId" | "reason">

export function formatTest(command: string, result: TestResult): string {
  const lines = [`命令：${command}`, `模式：${result.mode}`, `结果：${verdict(result)}`]
  result.atoms.forEach((atom, index) => {
    lines.push("", `${index + 1}. ${atom.argv.map(quote).join(" ")}`)
    lines.push(`   位置：${atom.isRemote ? `远端${atom.targetHost ? ` ${atom.targetHost}` : ""}` : "本机"}`)
    if (atom.wrapperChain.length > 0) lines.push(`   拆壳链：${atom.wrapperChain.join(" → ")}`)
    lines.push(`   判定：${verdict(atom)}`)
  })
  return lines.join("\n")
}

function verdict({ decision, ruleId, reason }: Verdict): string {
  return ruleId === undefined ? decision : `${decision} [${ruleId}] ${reason ?? ""}`.trimEnd()
}

function quote(arg: string): string {
  return /^[\w@%+=:,./*~^-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}
