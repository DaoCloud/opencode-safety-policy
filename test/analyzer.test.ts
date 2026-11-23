import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { analyze, type AnalyzeInput } from "../src/analyzer"
import { buildRuleSet } from "../src/rules"
import { loadBuiltinRules, RuleError } from "../src/rules/loader"
import { loadReadOnlyList } from "../src/rules/ssh-policy"
import type { InlineRule } from "../src/types"

// Paths that do not exist, so path expansion is deterministic.
const CWD = "/ocsp-analyzer/work/project"
const HOME = "/ocsp-analyzer/home"
const BUILTIN = loadBuiltinRules()
const RULES = buildRuleSet({ rules: BUILTIN })
const READ_ONLY = loadReadOnlyList()

const run = (command: string, options: Partial<AnalyzeInput> = {}) =>
  analyze({ command, locationDirectory: CWD, mode: "strict", rules: RULES, readOnly: READ_ONLY, home: HOME, ...options })
const verdict = (command: string, options: Partial<AnalyzeInput> = {}) => {
  const result = run(command, options)
  return [result.decision, result.ruleId]
}

describe("working directory", () => {
  test.each([
    ["rm -rf etc", { workdir: "/" }],
    ["rm -rf etc", { locationDirectory: "/" }],
    ["rm -rf etc", { workdir: "../../.." }],
    ["cd / && rm -rf etc", {}],
    ["cd .. && cd .. && cd .. && rm -rf etc", {}],
    ["cd && rm -rf ../..", {}],
    ["pushd / && rm -rf etc", {}],
    ["cd /tmp; cd /; rm -rf etc", {}],
    ["env -C / rm -rf etc", {}],
    ["sudo -D / rm -rf etc", {}],
    ["cd $X && rm -rf /etc", {}],
    ["sudo -i rm -rf /etc", {}],
  ])("%s %o is denied", (command, options) => {
    expect(verdict(command, options)).toEqual(["deny", "rm-system-path"])
  })

  test.each(["cd $X && rm -rf etc", "cd - && rm -rf etc", "sudo -i rm -rf ..", "su - -c 'rm -rf ..'"])(
    "%s asks when the directory is unknown",
    (command) => {
      const result = run(command)
      expect([result.decision, result.ruleId]).toEqual(["ask", "rm-system-path"])
      expect(result.reason).toContain("工作目录无法静态确定")
    },
  )

  test("a directory that cannot be determined does not turn local cleanup into a system path", () => {
    expect(verdict("cd $X && rm -rf build")).toEqual(["ask", "rm-local"])
  })

  test("too many directories fall back to an unknown one", () => {
    const cds = Array.from({ length: 8 }, (_, i) => `cd /ocsp-analyzer/d${i}`).join("; ")
    expect(verdict(`${cds}; rm -rf etc`)).toEqual(["ask", "rm-system-path"])
  })
})

describe("wrappers and stdin", () => {
  test.each([
    "nice -n 5 rm -rf /",
    "command rm -rf /",
    `eval "rm -rf /"`,
    "su -c 'rm -rf /'",
    "bash <<EOF\nrm -rf /\nEOF",
    "ssh node1 <<'EOF'\nrm -rf /\nEOF",
    `"$(go env GOPATH)/bin/sudo" rm -rf /`,
  ])("%s is denied", (command) => {
    expect(verdict(command)).toEqual(["deny", "rm-system-path"])
  })

  test("heredoc input of a database client is matched", () => {
    expect(verdict("psql -h db <<SQL\nDROP TABLE users;\nSQL")).toEqual(["deny", "sql-drop"])
  })

  test("xargs input is a variable operand", () => {
    expect(verdict("find / -name x | xargs rm -rf")).toEqual(["deny", "rm-recursive-variable"])
    expect(verdict("find / -name x | xargs rm -rf", { mode: "relaxed" })).toEqual(["ask", "rm-recursive-variable"])
  })
})

