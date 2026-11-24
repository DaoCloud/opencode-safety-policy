import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildRuleSet, combine, decide, severityDecision } from "../src/rules"
import { loadBuiltinRules, loadRuleFile, RuleError, validateInlineRule, validateRule } from "../src/rules/loader"
import type { HttpRequest } from "../src/http-extractor"
import { compileRule, matchRule } from "../src/rules/matcher"
import type { InlineRule, Mode, Rule, Severity } from "../src/types"

let root = ""

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "ocsp-rules-"))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const rule = (fields: Partial<Rule> & { id: string }): Rule => ({ severity: "high", reason: "test", ...fields })
const input = (line: string, isRemote = false) => ({ argv: line.split(" "), isRemote })
const matches = (fields: Partial<Rule>, line: string, isRemote = false) =>
  matchRule(compileRule(rule({ id: "r", ...fields })), input(line, isRemote))

function writeJson(name: string, data: unknown) {
  const file = path.join(root, name)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data))
  return file
}

describe("loader", () => {
  test("loadRuleFile returns validated rules", () => {
    const file = writeJson("one.json", { rules: [rule({ id: "a", command: "rm" })] })
    expect(loadRuleFile(file).map((r) => r.id)).toEqual(["a"])
  })

  test("loadRuleFile reports the file for bad JSON and bad shape", () => {
    const bad = writeJson("bad.json", "{")
    expect(() => loadRuleFile(bad)).toThrow(RuleError)
    expect(() => loadRuleFile(bad)).toThrow(bad)
    const shape = writeJson("shape.json", { other: [] })
    expect(() => loadRuleFile(shape)).toThrow(`${shape}: expected an object with a "rules" array`)
    expect(loadRuleFile(shape, { optional: true })).toEqual([])
    const invalid = writeJson("invalid.json", { rules: [{ id: "x", severity: "low", reason: "r", command: "rm" }] })
    expect(() => loadRuleFile(invalid)).toThrow(`${invalid}: rules[0]: rule "x": "severity" must be one of`)
  })

  test("loadBuiltinRules scans *.json in name order and skips files without rules", () => {
    const dir = path.join(root, "builtin")
    writeJson("builtin/b.json", { rules: [rule({ id: "b", command: "b" })] })
    writeJson("builtin/a.json", { rules: [rule({ id: "a", command: "a" })] })
    writeJson("builtin/ssh-readonly.json", { commands: ["ls"] })
    writeJson("builtin/notes.txt", "not json")
    expect(loadBuiltinRules(dir).map((r) => r.id)).toEqual(["a", "b"])
  })

  test.each<[string, unknown, string]>([
    ["non-object", "rm", "rule must be an object"],
    ["missing id", { severity: "high", reason: "r", command: "rm" }, 'non-empty string "id"'],
    ["unknown field", { ...rule({ id: "x", command: "rm" }), commands: ["rm"] }, 'unknown field "commands"'],
    ["bad severity", { id: "x", severity: "low", reason: "r", command: "rm" }, '"severity" must be one of'],
    ["missing reason", { id: "x", severity: "high", command: "rm" }, '"reason" must be a non-empty string'],
    ["empty command list", rule({ id: "x", command: [] }), '"command" must be a string'],
    ["subcommands without command", rule({ id: "x", pattern: "x", subcommands: ["rm"] }), '"subcommands" requires "command"'],
    ["empty flags", rule({ id: "x", command: "rm", flags: [] }), '"flags" must be a non-empty string array'],
    ["bad regex", rule({ id: "x", pattern: "(" }), "invalid regex"],
    ["unknown http field", rule({ id: "x", http: { url: "x" } as never }), 'unknown field "http.url"'],
    ["bad http regex", rule({ id: "x", http: { urlPatterns: ["["] } }), "invalid regex"],
    ["bad scope", rule({ id: "x", command: "rm", scope: "both" as never }), '"scope" must be "local" or "remote"'],
    ["bad examples", rule({ id: "x", command: "rm", examples: { match: ["rm"] } as never }), '"examples" must have'],
    ["no matcher", rule({ id: "x" }), 'needs at least one of "command", "pattern" or "http"'],
  ])("validateRule rejects %s", (_name, raw, problem) => {
    expect(() => validateRule(raw, "src")).toThrow(RuleError)
    expect(() => validateRule(raw, "src")).toThrow(problem)
  })

  test("inline rules may omit severity and reason but not other checks", () => {
    expect(validateInlineRule({ id: "x", command: "rm" }, "src").id).toBe("x")
    expect(() => validateInlineRule({ id: "x", command: "rm", severity: "low" }, "src")).toThrow('"severity"')
    expect(() => validateInlineRule({ id: "x" }, "src")).toThrow("needs at least one of")
  })
})

