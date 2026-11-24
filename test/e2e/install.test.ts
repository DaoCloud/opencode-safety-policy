/**
 * Online install (design 8, point 1): OpenCode installs the plugin from a git ref, as it does for
 * `github:DaoCloud/opencode-safety-policy#<tag>`. A `git+file://` commit of the working tree stands in for GitHub.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { E2E_ENABLED, expectDenied, Harness, REPO } from "./harness"
import { ENTER, Tui } from "./tui-driver"

setDefaultTimeout(180_000)

const ID = "opencode-safety-policy"

/** Commits a copy of the working tree, so uncommitted changes are installed too. */
function commit(dir: string) {
  const skip = new Set(["node_modules", ".git"].map((name) => path.join(REPO, name)))
  cpSync(REPO, dir, { recursive: true, filter: (file) => !skip.has(file) })
  const identity = ["-c", "user.name=ocsp", "-c", "user.email=ocsp@example.invalid", "-c", "commit.gpgsign=false"]
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "install"]]) {
    const git = Bun.spawnSync(["git", ...identity, ...args], { cwd: dir })
    if (git.exitCode) throw new Error(git.stderr.toString())
  }
}

describe.skipIf(!E2E_ENABLED)("install from git", () => {
  let tmp = ""
  let spec = ""
  let h: Harness

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "ocsp-e2e-install-"))
    commit(path.join(tmp, "repo"))
    spec = `git+file://${path.join(tmp, "repo")}`
    h = new Harness()
    const file = path.join(h.project, "opencode.json")
    const config = JSON.parse(readFileSync(file, "utf8"))
    writeFileSync(file, JSON.stringify({ ...config, plugins: [{ package: spec, options: { mode: "relaxed" } }] }))
    await h.start()
  })

  afterAll(async () => {
    await h?.dispose()
    rmSync(tmp, { recursive: true, force: true })
  })

  test("installs only the packed files, without peer dependencies, and receives options", async () => {
    const deadline = Date.now() + 120_000
    let plugin: any
    while (!plugin && Date.now() < deadline) {
      plugin = (await h.api("GET", "/api/plugin")).data.find((p: any) => p.id === ID)
      if (!plugin) await Bun.sleep(200)
    }
    expect(plugin).toMatchObject({ source: { type: "package", target: spec }, state: { status: "active" } })
    expect((await h.rpc("status")).body.output).toMatchObject({ mode: "relaxed", source: "config" })
    expectDenied(await h.shell("rm -rf /data"), "rm-system-path")

    const cache = path.join(h.root, "xdg", "cache")
    const scan = (pattern: string) => [...new Bun.Glob(pattern).scanSync({ cwd: cache, onlyFiles: true })]
    const installed = scan("**/node_modules/@daocloud/opencode-safety-policy/package.json")
    expect(installed).toHaveLength(1)
    const dir = path.join(cache, path.dirname(installed[0]!))
    expect(existsSync(path.join(dir, "index.ts"))).toBe(true)
    expect(existsSync(path.join(dir, "test"))).toBe(false)
    expect(scan("**/node_modules/@opencode/plugin/package.json")).toEqual([])
  })

  test("the TUI loads /safety from the installed package", async () => {
    const tui = new Tui(h)
    try {
      await tui.ready()
      await tui.type("/safety status")
      tui.press(ENTER)
      await tui.waitFor("当前模式：relaxed（source: config）")
    } finally {
      await tui.close()
    }
  })
})