describe("fail-closed atoms", () => {
  test.each([
    ["$CMD -rf /", "dynamic-command"],
    ["/bin/r[m] -rf /", "dynamic-command"],
    ["{rm,-rf,/}", "dynamic-command"],
    ["ssh node1 '$CMD'", "dynamic-command"],
    ["case x in *) rm -rf / ;; esac", "opaque"],
    ["f() { ls; }; f", "opaque"],
  ])("%s is denied in strict, asked in relaxed and allowed in off", (command, ruleId) => {
    expect(verdict(command)).toEqual(["deny", ruleId])
    expect(verdict(command, { mode: "relaxed" })).toEqual(["ask", ruleId])
    expect(verdict(command, { mode: "off" })).toEqual(["allow", undefined])
  })

  test("a literal basename behind a dynamic directory is matched as that command", () => {
    expect(verdict("$PREFIX/bin/rm -rf /")).toEqual(["deny", "rm-system-path"])
  })
})

describe("remote commands", () => {
  test.each([
    "ssh node1 ls -la /",
    "ssh node1 'ps aux | grep kubelet'",
    "ssh node1 'cd /var/log && grep -r error . 2>/dev/null'",
    "ssh node1 'journalctl -u kubelet 2>&1'",
    "ssh node1 kubectl -n prod get pods",
    "ssh jump ipmitool -I lanplus -H bmc1 -U admin -P x sel list",
    "kubectl exec pod -- ls /data",
    "ssh node1 'echo $HOSTNAME; uptime'",
  ])("read-only %s is allowed", (command) => {
    expect(verdict(command)).toEqual(["allow", undefined])
  })

  test.each([
    "ssh node1 /opt/ops/reset.sh",
    "ssh node1 'cat a > /tmp/b'",
    "ssh node1 docker run ps",
    "ssh node1 '> /tmp/x'",
    "ssh node1 <<'EOF'\n/opt/ops/reset.sh\nEOF",
  ])("unknown %s asks in strict and is allowed in relaxed", (command) => {
    expect(verdict(command)).toEqual(["ask", "unknown-remote-command"])
    expect(verdict(command, { mode: "relaxed" })).toEqual(["allow", undefined])
  })

  test.each([
    ["ssh node1 nvidia-smi -r", "nvidia-smi-reset"],
    ["ssh node1 rm /tmp/x", "remote-rm"],
    ["ssh jump ipmitool -H bmc1 sensor thresh CPU1 upper 90 95 100", "ipmitool-bmc-write"],
  ])("rules win over the allowlist: %s", (command, ruleId) => {
    expect(verdict(command)).toEqual(["deny", ruleId])
  })

  test("sshReadOnlyAllowlist adds commands", () => {
    expect(verdict("ssh node1 ibdiagnet")).toEqual(["ask", "unknown-remote-command"])
    expect(verdict("ssh node1 ibdiagnet", { readOnly: loadReadOnlyList(["ibdiagnet"]) })).toEqual(["allow", undefined])
  })

  test("extraAllow exempts an unknown remote command", () => {
    const allow: InlineRule[] = [{ id: "deploy-ok", command: "deploy.sh", scope: "remote" }]
    const rules = buildRuleSet({ rules: BUILTIN, extraAllow: allow })
    const result = run("ssh node1 /opt/deploy.sh", { rules })
    expect(result.decision).toBe("allow")
    expect(result.atoms[0]?.ruleId).toBe("deploy-ok")
  })
})

describe("result", () => {
  test("reports every atom with its context", () => {
    const result = run("ls && ssh node1 'sudo rm /tmp/x'")
    expect(result).toEqual({
      decision: "deny",
      ruleId: "remote-rm",
      reason: expect.any(String),
      atoms: [
        { argv: ["ls"], isRemote: false, wrapperChain: [], decision: "allow" },
        {
          argv: ["rm", "/tmp/x"],
          isRemote: true,
          targetHost: "node1",
          wrapperChain: ["ssh", "sudo"],
          decision: "deny",
          ruleId: "remote-rm",
          reason: expect.any(String),
        },
      ],
    })
  })

  test("an empty command is allowed", () => {
    expect(run("")).toEqual({ decision: "allow", atoms: [] })
  })

  test("off allows everything", () => {
    expect(verdict("rm -rf /", { mode: "off" })).toEqual(["allow", undefined])
  })
})

describe("loadReadOnlyList", () => {
  test("rejects a file without non-empty string commands", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocsp-readonly-"))
    const file = path.join(dir, "ssh-readonly.json")
    writeFileSync(file, JSON.stringify({ commands: ["ls", " "] }))
    expect(() => loadReadOnlyList([], file)).toThrow(RuleError)
  })
})
