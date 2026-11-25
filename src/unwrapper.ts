/**
 * Recursive unwrapper (design 3.1 Stage 3, 3.2).
 *
 * Peels wrappers such as `ssh`, `sudo` and `bash -c` off every tokenized command and returns the innermost
 * commands ("atoms") together with their execution context. Remote command strings are re-tokenized the way
 * the remote shell would parse them.
 *
 * `xargs` appends its input as the argument `$XARGS_INPUT` (or substitutes it for the `-I` string), marked as
 * expanded, so rules see a variable operand; `find -exec` and `parallel` do the same with `$FIND_PATH` and
 * `$PARALLEL_INPUT`. Inline stdin (heredoc / here-string) flows into wrapped commands, and a shell or `ssh` without
 * a command runs it as a script (`bash <<EOF`, `ssh host <<EOF`). A shell or interpreter that runs a script from
 * a pipe or a process substitution (`curl ... | bash`, `bash <(curl ...)`) yields a `piped-script` opaque atom. The
 * output of a literal `echo` / `printf` upstream is inline stdin too. A local file redirected to a shell, `ssh` or an
 * interpreter (`bash < x.sh`, `python3 < x.py`), or passed to one as the script (`bash x.sh`, `python3 x.py`), yields a
 * marker atom with `scriptFile`; the caller reads the file and walks its content with `unwrapScriptFile` or
 * `unwrapCode`. Interpreter inline code (`python3 -c`, `node -e`) is prescanned for shell commands (design 3.1
 * Stage 3.5); the atoms found in interpreter code carry `prescan`, and its endpoint literals become one atom with
 * `http`.
 */

import path from "node:path"
import { OPTION_SPECS, readOption, shortFlags, skipOptions, type OptionSpec, type ParsedOption } from "./cli-options"
import {
  braceBudget,
  isDynamicName,
  normalizeName,
  tokenize,
  type BraceBudget,
  type Command,
  type OpaqueReason,
  type Script,
} from "./tokenizer"
import type { HttpRequest } from "./http-extractor"
import { scanCode, scanHttp, type Language } from "./script-scanner"

export interface Atom {
  name: string
  argv: string[]
  expanded: boolean[]
  /** Environment assignments from the command and from `sudo` / `env` wrappers. */
  assignments: string[]
  /** True inside `ssh`, `kubectl exec` and `docker exec`: paths refer to another filesystem. */
  isRemote: boolean
  targetHost?: string
  /** Where the root filesystem of the target host is mounted, such as `/host` in `kubectl debug node/x`. */
  hostRoot?: string
  /** Wrappers from outermost to innermost, e.g. `["ssh", "sudo", "bash -c"]`. */
  wrapperChain: string[]
  /** The tokenized command this atom comes from (redirects, connector). */
  command: Command
  /**
   * Commands of the local shell this atom is nested in, outermost first, e.g. `bash -c 'x' > f` for `x`. Their
   * redirects open files on this machine. Includes `command` unless the atom comes from a remote script.
   */
  localCommands: Command[]
  /** Heredoc or here-string text on stdin, including stdin passed through wrappers such as `ssh` or `bash -c`. */
  stdin?: string
  /**
   * Directory changes by wrappers (`env -C`, `sudo -D`, `chroot`) in order; `null` is a directory that is unknown
   * statically, such as the home of a login (`sudo -i`, `su -`) or the directory of each file of `find -execdir`.
   */
  chdir?: (string | null)[]
  /** Set when a script could not be parsed (`name` is `""`) or the wrapper nesting is too deep. */
  opaque?: OpaqueReason
  /** Set on a marker atom (`name` is `""`) for a local file that the wrapper runs as a script. */
  scriptFile?: ScriptFile
  /** Found in interpreter code by the prescan, so only rules judge it. */
  prescan?: boolean
  /** HTTP requests to endpoint literals of interpreter code (`name` is `""`). */
  http?: HttpRequest[]
  /** Stdin is a pipe or a file, not inline text. */
  piped?: true
}

/** A local file run as a script: on stdin, or as the script argument of a shell or an interpreter. */
export interface ScriptFile {
  path: string
  /** Wrapper directory changes where the file is opened, like `Atom.chdir`. */
  chdir?: (string | null)[]
  /** The interpreter that runs the file; a shell when undefined. */
  language?: Language
  /** The file is the script argument (`bash x.sh`), not stdin. */
  argument?: boolean
  /** Stdin of an argument script when it is not inline text. */
  piped?: Piped
}

/** Stdin that is not inline text: `true` for a pipe whose content is unknown, or a local file. */
type Piped = boolean | ScriptFile

interface Context {
  isRemote: boolean
  localCommands: Command[]
  targetHost?: string
  hostRoot?: string
  wrapperChain: string[]
  depth: number
  stdin?: string
  piped?: Piped
  chdir?: (string | null)[]
  prescan?: boolean
}

type Inner =
  | { argv: string[]; expanded: boolean[]; assignments?: string[] }
  | { script: string }
  /** The wrapper runs a local file as a script. */
  | { file: ScriptFile }
  /** Interpreter code to prescan. */
  | { code: string; language: Language }
  /** The wrapper runs code that cannot be known statically. */
  | { opaque: OpaqueReason }

interface Layer {
  label: string
  inner: Inner
  /** Switches to a remote context on this host. */
  host?: string
  /** The root filesystem of `host` is mounted at this path in the inner context. */
  hostRoot?: string
  /** The wrapper consumes stdin (or detaches it), so inner commands do not inherit it. */
  readsStdin?: boolean
  /** The inner command runs in this directory; `null` when it is unknown statically. */
  chdir?: string | null
  /** The wrapper command is judged too, like the wrappers in `KEEP`. */
  keep?: boolean
}

type Unwrapper = (args: string[], expanded: boolean[], stdin?: string, piped?: Piped) => Layer[]

/** State shared by one analysis, including the scripts read later with `unwrapScriptFile`. */
export interface Walk {
  atoms: Atom[]
  /** Characters left for re-tokenizing wrapped scripts. */
  chars: number
  /** Brace expansion budget shared by every re-tokenized script. */
  braces: BraceBudget
  stopped: boolean
}

