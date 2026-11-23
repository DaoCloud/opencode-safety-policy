/**
 * Recursive unwrapper (design 3.1 Stage 3, 3.2).
 *
 * Peels wrappers such as `ssh`, `sudo` and `bash -c` off every tokenized command and returns the innermost
 * commands ("atoms") together with their execution context. Remote command strings are re-tokenized the way
 * the remote shell would parse them.
 *
 * `xargs` appends its input as the argument `$XARGS_INPUT` (or substitutes it for the `-I` string), marked as
 * expanded, so rules see a variable operand. Inline stdin (heredoc / here-string) flows into wrapped commands, and
 * a shell or `ssh` without a command runs it as a script (`bash <<EOF`, `ssh host <<EOF`).
 */

import { OPTION_SPECS, readOption, shortFlags, skipOptions, type OptionSpec, type ParsedOption } from "./cli-options"
import { isDynamicName, normalizeName, tokenize, type Command, type OpaqueReason, type Script } from "./tokenizer"

export interface Atom {
  name: string
  argv: string[]
  expanded: boolean[]
  /** Environment assignments from the command and from `sudo` / `env` wrappers. */
  assignments: string[]
  /** True inside `ssh`, `kubectl exec` and `docker exec`: paths refer to another filesystem. */
  isRemote: boolean
  targetHost?: string
  /** Wrappers from outermost to innermost, e.g. `["ssh", "sudo", "bash -c"]`. */
  wrapperChain: string[]
  /** The tokenized command this atom comes from (redirects, connector). */
  command: Command
  /** Heredoc or here-string text on stdin, including stdin passed through wrappers such as `ssh` or `bash -c`. */
  stdin?: string
  /** Directory changes by wrappers (`env -C`, `sudo -D`) in order; `null` is the home of a login (`sudo -i`, `su -`). */
  chdir?: (string | null)[]
  /** Set when a script could not be parsed (`name` is `""`) or the wrapper nesting is too deep. */
  opaque?: OpaqueReason
}

interface Context {
  isRemote: boolean
  targetHost?: string
  wrapperChain: string[]
  depth: number
  stdin?: string
  chdir?: (string | null)[]
}

type Inner = { argv: string[]; expanded: boolean[]; assignments?: string[] } | { script: string }

interface Layer {
  label: string
  inner: Inner
  /** Switches to a remote context on this host. */
  host?: string
  /** The script is the stdin text, so inner commands do not inherit it. */
  readsStdin?: boolean
  /** The inner command runs in this directory; `null` when it is the home of a login. */
  chdir?: string | null
}

type Unwrapper = (args: string[], expanded: boolean[], stdin?: string) => Layer[]

interface Walk {
  atoms: Atom[]
  /** Characters left for re-tokenizing wrapped scripts. */
  chars: number
  stopped: boolean
}

const MAX_DEPTH = 8
// A substitution inside a remote or `bash -c` string is analyzed on both sides, so nesting grows
// exponentially. Past these budgets the walk stops with a `too-long` opaque atom.
const MAX_ATOMS = 10_000
const MAX_CHARS = 1 << 20
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SHELLS = ["sh", "bash", "zsh", "dash", "ksh", "ash"]
export const XARGS_INPUT = "$XARGS_INPUT"

export function unwrap(script: Script): Atom[] {
  const walk: Walk = { atoms: [], chars: MAX_CHARS, stopped: false }
  walkScript(script, { isRemote: false, wrapperChain: [], depth: 0 }, walk, emptyCommand())
  return walk.atoms
}

function emptyCommand(): Command {
  return { assignments: [], name: "", argv: [], expanded: [], redirects: [], substitutions: [] }
}

function emit(walk: Walk, atom: Atom) {
  if (walk.stopped) return
  if (walk.atoms.length < MAX_ATOMS) return void walk.atoms.push(atom)
  stop(walk, atom)
}

function stop(walk: Walk, atom: Atom) {
  walk.stopped = true
  walk.atoms.push({ ...atom, name: "", argv: [], expanded: [], assignments: [], opaque: "too-long" })
}

function walkScript(script: Script, context: Context, walk: Walk, owner: Command) {
  if (script.opaque) emit(walk, { ...atomBase(context, owner), opaque: script.opaque })
  for (const command of script.commands) {
    for (const sub of command.substitutions) walkScript(sub, context, walk, command)
    const inner: Context = { ...context }
    const stdin = stdinOf(command, context.stdin)
    if (stdin === undefined) delete inner.stdin
    else inner.stdin = stdin
    walkArgv(command.argv, command.expanded, command.assignments, inner, command, walk)
    if (walk.stopped) return
  }
}

/** The last stdin redirect wins; a pipe or a file on stdin replaces the inherited text. */
function stdinOf(command: Command, inherited: string | undefined): string | undefined {
  let stdin = command.connector === "|" ? undefined : inherited
  for (const redirect of command.redirects) if ((redirect.fd ?? 0) === 0 && redirect.op.startsWith("<")) stdin = redirect.body
  return stdin
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
  }
  if (context.targetHost !== undefined) atom.targetHost = context.targetHost
  if (context.stdin !== undefined) atom.stdin = context.stdin
  if (context.chdir) atom.chdir = context.chdir
  return atom
}

