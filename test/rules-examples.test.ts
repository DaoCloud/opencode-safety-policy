import { describe, expect, test } from "bun:test"
import path from "node:path"
import { expandPathArgs } from "../src/path-util"
import { compileRule, matchRule, type MatchInput } from "../src/rules/matcher"
import { buildRuleSet } from "../src/rules"
import { BUILTIN_RULES_DIR, loadBuiltinRules, validateRule } from "../src/rules/loader"
import { tokenize } from "../src/tokenizer"
import type { Rule } from "../src/types"
import { unwrap } from "../src/unwrapper"

// Paths that do not exist, so path expansion is deterministic.
const CWD = "/ocsp-examples/work/project"
const HOME = "/ocsp-examples/home"

const FIXTURE_RULES: Rule[] = [
  {
    id: "k8s-delete",
    severity: "high",
    reason: "deletes Kubernetes resources",
    command: "kubectl",
    subcommands: ["delete", "del"],
    examples: {
      match: [
        "kubectl delete pod nginx",
        "kubectl -n prod delete deploy api",
        "kubectl --kubeconfig /tmp/kc --as admin del pod x",
        "sudo /usr/local/bin/kubectl delete pod x",
        "ssh node1 'kubectl --context prod delete ns x'",
        "echo $(kubectl delete pod x)",
        "bash -c 'kubectl delete pod x'",
      ],
      ignore: ["kubectl get pods", "echo kubectl delete", "kubectl get pod delete", "grep 'kubectl delete' audit.log"],
    },
  },
  {
    id: "k8s-scale-zero",
    severity: "high",
    reason: "scales a workload to zero",
    command: "kubectl",
    subcommands: ["scale"],
    flags: ["--replicas=0"],
    examples: {
      match: ["kubectl scale --replicas=0 deploy/api", "kubectl -n prod scale deploy/api --replicas 0"],
      ignore: ["kubectl scale --replicas=3 deploy/api", "kubectl get deploy --replicas=0"],
    },
  },
  {
    id: "container-destroy",
    severity: "high",
    reason: "stops or removes containers",
    command: ["docker", "nerdctl", "podman"],
    subcommands: ["rm", "rmi", "stop", "compose down", "system prune"],
    examples: {
      match: [
        "docker rm -f app",
        "podman stop web",
        "docker -H tcp://h:2375 rm app",
        "docker compose -f prod.yml down",
        "nerdctl system prune -af",
      ],
      ignore: ["docker ps", "docker run --name rm alpine", "docker compose up -d", "echo docker rm app"],
    },
  },
  {
    id: "rm-system-path",
    severity: "critical",
    reason: "recursively deletes a system path",
    command: "rm",
    flags: ["-r", "-R", "--recursive"],
    pattern: "(^| )/(etc|usr|var|boot)?/?( |$)",
    examples: {
      match: ["rm -rf /", "rm -fr /etc/", "rm --recursive /usr", "rm -rf ../../../..", "cd /tmp && rm -Rf /var"],
      ignore: ["rm -rf ./build", "rm /etc/hosts", "rm -rf /etc/app/cache", "echo rm -rf /"],
    },
  },
  {
    id: "remote-rm",
    severity: "high",
    reason: "deletes files on a remote host",
    command: "rm",
    scope: "remote",
    examples: {
      match: ["ssh node1 rm /tmp/x", "ssh -p 22 root@node1 'rm -f /var/log/x'", "kubectl exec pod -- rm /data/x"],
      ignore: ["rm /tmp/x", "ssh node1 ls /tmp"],
    },
  },
  {
    id: "mkfs",
    severity: "critical",
    reason: "formats a file system",
    pattern: "^mkfs(\\.\\w+)? ",
    examples: {
      match: ["mkfs.ext4 /dev/sdb1", "sudo /sbin/mkfs -t xfs /dev/sdc"],
      ignore: ["echo mkfs.ext4 /dev/sdb1", "man mkfs"],
    },
  },
]

/** Atoms of a command line as the analyzer sees them: local path arguments are expanded to absolute paths. */
function atomInputs(line: string): MatchInput[] {
  return unwrap(tokenize(line)).map((atom) => ({
    argv: atom.isRemote ? atom.argv : expandPathArgs(atom.argv, atom.expanded, CWD, HOME).argv,
    isRemote: atom.isRemote,
  }))
}

function exampleCases(rules: Rule[]) {
  return rules.flatMap((rule) => [
    ...(rule.examples?.match ?? []).map((line) => [rule.id, "match", line, rule] as const),
    ...(rule.examples?.ignore ?? []).map((line) => [rule.id, "ignore", line, rule] as const),
  ])
}

const BUILTIN_RULES = loadBuiltinRules()

describe("built-in rules", () => {
  test("load into one rule set with unique ids", () => {
    expect(BUILTIN_RULES.length).toBeGreaterThan(0)
    expect(() => buildRuleSet({ rules: BUILTIN_RULES })).not.toThrow()
  })

  test.each(BUILTIN_RULES.map((rule) => [rule.id, rule] as const))("%s has enough examples", (_id, rule) => {
    expect(rule.examples?.match.length).toBeGreaterThanOrEqual(2)
    expect(rule.examples?.ignore.length).toBeGreaterThanOrEqual(2)
    expect(rule.examples?.ignore.some((line) => line.includes("echo "))).toBe(true)
  })

  test.each(exampleCases(BUILTIN_RULES))("%s %s: %s", (_id, kind, line, rule) => {
    const compiled = compileRule(rule)
    expect(atomInputs(line).some((input) => matchRule(compiled, input))).toBe(kind === "match")
  })
})

test("ssh-readonly.json lists unique non-empty command prefixes", async () => {
  const data = await Bun.file(path.join(BUILTIN_RULES_DIR, "ssh-readonly.json")).json()
  expect(Object.keys(data)).toEqual(["commands"])
  expect(data.commands.length).toBeGreaterThan(0)
  for (const entry of data.commands) expect(entry).toMatch(/^\S+( \S+)*$/)
  expect(new Set(data.commands).size).toBe(data.commands.length)
})

describe("fixture rules", () => {
  test("are valid", () => {
    for (const rule of FIXTURE_RULES) expect(validateRule(rule, "fixture")).toBe(rule)
  })

  test.each(exampleCases(FIXTURE_RULES))("%s %s: %s", (_id, kind, line, rule) => {
    const compiled = compileRule(rule)
    expect(atomInputs(line).some((input) => matchRule(compiled, input))).toBe(kind === "match")
  })
})
