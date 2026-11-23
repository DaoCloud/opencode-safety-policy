/**
 * Rule loading and validation (design 4, 4.1).
 *
 * Rule files are JSON objects with a `rules` array. Files without `rules` (such as `ssh-readonly.json`) are
 * skipped by the built-in scan. Invalid rules throw with the source and rule id so that a broken rule never loads
 * silently.
 */

import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import type { InlineRule, Rule, Severity } from "../types"

export const BUILTIN_RULES_DIR = path.join(import.meta.dir, "../../rules")

const SEVERITIES: ReadonlySet<string> = new Set<Severity>(["critical", "high", "medium"])
const RULE_KEYS = new Set(["id", "severity", "reason", "command", "subcommands", "flags", "pattern", "http", "scope", "examples"])
const HTTP_KEYS = ["methods", "urlPatterns", "bodyPatterns"]

export class RuleError extends Error {}

/** Loads every `*.json` file of `dir` in name order. */
export function loadBuiltinRules(dir = BUILTIN_RULES_DIR): Rule[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
  return files.flatMap((name) => loadRuleFile(path.join(dir, name), { optional: true }))
}

/** Loads a rule file. With `optional`, a file without a `rules` key yields no rules instead of an error. */
export function loadRuleFile(file: string, options: { optional?: boolean } = {}): Rule[] {
  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    throw new RuleError(`${file}: ${message(error)}`)
  }
  if (isObject(data) && data.rules === undefined && options.optional) return []
  if (!isObject(data) || !Array.isArray(data.rules)) throw new RuleError(`${file}: expected an object with a "rules" array`)
  return data.rules.map((raw, i) => validateRule(raw, `${file}: rules[${i}]`))
}

/** Validates a rule from a rule file. */
export function validateRule(raw: unknown, source: string): Rule {
  return check(raw, source, false) as Rule
}

/** Validates a rule from `extraDeny` / `extraAsk` / `extraAllow`, where `severity` and `reason` are optional. */
export function validateInlineRule(raw: unknown, source: string): InlineRule {
  return check(raw, source, true)
}

function check(raw: unknown, source: string, inline: boolean): InlineRule {
  if (!isObject(raw)) throw new RuleError(`${source}: rule must be an object`)
  const id = raw.id
  if (typeof id !== "string" || !id.trim()) throw new RuleError(`${source}: rule needs a non-empty string "id"`)
  const fail = (problem: string): never => {
    throw new RuleError(`${source}: rule "${id}": ${problem}`)
  }
  for (const key of Object.keys(raw)) if (!RULE_KEYS.has(key)) fail(`unknown field "${key}"`)

  if ((raw.severity !== undefined || !inline) && !SEVERITIES.has(raw.severity as string))
    fail(`"severity" must be one of ${[...SEVERITIES].join(", ")}`)
  if ((raw.reason !== undefined || !inline) && !isText(raw.reason)) fail(`"reason" must be a non-empty string`)
  if (raw.command !== undefined && !isText(raw.command) && !isTexts(raw.command))
    fail(`"command" must be a string or a non-empty string array`)
  for (const key of ["subcommands", "flags"]) {
    if (raw[key] === undefined) continue
    if (!isTexts(raw[key])) fail(`"${key}" must be a non-empty string array`)
    if (raw.command === undefined) fail(`"${key}" requires "command"`)
  }
  if (raw.pattern !== undefined) {
    if (typeof raw.pattern !== "string") fail(`"pattern" must be a string`)
    compile(raw.pattern as string, fail)
  }
  if (raw.http !== undefined) {
    const http = raw.http
    if (!isObject(http)) return fail(`"http" must be an object`)
    for (const key of Object.keys(http)) if (!HTTP_KEYS.includes(key)) fail(`unknown field "http.${key}"`)
    for (const key of HTTP_KEYS) {
      const value = http[key]
      if (value === undefined) continue
      if (!isTexts(value)) fail(`"http.${key}" must be a non-empty string array`)
      if (key !== "methods") for (const pattern of value as string[]) compile(pattern, fail)
    }
  }
  if (raw.scope !== undefined && raw.scope !== "local" && raw.scope !== "remote") fail(`"scope" must be "local" or "remote"`)
  if (raw.examples !== undefined) {
    const examples = raw.examples
    if (!isObject(examples) || !isStrings(examples.match) || !isStrings(examples.ignore))
      fail(`"examples" must have "match" and "ignore" string arrays`)
  }
  if (raw.command === undefined && raw.pattern === undefined && raw.http === undefined)
    fail(`needs at least one of "command", "pattern" or "http"`)
  return raw as unknown as InlineRule
}

function compile(pattern: string, fail: (problem: string) => never) {
  try {
    new RegExp(pattern)
  } catch (error) {
    fail(`invalid regex ${JSON.stringify(pattern)}: ${message(error)}`)
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isTexts(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isText)
}
