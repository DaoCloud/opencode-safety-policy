import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { ConfigError, createRuleProvider, parseOptions } from "../src/config"
import { RuleError } from "../src/rules/loader"
import type { Rule } from "../src/types"

let root: string

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "ocsp-config-"))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const BUILTIN: Rule[] = [{ id: "builtin-mkfs", severity: "critical", reason: "mkfs", command: "mkfs" }]

function rulesFile(name: string, ids: string[]): string {
  const file = path.join(root, name)
  writeFileSync(file, JSON.stringify({ rules: ids.map((id) => ({ id, severity: "high", reason: id, command: id })) }))
  return file
}

describe("parseOptions", () => {
  test("accepts the design example", () => {
    const options = {
      mode: "strict",
      alwaysProtectSelf: true,
      auditLogPath: "/var/log/opencode-safety-audit.jsonl",
      rulesFile: ["/etc/opencode/safety-rules.json"],
      protectedEndpoints: { bmcCidrs: ["10.10.0.0/16"], ufmHosts: ["10.20.0.10"], nicoHosts: ["nico.internal"] },
      sshReadOnlyAllowlist: ["mlxlink"],
      extraDeny: [{ id: "custom-nico-reset", pattern: "^nico-cli\\s+(reset|wipe|delete)\\b", reason: "nico" }],
      extraAllow: [{ id: "allow-clean-tmp-build", pattern: "^rm\\s+-rf\\s+/tmp/my-build-[a-z0-9]+$", scope: "local" }],
    }
    expect(parseOptions(options)).toEqual(options as never)
    expect(parseOptions(undefined)).toEqual({})
  })

  test.each([
    [[], "must be an object"],
    [{ mod: "strict" }, 'unknown field "mod"'],
    [{ mode: "lax" }, '"mode"'],
    [{ alwaysProtectSelf: "yes" }, '"alwaysProtectSelf"'],
    [{ auditLogPath: "audit.jsonl" }, '"auditLogPath"'],
    [{ rulesFile: "/etc/opencode/safety-rules.json" }, '"rulesFile"'],
    [{ rulesFile: ["safety-rules.json"] }, '"rulesFile"'],
    [{ sshReadOnlyAllowlist: ["ls", " "] }, '"sshReadOnlyAllowlist"'],
    [{ extraDeny: { id: "x" } }, '"extraDeny"'],
    [{ protectedEndpoints: { bmcHosts: ["10.0.0.1"] } }, '"protectedEndpoints.bmcHosts"'],
    [{ protectedEndpoints: { ufmHosts: "ufm.internal" } }, '"protectedEndpoints.ufmHosts"'],
  ])("rejects %j", (raw, problem) => {
    expect(() => parseOptions(raw)).toThrow(ConfigError)
    expect(() => parseOptions(raw)).toThrow(problem)
  })
})

describe("createRuleProvider", () => {
  test("merges built-in, rulesFile and inline rules", () => {
    const file = rulesFile("merge.json", ["file-rule"])
    const set = createRuleProvider({ rulesFile: [file], extraDeny: [{ id: "inline-deny", command: "nico-cli" }] }, BUILTIN).get()
    expect(set.severity.map((rule) => rule.rule.id)).toEqual(["builtin-mkfs", "file-rule"])
    expect(set.deny.map((rule) => rule.rule.id)).toEqual(["inline-deny"])
  })

  test("reuses the rule set until a rules file changes", () => {
    const file = rulesFile("reload.json", ["first"])
    const provider = createRuleProvider({ rulesFile: [file] }, BUILTIN)
    const set = provider.get()
    expect(provider.get()).toBe(set)
    rulesFile("reload.json", ["first", "second"])
    expect(provider.get().severity.map((rule) => rule.rule.id)).toEqual(["builtin-mkfs", "first", "second"])
  })

  test("a missing or invalid rules file throws until it is fixed", () => {
    const file = path.join(root, "broken.json")
    const provider = createRuleProvider({ rulesFile: [file] }, BUILTIN)
    expect(() => provider.get()).toThrow(RuleError)
    writeFileSync(file, "{ not json")
    expect(() => provider.get()).toThrow(RuleError)
    expect(() => provider.get()).toThrow(RuleError)
    rulesFile("broken.json", ["fixed"])
    expect(provider.get().severity).toHaveLength(2)
  })

  test("a rulesFile id that duplicates a built-in id throws", () => {
    const file = rulesFile("dup.json", ["builtin-mkfs"])
    expect(() => createRuleProvider({ rulesFile: [file] }, BUILTIN).get()).toThrow('duplicate rule id "builtin-mkfs"')
  })
})