const MAX_DEPTH = 8
// A substitution inside a remote or `bash -c` string is analyzed on both sides, so nesting grows
// exponentially. Past these budgets the walk stops with a `too-long` opaque atom.
const MAX_ATOMS = 10_000
const MAX_CHARS = 1 << 20
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SHELLS = ["sh", "bash", "zsh", "dash", "ksh", "ash"]
const PYTHON_VERSION = /^python\d+\.\d+$/
// Script paths that read the script from stdin.
const STANDARD_STREAMS: Record<string, number> = { "/dev/stdin": 0, "/dev/stdout": 1, "/dev/stderr": 2 }
const DESCRIPTOR_PATH = /^\/(?:dev\/fd|proc\/(?:self|thread-self)\/fd)\/(\d+)$/
// Characters that make a redirect target known only at run time.
export const DYNAMIC_TARGET = /[$`*?[]/
// Wrappers whose inner command runs in the current shell, so an `exec` in it redirects the shell.
const SAME_SHELL = new Set(["command", "builtin", "time", "eval", "source", "."])
// Wrappers that are themselves commands to judge, not only carriers of the inner commands.
const KEEP = new Set(["find"])
export const XARGS_INPUT = "$XARGS_INPUT"
export const FIND_PATH = "$FIND_PATH"
export const PARALLEL_INPUT = "$PARALLEL_INPUT"
// A reparsed script may quote an input placeholder (`sh -c "rm '{}'"`), which still stands for the input.
const INPUT_PLACEHOLDER = /\$(?:XARGS_INPUT|FIND_PATH|PARALLEL_INPUT)/
// More `parallel` input values than this are judged as one variable operand.
const MAX_PARALLEL_VALUES = 64
// Bounds static pipe input, which `printf` can make much longer than the command.
const MAX_STATIC_OUTPUT = 64 * 1024
const ECHO_OPTIONS = /^-[neE]+$/
const PRINTF_ESCAPES: Record<string, string> = {
  "\\": "\\",
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
}

export function newWalk(): Walk {
  return { atoms: [], chars: MAX_CHARS, braces: braceBudget(), stopped: false }
}

/** Atoms of `script`, appended to `walk`. */
export function unwrap(script: Script, walk = newWalk()): Atom[] {
  const start = walk.atoms.length
  walkScript(script, { isRemote: false, localCommands: [], wrapperChain: [], depth: 0 }, walk, emptyCommand())
  return walk.atoms.slice(start)
}

/**
 * Atoms of the content of the file of a `scriptFile` marker, run as a shell script in the context of the marker. A
 * command atom that runs a script by its path can be the marker too.
 */
export function unwrapScriptFile(text: string, marker: Atom, walk: Walk): Atom[] {
  if (walk.stopped) return []
  const start = walk.atoms.length
  const context = markerContext(marker)
  if (text.length > walk.chars) {
    stop(walk, atomBase(context, marker.command))
  } else {
    walk.chars -= text.length
    walkScript(tokenize(text, walk.braces), context, walk, marker.command)
  }
  return walk.atoms.slice(start)
}

/** Atoms of the commands found in interpreter `code`, run in the context of `marker` like `unwrapScriptFile`. */
export function unwrapCode(code: string, language: Language, marker: Atom, walk: Walk): Atom[] {
  if (walk.stopped) return []
  const start = walk.atoms.length
  walkCode(code, language, markerContext(marker), marker.command, walk)
  return walk.atoms.slice(start)
}

/** The interpreter language of the command `name`. */
export function languageOf(name: string): Language | undefined {
  if (PYTHON_VERSION.test(name)) return "python"
  return Object.hasOwn(LANGUAGES, name) ? LANGUAGES[name] : undefined
}

/** What a literal `echo` / `printf`, or a `cat` / `tee` of inline stdin, writes. */
export function printedText(atom: Atom): string | undefined {
  const [, ...args] = atom.argv
  if (atom.name === "tee" || (atom.name === "cat" && args.every((arg) => arg === "-"))) return atom.stdin
  if (atom.expanded.some(Boolean)) return undefined
  if (atom.name === "echo") return echoOutput(args)
  if (atom.name === "printf") return printfOutput(args)
  return undefined
}

function markerContext(marker: Atom): Context {
  const context: Context = {
    isRemote: marker.isRemote,
    localCommands: marker.localCommands,
    wrapperChain: marker.wrapperChain,
    depth: marker.wrapperChain.length,
  }
  if (marker.targetHost !== undefined) context.targetHost = marker.targetHost
  if (marker.chdir) context.chdir = marker.chdir
  // An argument script inherits the stdin of its wrapper; a script on stdin has none left.
  if (marker.stdin !== undefined) context.stdin = marker.stdin
  if (marker.scriptFile?.piped) context.piped = marker.scriptFile.piped
  if (marker.prescan) context.prescan = true
  return context
}

/** Walks the commands found in interpreter `code` as atoms with `prescan`. */
function walkCode(code: string, language: Language, context: Context, owner: Command, walk: Walk) {
  if (code.length > walk.chars) return stop(walk, atomBase(context, owner))
  walk.chars -= code.length
  const prescan: Context = { ...context, prescan: true }
  const http = scanHttp(code, language)
  if (http.length) emit(walk, { ...atomBase(prescan, owner), http })
  for (const command of scanCode(code, language)) {
    if (command.length > walk.chars) return stop(walk, atomBase(context, owner))
    walk.chars -= command.length
    walkScript(tokenize(command, walk.braces), prescan, walk, owner)
    if (walk.stopped) return
  }
}

function emptyCommand(): Command {
  return { assignments: [], name: "", argv: [], expanded: [], redirects: [], substitutions: [] }
}

function emit(walk: Walk, atom: Atom) {
  if (walk.stopped) return
  if (walk.atoms.length < MAX_ATOMS) return void walk.atoms.push(atom)
  stop(walk, atom)
}

/** Ends the walk. The atoms left out may be outside the prescan, so the `too-long` atom is never a prescan atom. */
function stop(walk: Walk, atom: Atom) {
  walk.stopped = true
  const { prescan: _, ...rest } = atom
  walk.atoms.push({ ...rest, name: "", argv: [], expanded: [], assignments: [], opaque: "too-long" })
}

interface Input {
  stdin?: string
  piped: Piped
}

function inputContext(context: Context, input: Input): Context {
  const next: Context = { ...context }
  if (input.stdin === undefined) delete next.stdin
  else next.stdin = input.stdin
  if (input.piped) next.piped = input.piped
  else delete next.piped
  return next
}

function inputOf(context: Context): Input {
  const piped = context.piped ?? false
  return context.stdin === undefined ? { piped } : { stdin: context.stdin, piped }
}

/**
 * The input of the shell after an `exec` that redirects it to `input`. The `exec` may run in a subshell or not at
 * all, so `input` is only taken when the shell has no input or the same one; a replaced input becomes unknown.
 */
function shellInput(context: Context, input: Input): Input {
  const piped = context.piped ?? false
  if (context.stdin === undefined && !piped) return input
  return input.stdin === context.stdin && input.piped === piped ? input : { piped: true }
}

/** Walks `script`, and returns the input of the shell after it when an `exec` without a command changes it. */
function walkScript(script: Script, context: Context, walk: Walk, owner: Command): Input | undefined {
  if (script.opaque) emit(walk, { ...atomBase(context, owner), opaque: script.opaque })
  let changed = false
  for (const command of script.commands) {
    // Words are expanded before the command's own redirects apply, so `$(...)` and `<(...)` read the pipe of
    // their command or the redirects of an enclosing compound command.
    const words = stdinOf(command, context, command.redirects.slice(0, command.outerRedirects ?? 0))
    for (const sub of command.substitutions) {
      walkScript(sub, inputContext(context, sub.piped ? { piped: true } : words), walk, command)
    }
    const inner = inputContext(context, stdinOf(command, context))
    if (!context.isRemote) inner.localCommands = [...context.localCommands, command]
    const shell = walkArgv(command.argv, command.expanded, command.assignments, inner, command, walk)
    if (walk.stopped) return undefined
    if (shell) {
      context = inputContext(context, shellInput(context, shell))
      changed = true
    }
  }
  return changed ? inputOf(context) : undefined
}

/**
 * The last stdin redirect wins; a pipe or a file on stdin replaces the inherited input, and the output of a
 * literal `echo` / `printf` upstream is inline text. `<&0` and `< /dev/stdin` keep it, as does a target of a remote
 * shell known only at run time, `<&-` closes it, `<&N` or `< /dev/fd/N` duplicates a descriptor whose content is
 * unknown, and `/dev/null` is empty. A local file is kept as a `ScriptFile`; a file of a remote shell cannot be read.
 */
function stdinOf(command: Command, context: Context, redirects = command.redirects): Input {
  const pipe = command.connector === "|" || !!command.piped
  const literal = command.connector === "|" ? staticOutput(command.upstream) : undefined
  let stdin = pipe ? literal : context.stdin
  let piped: Piped = literal === undefined && (pipe || (context.piped ?? false))
  for (const redirect of pipe ? redirects.slice(command.pipeAt ?? 0) : redirects) {
    if ((redirect.fd ?? 0) !== 0 || !redirect.op.startsWith("<")) continue
    const file = redirect.op === "<" || redirect.op === "<>"
    const dynamic = file && context.isRemote && DYNAMIC_TARGET.test(redirect.target)
    if (redirect.op === "<&" ? redirect.target === "0" : dynamic) continue
    const descriptor = file ? descriptorOf(redirect.target) : undefined
    if (descriptor === 0) continue
    stdin = redirect.body
    if (redirect.op === "<&") piped = redirect.target !== "-"
    else if (!file) piped = false
    else if (descriptor !== undefined) piped = true
    else if (path.posix.normalize(redirect.target) === "/dev/null") {
      stdin = ""
      piped = false
    } else if (context.isRemote) piped = false
    else piped = context.chdir ? { path: redirect.target, chdir: context.chdir } : { path: redirect.target }
  }
  return stdin === undefined ? { piped } : { stdin, piped }
}

/** The output of a literal `echo` or `printf` that every shell prints the same way. */
function staticOutput(command: Command | undefined): string | undefined {
  if (!command || command.redirects.length || command.substitutions.length || command.piped) return undefined
  if (command.expanded.some(Boolean)) return undefined
  const [name, ...args] = command.argv
  if (name === "echo") return echoOutput(args)
  if (name === "printf") return printfOutput(args)
  return undefined
}

function echoOutput(args: string[]): string | undefined {
  let i = 0
  while (i < args.length && ECHO_OPTIONS.test(args[i]!)) i++
  const newline = !args.slice(0, i).some((arg) => arg.includes("n"))
  const words = args.slice(i)
  // zsh ends options at `-`, and escapes are interpreted only by some shells.
  if (words[0]?.startsWith("-") || words.some((word) => word.includes("\\"))) return undefined
  return words.join(" ") + (newline ? "\n" : "")
}

/** `printf` with only `%s` / `%%` conversions and single-character escapes; the format repeats for extra args. */
function printfOutput(args: string[]): string | undefined {
  const [format, ...values] = args
  if (format === undefined || format.startsWith("-")) return undefined
  const parts: (string | null)[] = []
  let text = ""
  for (let i = 0; i < format.length; i++) {
    const c = format[i]!
    if (c === "\\") {
      const escape = PRINTF_ESCAPES[format[++i] ?? ""]
      if (escape === undefined) return undefined
      text += escape
    } else if (c === "%") {
      const conversion = format[++i]
      if (conversion === "%") {
        text += "%"
        continue
      }
      if (conversion !== "s") return undefined
      parts.push(text, null)
      text = ""
    } else text += c
  }
  parts.push(text)
  const slots = parts.filter((part) => part === null).length
  if (!slots && values.length) return undefined
  let output = ""
  let next = 0
  do {
    for (const part of parts) output += part ?? values[next++] ?? ""
    if (output.length > MAX_STATIC_OUTPUT) return undefined
  } while (next < values.length)
  return output
}

/** The descriptor a `/dev/stdin` or `/dev/fd/N` style path opens. */
function descriptorOf(file: string): number | undefined {
  if (!file.startsWith("/")) return undefined
  const normal = path.posix.normalize(file)
  return STANDARD_STREAMS[normal] ?? (DESCRIPTOR_PATH.test(normal) ? Number(DESCRIPTOR_PATH.exec(normal)![1]) : undefined)
}

/**
 * How a shell or interpreter reads the script file `arg`: `"stdin"` for `/dev/stdin`, `"dynamic"` for a path known
 * only at run time (which may be `/dev/stdin`), `"opaque"` for a process substitution or another descriptor, and
 * `undefined` for a local file.
 */
function scriptFile(arg: string, expanded: boolean | undefined): "stdin" | "dynamic" | "opaque" | undefined {
  if (isProcessSubstitution(arg, expanded)) return "opaque"
  if (expanded) return "dynamic"
  const descriptor = descriptorOf(arg)
  if (descriptor === undefined) return undefined
  return descriptor === 0 ? "stdin" : "opaque"
}

function atomBase(context: Context, command: Command): Atom {
  const atom: Atom = {
    name: "",
    argv: [],
    expanded: [],
    assignments: [],
    isRemote: context.isRemote,
    wrapperChain: context.wrapperChain,
    command,
    localCommands: context.localCommands,
  }
  if (context.targetHost !== undefined) atom.targetHost = context.targetHost
  if (context.hostRoot !== undefined) atom.hostRoot = context.hostRoot
  if (context.stdin !== undefined) atom.stdin = context.stdin
  if (context.piped) atom.piped = true
  if (context.chdir) atom.chdir = context.chdir
  if (context.prescan) atom.prescan = true
  return atom
}

/** Walks a command, and returns the input of the shell after it when it is an `exec` without a command. */
function walkArgv(
  argv: string[],
  expanded: boolean[],
  assignments: string[],
  context: Context,
  command: Command,
  walk: Walk,
): Input | void {
  if (walk.stopped) return
  if (context.depth) expanded = expanded.map((flag, k) => flag || INPUT_PLACEHOLDER.test(argv[k]!))
  const name = normalizeName(argv[0] ?? "")
  const atom: Atom = { ...atomBase(context, command), name, argv, expanded, assignments }
  const unwrapper = isDynamicName(argv[0] ?? "", expanded[0] ?? false) ? undefined : wrapperFor(name)
  if (!unwrapper) return emit(walk, atom)
  // A script argument of a remote command is a remote file.
  const layers = unwrapper(argv.slice(1), expanded.slice(1), context.stdin, context.piped).filter(
    (layer) => !(context.isRemote && "file" in layer.inner && layer.inner.file.argument),
  )
  if (!layers.length) {
    emit(walk, atom)
    return name === "exec" ? inputOf(context) : undefined
  }
  if (KEEP.has(name) || layers.some((layer) => layer.keep)) emit(walk, atom)
  if (context.depth >= MAX_DEPTH) return emit(walk, { ...atom, opaque: "too-deep" })
  let shell: Input | void = undefined
  for (const layer of layers) {
    const next: Context = {
      isRemote: context.isRemote || layer.host !== undefined,
      localCommands: context.localCommands,
      wrapperChain: [...context.wrapperChain, layer.label],
      depth: context.depth + 1,
    }
    if (context.prescan) next.prescan = true
    const host = layer.host ?? context.targetHost
    if (host !== undefined) next.targetHost = host
    const hostRoot = layer.host !== undefined ? layer.hostRoot : context.hostRoot
    if (hostRoot !== undefined) next.hostRoot = hostRoot
    if (!layer.readsStdin) {
      if (context.stdin !== undefined) next.stdin = context.stdin
      if (context.piped) next.piped = context.piped
    }
    if (layer.chdir !== undefined) next.chdir = [...(context.chdir ?? []), layer.chdir]
    else if (context.chdir) next.chdir = context.chdir
    const inner = layer.inner
    let result: Input | void = undefined
    if ("opaque" in inner) {
      emit(walk, { ...atomBase(next, command), opaque: inner.opaque })
    } else if ("file" in inner) {
      // The wrapper opens a script argument in the directory it changes to.
      const file = inner.file.argument && next.chdir ? { ...inner.file, chdir: next.chdir } : inner.file
      emit(walk, { ...atomBase(next, command), scriptFile: file })
    } else if ("code" in inner) {
      walkCode(inner.code, inner.language, next, command, walk)
    } else if ("argv" in inner) {
      result = walkArgv(inner.argv, inner.expanded, [...assignments, ...(inner.assignments ?? [])], next, command, walk)
    } else if (inner.script.length > walk.chars) {
      stop(walk, atomBase(next, command))
    } else {
      walk.chars -= inner.script.length
      result = walkScript(tokenize(inner.script, walk.braces), next, walk, command)
    }
    if (walk.stopped) return
    if (result && SAME_SHELL.has(layer.label)) shell = result
  }
  return shell
}

function wrapperFor(name: string): Unwrapper | undefined {
  if (Object.hasOwn(WRAPPERS, name)) return WRAPPERS[name]
  return PYTHON_VERSION.test(name) ? interpreter(name, INTERPRETERS.python) : undefined
}

function quote(word: string) {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`
}