describe("buildRuleSet", () => {
  test("rejects duplicate ids across sources", () => {
    expect(() =>
      buildRuleSet({ rules: [rule({ id: "a", command: "rm" })], extraAllow: [{ id: "a", command: "ls" }] }),
    ).toThrow('options.extraAllow[0]: duplicate rule id "a"')
  })

  test("reports the option index of an invalid inline rule", () => {
    expect(() => buildRuleSet({ rules: [], extraDeny: [{ id: "a" }] })).toThrow('options.extraDeny[0]: rule "a"')
  })

  test("inline rules get a default reason", () => {
    const set = buildRuleSet({ rules: [], extraAsk: [{ id: "a", command: "rm" }] })
    expect(decide(input("rm x"), set, "strict")).toEqual({ decision: "ask", ruleId: "a", reason: 'extraAsk rule "a"' })
  })

  test("protectedEndpoints add a high rule for requests to them that are not a known GET / HEAD", () => {
    const set = buildRuleSet({ rules: [], protectedEndpoints: { bmcCidrs: ["10.0.0.0/24"], ufmHosts: ["ufm.lab"] } })
    const send = (method: string | undefined, host: string) => {
      const http = [{ urls: [`http://${host}/x`], host, ...(method && { method }) }]
      return decide({ argv: [], isRemote: false, http }, set, "strict").ruleId
    }
    expect(send("POST", "10.0.0.9")).toBe("protected-endpoint-write")
    expect(send(undefined, "ufm.lab")).toBe("protected-endpoint-write")
    expect(send("GET", "10.0.0.9")).toBeUndefined()
    expect(send("HEAD", "ufm.lab")).toBeUndefined()
    expect(send("POST", "10.0.1.9")).toBeUndefined()
    expect(buildRuleSet({ rules: [], protectedEndpoints: {} }).severity).toEqual([])
    const duplicate = rule({ id: "protected-endpoint-write", command: "x" })
    expect(() => buildRuleSet({ rules: [duplicate], protectedEndpoints: { ufmHosts: ["u"] } })).toThrow(
      'duplicate rule id "protected-endpoint-write"',
    )
  })
})

