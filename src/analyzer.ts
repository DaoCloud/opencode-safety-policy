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
 * - a local file run as a script (`bash < x.sh`, `ssh host < x.sh`, `bash x.sh`, `python3 x.py`) is read and its
 *   content is judged where it runs: a shell script like a heredoc, interpreter code by the prescan. The file may
 *   change before it runs, so it is asked in `strict` even when the content is allowed, and it fails closed when its
 *   path is only known at run time or it cannot be read from any directory the command may run in. An interpreter
 *   script that exists but cannot be prescanned (a directory, too large, binary) is asked like a readable one;
 * - a script that an earlier atom of the command writes (`cat > x.sh <<EOF ... EOF; bash x.sh`, `./x.sh`,
 *   `source x.sh`) fails closed without reading the file, and the written text, when it is known, is judged where
 *   the script runs (design 3.1 Stage 2);
 * - atoms found by the interpreter code prescan are judged by the rules only (design 3.1 Stage 3.5);
 * - `curl`, `wget` and HTTPie requests are matched by `http` rules (design 3.1 Stage 3.5). Their `@file` bodies and
 *   config files are read in each candidate directory; a config file that cannot be read fails closed. A remote
 *   GET / HEAD of a Redfish or UFM path that writes no local file is read-only.
 * Verdicts are combined as deny > ask > allow.
 */

import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { extractHttp, isReadOnlyQuery, type HttpExtraction, type HttpSources } from "./http-extractor"
import { effectiveCwd, expandPathArgs, resolveCanonicalPath } from "./path-util"
import { ALLOW, combine, decide, type RuleSet, type Verdict } from "./rules"
import type { MatchInput } from "./rules/matcher"
import {
  protectedTarget,
  secretTarget,
  secretVerdict,
  selfProtectVerdict,
  type ProtectedPaths,
} from "./rules/self-protect"
import { serverApiRequest, serverApiVerdict } from "./rules/server-api"
import { isFileWrite, isReadOnly, writesFile, type ReadOnlyList } from "./rules/ssh-policy"
import type { Language } from "./script-scanner"
import { isDynamicName, tokenize, type OpaqueReason } from "./tokenizer"
import type { Decision, Mode } from "./types"
import {
  DYNAMIC_TARGET,
  languageOf,
  newWalk,
  printedText,
  unwrap,
  unwrapCode,
  unwrapScriptFile,
  type Atom,
  type ScriptFile,
  type Walk,
} from "./unwrapper"

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
  /** Reads a script file run by the command; throws when it cannot be read. Defaults to `readScriptFile`. */
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
  http?: HttpExtraction
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
  /** Local files written by earlier atoms, with the text written when it is known. */
  written: Map<string, (string | undefined)[]>
}

