/**
 * Plugin options and rule loading (design 4, 5.2, 7).
 *
 * Options are validated once per plugin load, because OpenCode reloads the plugin when they change. `rulesFile`
 * entries are re-read when their mtime, size or inode changes. A missing or invalid rules file throws on every
 * call until it is fixed, so the hook layer can fail closed instead of silently running without those rules.
 */

import { statSync } from "node:fs"
import path from "node:path"
import { parseEndpoint } from "./http-extractor"
import { buildRuleSet, type RuleSet } from "./rules"
import { loadBuiltinRules, loadRuleFile, RuleError } from "./rules/loader"
import type { Mode, PluginOptions, Rule } from "./types"

export const MODES: readonly Mode[] = ["strict", "relaxed", "off"]

const OPTION_KEYS = new Set([
  "mode",
  "alwaysProtectSelf",
  "auditLogPath",
  "rulesFile",
  "protectedEndpoints",
  "sshReadOnlyAllowlist",
  "extraDeny",
  "extraAsk",
  "extraAllow",
  "enableServerSlashCommand",
])
const ENDPOINT_KEYS = ["bmcCidrs", "ufmHosts", "nicoHosts"]

export class ConfigError extends Error {}

/** Validates `plugins[].options`. Inline rules are validated later by `buildRuleSet`. */
export function parseOptions(raw: unknown): PluginOptions {
  if (raw === undefined || raw === null) return {}
  const fail = (problem: string): never => {
    throw new ConfigError(`options: ${problem}`)
  }
  if (!isObject(raw)) return fail("must be an object")
  for (const key of Object.keys(raw)) if (!OPTION_KEYS.has(key)) fail(`unknown field "${key}"`)

  if (raw.mode !== undefined && !MODES.includes(raw.mode as Mode)) fail(`"mode" must be one of ${MODES.join(", ")}`)
  for (const key of ["alwaysProtectSelf", "enableServerSlashCommand"])
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") fail(`"${key}" must be a boolean`)
  if (raw.auditLogPath !== undefined && !isAbsolute(raw.auditLogPath)) fail(`"auditLogPath" must be an absolute path`)
  if (raw.rulesFile !== undefined && !(Array.isArray(raw.rulesFile) && raw.rulesFile.every(isAbsolute)))
    fail(`"rulesFile" must be an array of absolute paths`)
  if (raw.sshReadOnlyAllowlist !== undefined && !isTexts(raw.sshReadOnlyAllowlist))
    fail(`"sshReadOnlyAllowlist" must be an array of non-empty strings`)
  for (const key of ["extraDeny", "extraAsk", "extraAllow"])
    if (raw[key] !== undefined && !Array.isArray(raw[key])) fail(`"${key}" must be an array`)

  const endpoints = raw.protectedEndpoints
  if (endpoints !== undefined) {
    if (!isObject(endpoints)) return fail(`"protectedEndpoints" must be an object`)
    for (const key of Object.keys(endpoints)) {
      if (!ENDPOINT_KEYS.includes(key)) fail(`unknown field "protectedEndpoints.${key}"`)
      if (!isTexts(endpoints[key])) fail(`"protectedEndpoints.${key}" must be an array of non-empty strings`)
      for (const entry of endpoints[key] as string[])
        if (!parseEndpoint(entry))
          fail(`"protectedEndpoints.${key}": "${entry}" is not an IP address, a CIDR block or a host name`)
    }
  }
  return raw as PluginOptions
}

export interface RuleProvider {
  /** Returns the current rule set, reloading `rulesFile` when a file changed. Throws `RuleError` on bad rules. */
  get(): RuleSet
}

export function createRuleProvider(options: PluginOptions, builtin: Rule[] = loadBuiltinRules()): RuleProvider {
  const files = options.rulesFile ?? []
  let stamp: string | undefined
  let set: RuleSet | undefined
  return {
    get() {
      const next = files.map(fileStamp).join("|")
      if (set && next === stamp) return set
      const rules = [...builtin, ...files.flatMap((file) => loadRuleFile(file))]
      set = buildRuleSet({
        rules,
        extraDeny: options.extraDeny,
        extraAsk: options.extraAsk,
        extraAllow: options.extraAllow,
        protectedEndpoints: options.protectedEndpoints,
      })
      stamp = next
      return set
    },
  }
}

function fileStamp(file: string): string {
  try {
    const stat = statSync(file)
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}`
  } catch (error) {
    throw new RuleError(`${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAbsolute(value: unknown): boolean {
  return typeof value === "string" && path.isAbsolute(value)
}

function isTexts(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "")
}