describe("matchRule", () => {
  test("command matches the normalized name and any listed name", () => {
    expect(matches({ command: "kubectl" }, "/usr/bin/kubectl get pods")).toBe(true)
    expect(matches({ command: "kubectl" }, "\\kubectl get pods")).toBe(true)
    expect(matches({ command: ["docker", "podman"] }, "podman ps")).toBe(true)
    expect(matches({ command: "kubectl" }, "kubectl-foo get")).toBe(false)
  })

  test("subcommands skip known global options and are anchored for known CLIs", () => {
    const k8s = { command: "kubectl", subcommands: ["delete"] }
    expect(matches(k8s, "kubectl --kubeconfig /p -n prod --as admin delete pod x")).toBe(true)
    expect(matches(k8s, "kubectl --namespace=prod delete pod x")).toBe(true)
    expect(matches(k8s, "kubectl get pod delete")).toBe(false)
    expect(matches(k8s, "kubectl -n delete get pod")).toBe(false)
  })

  test("subcommands match at any offset for unknown CLIs", () => {
    expect(matches({ command: "helm", subcommands: ["uninstall"] }, "helm -n prod uninstall api")).toBe(true)
    expect(matches({ command: "helm", subcommands: ["uninstall"] }, "helm list")).toBe(false)
  })

  test("multi-word subcommands follow in order after the first word", () => {
    const ns = { command: "kubectl", subcommands: ["delete namespace"] }
    expect(matches(ns, "kubectl delete namespace x")).toBe(true)
    expect(matches(ns, "kubectl delete --grace-period 0 namespace x")).toBe(true)
    expect(matches(ns, "kubectl delete pod x")).toBe(false)
    expect(matches(ns, "kubectl namespace delete")).toBe(false)
    const power = { command: "ipmitool", subcommands: ["chassis power off"] }
    expect(matches(power, "ipmitool -H bmc -U u -P p chassis power off")).toBe(true)
    expect(matches(power, "ipmitool -H bmc chassis power status")).toBe(false)
  })

  test("short flags match inside clusters", () => {
    expect(matches({ command: "rm", flags: ["-f"] }, "rm -rf x")).toBe(true)
    expect(matches({ command: "rm", flags: ["-f"] }, "rm -r x")).toBe(false)
    expect(matches({ command: "rm", flags: ["-f"] }, "rm --force x")).toBe(false)
  })

  test("short flags stop at a value-taking letter of a known CLI", () => {
    expect(matches({ command: "kubectl", flags: ["-f"] }, "kubectl delete -nf x")).toBe(false)
    expect(matches({ command: "kubectl", flags: ["-f"] }, "kubectl delete -f x.yaml")).toBe(true)
  })

  test("long flags match with or without a value", () => {
    expect(matches({ command: "kubectl", flags: ["--force"] }, "kubectl delete pod x --force")).toBe(true)
    expect(matches({ command: "kubectl", flags: ["--force"] }, "kubectl delete pod x --force=true")).toBe(true)
    expect(matches({ command: "kubectl", flags: ["--force"] }, "kubectl delete pod x --forced")).toBe(false)
  })

  test("long flags match a unique prefix unless the CLI takes exact names", () => {
    expect(matches({ command: "iptables", flags: ["--flush"] }, "iptables --flu")).toBe(true)
    expect(matches({ command: "journalctl", flags: ["--vacuum-time"] }, "journalctl --vacuum-t=1s")).toBe(true)
    expect(matches({ command: "journalctl", flags: ["--vacuum-files=1"] }, "journalctl --vacuum-f 1")).toBe(true)
    expect(matches({ command: "iptables", flags: ["--flush"] }, "iptables --flushed")).toBe(false)
    expect(matches({ command: "kubectl", flags: ["--force"] }, "kubectl delete pod x --for")).toBe(false)
  })

  test("--name=value flags also match the separated form", () => {
    const zero = { command: "kubectl", flags: ["--replicas=0"] }
    expect(matches(zero, "kubectl scale --replicas=0 deploy/x")).toBe(true)
    expect(matches(zero, "kubectl scale --replicas 0 deploy/x")).toBe(true)
    expect(matches(zero, "kubectl scale --replicas=1 deploy/x")).toBe(false)
  })

  test("other flags match exact tokens and flags after -- are ignored", () => {
    expect(matches({ command: "find", flags: ["-delete"] }, "find . -name x -delete")).toBe(true)
    expect(matches({ command: "find", flags: ["-delete"] }, "find . -name -deleted")).toBe(false)
    expect(matches({ command: "rm", flags: ["-r"] }, "rm -- -r")).toBe(false)
  })

  test("pattern runs on the normalized command line and combines with command", () => {
    expect(matches({ pattern: "^mkfs(\\.\\w+)? " }, "/sbin/mkfs.ext4 /dev/sdb")).toBe(true)
    expect(matches({ pattern: "^mkfs" }, "echo mkfs")).toBe(false)
    expect(matches({ command: "rm", pattern: " /$" }, "rm -rf /")).toBe(true)
    expect(matches({ command: "rm", pattern: " /$" }, "shred -rf /")).toBe(false)
  })

  test("pattern also sees the stdin of rules with a command", () => {
    const withStdin = (fields: Partial<InlineRule>, line: string, stdin: string) =>
      matchRule(compileRule(rule({ id: "r", ...fields })), { ...input(line), stdin })
    const flush = { command: "redis-cli", pattern: "(?i:(^| )flushall( |$))" }
    expect(withStdin(flush, "redis-cli -h db", "PING\n  FLUSHALL\n")).toBe(true)
    expect(withStdin(flush, "redis-cli -h db", "PING\n")).toBe(false)
    expect(withStdin(flush, "redis-cli flushall", "PING\n")).toBe(true)
    expect(withStdin({ pattern: "flushall" }, "cat", "flushall\n")).toBe(false)
  })

  test("tool calls only match rules with a command", () => {
    const call = (fields: Partial<InlineRule>, tool: string, json: string) =>
      matchRule(compileRule(rule({ id: "r", ...fields })), { argv: [tool, json], isRemote: false, tool: true })
    const force = { command: "opencode_worktree_remove", pattern: '"force":true' }
    expect(call(force, "opencode_worktree_remove", '{"directory":"/w","force":true}')).toBe(true)
    expect(call(force, "opencode_worktree_remove", '{"directory":"/w"}')).toBe(false)
    expect(call(force, "github_delete_repository", '{"force":true}')).toBe(false)
    expect(call({ pattern: "DROP TABLE" }, "edit", '{"text":"DROP TABLE x"}')).toBe(false)
  })

  test("scope restricts local and remote atoms", () => {
    expect(matches({ command: "rm", scope: "remote" }, "rm x", true)).toBe(true)
    expect(matches({ command: "rm", scope: "remote" }, "rm x", false)).toBe(false)
    expect(matches({ command: "rm", scope: "local" }, "rm x", true)).toBe(false)
    expect(matches({ command: "rm" }, "rm x", true)).toBe(true)
  })

  test("http rules match one request on every part, and http-only rules ignore the command line", () => {
    const request = (method: string | undefined, url: string, body?: string): HttpRequest => ({
      urls: [url],
      ...(method && { method }),
      ...(body !== undefined && { body }),
    })
    const http = (fields: Partial<Rule>, line: string, requests: HttpRequest[]) =>
      matchRule(compileRule(rule({ id: "r", ...fields })), { ...input(line), http: requests })
    const boot = { http: { methods: ["patch"], urlPatterns: ["/redfish/v1/systems/"], bodyPatterns: ["bootsource"] } }
    const url = "https://bmc/redfish/v1/Systems/1"
    expect(http(boot, "curl", [request("PATCH", url, '{"BootSourceOverrideTarget":"Pxe"}')])).toBe(true)
    expect(http(boot, "curl", [request(undefined, url, undefined)])).toBe(true)
    expect(http(boot, "curl", [request("GET", url, "BootSource"), request("PATCH", url, "{}")])).toBe(false)
    expect(http(boot, "curl", [request("PATCH", "https://bmc/redfish/v1/Managers/1", "BootSource")])).toBe(false)
    expect(http(boot, "curl", [])).toBe(false)
    expect(matches({ http: { methods: ["POST"] } }, "curl -X POST x")).toBe(false)
    expect(http({ command: "wget", http: { methods: ["POST"] } }, "curl", [request("POST", url)])).toBe(false)
    expect(http({ pattern: "-k", http: { methods: ["POST"] } }, "curl -k", [request("POST", url)])).toBe(true)
  })
})

