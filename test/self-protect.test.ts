import { describe, expect, test } from "bun:test"
import { analyze } from "../src/analyzer"
import { buildRuleSet } from "../src/rules"
import { loadBuiltinRules } from "../src/rules/loader"
import { isProtected, PLUGIN_DIR, protectedPaths } from "../src/rules/self-protect"
import { loadReadOnlyList } from "../src/rules/ssh-policy"
import type { Mode } from "../src/types"

// Paths that do not exist, so resolution is deterministic.
const HOME = "/ocsp-self/home"
const CWD = "/ocsp-self/repo"
const RULES_FILE = "/ocsp-self/rules/extra.json"
const PATHS = protectedPaths({ home: HOME, env: {}, rulesFile: [RULES_FILE] })
const RULES = buildRuleSet({ rules: loadBuiltinRules() })
const READ_ONLY = loadReadOnlyList()

const run = (command: string, mode: Mode = "relaxed", workdir?: string) =>
  analyze({ command, workdir, locationDirectory: CWD, mode, rules: RULES, readOnly: READ_ONLY, home: HOME, protect: PATHS })

describe("protected paths", () => {
  test.each([
    `${PLUGIN_DIR}/index.ts`,
    "/etc/opencode/opencode.json",
    `${HOME}/.config/opencode`,
    `${HOME}/.config/opencode/plugins/x.ts`,
    RULES_FILE,
    `${CWD}/opencode.json`,
    `${CWD}/sub/opencode.jsonc`,
    `${CWD}/.opencode`,
    `${CWD}/.opencode/agent/a.md`,
    `${HOME}/.opencode/bin/x`,
  ])("%s", (p) => expect(isProtected(p, PATHS)).toBe(true))

  test.each([
    `${HOME}/.opencode/plan`,
    `${HOME}/.opencode/plan/a.md`,
    `${CWD}/opencode.json.bak`,
    `${CWD}/src/a.ts`,
    "/etc/opencode-old/x",
    `${HOME}/.config/other`,
    "/ocsp-self/rules/other.json",
  ])("%s is not protected", (p) => expect(isProtected(p, PATHS)).toBe(false))

  test("follow OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME and OPENCODE_CONFIG", () => {
    const custom = protectedPaths({ home: HOME, env: { OPENCODE_CONFIG_DIR: "/cfg", XDG_CONFIG_HOME: "/xdg", OPENCODE_CONFIG: "/x/my.json" } })
    expect(isProtected("/cfg/a", custom)).toBe(true)
    expect(isProtected("/x/my.json", custom)).toBe(true)
    expect(isProtected("/xdg/opencode/a", custom)).toBe(false)
    expect(isProtected(`${HOME}/.config/opencode/a`, custom)).toBe(false)
    expect(isProtected("/xdg/opencode/a", protectedPaths({ home: HOME, env: { XDG_CONFIG_HOME: "/xdg" } }))).toBe(true)
  })
})

describe("shell", () => {
  test.each([
    "echo x > .opencode/a",
    "cat > opencode.json <<EOF\n{}\nEOF",
    "echo x >> ~/.config/opencode/opencode.json",
    "rm ~/.config/opencode/opencode.json",
    "sed -i s/a/b/ opencode.jsonc",
    "cp /tmp/x /ocsp-self/rules/extra.json",
    "dd if=/dev/zero of=opencode.json",
    "make CONFIG=.opencode/x",
    "sudo tee /etc/opencode/opencode.json",
    `rm ${PLUGIN_DIR}/index.ts`,
    "cd .opencode && touch a",
    "cd /etc/opencode && git checkout .",
    "env -C /etc/opencode touch a",
    "cd $X && touch .opencode/a",
    "sudo -i touch .opencode/a",
    "rm -rf ~/.config",
    "rm -rf ~/.config/*",
    "mv /ocsp-self/rules /tmp/r",
    "bash -c 'echo x' > opencode.json",
    "ssh h cat /etc/x > .opencode/x",
    "kubectl exec p -- cat /x > opencode.json",
  ])("%s is denied", (command) => {
    const result = run(command)
    expect([result.decision, result.ruleId]).toEqual(["deny", "self-protect"])
    expect(result.reason).toMatch(/^禁止修改安全插件与 OpenCode 配置（\/.+）$/)
  })

  test.each([
    "cat opencode.json",
    "ls -la .opencode ~/.config/opencode",
    "grep -r x /etc/opencode",
    "cd .opencode && ls",
    "cat opencode.json > /tmp/backup.json",
    "echo x > ~/.opencode/plan/a.md",
    "echo x > /dev/null",
    "touch src/a.ts",
    "git commit -m 'update .opencode/agent'",
    "rm -rf ~/.config/other",
    "cd $X && touch a",
    "ssh h touch .opencode/x",
  ])("%s is not self-protection", (command) => {
    expect(run(command).ruleId).not.toBe("self-protect")
  })

  test("checks workdir", () => {
    expect(run("touch a", "relaxed", "/etc/opencode").ruleId).toBe("self-protect")
    expect(run("ls", "relaxed", "/etc/opencode").decision).toBe("allow")
  })

  test("applies in every mode", () => {
    expect(run("rm ~/.config/opencode/opencode.json", "strict").ruleId).toBe("self-protect")
    expect(run("rm ~/.config/opencode/opencode.json", "off").decision).toBe("deny")
    expect(run("rm -rf /var", "off").decision).toBe("allow")
  })
})
