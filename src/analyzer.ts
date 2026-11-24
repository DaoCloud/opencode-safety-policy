/**
 * Command analyzer (design 3.1, 3.2, 4.3, 5.1).
 *
 * Tokenizes and unwraps a `shell` command, then judges every atom:
 * - with `protect`, an atom that may modify the plugin or the OpenCode configuration is denied in every mode, `off`
 *   included (design 4.2), unless a rule already denies it;
 * - opaque scripts and dynamic command names (`$CMD`, `r[m]`) are denied in `strict` and asked in `relaxed`;
 * - local atoms are matched after path expansion against every working directory they may run in. The start is
 *   `workdir` resolved against the session directory; `cd` / `pushd` and wrapper directory changes (`env -C`,
 *   `sudo -i`) add candidates, and the list never shrinks because a failed `cd` keeps the old directory. A directory
 *   that cannot be determined is tried as a deep placeholder (cwd-independent verdicts stay) and as `/`, where a
 *   deny is lowered to ask;
 * - remote atoms follow the rules first; without a rule hit, read-only allowlist commands are allowed and other
 *   commands are asked in `strict`.
 * Verdicts are combined as deny > ask > allow.
 */

import os from "node:os"
import { effectiveCwd, expandPathArgs, resolveCanonicalPath } from "./path-util"
import { ALLOW, combine, decide, type RuleSet, type Verdict } from "./rules"
import type { MatchInput } from "./rules/matcher"
import { protectedTarget, selfProtectVerdict, type ProtectedPaths } from "./rules/self-protect"
import { isReadOnly, writesFile, type ReadOnlyList } from "./rules/ssh-policy"
import { isDynamicName, tokenize, type OpaqueReason } from "./tokenizer"
import type { Decision, Mode } from "./types"
import { unwrap, type Atom } from "./unwrapper"

export interface AnalyzeInput {
  command: string
  workdir?: string
  /** `ctx.location.directory`. */
  locationDirectory: string
  mode: Mode
  rules: RuleSet
  readOnly: ReadOnlyList
  home?: string
  protect?: ProtectedPaths
}

export interface AtomReport {
  argv: string[]
  isRemote: boolean
  targetHost?: string
  wrapperChain: string[]
  decision: Decision
  ruleId?: string
  reason?: string
}

export interface Analysis extends Verdict {
  atoms: AtomReport[]
}

/** A rule input; `guessed` when it assumes `/` for a working directory that cannot be determined. */
interface Candidate {
  input: MatchInput
  guessed: boolean
}

/** A directory, or `null` when it cannot be determined statically. */
type Dir = string | null

