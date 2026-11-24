/**
 * Text of a `/safety test` dry run (design 5.3), shared by the TUI dialog and `cli.ts`. Imports are type-only, so the
 * TUI can load it without the rule loaders.
 */

import type { TestResult } from "../rpc"

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
