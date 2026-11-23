/**
 * Remote read-only allowlist (design 4.3).
 *
 * An entry such as `kubectl get` matches a remote atom whose command name is `kubectl` and whose leading
 * positionals are `get`; global options are skipped for CLIs with an option table (`kubectl -n prod get pods`,
 * `ipmitool -H bmc sel list`). A remote atom that writes a file through a redirect is never read-only.
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { OPTION_SPECS, type OptionSpec } from "../cli-options"
import { normalizeName, type Command } from "../tokenizer"
import { BUILTIN_RULES_DIR, RuleError } from "./loader"
import { NO_OPTIONS, positionals } from "./matcher"

/** Command name → word lists after the name. */
export type ReadOnlyList = ReadonlyMap<string, string[][]>

export const READONLY_FILE = path.join(BUILTIN_RULES_DIR, "ssh-readonly.json")

const SPECS: Record<string, OptionSpec> = {
  kubectl: OPTION_SPECS.kubectl,
  docker: OPTION_SPECS.docker,
  ipmitool: OPTION_SPECS.ipmitool,
}
const HARMLESS_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"])

/** Loads the built-in list and appends `extra` (`options.sshReadOnlyAllowlist`). */
export function loadReadOnlyList(extra: string[] = [], file = READONLY_FILE): ReadOnlyList {
  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    throw new RuleError(`${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const commands = (data as { commands?: unknown } | null)?.commands
  if (!Array.isArray(commands) || !commands.every((entry) => typeof entry === "string" && entry.trim()))
    throw new RuleError(`${file}: expected an object with a "commands" array of non-empty strings`)
  const list = new Map<string, string[][]>()
  for (const entry of [...(commands as string[]), ...extra]) {
    const [name, ...words] = entry.trim().split(/\s+/)
    if (!name) continue
    const key = normalizeName(name)
    list.set(key, [...(list.get(key) ?? []), words])
  }
  return list
}

export function isReadOnly(argv: string[], list: ReadOnlyList): boolean {
  const name = normalizeName(argv[0] ?? "")
  const entries = list.get(name)
  if (!entries) return false
  const words = positionals(argv, SPECS[name] ?? NO_OPTIONS)
  return entries.some((entry) => entry.every((word, i) => words[i] === word))
}

/** True when a redirect writes a file; `/dev/null`, `/dev/stdout`, `/dev/stderr` and fd duplication (`2>&1`) do not count. */
export function writesFile(command: Command): boolean {
  return command.redirects.some((redirect) => {
    if (!redirect.op.includes(">")) return false
    if (HARMLESS_TARGETS.has(redirect.target)) return false
    return !(redirect.op === ">&" && /^(\d+|-)$/.test(redirect.target))
  })
}
