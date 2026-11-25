/**
 * System-level deployment (design 8, point 2) against a real `opencode`. It rewrites /etc/opencode and
 * /etc/profile.d, so it runs only in a throwaway container: `bun run test:system`.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { expectDenied, Harness, safetyPermissions, STUB_MARK } from "../e2e/harness"
import { ENTER, Tui } from "../e2e/tui-driver"

setDefaultTimeout(120_000)

const SYSTEM_ENABLED = process.env.OCSP_SYSTEM === "1"
if (SYSTEM_ENABLED && !existsSync("/.dockerenv")) throw new Error("test:system rewrites /etc: run it only in a container")

const ROOT = path.resolve(import.meta.dir, "../..")
const ID = "opencode-safety-policy"
const ETC = "/etc/opencode"
const DEPLOY = `${ETC}/safety-policy`
const DISCOVERED = `${ETC}/plugins/safety-policy`
const PROFILE = "/etc/profile.d/opencode-safety.sh"
const POLICIES = [
  { action: "plugin.use", resource: "*", effect: "deny" },
  { action: "plugin.use", resource: DEPLOY, effect: "allow" },
]
const OPTIONS = { mode: "relaxed", protectedEndpoints: { ufmHosts: ["ufm.internal"] } }
const PLUGIN = { package: "./safety-policy", options: OPTIONS }
const FAKE = `export default { id: "${ID}", setup: async () => {} }\n`

let tmp = ""
let tarball = ""

/** Unpacks the package tarball into `dir`, as an offline delivery would. */
function install(dir: string) {
  mkdirSync(dir, { recursive: true })
  const tar = Bun.spawnSync(["tar", "xzf", tarball, "-C", dir, "--strip-components=1"])
  if (tar.exitCode) throw new Error(tar.stderr.toString())
}

/** A clean /etc with the plugin unpacked into `dirs` and `config` as the system opencode.json. */
function system(dirs: string[], config?: object) {
  rmSync(ETC, { recursive: true, force: true })
  rmSync(PROFILE, { force: true })
  dirs.forEach(install)
  if (config) writeFileSync(`${ETC}/opencode.json`, JSON.stringify(config, null, 2))
}

/** A harness whose projects configure only the mock model, plus `project` and `project2` settings. */
function harness(project: object = {}, project2: object = {}) {
  const h = new Harness()
  const { plugins: _, ...base } = JSON.parse(readFileSync(path.join(h.project, "opencode.json"), "utf8"))
  writeFileSync(path.join(h.project, "opencode.json"), JSON.stringify({ ...base, ...project }, null, 2))
  writeFileSync(path.join(h.project2, "opencode.json"), JSON.stringify({ ...base, ...project2 }, null, 2))
  return h
}

/** The plugins with this plugin's ID. The list is empty, builtins included, until the location's plugins load. */
async function listed(h: Harness, directory = h.project) {
  const deadline = Date.now() + 30_000
  let data: any[] = []
  while (!data.length && Date.now() < deadline) {
    data = (await h.api("GET", "/api/plugin", undefined, directory)).data
    if (!data.length) await Bun.sleep(100)
  }
  return data.filter((p) => p.id === ID).map((p) => ({ path: p.source.path, state: p.state }))
}

async function status(h: Harness) {
  return (await h.rpc("status")).body.output
}

function ran(call: { result: string }, command: string) {
  expect(call.result).toContain(`${STUB_MARK} ${command}`)
}

