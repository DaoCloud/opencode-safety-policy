/**
 * Recursive unwrapper (design 3.1 Stage 3, 3.2).
 *
 * Peels wrappers such as `ssh`, `sudo` and `bash -c` off every tokenized command and returns the innermost
 * commands ("atoms") together with their execution context. Remote command strings are re-tokenized the way
 * the remote shell would parse them.
 */

import { OPTION_SPECS, readOption, shortFlags, skipOptions, type OptionSpec } from "./cli-options"
import { normalizeName, tokenize, type Command, type OpaqueReason, type Script } from "./tokenizer"

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
  /** Set when a script could not be parsed (`name` is `""`) or the wrapper nesting is too deep. */
  opaque?: OpaqueReason
}

interface Context {
  isRemote: boolean
  targetHost?: string
  wrapperChain: string[]
  depth: number
}

type Inner = { argv: string[]; expanded: boolean[]; assignments?: string[] } | { script: string }

interface Layer {
  label: string
  inner: Inner
  /** Switches to a remote context on this host. */
  host?: string
}

type Unwrapper = (args: string[], expanded: boolean[]) => Layer[]

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
    walkArgv(command.argv, command.expanded, command.assignments, context, command, walk)
    if (walk.stopped) return
  }
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
  const unwrapper = expanded[0] ? undefined : WRAPPERS[name]
  if (!unwrapper) return emit(walk, atom)
  const layers = unwrapper(argv.slice(1), expanded.slice(1))
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

function sudo(args: string[], expanded: boolean[]): Layer[] {
  const spec = OPTION_SPECS.sudo
  let i = 0
  let edit = false
  while (i < args.length) {
    const arg = args[i]!
    if (arg === "--") {
      i++
      break
    }
    const option = readOption(args, i, spec)
    if (!option) break
    if (option.name === "--edit" || shortFlags(arg, spec).includes("e")) edit = true
    i = option.next
  }
  const assignments: string[] = []
  while (i < args.length && ASSIGNMENT.test(args[i]!)) assignments.push(args[i++]!)
  if (i >= args.length) return []
  if (edit) return [{ label: "sudo", inner: { argv: ["sudoedit", ...args.slice(i)], expanded: [false, ...expanded.slice(i)] } }]
  return [{ label: "sudo", inner: { argv: args.slice(i), expanded: expanded.slice(i), assignments } }]
}

function env(args: string[], expanded: boolean[]): Layer[] {
  const spec = OPTION_SPECS.env
  let i = 0
  let split: string | undefined
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
    i = option.next
  }
  if (split !== undefined) return [{ label: "env", inner: { script: [split, ...args.slice(i).map(quote)].join(" ") } }]
  const assignments: string[] = []
  while (i < args.length && ASSIGNMENT.test(args[i]!)) assignments.push(args[i++]!)
  if (i >= args.length) return []
  return [{ label: "env", inner: { argv: args.slice(i), expanded: expanded.slice(i), assignments } }]
}

function timeout(args: string[], expanded: boolean[]): Layer[] {
  const duration = skipOptions(args, 0, OPTION_SPECS.timeout)
  return commandFrom("timeout", args, expanded, duration + 1, OPTION_SPECS.nohup)
}

function shell(name: string): Unwrapper {
  return (args) => {
    let i = 0
    let command = false
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
        else if (c === "o" || c === "O") values++
      }
      i += 1 + values
    }
    const script = args[i]
    if (!command || script === undefined) return []
    return [{ label: `${name} -c`, inner: { script } }]
  }
}

function sshHost(destination: string) {
  const uri = destination.startsWith("ssh://")
  let host = uri ? destination.slice("ssh://".length) : destination
  host = host.slice(host.lastIndexOf("@") + 1)
  if (uri) host = host.replace(/\/.*$/, "").replace(/:\d+$/, "")
  return host.replace(/^\[(.*)\]$/, "$1")
}

function ssh(args: string[]): Layer[] {
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
  ssh,
  kubectl,
  docker,
  ...Object.fromEntries(SHELLS.map((name) => [name, shell(name)])),
}
