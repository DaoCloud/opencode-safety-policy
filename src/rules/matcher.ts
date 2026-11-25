/**
 * Declarative rule matching (design 4.1).
 *
 * A rule matches an atom when all of its parts match:
 * - `command`: the basename-normalized command name is one of the listed names;
 * - `subcommands`: one entry matches the positionals. The first word of the entry must be the first positional for
 *   CLIs with an option table (global options are skipped), or any positional for other CLIs, because unknown value
 *   options (`helm -n prod uninstall`) would otherwise hide the subcommand. The remaining words must follow in order,
 *   not necessarily adjacent, so that `kubectl delete --grace-period 0 namespace x` matches `delete namespace`;
 * - `flags`: one flag is present. `-f` also matches inside a short cluster such as `-rf`, `--force` also matches
 *   `--force=true` and an abbreviation such as `--for` (not for CLIs whose option table needs exact names, nor when
 *   the abbreviation is an option of its own in the table), and `--replicas=0` also matches `--replicas 0`;
 * - `pattern`: the regex matches `name arg1 arg2 ...`. For rules with `command`, inline stdin (heredoc / here-string)
 *   is input to that command, so the regex is also tried on `name arg1 ... stdin` with stdin whitespace collapsed
 *   (`psql <<SQL DROP TABLE x`). Rules without `command` ignore stdin so that `cat <<EOF > x.sh` is not matched;
 * - `http`: one HTTP request of the atom (design 3.1 Stage 3.5) matches every part. An unknown method matches
 *   `methods` and an unknown body matches `bodyPatterns`; URL and body patterns ignore case. A rule with only `http`
 *   looks at the requests alone, not at the command name and arguments;
 * - `scope`: `local` / `remote` restricts the rule to local or remote atoms.
 * A non-shell tool call is matched as `[tool ID, JSON input]`, and only by rules whose `command` lists the tool ID, so
 * that a pattern-only rule does not hit file content written by `edit`.
 */

import { OPTION_SPECS, readOption, shortFlags, type OptionSpec } from "../cli-options"
import type { HttpRequest } from "../http-extractor"
import { normalizeName } from "../tokenizer"
import type { InlineRule } from "../types"

export interface MatchInput {
  /** Arguments after path expansion; `argv[0]` may still carry a path such as `/usr/bin/rm`. */
  argv: string[]
  isRemote: boolean
  /** Inline stdin text of the atom. */
  stdin?: string
  /** A non-shell tool call. */
  tool?: boolean
  /** HTTP requests of the atom. */
  http?: HttpRequest[]
}

export interface CompiledHttp {
  methods?: ReadonlySet<string>
  urls?: RegExp[]
  bodies?: RegExp[]
  /** Built-in rules only: the request host must pass. */
  hosts?: (host: string) => boolean
  /** Built-in rules only: a known GET / HEAD does not match. */
  write?: boolean
}

export interface CompiledRule {
  rule: InlineRule
  commands?: ReadonlySet<string>
  subcommands?: string[][]
  regex?: RegExp
  http?: CompiledHttp
}

const COMMAND_SPECS = new Map<string, OptionSpec>([
  ...["kubectl", "oc", "kubecolor"].map((name): [string, OptionSpec] => [name, OPTION_SPECS.kubectl]),
  ["docker", OPTION_SPECS.docker],
  ...["iptables", "ip6tables", "iptables-legacy", "ip6tables-legacy", "iptables-nft", "ip6tables-nft", "ebtables", "arptables"]
    .map((name): [string, OptionSpec] => [name, OPTION_SPECS.iptables]),
])

export const NO_OPTIONS: OptionSpec = { shortValue: "", longValue: new Set() }

export function compileRule(rule: InlineRule): CompiledRule {
  const compiled: CompiledRule = { rule }
  if (rule.command !== undefined) compiled.commands = new Set([rule.command].flat())
  if (rule.subcommands) compiled.subcommands = rule.subcommands.map((entry) => entry.trim().split(/\s+/))
  if (rule.pattern !== undefined) compiled.regex = new RegExp(rule.pattern)
  if (rule.http) {
    const { methods, urlPatterns, bodyPatterns } = rule.http
    const http: CompiledHttp = {}
    if (methods) http.methods = new Set(methods.map((method) => method.toUpperCase()))
    if (urlPatterns) http.urls = urlPatterns.map((pattern) => new RegExp(pattern, "i"))
    if (bodyPatterns) http.bodies = bodyPatterns.map((pattern) => new RegExp(pattern, "i"))
    compiled.http = http
  }
  return compiled
}