describe.skipIf(!SYSTEM_ENABLED)("system deployment", () => {
  beforeAll(() => {
    // Pack a copy: `bun pm pack` needs a writable package directory.
    tmp = mkdtempSync(path.join(os.tmpdir(), "ocsp-system-"))
    const src = path.join(tmp, "src")
    const skip = new Set(["node_modules", ".git"].map((name) => path.join(ROOT, name)))
    cpSync(ROOT, src, { recursive: true, filter: (file) => !skip.has(file) })
    const pack = path.join(tmp, "pack")
    mkdirSync(pack)
    const packed = Bun.spawnSync(["bun", "pm", "pack", "--destination", pack, "--quiet"], { cwd: src })
    if (packed.exitCode) throw new Error(packed.stderr.toString())
    tarball = path.join(pack, readdirSync(pack)[0]!)
  })

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  describe("design 8.2 deployment", () => {
    let h: Harness

    beforeAll(async () => {
      system([DEPLOY], { policies: POLICIES, plugins: [PLUGIN] })
      h = harness()
      await h.start()
    })

    afterAll(async () => {
      await h?.dispose()
    })

    test("loads from the unpacked tarball without node_modules and receives options", async () => {
      expect(existsSync(path.join(DEPLOY, "node_modules"))).toBe(false)
      expect(await status(h)).toMatchObject({ mode: "relaxed", source: "config", locked: false })
      expect(await listed(h)).toEqual([{ path: DEPLOY, state: { status: "active" } }])
      const decision = async (command: string) => (await h.rpc("test", { command })).body.output.decision
      expect(await decision("curl -X POST http://ufm.internal/ufmRest/actions")).toBe("ask")
      expect(await decision("curl -X POST http://other.internal/actions")).toBe("allow")
    })

    test("guards a project that does not configure it", async () => {
      expectDenied(await h.shell("rm -rf /data"), "rm-system-path")
      const relaxed = await h.shell("kubectl delete pod p1")
      expect(safetyPermissions(relaxed.permissions)).toHaveLength(1)
      ran(relaxed, "kubectl delete pod p1")
    })

    test("the TUI loads /safety from the system directory", async () => {
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

  describe("plugin.use allowlist", () => {
    let h: Harness

    afterAll(async () => {
      await h?.dispose()
    })

    test("blocks a project plugin with the same ID", async () => {
      system([DEPLOY], { policies: POLICIES, plugins: [PLUGIN] })
      h = harness()
      h.write(".opencode/plugins/fake.ts", FAKE)
      await h.start()
      expectDenied(await h.shell("rm -rf /data"), "rm-system-path")
      expect(await listed(h)).toEqual([{ path: DEPLOY, state: { status: "active" } }])
    })

    test("control: without it the project plugin takes the ID and the system plugin fails", async () => {
      await h.dispose()
      system([DEPLOY], { plugins: [PLUGIN] })
      h = harness()
      const fake = h.write(".opencode/plugins/fake.ts", FAKE)
      await h.start()
      ran(await h.shell("rm -rf /data"), "rm -rf /data")
      expect(await listed(h)).toEqual([
        { path: fake, state: { status: "active" } },
        { path: DEPLOY, state: { status: "failed", error: `Duplicate plugin ID: ${ID}` } },
      ])
    })
  })

  describe('project "plugins": ["-*"]', () => {
    let h: Harness
    // A bare "-*" also drops the builtin agents, so a project that still prompts re-enables "opencode.*".
    const UNLOAD = { plugins: ["-*", "opencode.*"] }

    afterAll(async () => {
      await h?.dispose()
    })

    test("cannot unload the configured system plugin", async () => {
      system([DEPLOY], { policies: POLICIES, plugins: [PLUGIN] })
      h = harness(UNLOAD, { plugins: ["-*"] })
      await h.start()
      expectDenied(await h.shell("rm -rf /data"), "rm-system-path")
      expect(await listed(h)).toEqual([{ path: DEPLOY, state: { status: "active" } }])
      expect((await h.rpc("status", {}, h.project2)).body.output).toMatchObject({ mode: "relaxed", source: "config" })
      expect(await listed(h, h.project2)).toEqual([{ path: DEPLOY, state: { status: "active" } }])
    })

    test("control: unloads a plugin that is only auto-discovered", async () => {
      await h.dispose()
      system([DISCOVERED])
      h = harness(UNLOAD)
      await h.start()
      ran(await h.shell("rm -rf /data"), "rm -rf /data")
      expect(await listed(h)).toEqual([])
      expectDenied(await h.shell("rm -rf /data", { directory: h.project2 }), "rm-system-path")
      expect(await listed(h, h.project2)).toEqual([{ path: DISCOVERED, state: { status: "active" } }])
    })
  })

  describe("auto-discovered and configured at once", () => {
    let h: Harness

    afterAll(async () => {
      await h?.dispose()
    })

    test("a second copy in plugins/ wins with empty options and the configured one fails", async () => {
      system([DEPLOY, DISCOVERED], { plugins: [PLUGIN] })
      h = harness()
      await h.start()
      expect(await status(h)).toMatchObject({ mode: "relaxed", source: "default" })
      expect(await listed(h)).toEqual([
        { path: DISCOVERED, state: { status: "active" } },
        { path: DEPLOY, state: { status: "failed", error: `Duplicate plugin ID: ${ID}` } },
      ])
    })

    test("configuring the auto-discovered directory itself is one plugin with options", async () => {
      await h.dispose()
      system([DISCOVERED], { plugins: [{ ...PLUGIN, package: "./plugins/safety-policy" }] })
      h = harness()
      await h.start()
      expect(await status(h)).toMatchObject({ mode: "relaxed", source: "config" })
      expect(await listed(h)).toEqual([{ path: DISCOVERED, state: { status: "active" } }])
    })
  })

  describe("OPENCODE_SAFETY_LOCK_MODE from /etc/profile.d", () => {
    let h: Harness
    const PATH = process.env.PATH

    beforeAll(async () => {
      system([DEPLOY], { policies: POLICIES, plugins: [PLUGIN] })
      writeFileSync(PROFILE, "export OPENCODE_SAFETY_LOCK_MODE=strict\n")
      // Start `opencode` from a login shell, the way a user on the jump host would.
      const bin = path.join(tmp, "login-bin")
      mkdirSync(bin)
      writeFileSync(`${bin}/opencode`, `#!/bin/sh\nexec bash -lc 'exec ${Bun.which("opencode")} "$@"' opencode "$@"\n`)
      chmodSync(`${bin}/opencode`, 0o755)
      process.env.PATH = `${bin}:${PATH}`
      h = harness()
      await h.start()
    })

    afterAll(async () => {
      process.env.PATH = PATH
      await h?.dispose()
      rmSync(PROFILE, { force: true })
    })

    test("locks the mode over the configured relaxed", async () => {
      expect(await status(h)).toMatchObject({ mode: "strict", source: "lock", locked: true })
      const res = await h.rpc("setMode", { mode: "off" })
      expect(JSON.stringify(res.body)).toContain("锁定为 strict")
      expectDenied(await h.shell("kubectl delete pod p1"), "k8s-delete")
    })
  })
})
