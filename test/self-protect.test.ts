import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { analyze } from "../src/analyzer"
import { buildRuleSet } from "../src/rules"
import { loadBuiltinRules } from "../src/rules/loader"
import { isProtected, isSecret, PLUGIN_DIR, protectedPaths, type ProtectedPaths } from "../src/rules/self-protect"
import { listeningPorts, serverPorts } from "../src/rules/server-api"
import { loadReadOnlyList } from "../src/rules/ssh-policy"
import type { Mode } from "../src/types"

// Paths that do not exist, so resolution is deterministic.
const HOME = "/ocsp-self/home"
const CWD = "/ocsp-self/repo"
const RULES_FILE = "/ocsp-self/rules/extra.json"
const PATHS = protectedPaths({ home: HOME, env: {}, rulesFile: [RULES_FILE] })
const RULES = buildRuleSet({ rules: loadBuiltinRules() })
const READ_ONLY = loadReadOnlyList()

const CONFIG = `${HOME}/.config/opencode`
const STATE = `${HOME}/.local/state/opencode`
const DATA = `${HOME}/.local/share/opencode`

const run = (command: string, mode: Mode = "relaxed", workdir?: string, protect: ProtectedPaths = PATHS) =>
  analyze({ command, workdir, locationDirectory: CWD, mode, rules: RULES, readOnly: READ_ONLY, home: HOME, protect })

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
    `python3 -c 'import os; os.system("touch .opencode/a")'`,
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

describe("secrets", () => {
  test.each([
    `${CONFIG}/service.json`,
    `${STATE}/service.json`,
    `${STATE}/service-beta.json`,
    `${STATE}/service.json.tmp`,
    `${DATA}/opencode.db`,
    `${DATA}/opencode-beta.db-wal`,
    "/proc/123/environ",
    "/proc/self/environ",
    "/proc/1/task/2/environ",
  ])("%s", (p) => expect(isSecret(p, PATHS)).toBe(true))

  test.each([
    `${CWD}/service.json`,
    `${CONFIG}/opencode.json`,
    `${DATA}/log/x.log`,
    `${DATA}/storage/opencode.db`,
    `${HOME}/.config/service.json`,
    "/proc/1/status",
  ])("%s is not a secret", (p) => expect(isSecret(p, PATHS)).toBe(false))

  test("follow XDG directories, OPENCODE_CONFIG_DIR and OPENCODE_DB", () => {
    const env = { XDG_STATE_HOME: "/st", XDG_DATA_HOME: "/da", OPENCODE_CONFIG_DIR: "/cfg", OPENCODE_DB: "custom.db" }
    const custom = protectedPaths({ home: HOME, env })
    for (const p of ["/st/opencode/service.json", "/cfg/service.json", `${CONFIG}/service.json`])
      expect(isSecret(p, custom)).toBe(true)
    expect(isSecret("/da/opencode/opencode.db", custom)).toBe(true)
    expect(isSecret("/da/opencode/custom.db-shm", custom)).toBe(true)
    expect(isSecret(`${STATE}/service.json`, custom)).toBe(false)
    expect(isSecret("/x/my.sqlite", protectedPaths({ home: HOME, env: { OPENCODE_DB: "/x/my.sqlite" } }))).toBe(true)
    expect(protectedPaths({ home: HOME, env: { OPENCODE_DB: ":memory:" } }).databases).toEqual([])
  })

  test.each([
    `cat ${STATE}/service.json`,
    "cat ~/.config/opencode/service.json",
    `sqlite3 ${DATA}/opencode.db .tables`,
    `cp ${DATA}/opencode.db-wal /tmp/x`,
    "cat < /proc/self/environ",
    "tr '\\0' '\\n' < /proc/1/environ",
    "cat /proc/*/environ",
    "cat /proc/$PPID/environ",
    "head ~/.config/opencode/*",
    "cat ~/.local/state/*/service*",
    "cat ~/.local/share/opencode/*.db",
    "cd ~/.local/state/opencode && cat service.json",
    "ssh h cat x < ~/.config/opencode/service.json",
  ])("%s is denied", (command) => {
    const result = run(command)
    expect([result.decision, result.ruleId]).toEqual(["deny", "self-protect"])
    expect(result.reason).toMatch(/^禁止读写 OpenCode Server 凭据与数据库（\/.+）$/)
  })

  test.each([
    "cat service.json",
    "ls ~/.config/opencode",
    "cat ~/.local/share/opencode/log/*",
    "cat /proc/1/status",
    "ssh h cat ~/.config/opencode/service.json",
  ])("%s is not self-protection", (command) => {
    expect(run(command).ruleId).not.toBe("self-protect")
  })

  test("applies in off mode", () => {
    expect(run(`cat ${STATE}/service.json`, "off").ruleId).toBe("self-protect")
  })
})

describe("server api", () => {
  const known = protectedPaths({ home: HOME, env: {}, ports: () => new Set([4096]) })
  const any = protectedPaths({ home: HOME, env: {}, ports: () => undefined })

  test.each([
    "curl http://127.0.0.1:4096/api/rpc/x",
    "curl localhost:4096/api",
    "curl -X POST 'http://[::1]:4096/api/session'",
    "curl 'http://[::ffff:127.0.0.1]:4096/api/x'",
    "curl http://0:4096/api/x",
    "curl http://127.1:4096/api/x",
    "curl http://127.0.0.1:4096/%61pi/x",
    "curl http://app.localhost:4096//api/x",
    "wget -qO- http://localhost:4096/api/info",
    `python3 -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:4096/api/x")'`,
  ])("%s is denied", (command) => {
    const result = run(command, "relaxed", undefined, known)
    expect([result.decision, result.ruleId]).toEqual(["deny", "self-protect"])
    expect(result.reason).toMatch(/^禁止调用本机 OpenCode Server API（.+）$/)
  })

  test.each([
    "curl http://127.0.0.1:4096/",
    "curl http://127.0.0.1:4096/apix",
    "curl http://127.0.0.1:8001/api/v1/namespaces",
    "curl http://10.255.255.1:4096/api/x",
    "ssh h curl http://127.0.0.1:4096/api/x",
  ])("%s is not self-protection", (command) => {
    expect(run(command, "relaxed", undefined, known).ruleId).not.toBe("self-protect")
  })

  test("applies in off mode and to every port when the ports are unknown", () => {
    expect(run("curl http://127.0.0.1:4096/api/x", "off", undefined, known).ruleId).toBe("self-protect")
    expect(run("curl http://127.0.0.1:8001/api/v1", "relaxed", undefined, any).ruleId).toBe("self-protect")
  })

  test("serverPorts adds registered services to this process's ports", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocsp-server-api-"))
    try {
      writeFileSync(path.join(dir, "service.json"), JSON.stringify({ url: "http://127.0.0.1:5000", pid: 1 }))
      writeFileSync(path.join(dir, "service-beta.json"), JSON.stringify({ port: 5001, password: "x" }))
      writeFileSync(path.join(dir, "service-bad.json"), "{")
      expect([...serverPorts([dir, "/ocsp-missing"], () => [4096])!].sort()).toEqual([4096, 5000, 5001])
      expect(serverPorts([dir], () => [])).toBeUndefined()
      expect(serverPorts([dir], () => undefined)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== "linux")("listeningPorts finds a server of this process", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    try {
      expect(listeningPorts()).toContain(server.port!)
    } finally {
      await server.stop(true)
    }
    expect(listeningPorts()).not.toContain(server.port!)
  })
})
