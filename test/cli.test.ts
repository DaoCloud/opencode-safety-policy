import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const CLI = path.resolve(import.meta.dir, "../cli.ts")
let dir: string

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ocsp-cli-"))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function cli(args: string[], env: Record<string, string> = {}) {
  const run = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: dir, env: { ...process.env, ...env } })
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() }
}

describe("cli test", () => {
  test("prints the unwrap chain and the verdict", () => {
    const command = `ssh n1 "sudo bash -c 'rm -rf /data/*'"`
    const reason = "禁止删除根目录或系统关键目录"
    expect(cli(["test", command])).toEqual({
      code: 0,
      stdout: [
        `命令：${command}`,
        "模式：relaxed",
        `结果：deny [rm-system-path] ${reason}`,
        "",
        "1. rm -rf /data/*",
        "   位置：远端 n1",
        "   拆壳链：ssh → sudo → bash -c",
        `   判定：deny [rm-system-path] ${reason}`,
        "",
      ].join("\n"),
      stderr: "",
    })
  })

  test("takes the mode and the options, not the environment", () => {
    const options = path.join(dir, "options.json")
    writeFileSync(options, JSON.stringify({ mode: "off", protectedEndpoints: { bmcCidrs: ["10.0.0.0/24"] } }))
    const post = "curl -X POST http://10.0.0.5/api"
    expect(cli(["test", post], { OPENCODE_SAFETY_MODE: "off" }).stdout).toContain("模式：relaxed\n结果：allow\n")
    expect(cli(["test", "--options", options, post]).stdout).toContain("模式：off\n结果：allow\n")
    expect(cli(["test", "--options", options, "--mode", "relaxed", post]).stdout).toContain(
      "模式：relaxed\n结果：ask [protected-endpoint-write]",
    )
  })

  const invalid = [
    [],
    ["test"],
    ["check", "ls"],
    ["test", "ls", "extra"],
    ["test", "--bogus", "ls"],
    ["test", "--mode", "loose", "ls"],
  ]
  test.each(invalid.map((args) => [args]))("rejects %p with the usage", (args) => {
    const run = cli(args)
    expect(run.code).toBe(2)
    expect(run.stdout).toBe("")
    expect(run.stderr).toContain("用法：bun ./cli.ts test")
  })

  test("reports an unreadable options file", () => {
    const run = cli(["test", "--options", path.join(dir, "missing.json"), "ls"])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain("missing.json")
  })
})
