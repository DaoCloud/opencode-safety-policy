/**
 * Self-protection (design 4.2): the agent must not modify this plugin, the OpenCode configuration or `rulesFile`.
 *
 * Protected are fixed roots with everything below them (the plugin package, the system and global configuration
 * directories, the `OPENCODE_CONFIG` file and `rulesFile`) and any `opencode.json` / `opencode.jsonc` file or
 * `.opencode/` directory, except `~/.opencode/plan/` that plan mode writes to. Paths are compared after
 * `resolveCanonicalPath`.
 *
 * A shell atom is denied when a local redirect writes a protected path or, unless the command is on the read-only list,
 * when it runs in a protected directory or an argument names a protected path. `rm`, `rmdir` and `mv` are also denied
 * on an ancestor of a fixed root. Only static paths are seen: interpreters and scripts can still write protected files.
 */

import os from "node:os"
import path from "node:path"
import { resolveCanonicalPath } from "../path-util"
import type { Atom } from "../unwrapper"
import type { Verdict } from "./index"
import { isFileWrite, isReadOnly, type ReadOnlyList } from "./ssh-policy"

export const PLUGIN_DIR = path.resolve(import.meta.dir, "../..")

const CONFIG_FILES = new Set(["opencode.json", "opencode.jsonc"])
const CONFIG_DIR = ".opencode"
const ANCESTOR_COMMANDS = new Set(["rm", "rmdir", "mv"])
// `--config=x`, `of=x`, `KEY=x`
const ASSIGNMENT = /^-{0,2}[\w.-]+=/
const GLOB = /[*?[]/

export interface ProtectedPaths {
  /** Protected with everything below them. */
  roots: string[]
  /** Never protected. */
  exempt: string[]
}

export interface ProtectedPathsInput {
  home?: string
  env?: Record<string, string | undefined>
  rulesFile?: string[]
}

/** Where OpenCode reads its configuration from (`packages/core/src/config/discovery.ts`). */
export function protectedPaths(input: ProtectedPathsInput = {}): ProtectedPaths {
  const home = input.home ?? os.homedir()
  const env = input.env ?? process.env
  const canonical = (p: string) => resolveCanonicalPath(p, process.cwd(), home)
  const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config")
  const roots = [
    PLUGIN_DIR,
    process.platform === "darwin" ? "/Library/Application Support/opencode" : "/etc/opencode",
    env.OPENCODE_CONFIG_DIR || path.join(configHome, "opencode"),
    ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : []),
    ...(input.rulesFile ?? []),
  ]
  return { roots: roots.map(canonical), exempt: [canonical(path.join(home, CONFIG_DIR, "plan"))] }
}

/** `p` must be canonical. */
export function isProtected(p: string, paths: ProtectedPaths): boolean {
  if (paths.exempt.some((dir) => within(p, dir))) return false
  if (paths.roots.some((root) => within(p, root))) return true
  const parts = p.split("/")
  return parts.includes(CONFIG_DIR) || CONFIG_FILES.has(parts.at(-1)!)
}

export function selfProtectVerdict(target: string): Verdict {
  return { decision: "deny", ruleId: "self-protect", reason: `禁止修改安全插件与 OpenCode 配置（${target}）` }
}

/** The first protected path that `atom`, running in the local directory `dir`, may modify. */
export function protectedTarget(
  atom: Atom,
  dir: string,
  paths: ProtectedPaths,
  readOnly: ReadOnlyList,
  home = os.homedir(),
): string | undefined {
  const resolve = (p: string) => resolveCanonicalPath(p, dir, home)
  for (const command of atom.localCommands)
    for (const redirect of command.redirects) {
      if (!isFileWrite(redirect)) continue
      const target = resolve(redirect.target)
      if (isProtected(target, paths)) return target
    }
  if (atom.isRemote || !atom.argv.length || isReadOnly(atom.argv, readOnly)) return undefined
  if (isProtected(dir, paths)) return dir
  const ancestor = ANCESTOR_COMMANDS.has(atom.name)
  for (const arg of atom.argv.slice(1)) {
    const word = arg.replace(ASSIGNMENT, "")
    if (word === "") continue
    const target = resolve(word)
    if (isProtected(target, paths)) return target
    if (ancestor && paths.roots.some((root) => within(root, literalPrefix(target)))) return target
  }
  return undefined
}

function within(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir === "/" ? dir : `${dir}/`)
}

/** The path before its first glob segment, since `rm -rf ~/.config/*` removes `~/.config/opencode`. */
function literalPrefix(p: string): string {
  const parts = p.split("/")
  const glob = parts.findIndex((part) => GLOB.test(part))
  return glob < 0 ? p : parts.slice(0, glob).join("/") || "/"
}