const MAX_DIRS = 8
// Deep enough that `..` chains do not reach `/` and do not exist, so the result only depends on absolute paths.
const PLACEHOLDER = "/.ocsp-unknown-cwd/a/b/c/d/e/f/g"
const UNSTABLE = /[$`*?[{]/

const FAIL_CLOSED: Record<Mode, Decision> = { strict: "deny", relaxed: "ask", off: "allow" }
const UNKNOWN_REMOTE: Record<Mode, Decision> = { strict: "ask", relaxed: "allow", off: "allow" }

const OPAQUE_TEXT: Record<OpaqueReason, string> = {
  "unterminated-quote": "引号未闭合",
  "unterminated-substitution": "命令替换未闭合",
  "invalid-syntax": "语法无效",
  "unsupported-syntax": "包含不支持的语法（如 case）",
  "function-definition": "定义了 shell 函数",
  "too-deep": "包装层级过深",
  "too-long": "命令过长",
  "piped-script": "从管道或进程替换读取脚本执行，内容无法静态确定",
  "dynamic-args": "包装命令的参数含模板或无法解析，内容无法静态确定",
}

export function analyze(input: AnalyzeInput): Analysis {
  const home = input.home ?? os.homedir()
  const cwd = effectiveCwd(input.workdir, input.locationDirectory, home)
  const atoms = expandAtoms(input.command, cwd, home).map(({ atom, candidates, dirs }) => {
    const judged = judge(atom, candidates, input)
    const verdict = judged.decision === "deny" ? judged : (selfProtect(atom, dirs, input, home) ?? judged)
    const report: AtomReport = {
      argv: atom.argv,
      isRemote: atom.isRemote,
      wrapperChain: atom.wrapperChain,
      decision: verdict.decision,
    }
    if (atom.targetHost !== undefined) report.targetHost = atom.targetHost
    if (verdict.ruleId !== undefined) report.ruleId = verdict.ruleId
    if (verdict.reason !== undefined) report.reason = verdict.reason
    return report
  })
  const top = combine(atoms)
  const analysis: Analysis = { decision: top.decision, atoms }
  if (top.ruleId !== undefined) analysis.ruleId = top.ruleId
  if (top.reason !== undefined) analysis.reason = top.reason
  return analysis
}

/**
 * Atoms of `command` with the rule inputs they are matched with (opaque atoms have none) and the local directories
 * their paths resolve against, where an unknown directory only keeps name-based self-protection matches.
 */
function expandAtoms(command: string, cwd: string, home = os.homedir()): { atom: Atom; candidates: Candidate[]; dirs: string[] }[] {
  const dirs: Dir[] = [cwd]
  const known = (list: Dir[]) => [...new Set(list.map((dir) => dir ?? PLACEHOLDER))]
  return unwrap(tokenize(command)).map((atom) => {
    if (atom.opaque) return { atom, candidates: [], dirs: known(dirs) }
    const base: Omit<MatchInput, "argv"> = { isRemote: atom.isRemote }
    if (atom.stdin !== undefined) base.stdin = atom.stdin
    if (atom.isRemote) return { atom, candidates: [{ input: { ...base, argv: atom.argv }, guessed: false }], dirs: known(dirs) }
    const atomDirs = (atom.chdir ?? []).reduce(changeDir(home), dirs)
    const at = (dir: string, guessed: boolean): Candidate => ({
      input: { ...base, argv: expandPathArgs(atom.argv, atom.expanded, dir, home).argv },
      guessed,
    })
    const candidates = atomDirs.flatMap((dir) => (dir === null ? [at(PLACEHOLDER, false), at("/", true)] : [at(dir, false)]))
    const target = cdTarget(atom)
    if (target !== undefined) addDirs(dirs, changeDir(home)(atomDirs, target))
    return { atom, candidates, dirs: known(atomDirs) }
  })
}

function selfProtect(atom: Atom, dirs: string[], input: AnalyzeInput, home: string): Verdict | undefined {
  if (!input.protect) return undefined
  for (const dir of dirs) {
    const target = protectedTarget(atom, dir, input.protect, input.readOnly, home)
    if (target !== undefined) return selfProtectVerdict(target)
  }
  return undefined
}

function judge(atom: Atom, candidates: Candidate[], input: AnalyzeInput): Verdict {
  const { mode, rules } = input
  if (atom.opaque) return failClosed(mode, "opaque", `命令无法静态分析：${OPAQUE_TEXT[atom.opaque]}`)
  // Lowered verdicts go first so that a tie with an ordinary ask reports the directory problem.
  const lowered: Verdict[] = []
  const verdicts: Verdict[] = []
  for (const { input: candidate, guessed } of candidates) {
    const verdict = decide(candidate, rules, mode)
    if (guessed && verdict.decision === "deny")
      lowered.push({ ...verdict, decision: "ask", reason: `${verdict.reason}（工作目录无法静态确定）` })
    else verdicts.push(verdict)
  }
  if (isDynamicName(atom.argv[0] ?? "", atom.expanded[0] ?? false))
    verdicts.push(failClosed(mode, "dynamic-command", `命令名在运行时才能确定（${atom.argv[0]}），无法静态判定`))
  const verdict = combine([...lowered, ...verdicts])
  if (!atom.isRemote || verdict.decision !== "allow" || verdict.ruleId !== undefined) return verdict
  if ((!atom.argv.length || isReadOnly(atom.argv, input.readOnly)) && !writesFile(atom.command)) return ALLOW
  const decision = UNKNOWN_REMOTE[mode]
  if (decision === "allow") return ALLOW
  return { decision, ruleId: "unknown-remote-command", reason: `远端命令不在只读白名单中（${atom.targetHost ?? "远端"}）` }
}

function failClosed(mode: Mode, ruleId: string, reason: string): Verdict {
  const decision = FAIL_CLOSED[mode]
  return decision === "allow" ? ALLOW : { decision, ruleId, reason }
}

/** The directory argument of `cd` / `pushd`; `null` when it cannot be determined, `undefined` for other atoms. */
function cdTarget(atom: Atom): string | null | undefined {
  if (atom.name !== "cd" && atom.name !== "pushd") return undefined
  const argv = atom.argv
  let i = 1
  while (i < argv.length && /^-[LPe@]+$/.test(argv[i]!)) i++
  if (argv[i] === "--") i++
  const target = argv[i]
  if (target === undefined) return atom.name === "cd" ? "~" : null
  if (atom.expanded[i] || target === "-" || /^[+-]\d+$/.test(target)) return null
  return target
}

function changeDir(home: string) {
  return (dirs: Dir[], target: string | null): Dir[] => {
    const next = dirs.map((dir): Dir => {
      if (target === null || UNSTABLE.test(target) || /^~[^/]/.test(target)) return null
      const absolute = target.startsWith("/") || target === "~" || target.startsWith("~/")
      if (dir === null && !absolute) return null
      return resolveCanonicalPath(target, dir ?? "/", home)
    })
    return [...new Set(next)]
  }
}

function addDirs(dirs: Dir[], added: Dir[]) {
  for (const dir of added) {
    if (dirs.includes(dir)) continue
    if (dirs.length >= MAX_DIRS) {
      if (!dirs.includes(null)) dirs.push(null)
      return
    }
    dirs.push(dir)
  }
}
