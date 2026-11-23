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
 *   `--force=true`, and `--replicas=0` also matches `--replicas 0`;
 * - `pattern`: the regex matches `name arg1 arg2 ...`. For rules with `command`, inline stdin (heredoc / here-string)
 *   is input to that command, so the regex is also tried on `name arg1 ... stdin` with stdin whitespace collapsed
 *   (`psql <<SQL DROP TABLE x`). Rules without `command` ignore stdin so that `cat <<EOF > x.sh` is not matched;
 * - `scope`: `local` / `remote` restricts the rule to local or remote atoms.
 * A non-shell tool call is matched as `[tool ID, JSON input]`, and only by rules whose `command` lists the tool ID, so
 * that a pattern-only rule does not hit file content written by `edit`.
 * `http` rules are matched in P1-3; a rule with only `http` never matches here.
 */

import { OPTION_SPECS, readOption, shortFlags, type OptionSpec } from "../cli-options"
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
}

export interface CompiledRule {
  rule: InlineRule
  commands?: ReadonlySet<string>
  subcommands?: string[][]
  regex?: RegExp
}

const COMMAND_SPECS = new Map<string, OptionSpec>([
  ["kubectl", OPTION_SPECS.kubectl],
  ["docker", OPTION_SPECS.docker],
])

export const NO_OPTIONS: OptionSpec = { shortValue: "", longValue: new Set() }

export function compileRule(rule: InlineRule): CompiledRule {
  const compiled: CompiledRule = { rule }
  if (rule.command !== undefined) compiled.commands = new Set([rule.command].flat())
  if (rule.subcommands) compiled.subcommands = rule.subcommands.map((entry) => entry.trim().split(/\s+/))
  if (rule.pattern !== undefined) compiled.regex = new RegExp(rule.pattern)
  return compiled
}

export function matchRule(compiled: CompiledRule, input: MatchInput): boolean {
  const { rule, commands, subcommands, regex } = compiled
  if (rule.scope === "local" && input.isRemote) return false
  if (rule.scope === "remote" && !input.isRemote) return false
  if (!commands && (!regex || input.tool)) return false
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
  const eq = flag.indexOf("=")
  if (flag.startsWith("--") && eq > 0) {
    const name = flag.slice(0, eq)
    const value = flag.slice(eq + 1)
    return args.some((arg, i) => arg === flag || (arg === name && args[i + 1] === value))
  }
  if (flag.startsWith("--")) return args.some((arg) => arg === flag || arg.startsWith(flag + "="))
  if (/^-[^-]$/.test(flag)) return args.some((arg) => /^-[^-]/.test(arg) && clusterLetters(arg, spec).includes(flag.charAt(1)))
  return args.includes(flag)
}

/** Letters of a short option cluster up to and including the first value-taking letter. */
function clusterLetters(arg: string, spec: OptionSpec | undefined) {
  const letters = arg.slice(1)
  return spec ? letters.slice(0, shortFlags(arg, spec).length + 1) : letters
}