function commandFrom(label: string, args: string[], expanded: boolean[], start: number, spec: OptionSpec): Layer[] {
  const i = skipOptions(args, start, spec)
  if (i >= args.length) return []
  return [{ label, inner: { argv: args.slice(i), expanded: expanded.slice(i) } }]
}

/** Skips the options of `spec` and unwraps the rest. `skip` rejects options after which no command runs. */
function optionsThen(label: string, spec: OptionSpec, skip?: (option: ParsedOption, arg: string) => boolean): Unwrapper {
  return (args, expanded) => {
    let i = 0
    while (i < args.length) {
      if (args[i] === "--") {
        i++
        break
      }
      const option = readOption(args, i, spec)
      if (!option) break
      if (skip?.(option, args[i]!)) return []
      i = option.next
    }
    if (i >= args.length) return []
    return [{ label, inner: { argv: args.slice(i), expanded: expanded.slice(i) } }]
  }
}

/**
 * `su` / `runuser` (util-linux getopt permutes options): `-c` runs a script, arguments after the user go to
 * the shell (`su root -- -c cmd`), and `runuser -u user [--] command` runs a command.
 */
function su(name: string): Unwrapper {
  return (args, expanded, stdin, piped) => {
    let script: string | undefined
    let user = false
    let login = false
    let first: number | undefined
    const positionals: string[] = []
    let i = 0
    while (i < args.length) {
      if (args[i] === "--") {
        first ??= i + 1
        positionals.push(...args.slice(i + 1))
        break
      }
      const option = readOption(args, i, OPTION_SPECS.su)
      if (!option) {
        first ??= i
        positionals.push(args[i++]!)
        continue
      }
      if (["-c", "--command", "--session-command"].includes(option.name)) script = option.value
      if (option.name === "-u" || option.name === "--user") user = true
      if (option.name === "--login" || shortFlags(args[i]!, OPTION_SPECS.su).includes("l")) login = true
      i = option.next
    }
    if (positionals[0] === "-") {
      login = true
      positionals.shift()
    }
    const chdir = login ? null : undefined
    if (script !== undefined) return inDir([{ label: `${name} -c`, inner: { script } }], chdir)
    if (name === "runuser" && user) {
      if (first === undefined || first >= args.length) return []
      return inDir([{ label: name, inner: { argv: args.slice(first), expanded: expanded.slice(first) } }], chdir)
    }
    return inDir(shell(name)(positionals.slice(1), [], stdin, piped), chdir)
  }
}

function xargs(args: string[], expanded: boolean[]): Layer[] {
  let replace: string | undefined
  let i = 0
  while (i < args.length) {
    if (args[i] === "--") {
      i++
      break
    }
    const option = readOption(args, i, OPTION_SPECS.xargs)
    if (!option) break
    if (["-I", "-i", "--replace"].includes(option.name)) replace = option.value || "{}"
    i = option.next
  }
  if (i >= args.length) return []
  const argv = args.slice(i)
  const flags = expanded.slice(i)
  if (replace === undefined) {
    argv.push(XARGS_INPUT)
    flags.push(true)
  } else {
    for (let k = 0; k < argv.length; k++) {
      if (!argv[k]!.includes(replace)) continue
      argv[k] = argv[k]!.replaceAll(replace, XARGS_INPUT)
      flags[k] = true
    }
  }
  // GNU xargs runs commands with stdin on /dev/null.
  return [{ label: "xargs", inner: { argv, expanded: flags }, readsStdin: true }]
}

function sudo(args: string[], expanded: boolean[], stdin?: string, piped?: Piped): Layer[] {
  const spec = OPTION_SPECS.sudo
  let i = 0
  let edit = false
  let shell = false
  let chdir: string | null | undefined
  while (i < args.length) {
    const arg = args[i]!
    if (arg === "--") {
      i++
      break
    }
    const option = readOption(args, i, spec)
    if (!option) break
    if (option.name === "--edit" || shortFlags(arg, spec).includes("e")) edit = true
    if (["--shell", "--login"].includes(option.name) || /[is]/.test(shortFlags(arg, spec))) shell = true
    if (option.name === "-D" || option.name === "--chdir") chdir = option.value ?? ""
    if (option.name === "--login" || shortFlags(arg, spec).includes("i")) chdir = null
    i = option.next
  }
  const assignments: string[] = []
  while (i < args.length && ASSIGNMENT.test(args[i]!)) assignments.push(args[i++]!)
  if (i >= args.length) return shell ? inDir(stdinLayers("sudo -s", stdin, piped), chdir) : []
  if (edit) return [{ label: "sudo", inner: { argv: ["sudoedit", ...args.slice(i)], expanded: [false, ...expanded.slice(i)] } }]
  return inDir([{ label: "sudo", inner: { argv: args.slice(i), expanded: expanded.slice(i), assignments } }], chdir)
}

function env(args: string[], expanded: boolean[]): Layer[] {
  const spec = OPTION_SPECS.env
  let i = 0
  let split: string | undefined
  let chdir: string | undefined
  while (i < args.length) {
    const arg = args[i]!
    if (arg === "--") {
      i++
      break
    }
    if (arg === "-") {
      i++
      continue
    }
    const option = readOption(args, i, spec)
    if (!option) break
    if (option.name === "-S" || option.name === "--split-string") split = option.value
    if (option.name === "-C" || option.name === "--chdir") chdir = option.value ?? ""
    i = option.next
  }
  if (split !== undefined) return inDir([{ label: "env", inner: { script: [split, ...args.slice(i).map(quote)].join(" ") } }], chdir)
  const assignments: string[] = []
  while (i < args.length && ASSIGNMENT.test(args[i]!)) assignments.push(args[i++]!)
  if (i >= args.length) return []
  return inDir([{ label: "env", inner: { argv: args.slice(i), expanded: expanded.slice(i), assignments } }], chdir)
}