export function matchRule(compiled: CompiledRule, input: MatchInput): boolean {
  const { rule, commands, subcommands, regex, http } = compiled
  if (rule.scope === "local" && input.isRemote) return false
  if (rule.scope === "remote" && !input.isRemote) return false
  if (!commands && (input.tool || (!regex && !http))) return false
  if (!input.argv.length && (commands || regex)) return false
  if (http && !input.http?.some((request) => matchHttp(http, request))) return false
  const argv = input.argv
  const name = normalizeName(argv[0] ?? "")
  if (commands) {
    if (!commands.has(name)) return false
    const spec = COMMAND_SPECS.get(name)
    if (subcommands) {
      const words = positionals(argv, spec ?? NO_OPTIONS)
      if (!subcommands.some((entry) => hasSequence(words, entry, spec !== undefined))) return false
    }
    if (rule.flags && !rule.flags.some((flag) => hasFlag(argv, flag, spec))) return false
  }
  if (!regex) return true
  const text = [name, ...argv.slice(1)].join(" ")
  if (regex.test(text)) return true
  const stdin = commands && input.stdin?.trim()
  return !!stdin && regex.test(`${text} ${stdin.split(/\s+/).join(" ")}`)
}

function matchHttp(http: CompiledHttp, request: HttpRequest): boolean {
  const { method, body, host } = request
  if (http.methods && method !== undefined && !http.methods.has(method)) return false
  if (http.write && (method === "GET" || method === "HEAD")) return false
  if (http.urls && !http.urls.some((regex) => request.urls.some((url) => regex.test(url)))) return false
  if (http.bodies && body !== undefined && !http.bodies.some((regex) => regex.test(body))) return false
  return !http.hosts || (host !== undefined && http.hosts(host))
}

/** Positional arguments after `argv[0]`, skipping options of `spec`; everything after `--` is positional. */
export function positionals(argv: string[], spec: OptionSpec): string[] {
  const words: string[] = []
  for (let i = 1; i < argv.length; ) {
    if (argv[i] === "--") return [...words, ...argv.slice(i + 1)]
    const option = readOption(argv, i, spec)
    if (option) i = option.next
    else words.push(argv[i++]!)
  }
  return words
}

function hasSequence(words: string[], entry: string[], anchored: boolean) {
  const starts = anchored ? 1 : words.length
  for (let start = 0; start < starts; start++) {
    if (words[start] !== entry[0]) continue
    let k = 1
    for (let i = start + 1; i < words.length && k < entry.length; i++) if (words[i] === entry[k]) k++
    if (k === entry.length) return true
  }
  return false
}

function hasFlag(argv: string[], flag: string, spec: OptionSpec | undefined) {
  const end = argv.indexOf("--")
  const args = argv.slice(1, end < 0 ? undefined : end)
  if (flag.startsWith("--")) {
    const eq = flag.indexOf("=")
    const name = eq > 0 ? flag.slice(2, eq) : flag.slice(2)
    const value = eq > 0 ? flag.slice(eq + 1) : undefined
    // A unique prefix of a long option works for most parsers (getopt_long, argparse) but not for CLIs with an
    // option table, which need exact names. A known name stands for itself (`iptables --delete` is not
    // `--delete-chain`).
    const exact = spec !== undefined && spec.longNames === undefined
    return args.some((arg, i) => {
      if (!arg.startsWith("--")) return false
      const at = arg.indexOf("=")
      const given = at < 0 ? arg.slice(2) : arg.slice(2, at)
      if (given !== name && (exact || given === "" || !name.startsWith(given) || spec?.longNames?.includes(given))) {
        return false
      }
      if (value === undefined) return true
      return at < 0 ? args[i + 1] === value : arg.slice(at + 1) === value
    })
  }
  if (/^-[^-]$/.test(flag)) return args.some((arg) => /^-[^-]/.test(arg) && clusterLetters(arg, spec).includes(flag.charAt(1)))
  return args.includes(flag)
}

/** Letters of a short option cluster up to and including the first value-taking letter. */
function clusterLetters(arg: string, spec: OptionSpec | undefined) {
  const letters = arg.slice(1)
  return spec ? letters.slice(0, shortFlags(arg, spec).length + 1) : letters
}