function walkArgv(
  argv: string[],
  expanded: boolean[],
  assignments: string[],
  context: Context,
  command: Command,
  walk: Walk,
) {
  if (walk.stopped) return
  const name = normalizeName(argv[0] ?? "")
  const atom: Atom = { ...atomBase(context, command), name, argv, expanded, assignments }
  const unwrapper = isDynamicName(argv[0] ?? "", expanded[0] ?? false) ? undefined : WRAPPERS[name]
  if (!unwrapper) return emit(walk, atom)
  const layers = unwrapper(argv.slice(1), expanded.slice(1), context.stdin)
  if (!layers.length) return emit(walk, atom)
  if (context.depth >= MAX_DEPTH) return emit(walk, { ...atom, opaque: "too-deep" })
  for (const layer of layers) {
    const next: Context = {
      isRemote: context.isRemote || layer.host !== undefined,
      wrapperChain: [...context.wrapperChain, layer.label],
      depth: context.depth + 1,
    }
    const host = layer.host ?? context.targetHost
    if (host !== undefined) next.targetHost = host
    if (context.stdin !== undefined && !layer.readsStdin) next.stdin = context.stdin
    if (layer.chdir !== undefined) next.chdir = [...(context.chdir ?? []), layer.chdir]
    else if (context.chdir) next.chdir = context.chdir
    const inner = layer.inner
    if (!("script" in inner)) {
      walkArgv(inner.argv, inner.expanded, [...assignments, ...(inner.assignments ?? [])], next, command, walk)
    } else if (inner.script.length > walk.chars) {
      stop(walk, atomBase(next, command))
    } else {
      walk.chars -= inner.script.length
      walkScript(tokenize(inner.script), next, walk, command)
    }
    if (walk.stopped) return
  }
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
  return (args, expanded, stdin) => {
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
    return inDir(shell(name)(positionals.slice(1), [], stdin), chdir)
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
    if (option.name === "-I" || option.name === "--replace") replace = option.value || "{}"
    else if (!option.name.startsWith("--")) {
      // `-e[eof]`, `-l[lines]` and `-i[replace]` take an optional attached value.
      const at = option.name.search(/[eli]/)
      if (option.name.charAt(at) === "i") replace = option.name.slice(at + 1) || "{}"
    }
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
  return [{ label: "xargs", inner: { argv, expanded: flags } }]
}

function sudo(args: string[], expanded: boolean[], stdin?: string): Layer[] {
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
  if (i >= args.length) return shell && stdin !== undefined ? inDir([stdinScript("sudo -s", stdin)], chdir) : []
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

function shell(name: string): Unwrapper {
  return (args, _, stdin) => {
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
    if (stdin === undefined || !(fromStdin || script === undefined || script === "/dev/stdin")) return []
    return [stdinScript(`${name} -s`, stdin)]
  }
}

function sshHost(destination: string) {
  const uri = destination.startsWith("ssh://")
  let host = uri ? destination.slice("ssh://".length) : destination
  host = host.slice(host.lastIndexOf("@") + 1)
  if (uri) host = host.replace(/\/.*$/, "").replace(/:\d+$/, "")
  return host.replace(/^\[(.*)\]$/, "$1")
}

function ssh(args: string[], _: boolean[], stdin?: string): Layer[] {
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
  else if (stdin !== undefined) layers.push(stdinScript("ssh", stdin, sshHost(destination)))
  return layers
}

function kubectl(args: string[], expanded: boolean[]): Layer[] {
  const positionals: number[] = []
  let i = 0
  while (i < args.length && args[i] !== "--") {
    const option = readOption(args, i, OPTION_SPECS.kubectl)
    if (option) i = option.next
    else positionals.push(i++)
  }
  const [sub, target, command] = positionals
  if (sub === undefined || args[sub] !== "exec" || target === undefined) return []
  const start = i < args.length ? i + 1 : command
  if (start === undefined || start >= args.length) return []
  return [{ label: "kubectl exec", host: args[target], inner: { argv: args.slice(start), expanded: expanded.slice(start) } }]
}

function docker(args: string[], expanded: boolean[]): Layer[] {
  let i = skipOptions(args, 0, OPTION_SPECS.docker)
  if (args[i] === "container") i++
  if (args[i] !== "exec") return []
  i = skipOptions(args, i + 1, OPTION_SPECS.dockerExec)
  const container = args[i]
  const start = i + 1
  if (container === undefined || start >= args.length) return []
  return [{ label: "docker exec", host: container, inner: { argv: args.slice(start), expanded: expanded.slice(start) } }]
}

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
  kubectl,
  docker,
  ...Object.fromEntries(SHELLS.map((name) => [name, shell(name)])),
}