function timeout(args: string[], expanded: boolean[]): Layer[] {
  const duration = skipOptions(args, 0, OPTION_SPECS.timeout)
  return commandFrom("timeout", args, expanded, duration + 1, OPTION_SPECS.nohup)
}

function inDir(layers: Layer[], chdir: string | null | undefined): Layer[] {
  return chdir === undefined ? layers : layers.map((layer) => ({ ...layer, chdir }))
}

function stdinScript(label: string, script: string, host?: string): Layer {
  const layer: Layer = { label, inner: { script }, readsStdin: true }
  if (host !== undefined) layer.host = host
  return layer
}

function opaqueLayer(label: string, host?: string, reason: OpaqueReason = "piped-script"): Layer {
  const layer: Layer = { label, inner: { opaque: reason }, readsStdin: true }
  if (host !== undefined) layer.host = host
  return layer
}

/** Layers of a wrapper that runs its stdin as a script: the inline text, a local file, or an opaque pipe. */
function stdinLayers(label: string, stdin: string | undefined, piped: Piped | undefined, host?: string): Layer[] {
  if (stdin !== undefined) return [stdinScript(label, stdin, host)]
  if (typeof piped === "object") {
    const layer: Layer = { label, inner: { file: piped }, readsStdin: true }
    if (host !== undefined) layer.host = host
    return [layer]
  }
  return piped ? [opaqueLayer(label, host)] : []
}

/** `<(...)` passed as a script file. */
function isProcessSubstitution(arg: string | undefined, expanded: boolean | undefined) {
  return !!expanded && !!arg?.startsWith("<(")
}

function shell(name: string): Unwrapper {
  return (args, expanded, stdin, piped) => {
    let i = 0
    let command = false
    let fromStdin = false
    while (i < args.length) {
      const arg = args[i]!
      if (arg === "--" || arg === "-") {
        i++
        break
      }
      if (arg.startsWith("--")) {
        i += OPTION_SPECS.shell.longValue.has(arg.slice(2)) ? 2 : 1
        continue
      }
      if (!/^[-+]./.test(arg)) break
      let values = 0
      for (const c of arg.slice(1)) {
        if (c === "c") command = true
        else if (c === "s") fromStdin = true
        else if (c === "o" || c === "O") values++
      }
      i += 1 + values
    }
    const script = args[i]
    if (command) return script === undefined ? [] : [{ label: `${name} -c`, inner: { script } }]
    const file = script === undefined ? "stdin" : scriptFile(script, expanded[i])
    if (file === "opaque") return [opaqueLayer(name)]
    if (fromStdin || file === "stdin") return stdinLayers(`${name} -s`, stdin, piped)
    const layers = [argumentLayer(name, script!, piped)]
    if (file === "dynamic") layers.push(...stdinLayers(`${name} -s`, stdin, piped))
    return layers
  }
}

/** A local script file passed as an argument; the script inherits the stdin of the wrapper. */
function argumentLayer(label: string, path: string, piped: Piped | undefined, language?: Language): Layer {
  const file: ScriptFile = { path, argument: true }
  if (language) file.language = language
  if (piped) file.piped = piped
  return { label, inner: { file }, keep: true }
}

function sshHost(destination: string) {
  const uri = destination.startsWith("ssh://")
  let host = uri ? destination.slice("ssh://".length) : destination
  host = host.slice(host.lastIndexOf("@") + 1)
  if (uri) host = host.replace(/\/.*$/, "").replace(/:\d+$/, "")
  return host.replace(/^\[(.*)\]$/, "$1")
}

function ssh(args: string[], _: boolean[], stdin?: string, piped?: Piped): Layer[] {
  const layers: Layer[] = []
  let destination: string | undefined
  let remoteCommand: string | undefined
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === "--") {
      i++
      if (destination === undefined) destination = args[i++]
      break
    }
    const option = readOption(args, i, OPTION_SPECS.ssh)
    if (option) {
      const match = option.name === "-o" ? /^\s*(\w+)\s*[=\s]\s*(.*)$/s.exec(option.value ?? "") : null
      if (match) {
        const key = match[1]!
        const value = match[2]!
        const lower = key.toLowerCase()
        if (lower === "proxycommand" || lower === "localcommand") layers.push({ label: `ssh -o ${key}`, inner: { script: value } })
        if (lower === "remotecommand") remoteCommand = value
      }
      i = option.next
      continue
    }
    if (destination !== undefined) break
    destination = arg
    i++
  }
  if (destination === undefined) return layers
  const script = i < args.length ? args.slice(i).join(" ") : remoteCommand
  if (script !== undefined) layers.push({ label: "ssh", host: sshHost(destination), inner: { script } })
  else layers.push(...stdinLayers("ssh", stdin, piped, sshHost(destination)))
  return layers
}

