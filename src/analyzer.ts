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
 *   commands are asked in `strict`;
 * - a local file run as a script from stdin (`bash < x.sh`, `ssh host < x.sh`) is read and its content is judged
 *   where it runs. The file may change before it runs, so it is asked even when the content is allowed, and it
 *   fails closed when its path is only known at run time or it cannot be read from any directory the command may
 *   run in.
 * Verdicts are combined as deny > ask > allow.
 */

import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs"
import os from "node:os"
import { effectiveCwd, expandPathArgs, resolveCanonicalPath } from "./path-util"
import { ALLOW, combine, decide, type RuleSet, type Verdict } from "./rules"
import type { MatchInput } from "./rules/matcher"
import { protectedTarget, selfProtectVerdict, type ProtectedPaths } from "./rules/self-protect"
import { isReadOnly, writesFile, type ReadOnlyList } from "./rules/ssh-policy"
import { isDynamicName, tokenize, type OpaqueReason } from "./tokenizer"
import type { Decision, Mode } from "./types"
import { DYNAMIC_TARGET, newWalk, unwrap, unwrapScriptFile, type Atom, type StdinFile, type Walk } from "./unwrapper"

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
  /** Reads a script file redirected to stdin; throws when it cannot be read. Defaults to `readScriptFile`. */
  readFile?: (file: string) => string
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

/** An atom with what it is judged with; `verdict` replaces the rule match. */
interface Entry {
  atom: Atom
  candidates: Candidate[]
  dirs: string[]
  verdict?: Verdict
}

interface Scope {
  home: string
  mode: Mode
  walk: Walk
  read: (file: string) => string | Error
}

const MAX_DIRS = 8
// Deep enough that `..` chains do not reach `/` and do not exist, so the result only depends on absolute paths.
const PLACEHOLDER = "/.ocsp-unknown-cwd/a/b/c/d/e/f/g"
const UNSTABLE = /[$`*?[{]/

const FAIL_CLOSED: Record<Mode, Decision> = { strict: "deny", relaxed: "ask", off: "allow" }
const UNKNOWN_REMOTE: Record<Mode, Decision> = { strict: "ask", relaxed: "allow", off: "allow" }
const SCRIPT_FILE: Record<Mode, Decision> = { strict: "ask", relaxed: "ask", off: "allow" }
export const MAX_SCRIPT_BYTES = 64 * 1024

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
  const walk = newWalk()
  const scope: Scope = { home, mode: input.mode, walk, read: cachedReader(input.readFile ?? readScriptFile) }
  const entries = expandAtoms(unwrap(tokenize(input.command), walk), [cwd], scope)
  const atoms = entries.map(({ atom, candidates, dirs, verdict: fixed }) => {
    const judged = fixed ?? judge(atom, candidates, input)
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
 * `atoms` with the rule inputs they are matched with (opaque atoms have none) and the local directories their paths
 * resolve against, where an unknown directory only keeps name-based self-protection matches. `dirs` are the
 * working directories before the first atom; `cd` adds to them. A script file marker is followed by the atoms of
 * the file content.
 */
function expandAtoms(atoms: Atom[], dirs: Dir[], scope: Scope): Entry[] {
  const { home } = scope
  return atoms.flatMap((atom): Entry | Entry[] => {
    if (atom.opaque) return { atom, candidates: [], dirs: known(dirs) }
    if (atom.scriptFile) return expandScriptFile(atom, atom.scriptFile, dirs, scope)
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

function known(dirs: Dir[]): string[] {
  return [...new Set(dirs.map((dir) => dir ?? PLACEHOLDER))]
}

/**
 * The marker of a script file and the atoms of its content. The file is opened in the directories of the redirect;
 * a directory that cannot be determined only allows an absolute path. Candidates that cannot be read are ignored
 * when another one can, because a failed `cd` keeps directories in the list that the command may not run in.
 * A `cd` in the content adds to `dirs`, because `source` runs the content in the current shell.
 */
function expandScriptFile(atom: Atom, file: StdinFile, dirs: Dir[], scope: Scope): Entry[] {
  const { home, mode } = scope
  const markerDirs = known(dirs)
  if (DYNAMIC_TARGET.test(file.path)) {
    const reason = `命令无法静态分析：作为脚本输入的本地文件路径在运行期才能确定（${file.path}）`
    return [{ atom, candidates: [], dirs: markerDirs, verdict: failClosed(mode, "opaque", reason) }]
  }
  const absolute = file.path.startsWith("/") || file.path === "~" || file.path.startsWith("~/")
  const paths = (file.chdir ?? []).reduce(changeDir(home), dirs).map((dir) => {
    if (dir === null && !absolute) return null
    return resolveCanonicalPath(file.path, dir ?? "/", home)
  })
  const content: Entry[] = []
  const errors: string[] = []
  let readable = false
  for (const target of new Set(paths)) {
    const text = target === null ? new Error("工作目录无法静态确定") : scope.read(target)
    if (text instanceof Error) {
      errors.push(`${target ?? file.path}：${(text as NodeJS.ErrnoException).code ?? text.message}`)
      continue
    }
    readable = true
    content.push(...expandAtoms(unwrapScriptFile(text, atom, scope.walk), dirs, scope))
  }
  const verdict = readable
    ? verdictOf(SCRIPT_FILE[mode], "script-file", `从本地文件读取脚本执行（${file.path}），执行前内容可能被修改`)
    : failClosed(mode, "opaque", `命令无法静态分析：无法读取作为脚本输入的本地文件（${errors.join("；")}）`)
  return [{ atom, candidates: [], dirs: markerDirs, verdict }, ...content]
}

/** Shells drop NUL bytes from a script, which would hide a command from the rules, so such content is not read. */
function cachedReader(readFile: (file: string) => string): (file: string) => string | Error {
  const cache = new Map<string, string | Error>()
  return (file) => {
    let result = cache.get(file)
    if (result === undefined) {
      try {
        result = readFile(file)
        if (result.includes("\0")) result = new Error("包含 NUL 字节")
      } catch (error) {
        result = error instanceof Error ? error : new Error(String(error))
      }
      cache.set(file, result)
    }
    return result
  }
}

/**
 * Reads a script file of at most `MAX_SCRIPT_BYTES` bytes. Anything but a regular file is rejected before it is
 * opened, so FIFOs and devices are neither blocked on nor triggered.
 */
export function readScriptFile(file: string): string {
  if (!statSync(file).isFile()) throw new Error("不是普通文件")
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    if (!fstatSync(fd).isFile()) throw new Error("不是普通文件")
    const buffer = Buffer.alloc(MAX_SCRIPT_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      const read = readSync(fd, buffer, size, buffer.length - size, null)
      if (!read) break
      size += read
    }
    if (size > MAX_SCRIPT_BYTES) throw new Error("超过 64 KiB")
    return buffer.toString("utf8", 0, size)
  } finally {
    closeSync(fd)
  }
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
  return verdictOf(FAIL_CLOSED[mode], ruleId, reason)
}

function verdictOf(decision: Decision, ruleId: string, reason: string): Verdict {
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