describe("decide", () => {
  const MATRIX: [Severity, Mode, string][] = [
    ["critical", "strict", "deny"],
    ["critical", "relaxed", "deny"],
    ["critical", "off", "allow"],
    ["high", "strict", "deny"],
    ["high", "relaxed", "ask"],
    ["high", "off", "allow"],
    ["medium", "strict", "ask"],
    ["medium", "relaxed", "allow"],
    ["medium", "off", "allow"],
  ]

  test.each(MATRIX)("%s in %s mode: %s", (severity, mode, decision) => {
    expect(severityDecision(severity, mode)).toBe(decision as never)
    const set = buildRuleSet({ rules: [rule({ id: "r", severity, command: "rm" })] })
    expect(decide(input("rm x"), set, mode).decision).toBe(decision as never)
  })

  const set = (extra: { extraDeny?: InlineRule[]; extraAsk?: InlineRule[]; extraAllow?: InlineRule[] }) =>
    buildRuleSet({
      rules: [
        rule({ id: "rm-root", severity: "critical", command: "rm", pattern: " /$" }),
        rule({ id: "rm-any", severity: "high", command: "rm" }),
        rule({ id: "kill", severity: "medium", command: "kill" }),
      ],
      ...extra,
    })

  test("no match allows", () => {
    expect(decide(input("ls -la"), set({}), "strict")).toEqual({ decision: "allow" })
  })

  test("off allows everything", () => {
    expect(decide(input("rm -rf /"), set({ extraDeny: [{ id: "d", command: "rm" }] }), "off").decision).toBe("allow")
  })

  test("extraDeny denies and beats extraAllow", () => {
    const s = set({ extraDeny: [{ id: "deny-ls", command: "ls" }], extraAllow: [{ id: "allow-ls", command: "ls" }] })
    expect(decide(input("ls"), s, "relaxed")).toMatchObject({ decision: "deny", ruleId: "deny-ls" })
  })

  test("extraAllow cannot override critical rules", () => {
    const s = set({ extraAllow: [{ id: "allow-rm", command: "rm" }] })
    expect(decide(input("rm -rf /"), s, "strict")).toMatchObject({ decision: "deny", ruleId: "rm-root" })
  })

  test("extraAllow exempts high, medium and extraAsk rules", () => {
    const s = set({ extraAsk: [{ id: "ask-rm", command: "rm" }], extraAllow: [{ id: "allow-tmp", command: "rm", pattern: " /tmp/" }] })
    expect(decide(input("rm /tmp/x"), s, "strict")).toMatchObject({ decision: "allow", ruleId: "allow-tmp" })
    expect(decide(input("rm /srv/x"), s, "strict")).toMatchObject({ decision: "deny", ruleId: "rm-any" })
    expect(decide(input("rm /srv/x"), s, "relaxed")).toMatchObject({ decision: "ask", ruleId: "ask-rm" })
  })

  test("extraAsk raises an allowed severity to ask", () => {
    const s = set({ extraAsk: [{ id: "ask-kill", command: "kill" }] })
    expect(decide(input("kill 1"), s, "relaxed")).toMatchObject({ decision: "ask", ruleId: "ask-kill" })
  })

  test("combine keeps the strongest verdict and the first on a tie", () => {
    expect(combine([])).toEqual({ decision: "allow" })
    expect(
      combine([
        { decision: "ask", ruleId: "a" },
        { decision: "deny", ruleId: "b" },
        { decision: "deny", ruleId: "c" },
        { decision: "allow", ruleId: "d" },
      ]),
    ).toEqual({ decision: "deny", ruleId: "b" })
    expect(combine([{ decision: "allow", ruleId: "a" }, { decision: "allow" }])).toEqual({ decision: "allow", ruleId: "a" })
  })
})