/** `kubectl exec`, `kubectl debug` and `oc rsh`; `oc` and `kubecolor` take the same arguments. */
function kubectl(name: string): Unwrapper {
  return (args, expanded) => {
    const positionals: number[] = []
    let i = 0
    while (i < args.length && args[i] !== "--") {
      const option = readOption(args, i, OPTION_SPECS.kubectl)
      if (option) i = option.next
      else positionals.push(i++)
    }
    const [sub, target, command] = positionals
    if (sub !== undefined && args[sub] === "rsh") return rsh(name, args, expanded, sub + 1)
    // `kubectl debug target... -- command` runs in a debug container of a pod, or on a node (`node/x`), where the
    // root filesystem of the node is mounted at `/host`.
    if (sub !== undefined && args[sub] === "debug" && target !== undefined && i + 1 < args.length) {
      const targets = positionals.slice(1).map((k) => args[k]!)
      const inner = { argv: args.slice(i + 1), expanded: expanded.slice(i + 1) }
      const layer: Layer = { label: `${name} debug`, host: targets.join(","), inner }
      if (targets.some((arg) => /^(nodes?|no)\//i.test(arg))) layer.hostRoot = "/host"
      return [layer]
    }
    if (sub === undefined || args[sub] !== "exec" || target === undefined) return []
    const start = i < args.length ? i + 1 : command
    if (start === undefined || start >= args.length) return []
    return [{ label: `${name} exec`, host: args[target], inner: { argv: args.slice(start), expanded: expanded.slice(start) } }]
  }
}

/**
 * `oc rsh [options] pod command...`: options end at the pod, and the rest is the command. With `-f file` there is
 * no pod argument. Without a command it opens an interactive shell.
 */
function rsh(name: string, args: string[], expanded: boolean[], i: number): Layer[] {
  let file: string | undefined
  for (let option; (option = readOption(args, i, OPTION_SPECS.kubectl)); i = option.next) {
    if (option.name === "-f" || option.name === "--filename") file = option.value
  }
  const start = file === undefined ? i + 1 : i
  if (start >= args.length) return []
  const host = file ?? args[i]!
  return [{ label: `${name} rsh`, host, inner: { argv: args.slice(start), expanded: expanded.slice(start) } }]
}

/**
 * `docker` / `nerdctl` / `podman` / `crictl` `[container] exec [options] container command...`. With one of the
 * `select` options (`podman exec -l`, `crictl exec --name x`), containers are selected without a container argument.
 */
function containerExec(name: string, global: OptionSpec, exec: OptionSpec, select?: ReadonlySet<string>): Unwrapper {
  return (args, expanded) => {
    let i = skipOptions(args, 0, global)
    if (args[i] === "container") i++
    if (args[i] !== "exec") return []
    let selected = false
    for (i++; i < args.length; ) {
      if (args[i] === "--") {
        i++
        break
      }
      const option = readOption(args, i, exec)
      if (!option) break
      if (select && optionNames(args[i]!, option, exec).some((option) => select.has(option))) selected = true
      i = option.next
    }
    const container = selected ? "(selected)" : args[i]
    const start = selected ? i : i + 1
    if (container === undefined || start >= args.length) return []
    return [{ label: `${name} exec`, host: container, inner: { argv: args.slice(start), expanded: expanded.slice(start) } }]
  }
}

/** Every option `arg` sets: `--name`, or `-x` for each letter of a short option cluster. */
function optionNames(arg: string, option: ParsedOption, spec: OptionSpec): string[] {
  if (option.name.startsWith("--")) return [option.name]
  const letters = [...shortFlags(arg, spec)]
  if (option.name.length === 2) letters.push(option.name.charAt(1))
  return letters.map((c) => `-${c}`)
}

const FIND_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"])

/** Every `-exec` / `-execdir` / `-ok` / `-okdir` action, ended by `;` or by `{} +`. */
function find(args: string[], expanded: boolean[]): Layer[] {
  const layers: Layer[] = []
  for (let i = 0; i < args.length; i++) {
    const action = args[i]!
    if (!FIND_ACTIONS.has(action)) continue
    let end = i + 1
    while (end < args.length && args[end] !== ";" && !(args[end] === "+" && args[end - 1] === "{}")) end++
    if (end >= args.length) break
    const words = args.slice(i + 1, end)
    if (words.length) {
      const argv = words.map((word) => word.replaceAll("{}", FIND_PATH))
      const flags = words.map((word, k) => expanded[i + 1 + k]! || word.includes("{}"))
      const layer: Layer = { label: `find ${action}`, inner: { argv, expanded: flags } }
      if (action.endsWith("dir")) layer.chdir = null
      layers.push(layer)
    }
    i = end
  }
  return layers
}

/**
 * Ad-hoc `ansible <pattern> -m shell|command|raw -a <args>`; other modules are not unwrapped. The args are a JSON
 * object or free-form text, parsed as ansible does; Jinja2 templates in them are opaque.
 */
function ansible(args: string[]): Layer[] {
  let pattern: string | undefined
  let module = "command"
  let text: string | undefined
  for (let i = 0; i < args.length; ) {
    if (args[i] === "--") {
      pattern ??= args[i + 1]
      break
    }
    const option = readOption(args, i, OPTION_SPECS.ansible)
    if (!option) {
      pattern ??= args[i]
      i++
      continue
    }
    if (option.name === "-m" || option.name === "--module-name") module = option.value ?? ""
    if (option.name === "-a" || option.name === "--args") text = option.value
    i = option.next
  }
  const short = module.replace(/^ansible\.(builtin|legacy)\./, "")
  if (pattern === undefined || !text || !["command", "shell", "raw"].includes(short)) return []
  const label = `ansible -m ${module}`
  const opaque = [opaqueLayer(label, pattern, "dynamic-args")]
  if (JINJA.test(text)) return opaque
  // Python's `json` also accepts input that JSON.parse rejects (`NaN`), so a parse failure is opaque.
  const json = text.startsWith("{") && text.endsWith("}") ? jsonObject(text) : {}
  if (!json) return opaque
  const params = Object.keys(json).length ? json : ansibleKv(text)
  return params ? ansibleLayers(label, pattern, params) : opaque
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

// `key=value` words that `parse_kv` takes out of the free-form args of command modules.
const ANSIBLE_RAW_KEYS = new Set([
  "creates",
  "removes",
  "chdir",
  "executable",
  "warn",
  "stdin",
  "stdin_add_newline",
  "strip_empty_ends",
])
const ANSIBLE_ESCAPE = /\\(U[0-9a-fA-F]{8}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|N\{[^}]+\}|[\\'"abfnrtv])/g
const ESCAPED: Record<string, string> = {
  "\\": "\\",
  "'": "'",
  '"': '"',
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
}
const JINJA = /\{[{%#]/

/** Ansible `parse_kv` with `check_raw`; undefined when the args cannot be parsed statically. */
function ansibleKv(text: string): Record<string, unknown> | undefined {
  const words = ansibleSplit(text)
  if (!words) return undefined
  const params: Record<string, unknown> = {}
  const raw: string[] = []
  for (const word of words) {
    const decoded = ansibleDecode(word)
    if (decoded === undefined) return undefined
    let eq = decoded.indexOf("=", 1)
    while (eq > 0 && decoded[eq - 1] === "\\") eq = decoded.indexOf("=", eq + 1)
    if (!decoded.includes("=")) raw.push(word)
    else if (eq < 0) raw.push(decoded.replaceAll("\\=", "="))
    else if (!ANSIBLE_RAW_KEYS.has(decoded.slice(0, eq))) raw.push(word)
    else params[decoded.slice(0, eq).trim()] = ansibleUnquote(decoded.slice(eq + 1).trim())
  }
  if (raw.length) params._raw_params = raw.reduce((all, word) => (!all || all.endsWith("\n") ? all + word : `${all} ${word}`), "")
  return params
}

/** Ansible `split_args` without Jinja2 blocks: words split on spaces outside quotes, line breaks kept on words. */
function ansibleSplit(text: string): string[] | undefined {
  const words: string[] = []
  const append = (suffix: string) => {
    if (!words.length) words.push("")
    words[words.length - 1] += suffix
  }
  let quoteChar: string | undefined
  const lines = text.split("\n")
  for (const [l, line] of lines.entries()) {
    let continuation = false
    for (const [k, token] of line.split(" ").entries()) {
      if (!token && k) {
        append(" ")
        continue
      }
      if (token === "\\" && quoteChar === undefined) {
        continuation = true
        continue
      }
      const wasQuoted = quoteChar !== undefined
      for (let c = 0; c < token.length; c++) {
        const char = token[c]
        if ((char !== '"' && char !== "'") || token[c - 1] === "\\") continue
        if (quoteChar === undefined) quoteChar = char
        else if (char === quoteChar) quoteChar = undefined
      }
      if (quoteChar !== undefined && !wasQuoted) words.push(token)
      else if (quoteChar !== undefined || wasQuoted) append((k ? " " : "") + token)
      else if (token) words.push(token)
    }
    if (l < lines.length - 1 && !continuation) append("\n")
  }
  return quoteChar === undefined ? words : undefined
}

/** Python escape sequences decoded by `parse_kv`; undefined for `\N{name}`, which needs the Unicode name table. */
function ansibleDecode(word: string): string | undefined {
  let failed = false
  const decoded = word.replace(ANSIBLE_ESCAPE, (_, escape: string) => {
    if (escape.length === 1) return ESCAPED[escape]!
    const code = escape[0] === "N" ? NaN : parseInt(escape.slice(1), 16)
    if (!(code <= 0x10ffff)) failed = true
    return failed ? "" : String.fromCodePoint(code)
  })
  return failed ? undefined : decoded
}

function ansibleUnquote(value: string): string {
  const quoted = value.length > 1 && value[0] === value.at(-1) && `"'`.includes(value[0]!) && value.at(-2) !== "\\"
  return quoted ? value.slice(1, -1) : value
}

/** The command of `shell` / `command` / `raw` module params, run with their `chdir` and `stdin`. */
function ansibleLayers(label: string, host: string, params: Record<string, unknown>): Layer[] {
  const opaque = [opaqueLayer(label, host, "dynamic-args")]
  const text = (value: unknown) =>
    typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined
  const fields: Record<string, string> = {}
  for (const key of ["_raw_params", "cmd", "chdir", "stdin", "executable"]) {
    if (params[key] === undefined || params[key] === null) continue
    const value = text(params[key])
    if (value === undefined) return opaque
    fields[key] = value
  }
  let script = fields._raw_params ?? fields.cmd
  if (script === undefined && params.argv !== undefined && params.argv !== null) {
    const argv = Array.isArray(params.argv) ? params.argv.map(text) : [undefined]
    if (argv.some((word) => word === undefined)) return opaque
    script = argv.map((word) => quote(word!)).join(" ")
  }
  if (script === undefined) return []
  const { chdir, stdin, executable } = fields
  if ([script, chdir, stdin, executable].some((value) => value !== undefined && JINJA.test(value))) return opaque
  // `executable` replaces `/bin/sh` of the shell and raw modules, e.g. with an interpreter for another language.
  if (executable !== undefined && !SHELLS.includes(normalizeName(executable))) return opaque
  // `stdin` feeds the whole command, as for `sh -c script <<EOF`.
  if (stdin !== undefined) {
    let delimiter = "ANSIBLE_STDIN"
    while (stdin.split("\n").includes(delimiter)) delimiter += "_"
    script = `sh -c ${quote(script)} <<'${delimiter}'\n${stdin}\n${delimiter}`
  }
  const layer: Layer = { label, host, inner: { script } }
  if (chdir !== undefined) layer.chdir = chdir
  return [layer]
}

/** A command run on many hosts; without a command, `pdsh` / `clush` read commands from stdin. */
function fanOut(label: string, host: string, command: string[], stdin?: string, piped?: Piped): Layer[] {
  if (command.length) return [{ label, host, inner: { script: command.join(" ") } }]
  return stdinLayers(label, stdin, piped, host)
}

function pdsh(args: string[], _: boolean[], stdin?: string, piped?: Piped): Layer[] {
  let nodes: string | undefined
  let group: string | undefined
  let i = 0
  while (i < args.length) {
    if (args[i] === "--") {
      i++
      break
    }
    const option = readOption(args, i, OPTION_SPECS.pdsh)
    if (!option) break
    if (option.name === "-w") nodes = option.value
    if (option.name === "-g") group = option.value
    i = option.next
  }
  return fanOut("pdsh", nodes ?? (group === undefined ? "*" : `@${group}`), args.slice(i), stdin, piped)
}

function pssh(name: string): Unwrapper {
  return (args) => {
    let host = "*"
    let i = 0
    while (i < args.length) {
      if (args[i] === "--") {
        i++
        break
      }
      const option = readOption(args, i, OPTION_SPECS.pssh)
      if (!option) break
      if (option.name === "-H" || option.name === "--host") host = option.value ?? host
      i = option.next
    }
    return fanOut(name, host, args.slice(i))
  }
}

function clush(args: string[], _: boolean[], stdin?: string, piped?: Piped): Layer[] {
  const spec = OPTION_SPECS.clush
  let nodes: string | undefined
  let group: string | undefined
  let i = 0
  while (i < args.length) {
    if (args[i] === "--") {
      i++
      break
    }
    const option = readOption(args, i, spec)
    if (!option) break
    // `-c` / `--copy` / `--rcopy` copy files instead of running a command.
    if (option.name === "--copy" || option.name === "--rcopy" || shortFlags(args[i]!, spec).includes("c")) return []
    if (option.name === "-w") nodes = option.value
    if (option.name === "-g" || option.name === "--group") group = option.value
    i = option.next
  }
  const host = nodes ?? (group === undefined ? "*" : `@${group.replace(/^@/, "")}`)
  return fanOut("clush", host, args.slice(i), stdin, piped)
}

/** `chroot [options] newroot [command...]` runs in `/` of the new root; without a command it runs a shell. */
function chroot(args: string[], expanded: boolean[], stdin?: string, piped?: Piped): Layer[] {
  let skip = false
  let i = 0
  while (i < args.length) {
    if (args[i] === "--") {
      i++
      break
    }
    const option = readOption(args, i, OPTION_SPECS.chroot)
    if (!option) break
    if (option.name === "--skip-chdir") skip = true
    i = option.next
  }
  if (i >= args.length) return []
  const start = i + 1
  const layers: Layer[] =
    start < args.length
      ? [{ label: "chroot", inner: { argv: args.slice(start), expanded: expanded.slice(start) } }]
      : shell("chroot")([], [], stdin, piped)
  return inDir(layers, skip ? undefined : "/")
}

/**
 * `nsenter [options] [command...]`; without a command it runs a shell. Entering a mount namespace (`-m`, or `-a`
 * for all namespaces) moves to its root unless `-w` / `-W` sets the directory.
 */
function nsenter(args: string[], expanded: boolean[], stdin?: string, piped?: Piped): Layer[] {
  const spec = OPTION_SPECS.nsenter
  let mount = false
  let wd: string | null | undefined
  let i = 0
  while (i < args.length) {
    if (args[i] === "--") {
      i++
      break
    }
    const option = readOption(args, i, spec)
    if (!option) break
    const names = optionNames(args[i]!, option, spec)
    if (["-m", "--mount", "-a", "--all"].some((name) => names.includes(name))) mount = true
    if (["-w", "-W", "--wd", "--wdns"].includes(option.name)) wd = option.value || null
    i = option.next
  }
  const layers: Layer[] =
    i < args.length
      ? [{ label: "nsenter", inner: { argv: args.slice(i), expanded: expanded.slice(i) } }]
      : shell("nsenter")([], [], stdin, piped)
  return inDir(layers, wd !== undefined ? wd : mount ? "/" : undefined)
}

/** `unshare [options] [command...]`; without a command it runs a shell. `-R` moves to the new root unless `-w` is given. */
function unshare(args: string[], expanded: boolean[], stdin?: string, piped?: Piped): Layer[] {
  let root = false
  let wd: string | undefined
  let i = 0
  while (i < args.length) {
    if (args[i] === "--") {
      i++
      break
    }
    const option = readOption(args, i, OPTION_SPECS.unshare)
    if (!option) break
    if (option.name === "-R" || option.name === "--root") root = true
    if (option.name === "-w" || option.name === "--wd") wd = option.value ?? ""
    i = option.next
  }
  const layers: Layer[] =
    i < args.length
      ? [{ label: "unshare", inner: { argv: args.slice(i), expanded: expanded.slice(i) } }]
      : shell("unshare")([], [], stdin, piped)
  return inDir(layers, wd ?? (root ? "/" : undefined))
}

/**
 * `systemd-run [options] command...` runs the command in a transient unit: on another host with `-H`, in a container
 * with `-M`, and in `/` (the home directory with `--user`) unless `--scope` or `--same-dir` keeps the directory.
 * `--shell` runs a shell instead of a command.
 */
function systemdRun(args: string[], expanded: boolean[], stdin?: string, piped?: Piped): Layer[] {
  const spec = OPTION_SPECS.systemdRun
  let host: string | undefined
  let same = false
  let user = false
  let runShell = false
  let wd: string | null | undefined
  let i = 0
  while (i < args.length) {
    if (args[i] === "--") {
      i++
      break
    }
    const option = readOption(args, i, spec)
    if (!option) break
    const names = optionNames(args[i]!, option, spec)
    const value = option.value ?? ""
    if (option.name === "-H" || option.name === "--host") host = sshHost(value)
    // `.host` and an empty machine name are the local host.
    if ((option.name === "-M" || option.name === "--machine") && !/^([^@]*@)?(\.host)?$/.test(value)) {
      host = value.slice(value.indexOf("@") + 1)
    }
    if (["--scope", "-d", "--same-dir"].some((name) => names.includes(name))) same = true
    if (names.includes("-S") || names.includes("--shell")) runShell = true
    if (names.includes("--user")) user = true
    if (option.name === "--working-directory") wd = value
    if ((option.name === "-p" || option.name === "--property") && value.startsWith("WorkingDirectory=")) wd = null
    i = option.next
  }
  let layers: Layer[]
  if (i < args.length) {
    const layer: Layer = { label: "systemd-run", inner: { argv: args.slice(i), expanded: expanded.slice(i) } }
    if (host !== undefined) layer.host = host
    layers = [layer]
  } else if (runShell) {
    return stdinLayers("systemd-run", stdin, piped, host)
  } else {
    return []
  }
  if (host !== undefined) return layers
  return inDir(layers, wd !== undefined ? wd : same ? undefined : user ? null : "/")
}

/** `ip` options that take a value, with the shortest prefix iproute2 accepts for each. */
const IP_VALUE_OPTIONS: [string, number][] = [["-loops", 2], ["-family", 2], ["-batch", 2], ["-rcvbuf", 3], ["-netns", 2]]

/**
 * `ip [options] netns exec <name> command...`, `ip -all netns exec command...` and `ip [options] vrf exec <vrf>
 * command...` run a command on this host. iproute2 accepts prefixes of options, objects and `exec`.
 */
function ip(args: string[], expanded: boolean[]): Layer[] {
  const prefix = (word: string, name: string, min = 1) => word.length >= min && name.startsWith(word)
  let all = false
  let i = 0
  for (; i < args.length && args[i]!.startsWith("-"); i++) {
    if (args[i] === "--") {
      i++
      break
    }
    const option = args[i]!.replace(/^--/, "-")
    if (prefix(option, "-all", 2)) all = true
    if (IP_VALUE_OPTIONS.some(([name, min]) => prefix(option, name, min))) i++
  }
  const object = args[i] ?? ""
  if (!prefix(args[i + 1] ?? "", "exec")) return []
  let label: string
  let start: number
  if (prefix(object, "netns", 3)) [label, start] = ["ip netns exec", all ? i + 2 : i + 3]
  else if (prefix(object, "vrf")) [label, start] = ["ip vrf exec", i + 3]
  else return []
  if (start >= args.length) return []
  return [{ label, inner: { argv: args.slice(start), expanded: expanded.slice(start) } }]
}

/** `k3s` / `k0s` / `microk8s` run their bundled `kubectl` and other CLIs: `k3s kubectl delete ns x`. */
function bundled(label: string, names: readonly string[]): Unwrapper {
  return (args, expanded) => (names.includes(args[0] ?? "") ? [{ label, inner: { argv: args, expanded } }] : [])
}

const MICROK8S_TOOLS = ["kubectl", "ctr", "helm", "helm3"]

/** A command that runs `tool` with its own arguments. */
function alias(label: string, tool: string): Unwrapper {
  return (args, expanded) => [{ label, inner: { argv: [tool, ...args], expanded: [false, ...expanded] } }]
}

/** `flock [options] file command...` or `flock [options] file -c command`; `flock fd` runs nothing. */
function flock(args: string[], expanded: boolean[]): Layer[] {
  const start = skipOptions(args, 0, OPTION_SPECS.flock) + 1
  if (start >= args.length) return []
  if (args[start] !== "-c" && args[start] !== "--command") {
    return [{ label: "flock", inner: { argv: args.slice(start), expanded: expanded.slice(start) } }]
  }
  const script = args[start + 1]
  return script === undefined ? [] : [{ label: "flock -c", inner: { script } }]
}

/** `watch` runs its joined arguments with `sh -c`, or the arguments themselves with `-x`. */
function watch(args: string[], expanded: boolean[]): Layer[] {
  const spec = OPTION_SPECS.watch
  let exec = false
  let i = 0
  while (i < args.length) {
    if (args[i] === "--") {
      i++
      break
    }
    const option = readOption(args, i, spec)
    if (!option) break
    if (option.name === "--exec" || shortFlags(args[i]!, spec).includes("x")) exec = true
    i = option.next
  }
  if (i >= args.length) return []
  if (exec) return [{ label: "watch", inner: { argv: args.slice(i), expanded: expanded.slice(i) } }]
  return [{ label: "watch", inner: { script: args.slice(i).join(" ") } }]
}

// The default replacement strings of `parallel` besides `{}`, with the part of the input each stands for.
const REPLACEMENTS: [string, string][] = [
  ["{//}", "//"],
  ["{/.}", "/."],
  ["{/}", "/"],
  ["{.}", "."],
  ["{#}", "#"],
  ["{%}", "%"],
]
// Options that rename or add replacement strings, which may turn the input into any text.
const PARALLEL_RENAMES = new Set(
  "--rpl --plus --parens --er --extensionreplace --bnr --basenamereplace --dnr --dirnamereplace --bner --basenameextensionreplace --seqreplace --slotreplace --header".split(
    " ",
  ),
)
// Options that change the text of the values: columns, other separators, trimming.
const PARALLEL_SPLITS = new Set("-C --colsep --col-sep --csv -d --delimiter --null --trim".split(" "))
// Options that put several values in one job, besides `-m` and `-X`.
const PARALLEL_GROUPS = new Set("-L -l --max-lines --maxlines --xargs".split(" "))
// A command word split into text and replacement strings; `position` is that of a positional one (`{2}`).
type Template = (string | { op: string; position?: string })[]
/**
 * The values a job's replacement strings stand for: unknown, one `value` that positions name when the job has
 * `size` values (all positions without a size), or all `values`, joined.
 */
type JobInput = { value?: string; values?: string[]; seq?: number; size?: number }

/**
 * GNU `parallel`: the command words are joined and run by a shell once per input value. Values are the lines of
 * `:::` arguments or of stdin; `::::` files, `-a`, piped stdin, dynamic values and options that split values
 * make them unknown. Several sources and options that put several values in one job group them.
 */
function parallel(argv: string[], expanded: boolean[], stdin?: string, piped?: Piped): Layer[] {
  const spec = OPTION_SPECS.parallel
  const args = [...argv]
  let host: string | undefined
  let replaceI: string | undefined
  let replaceLower: string | undefined
  let chdir: string | null | undefined
  let argSep = ":::"
  let fileSep = "::::"
  let quoteWords = false
  let pipe = false
  let source = false
  let unknown = false
  let grouped = false
  let maxArgs: string | undefined
  let maxReplaceArgs: string | undefined
  let maxLines: string | undefined
  let renamed = false
  const isFile = (word: string) => word === fileSep || word === `${fileSep}+`
  const isSource = (word: string) => word === argSep || word === `${argSep}+` || isFile(word)
  let i = 0
  while (i < args.length && !isSource(args[i]!)) {
    if (args[i] === "--") {
      i++
      break
    }
    const option = readOption(args, i, spec)
    if (!option) break
    const { name, value } = option
    const flags = shortFlags(args[i]!, spec)
    if (name === "-S" || name === "--sshlogin") host = value === ":" ? host : (value ?? "*")
    if (name === "--sshloginfile" || name === "--slf") host = "*"
    if (name === "-I") replaceI = value
    if (name === "-i" || name === "--replace") replaceLower = value
    if (name === "-a" || name === "--arg-file" || name === "--argfile") source = unknown = true
    if (PARALLEL_RENAMES.has(name)) renamed = true
    if (PARALLEL_SPLITS.has(name) || flags.includes("0")) unknown = true
    if (PARALLEL_GROUPS.has(name) || /[mX]/.test(flags)) grouped = true
    if (name === "-n" || name === "--max-args" || name === "--maxargs") maxArgs = value
    if (name === "-N" || name === "--max-replace-args" || name === "--maxreplaceargs") maxReplaceArgs = value
    if (name === "-L") maxLines = value
    if (name === "--arg-sep" || name === "--argsep") argSep = value ?? argSep
    if (name === "--arg-file-sep" || name === "--argfilesep") fileSep = value ?? fileSep
    // `--wd ...` is a new temporary directory.
    if (name === "--work-dir" || name === "--workdir" || name === "--wd") chdir = value === "..." ? null : value
    if (name === "--quote" || name === "-q" || flags.includes("q")) quoteWords = true
    if (["--pipe", "--spreadstdin", "--pipe-part", "--pipepart"].includes(name)) pipe = true
    if (option.rest) args[i] = option.rest
    else i = option.next
  }
  let end = i
  while (end < args.length && !isSource(args[end]!)) end++
  const words = args.slice(i, end)
  const command = words.map((word) => (quoteWords ? parallelQuote(word) : word)).join(" ")
  // `-I` and a `-i` value Perl treats as true both rename `{}`.
  const keys = [replaceI, replaceLower !== "0" ? replaceLower : undefined].filter((key): key is string => !!key)
  const inputs = keys.length ? keys : ["{}"]
  // An empty replacement string makes parallel loop forever, a `(...)` in one is a regex, and a word with an
  // unclosed `{=` is joined to the next ones.
  if (renamed || replaceI === "" || keys.some((key) => /\(.*\)/s.test(key)) || words.slice(0, -1).some(unclosedPerl)) {
    return [opaqueLayer("parallel", host, "dynamic-args")]
  }
  // The work dir may contain replacement strings too.
  if (chdir && replacements(chdir, inputs).some((part) => typeof part !== "string")) chdir = null
  const layer = (inner: Inner): Layer => {
    // Jobs read stdin only with `--pipe`.
    const result: Layer = { label: "parallel", inner, readsStdin: !pipe }
    if (host !== undefined) result.host = host
    if (chdir !== undefined) result.chdir = chdir
    return result
  }
  if (pipe) return command ? [layer({ script: command })] : []
  const values: string[] = []
  let fromFile = false
  let sources = 0
  for (let k = end; k < args.length; k++) {
    if (isSource(args[k]!)) {
      source = true
      sources++
      fromFile = isFile(args[k]!)
    } else if (fromFile || (command && expanded[k])) unknown = true
    // `parallel` reads the arguments back as lines.
    else values.push(...args[k]!.split("\n"))
  }
  // `-N` overrides `-n`, and `-n 0` runs each job without values.
  const count = parallelCount(maxReplaceArgs ?? maxArgs)
  const none = count === 0 || Number.isNaN(count) || [0, NaN].includes(parallelCount(maxLines)!)
  if (sources > 1 || (count !== undefined && count > 1) || Number.isNaN(count)) grouped = true
  if (!source) {
    if (stdin !== undefined) values.push(...(stdin ? stdin.replace(/\n$/, "").split("\n") : []))
    else if (!command) return piped ? [opaqueLayer("parallel", host)] : []
    else unknown = true
  }
  if (!command) {
    return unknown || grouped ? [opaqueLayer("parallel", host, "dynamic-args")] : values.map((script) => layer({ script }))
  }
  const templates = words.map((word) => replacements(word, inputs))
  const parts = templates.flat().filter((part) => typeof part !== "string").length
  const lead = templates[0]!.findIndex((part) => typeof part !== "string")
  // A replacement string in the first word, after no blank or `=`, leaves the values unquoted.
  const quoted = quoteWords || lead < 0 || /[ \t\n=]/.test(templates[0]!.slice(0, lead).join(""))
  const job = (input: JobInput) => {
    if (parts) return withInput(templates, quoteWords, quoted, input)
    if (input.size === 0) return command
    const { value, values } = input
    return `${command} ${values ? values.map(parallelQuote).join(" ") : value === undefined ? PARALLEL_INPUT : parallelQuote(value)}`
  }
  // Unquoted values grouped in one job may form any command.
  if (unknown || (grouped && !quoted) || values.length > MAX_PARALLEL_VALUES) return [layer({ script: job({}) })]
  if (!values.length) return []
  const one = values.map((value, k) => ({ value, seq: k + 1, size: 1 }))
  // A job holds one or more of the values, in any order: each value at every position, each value alone, and
  // all values at once.
  const jobs: JobInput[] = grouped
    ? [...values.map((value, k) => ({ value, seq: k + 1 })), ...one, { values, seq: 1 }]
    : none
      ? []
      : one
  if (none) jobs.push(...values.map((_, k) => ({ value: "", seq: k + 1, size: 0 })))
  const length = (value: string) => parallelQuote(value).length + 20
  const text = templates.flat().reduce<number>((n, part) => n + (typeof part === "string" ? part.length : 0), words.length)
  const size = jobs.reduce((n, { value = "", values = [value] }) => {
    return n + text + Math.max(parts, 1) * values.reduce((m, value) => m + length(value), 0)
  }, 0)
  if ((quoteWords ? 4 : 1) * size > MAX_CHARS) return [opaqueLayer("parallel", host, "too-long")]
  return [...new Set(jobs.map(job))].map((script) => layer({ script }))
}

/**
 * A `parallel` count, which is a Perl expression: digits are a number, a blank one means unset (one value per
 * job) and others may be anything, 0 included.
 */
function parallelCount(value: string | undefined): number | undefined {
  if (value === undefined || /^\s*\+?\d+\s*$/.test(value)) return value === undefined ? undefined : Number(value)
  return value.trim() ? NaN : 1
}

/**
 * Splits a `parallel` command word at its replacement strings the way `parallel` does: first the shortest
 * `{= perl =}` expressions, then the other strings from the longest, each also in its positional form
 * (`{1}`, `{-1 /}`) when it starts with `{`.
 */
function replacements(word: string, inputs: string[]): Template {
  let parts: Template = splitPerl(word)
  const table = new Map(REPLACEMENTS)
  for (const input of inputs) table.set(input, "")
  for (const [key, op] of [...table].sort((a, b) => b[0].length - a[0].length)) {
    const literal = key.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
    const patterns = [new RegExp(literal, "g")]
    // Perl's `\s` on argument bytes is ASCII.
    if (key.startsWith("{")) patterns.push(new RegExp(`\\{(-?\\d+)[ \\t\\n\\v\\f\\r]*${literal.slice(2)}`, "g"))
    for (const pattern of patterns) {
      parts = parts.flatMap((part) => {
        if (typeof part !== "string") return [part]
        const split: Template = []
        let from = 0
        for (const match of part.matchAll(pattern)) {
          split.push(part.slice(from, match.index), match[1] === undefined ? { op } : { op, position: match[1] })
          from = match.index + match[0].length
        }
        split.push(part.slice(from))
        return split
      })
    }
  }
  return parts
}

/** The `parallel` command line of the word templates for a job; `-q` quotes whole words. */
function withInput(templates: Template[], quoteWords: boolean, quoted: boolean, input: JobInput): string {
  const { value, values, seq, size } = input
  const text = (value: string, op: string) => {
    const text = op === "#" ? String(seq) : pathPart(value, op)
    return quoted ? parallelQuote(text) : text
  }
  const render = (part: Template[number]) => {
    if (typeof part === "string") return quoteWords && part ? parallelQuote(part) : part
    // `{= perl =}` and the job slot `{%}` are computed at run time.
    if ((value === undefined && !values) || part.op === "=" || part.op === "%") {
      return quoteWords ? `"${PARALLEL_INPUT}"` : PARALLEL_INPUT
    }
    if (values) return values.map((value) => text(value, part.op)).join(" ")
    if (part.position !== undefined && !namesValue(part.position, size)) return ""
    return text(value!, part.op)
  }
  return templates.map((template) => template.map(render).join("") || (quoteWords ? "''" : "")).join(" ")
}

/** Whether `position` names a value of a job with `size` values, or of any job without a size. */
function namesValue(position: string, size?: number): boolean {
  // Perl treats "0" as false, which makes `{0}` a plain replacement string.
  if (position === "0") return true
  const n = Number(position)
  if (n === 0) return false
  // Others count from the end, and Perl's negative indexes wrap once.
  return size === undefined || (n > 0 ? n <= size : -n <= 2 * size)
}

/** Whether a command word may keep a `{=` that `parallel` closes in the next words; over-approximated. */
function unclosedPerl(word: string): boolean {
  return splitPerl(word)
    .filter((part) => typeof part === "string")
    .join("")
    .includes("{=")
}

/** Splits a command line at its shortest `{= perl =}` expressions, which `parallel` evaluates at run time. */
function splitPerl(command: string): Template {
  const parts: Template = []
  let from = 0
  let open = command.indexOf("{=")
  let close = -1
  while (open >= 0) {
    if (close < open + 2) close = command.indexOf("=}", open + 2)
    if (close < 0) break
    // An expression contains no `{=`, so an earlier unmatched `{=` stays text.
    const next = command.indexOf("{=", open + 2)
    if (next >= 0 && next < close) {
      open = next
      continue
    }
    parts.push(command.slice(from, open), { op: "=" })
    from = close + 2
    open = command.indexOf("{=", from)
  }
  parts.push(command.slice(from))
  return parts
}

/** `{}` / `{.}` / `{/}` / `{//}` / `{/.}` of a `parallel` input value. */
/** Quotes like `parallel`, which leaves only `[-_.+/a-zA-Z0-9]+` bare. */
function parallelQuote(word: string) {
  return /^[-\w.+/]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`
}

/** File::Basename's `dirname`, which drops trailing slashes. */
function dirname(path: string): string {
  const parse = (path: string) => {
    const slash = path.lastIndexOf("/")
    return [slash < 0 ? "./" : path.slice(0, slash + 1), path.slice(slash + 1)] as const
  }
  const strip = (dir: string) => dir.replace(/([\s\S])\/*$/, "$1")
  const [dir, base] = parse(path)
  return strip(base ? dir : parse(strip(dir))[0])
}

function pathPart(value: string, op: string): string {
  const slash = value.lastIndexOf("/")
  const base = value.slice(slash + 1)
  if (op === "/") return base
  if (op === "//") return dirname(value)
  if (op === ".") return value.replace(/\.[^./]*$/, "")
  if (op === "/.") return base.replace(/\.[^.]*$/, "")
  return value
}

/** `source` / `.` of a process substitution or of piped stdin. */
function source(name: string): Unwrapper {
  return (args, expanded, stdin, piped) => {
    const i = args[0] === "--" ? 1 : 0
    const file = args[i] === undefined ? undefined : scriptFile(args[i]!, expanded[i])
    if (file === "opaque") return [opaqueLayer(name)]
    return file === "stdin" || file === "dynamic" ? stdinLayers(name, stdin, piped) : []
  }
}

interface InterpreterSpec {
  language: Language
  options: OptionSpec
  /** Options whose value is (a line of) the program. */
  code: string[]
  /** Options that run a module instead of a program; it is not prescanned. */
  module: string[]
  /** Options that only print information. */
  info: string[]
}

const INTERPRETERS = {
  python: {
    language: "python",
    options: OPTION_SPECS.python,
    code: ["-c"],
    module: ["-m"],
    info: ["-V", "--version", "-h", "--help"],
  },
  perl: {
    language: "perl",
    options: OPTION_SPECS.perl,
    code: ["-e", "-E"],
    module: [],
    info: ["-v", "-V", "--version", "-h", "--help"],
  },
  ruby: {
    language: "ruby",
    options: OPTION_SPECS.ruby,
    code: ["-e"],
    module: [],
    info: ["-v", "--version", "-h", "--help"],
  },
  node: {
    language: "node",
    options: OPTION_SPECS.node,
    code: ["-e", "-p", "--eval", "--print"],
    module: [],
    info: ["-v", "--version", "-h", "--help", "-c", "--check"],
  },
} satisfies Record<string, InterpreterSpec>

const LANGUAGES: Record<string, Language> = {
  python: "python",
  python2: "python",
  python3: "python",
  perl: "perl",
  ruby: "ruby",
  node: "node",
  nodejs: "node",
}

/**
 * An interpreter and its program (design 3.1 Stage 3.5): inline code, a script argument, or stdin (inline text, a
 * local file, or an opaque pipe). A process substitution as the script is opaque.
 */
function interpreter(name: string, { language, options, code, module, info }: InterpreterSpec): Unwrapper {
  return (args, expanded, stdin, piped) => {
    const programs: string[] = []
    let label = name
    let i = 0
    while (i < args.length) {
      if (args[i] === "--") {
        i++
        break
      }
      const option = readOption(args, i, options)
      if (!option) break
      // Options after the code are not checked: python passes them to the program.
      if (code.includes(option.name) && option.value !== undefined) {
        if (!programs.length) label = `${name} ${option.name}`
        programs.push(option.value)
        if (language === "python") break
      } else if (!programs.length && (module.includes(option.name) || info.includes(option.name))) return []
      i = option.next
    }
    if (programs.length) return [{ label, inner: { code: programs.join("\n"), language }, keep: true }]
    const script = args[i]
    const file = script === undefined || script === "-" ? "stdin" : scriptFile(script, expanded[i])
    if (file === "opaque") return [opaqueLayer(name)]
    if (file === "stdin") return interpreterStdin(name, language, stdin, piped)
    const layers = [argumentLayer(name, script!, piped, language)]
    if (file === "dynamic") layers.push(...interpreterStdin(name, language, stdin, piped))
    return layers
  }
}

/** The program of an interpreter on stdin: inline text, a local file, or an opaque pipe. */
function interpreterStdin(
  label: string,
  language: Language,
  stdin: string | undefined,
  piped: Piped | undefined,
): Layer[] {
  if (stdin !== undefined) return [{ label, inner: { code: stdin, language }, readsStdin: true, keep: true }]
  if (typeof piped === "object") return [{ label, inner: { file: { ...piped, language } }, readsStdin: true, keep: true }]
  return piped ? [opaqueLayer(label)] : []
}

// `crictl exec` filters that select containers instead of a container argument.
const CRICTL_SELECT = new Set(["--name", "--pod", "-p", "--image", "--state", "--label", "--latest", "-l", "--last", "-n"])

const WRAPPERS: Record<string, Unwrapper> = {
  sudo,
  env,
  timeout,
  nohup: (args, expanded) => commandFrom("nohup", args, expanded, 0, OPTION_SPECS.nohup),
  sshpass: (args, expanded) => commandFrom("sshpass", args, expanded, 0, OPTION_SPECS.sshpass),
  nice: optionsThen("nice", OPTION_SPECS.nice),
  // `command -v` / `-V` only looks the command up.
  command: optionsThen("command", OPTION_SPECS.nohup, (_, arg) => /^-[^-]*[vV]/.test(arg)),
  builtin: optionsThen("builtin", OPTION_SPECS.nohup),
  exec: optionsThen("exec", OPTION_SPECS.exec),
  time: optionsThen("time", OPTION_SPECS.time),
  stdbuf: optionsThen("stdbuf", OPTION_SPECS.stdbuf),
  // `ionice -p/-P/-u` changes running processes.
  ionice: optionsThen("ionice", OPTION_SPECS.ionice, (option) => /^(-[pPu]|--(pid|pgid|uid))$/.test(option.name)),
  setsid: optionsThen("setsid", OPTION_SPECS.nohup),
  // `doas -C config` only checks the config.
  doas: optionsThen("doas", OPTION_SPECS.doas, (option) => option.name === "-C"),
  su: su("su"),
  runuser: su("runuser"),
  xargs,
  eval: (args) => (args.length ? [{ label: "eval", inner: { script: args.join(" ") } }] : []),
  ssh,
  ...Object.fromEntries(["kubectl", "oc", "kubecolor"].map((name) => [name, kubectl(name)])),
  k3s: bundled("k3s", ["kubectl", "crictl", "ctr"]),
  k0s: bundled("k0s", ["kubectl", "ctr"]),
  microk8s: bundled("microk8s", MICROK8S_TOOLS),
  // Snap aliases: `microk8s.kubectl delete ns x`.
  ...Object.fromEntries(MICROK8S_TOOLS.map((tool) => [`microk8s.${tool}`, alias(`microk8s.${tool}`, tool)])),
  docker: containerExec("docker", OPTION_SPECS.docker, OPTION_SPECS.dockerExec),
  nerdctl: containerExec("nerdctl", OPTION_SPECS.nerdctl, OPTION_SPECS.nerdctlExec),
  podman: containerExec("podman", OPTION_SPECS.podman, OPTION_SPECS.podmanExec, new Set(["-l", "--latest", "--cidfile"])),
  crictl: containerExec("crictl", OPTION_SPECS.crictl, OPTION_SPECS.crictlExec, CRICTL_SELECT),
  find,
  ansible,
  pdsh,
  pssh: pssh("pssh"),
  "parallel-ssh": pssh("parallel-ssh"),
  clush,
  chroot,
  nsenter,
  unshare,
  ip,
  setpriv: optionsThen("setpriv", OPTION_SPECS.setpriv),
  "systemd-run": systemdRun,
  flock,
  watch,
  parallel,
  source: source("source"),
  ".": source("."),
  ...Object.fromEntries(SHELLS.map((name) => [name, shell(name)])),
  ...Object.fromEntries(["python", "python2", "python3"].map((name) => [name, interpreter(name, INTERPRETERS.python)])),
  perl: interpreter("perl", INTERPRETERS.perl),
  ruby: interpreter("ruby", INTERPRETERS.ruby),
  node: interpreter("node", INTERPRETERS.node),
  nodejs: interpreter("nodejs", INTERPRETERS.node),
}