const MAX_DIRS = 8
// Deep enough that `..` chains do not reach `/` and do not exist, so the result only depends on absolute paths.
const PLACEHOLDER = "/.ocsp-unknown-cwd/a/b/c/d/e/f/g"
const UNSTABLE = /[$`*?[{]/

const FAIL_CLOSED: Record<Mode, Decision> = { strict: "deny", relaxed: "ask", off: "allow" }
const UNKNOWN_REMOTE: Record<Mode, Decision> = { strict: "ask", relaxed: "allow", off: "allow" }
const SCRIPT_FILE: Record<Mode, Decision> = { strict: "ask", relaxed: "allow", off: "allow" }
export const MAX_SCRIPT_BYTES = 64 * 1024
// Errors that mean an interpreter script does not exist; other read errors only stop the prescan.
const MISSING = new Set(["ENOENT", "ENOTDIR"])
// Extensions node tries for a script argument that does not exist.
const NODE_EXTENSIONS = [".js", ".mjs", ".cjs"]
// Commands that write files named by their arguments.
const WRITERS = new Set(
  ["tee", "cp", "mv", "install", "ln", "rsync", "scp", "curl", "wget", "dd", "sed", "patch", "git", "tar", "unzip"],
)

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
  const read = cachedReader(input.readFile ?? readScriptFile)
  const scope: Scope = { home, mode: input.mode, walk, read, written: new Map() }
  const entries = expandAtoms(unwrap(tokenize(input.command), walk), [cwd], scope)
  const atoms = entries.map((entry) => {
    const { atom, candidates, verdict: fixed } = entry
    const judged = fixed ?? judge(atom, candidates, input)
    const verdict = judged.decision === "deny" ? judged : (selfProtect(entry, input, home) ?? judged)
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
 * working directories before the first atom; `cd` adds to them. A script file marker, and an atom that runs a
 * script written earlier in the command, is followed by the atoms of the script.
 */
function expandAtoms(atoms: Atom[], dirs: Dir[], scope: Scope): Entry[] {
  const { home } = scope
  return atoms.flatMap((atom): Entry[] => {
    if (atom.opaque) return [{ atom, candidates: [], dirs: known(dirs) }]
    if (atom.scriptFile) return expandScriptFile(atom, atom.scriptFile, dirs, scope)
    const base: Omit<MatchInput, "argv"> = { isRemote: atom.isRemote }
    if (atom.stdin !== undefined) base.stdin = atom.stdin
    const atomDirs = (atom.chdir ?? []).reduce(changeDir(home), dirs)
    if (atom.isRemote) {
      if (!atom.prescan) recordWrites(atom, [...dirs, ...atomDirs], scope)
      const candidate = withHttp({ input: { ...base, argv: atom.argv }, guessed: false }, atom)
      return [{ atom, candidates: [candidate], dirs: known(dirs) }]
    }
    const at = (dir: string, guessed: boolean): Candidate => {
      const input = { ...base, argv: expandPathArgs(atom.argv, atom.expanded, dir, home).argv }
      const read = (file: string) => {
        const text = scope.read(resolveCanonicalPath(file, dir, home))
        return text instanceof Error ? undefined : text
      }
      return withHttp({ input, guessed }, atom, read)
    }
    const candidates = atomDirs.flatMap((dir) => (dir === null ? [at(PLACEHOLDER, false), at("/", true)] : [at(dir, false)]))
    const entries: Entry[] = [{ atom, candidates, dirs: known(atomDirs) }]
    if (!atom.prescan) {
      entries.push(...expandWrittenScript(atom, dirs, atomDirs, scope))
      recordWrites(atom, [...dirs, ...atomDirs], scope, atomDirs)
    }
    const target = cdTarget(atom)
    if (target !== undefined) addDirs(dirs, changeDir(home)(atomDirs, target))
    return entries
  })
}

/** Adds the HTTP requests of `atom`; files named by the command are read with `read`. */
function withHttp(candidate: Candidate, atom: Atom, read?: (file: string) => string | undefined): Candidate {
  const sources: HttpSources = { stdin: atom.stdin ?? (atom.piped ? undefined : "") }
  if (read) sources.read = read
  const http = atom.http ? { requests: atom.http } : extractHttp(atom.argv, atom.expanded, sources)
  if (!http) return candidate
  return { ...candidate, input: { ...candidate.input, http: http.requests }, http }
}

function known(dirs: Dir[]): string[] {
  return [...new Set(dirs.map((dir) => dir ?? PLACEHOLDER))]
}

/**
 * The marker of a script file and the atoms of its content. The file is opened in the directories of the redirect
 * or of the wrapper; a directory that cannot be determined only allows an absolute path. Candidates that cannot be
 * read are ignored when another one can, because a failed `cd` keeps directories in the list that the command may
 * not run in. A `cd` in the content adds to `dirs`, because `source` runs the content in the current shell. A
 * marker found by the prescan is judged by the content only.
 */
function expandScriptFile(atom: Atom, file: ScriptFile, dirs: Dir[], scope: Scope): Entry[] {
  const { home, mode } = scope
  const markerDirs = known(dirs)
  const marker = (verdict: Verdict): Entry => ({ atom, candidates: [], dirs: markerDirs, verdict })
  if (DYNAMIC_TARGET.test(file.path)) {
    if (atom.prescan) return [marker(ALLOW)]
    return [marker(failClosed(mode, "opaque", `命令无法静态分析：执行的本地脚本路径在运行期才能确定（${file.path}）`))]
  }
  const paths = scriptPaths(file.path, (file.chdir ?? []).reduce(changeDir(home), dirs), home)
  const node = file.language === "node" && file.argument
  if (!atom.prescan) {
    const withExtensions = (p: string | null) => (p === null ? [p] : [p, ...NODE_EXTENSIONS.map((ext) => p + ext)])
    const bodies = writtenTo(node ? paths.flatMap(withExtensions) : paths, scope)
    if (bodies) return writeThenRun(atom, file.path, bodies, () => file.language, dirs, scope)
  }
  const content: Entry[] = []
  const errors: string[] = []
  let readable = false
  let exists = false
  for (const target of paths) {
    const text = target === null ? new Error("工作目录无法静态确定") : node ? readNodeScript(target, scope) : scope.read(target)
    if (text instanceof Error) {
      const code = errorCode(text)
      if (target !== null && !MISSING.has(code)) exists = true
      errors.push(`${target ?? file.path}：${code}`)
      continue
    }
    readable = true
    const atoms = file.language
      ? unwrapCode(text, file.language, atom, scope.walk)
      : unwrapScriptFile(text, atom, scope.walk)
    content.push(...expandAtoms(atoms, dirs, scope))
  }
  let verdict: Verdict
  if (atom.prescan) verdict = ALLOW
  else if (readable) verdict = verdictOf(SCRIPT_FILE[mode], "script-file", `从本地文件读取脚本执行（${file.path}），执行前内容可能被修改`)
  else if (file.language && exists) {
    const reason = `执行本地脚本（${file.path}），内容无法预扫（${errors.join("；")}），执行前内容可能被修改`
    verdict = verdictOf(SCRIPT_FILE[mode], "script-file", reason)
  } else verdict = failClosed(mode, "opaque", `命令无法静态分析：无法读取执行的本地脚本（${errors.join("；")}）`)
  return [marker(verdict), ...content]
}

/** Canonical paths of `file` opened in `dirs`; `null` for a relative path in a directory that cannot be determined. */
function scriptPaths(file: string, dirs: Dir[], home: string): (string | null)[] {
  const absolute = file.startsWith("/") || file === "~" || file.startsWith("~/")
  const resolve = (dir: Dir) => (dir === null && !absolute ? null : resolveCanonicalPath(file, dir ?? "/", home))
  return [...new Set(dirs.map(resolve))]
}

function errorCode(error: Error): string {
  return (error as NodeJS.ErrnoException).code ?? error.message
}

/** Node tries `.js`, `.mjs` and `.cjs` after a script argument that does not exist. */
function readNodeScript(target: string, scope: Scope): string | Error {
  const text = scope.read(target)
  if (!(text instanceof Error) || errorCode(text) !== "ENOENT") return text
  for (const ext of NODE_EXTENSIONS) {
    const other = scope.read(target + ext)
    if (!(other instanceof Error) || errorCode(other) !== "ENOENT") return other
  }
  return text
}

/**
 * The script that a command atom runs by its path (`./x.sh`, `sudo /tmp/x.sh`, `source x.sh`), when an earlier atom
 * of the command wrote it: fails closed, followed by the atoms of the written text.
 */
function expandWrittenScript(atom: Atom, dirs: Dir[], atomDirs: Dir[], scope: Scope): Entry[] {
  const sourced = atom.name === "source" || atom.name === "."
  const i = sourced ? (atom.argv[1] === "--" ? 2 : 1) : 0
  const file = atom.argv[i]
  if (file === undefined || atom.expanded[i] || (!sourced && !file.includes("/"))) return []
  const bodies = writtenTo(scriptPaths(file, atomDirs, scope.home), scope)
  if (!bodies) return []
  return writeThenRun(atom, file, bodies, (text) => (sourced ? undefined : shebangLanguage(text)), dirs, scope)
}

/**
 * What earlier atoms wrote to any of `paths`, or undefined when none of them is written. A path below a written
 * directory (`git clone x repo`, `tar -C dir`) is written with an unknown text.
 */
function writtenTo(paths: (string | null)[], scope: Scope): (string | undefined)[] | undefined {
  let bodies: (string | undefined)[] | undefined
  for (const p of paths) {
    if (p === null) continue
    for (const [file, written] of scope.written) {
      if (file === p) (bodies ??= []).push(...written)
      else if (p.startsWith(file === "/" ? file : `${file}/`)) (bodies ??= []).push(undefined)
    }
  }
  return bodies
}

/**
 * A script written earlier in the command fails closed, because what runs depends on the order of the writes and
 * on the file before them; each known written text is judged where `marker` runs it, as `language` code or a shell
 * script.
 */
function writeThenRun(
  marker: Atom,
  file: string,
  bodies: (string | undefined)[],
  language: (text: string) => Language | undefined,
  dirs: Dir[],
  scope: Scope,
): Entry[] {
  const reason = `命令无法静态分析：同一条命令先写入再执行脚本（${file}），执行时的内容无法静态确定`
  const verdict = failClosed(scope.mode, "opaque", reason)
  const entries: Entry[] = [{ atom: marker, candidates: [], dirs: known(dirs), verdict }]
  for (const body of new Set(bodies)) {
    if (body === undefined) continue
    const lang = language(body)
    const atoms = lang ? unwrapCode(body, lang, marker, scope.walk) : unwrapScriptFile(body, marker, scope.walk)
    entries.push(...expandAtoms(atoms, dirs, scope))
  }
  return entries
}

/** The interpreter of a `#!` line, through `env` too; a shell when undefined. */
function shebangLanguage(text: string): Language | undefined {
  const match = /^#!\s*(\S+)[ \t]*(.*)/.exec(text)
  if (!match) return undefined
  const name = path.posix.basename(match[1]!)
  if (name !== "env") return languageOf(name)
  const words = match[2]!.split(/\s+/).filter((word) => word && !word.startsWith("-") && !word.includes("="))
  return languageOf(words[0] ?? "")
}

/**
 * Records the local files that `atom` writes through a redirect, resolved in `dirs`, and, for a command that
 * writes files named by its arguments, through an argument resolved in `atomDirs`. The text written is known for a
 * literal `echo` / `printf` and for `cat` / `tee` of inline stdin.
 */
function recordWrites(atom: Atom, dirs: Dir[], scope: Scope, atomDirs?: Dir[]) {
  const add = (file: string, text: string | undefined, from: Dir[]) => {
    for (const p of scriptPaths(file, from, scope.home)) {
      if (p === null) continue
      const written = scope.written.get(p) ?? []
      if (!written.includes(text)) written.push(text)
      scope.written.set(p, written)
    }
  }
  const text = atom.isRemote ? undefined : printedText(atom)
  for (const command of atom.localCommands)
    for (const redirect of command.redirects)
      if (isFileWrite(redirect) && !DYNAMIC_TARGET.test(redirect.target)) add(redirect.target, text, dirs)
  if (!atomDirs || !WRITERS.has(atom.name)) return
  for (let i = 1; i < atom.argv.length; i++) {
    if (atom.expanded[i]) continue
    const word = atom.argv[i]!.replace(atom.name === "dd" ? /^of=/ : /^--?[\w-]+=/, "")
    if (word && !word.startsWith("-")) add(word, atom.name === "tee" ? atom.stdin : undefined, atomDirs)
  }
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

/** Self-protection (design 4.2). Atoms found by the prescan are only checked for the local Server API. */
function selfProtect({ atom, candidates, dirs }: Entry, input: AnalyzeInput, home: string): Verdict | undefined {
  const { protect } = input
  if (!protect) return undefined
  const api = atom.isRemote ? undefined : serverApiRequest(candidates.flatMap((c) => c.input.http ?? []), protect.ports)
  if (api) return serverApiVerdict(api)
  if (atom.prescan) return undefined
  for (const dir of dirs) {
    const secret = secretTarget(atom, dir, protect, home)
    if (secret !== undefined) return secretVerdict(secret)
    const target = protectedTarget(atom, dir, protect, input.readOnly, home)
    if (target !== undefined) return selfProtectVerdict(target)
  }
  return undefined
}

function judge(atom: Atom, candidates: Candidate[], input: AnalyzeInput): Verdict {
  const { mode, rules } = input
  if (atom.opaque) return atom.prescan ? ALLOW : failClosed(mode, "opaque", `命令无法静态分析：${OPAQUE_TEXT[atom.opaque]}`)
  // Lowered verdicts go first so that a tie with an ordinary ask reports the directory problem.
  const lowered: Verdict[] = []
  const verdicts: Verdict[] = []
  for (const { input: candidate, guessed } of candidates) {
    const verdict = decide(candidate, rules, mode)
    if (guessed && verdict.decision === "deny")
      lowered.push({ ...verdict, decision: "ask", reason: `${verdict.reason}（工作目录无法静态确定）` })
    else verdicts.push(verdict)
  }
  if (!atom.prescan && isDynamicName(atom.argv[0] ?? "", atom.expanded[0] ?? false))
    verdicts.push(failClosed(mode, "dynamic-command", `命令名在运行时才能确定（${atom.argv[0]}），无法静态判定`))
  const opaque = candidates[0]?.http?.opaque
  if (!atom.prescan && opaque !== undefined && candidates.every((candidate) => candidate.http?.opaque !== undefined))
    verdicts.push(failClosed(mode, "opaque", `命令无法静态分析：${opaque}`))
  const verdict = combine([...lowered, ...verdicts])
  if (atom.prescan) return verdict.reason === undefined ? verdict : { ...verdict, reason: `${verdict.reason}（解释器代码预扫）` }
  if (!atom.isRemote || verdict.decision !== "allow" || verdict.ruleId !== undefined) return verdict
  const readOnly = !atom.argv.length || isReadOnly(atom.argv, input.readOnly) || isReadOnlyQuery(candidates[0]?.http)
  if (readOnly && !writesFile(atom.command)) return ALLOW
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
