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
 *
 * Server credentials and the OpenCode database are not read either (design 4.2, "防绕过 `/safety` 与审批"): the
 * `service*.json` files of the configuration and state directories, the `opencode*.db` files of the data directory,
 * the `OPENCODE_DB` file (with their `-wal`, `-shm` and `-journal` files) and every `/proc/<pid>/environ`. A shell atom
 * is denied when a redirect or a local argument names one, read-only commands included; an argument with a glob is
 * matched like the shell would expand it.
 *
 * A local `opencode` is denied when it approves every permission request itself (`--auto` and its aliases) or when
 * its prefix assignments change the safety mode, the configuration that loads this plugin or where it is read from.
 */

import os from "node:os"
import path from "node:path"
import { resolveCanonicalPath } from "../path-util"
import type { Atom } from "../unwrapper"
import type { Verdict } from "./index"
import { serverPorts, type ServerPorts } from "./server-api"
import { isFileWrite, isReadOnly, type ReadOnlyList } from "./ssh-policy"

export const PLUGIN_DIR = path.resolve(import.meta.dir, "../..")

const CONFIG_FILES = new Set(["opencode.json", "opencode.jsonc"])
const CONFIG_DIR = ".opencode"
const ANCESTOR_COMMANDS = new Set(["rm", "rmdir", "mv"])
// `--config=x`, `of=x`, `KEY=x`
const ASSIGNMENT = /^-{0,2}[\w.-]+=/
const GLOB = /[*?[]/
const SERVICE_FILE = /^service.*\.json/
const DATABASE = /^opencode.*\.db(-wal|-shm|-journal)?$/
const DATABASE_SUFFIXES = ["", "-wal", "-shm", "-journal"]
const ENVIRON = /^\/proc\/[^/]+(\/task\/[^/]+)?\/environ$/
// `packages/cli/src/commands/commands.ts`: `--yolo` and `--dangerously-skip-permissions` are hidden aliases of `--auto`.
const AUTO_APPROVE = /^--(auto|yolo|dangerously-skip-permissions)(=|$)/
const OPENCODE_ENV = /^(HOME|XDG_\w+|OPENCODE_(SAFETY_|CONFIG|CLI_CONFIG|DISABLE_PROJECT_CONFIG|DB|DISABLE_CHANNEL_DB)\w*)=/

export interface ProtectedPaths {
  /** Protected with everything below them. */
  roots: string[]
  /** Never protected. */
  exempt: string[]
  /** Directories with Server credentials and service registrations (`service*.json`). */
  serviceDirs: string[]
  /** The OpenCode data directory with `opencode*.db`. */
  dataDir: string
  /** The database set by `OPENCODE_DB`. */
  databases: string[]
  /** The ports of the local OpenCode Servers. */
  ports: ServerPorts
}

export interface ProtectedPathsInput {
  home?: string
  env?: Record<string, string | undefined>
  rulesFile?: string[]
  /** Defaults to `serverPorts`. */
  ports?: ServerPorts
}

/**
 * Where OpenCode reads its configuration from (`packages/core/src/config/discovery.ts`), keeps the service files
 * (`packages/cli/src/services/service-config.ts`) and the database (`packages/cli/src/database-path.ts`).
 */
export function protectedPaths(input: ProtectedPathsInput = {}): ProtectedPaths {
  const home = input.home ?? os.homedir()
  const env = input.env ?? process.env
  const canonical = (p: string) => resolveCanonicalPath(p, process.cwd(), home)
  const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config")
  const configDir = env.OPENCODE_CONFIG_DIR || path.join(configHome, "opencode")
  const roots = [
    PLUGIN_DIR,
    process.platform === "darwin" ? "/Library/Application Support/opencode" : "/etc/opencode",
    configDir,
    ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : []),
    ...(input.rulesFile ?? []),
  ]
  const stateDir = path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "opencode")
  const dataDir = canonical(path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "opencode"))
  const database = env.OPENCODE_DB
  const serviceDirs = [...new Set([configDir, path.join(configHome, "opencode"), stateDir].map(canonical))]
  return {
    roots: roots.map(canonical),
    exempt: [canonical(path.join(home, CONFIG_DIR, "plan"))],
    serviceDirs,
    dataDir,
    databases: database && database !== ":memory:" ? [canonical(path.resolve(dataDir, database))] : [],
    ports: input.ports ?? (() => serverPorts(serviceDirs)),
  }
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

/** Whether the canonical path `p` is a Server credential or database file. */
export function isSecret(p: string, paths: ProtectedPaths): boolean {
  const dir = path.dirname(p)
  const name = path.basename(p)
  if (ENVIRON.test(p)) return true
  if (paths.serviceDirs.includes(dir) && SERVICE_FILE.test(name)) return true
  if (dir === paths.dataDir && DATABASE.test(name)) return true
  return paths.databases.some((db) => DATABASE_SUFFIXES.some((suffix) => p === db + suffix))
}

export function secretVerdict(target: string): Verdict {
  return { decision: "deny", ruleId: "self-protect", reason: `禁止读写 OpenCode Server 凭据与数据库（${target}）` }
}

/** The flag or assignment that makes a local `opencode` bypass approvals or this plugin. */
export function nestedOpencode(atom: Atom): string | undefined {
  if (atom.isRemote || atom.name !== "opencode") return undefined
  return atom.argv.find((arg) => AUTO_APPROVE.test(arg)) ?? atom.assignments.find((word) => OPENCODE_ENV.test(word))
}

export function nestedOpencodeVerdict(target: string): Verdict {
  return { decision: "deny", ruleId: "self-protect", reason: `禁止启动自动批准权限或改写安全模式与配置的 OpenCode（${target}）` }
}

/** The first Server credential or database file that `atom`, running in the local directory `dir`, names. */
export function secretTarget(atom: Atom, dir: string, paths: ProtectedPaths, home = os.homedir()): string | undefined {
  const named = (word: string) => {
    const target = resolveCanonicalPath(word, dir, home)
    return isSecret(target, paths) || (GLOB.test(target) && globMatchesSecret(target, paths)) ? target : undefined
  }
  for (const command of atom.localCommands)
    for (const redirect of command.redirects) {
      const target = named(redirect.target)
      if (target !== undefined) return target
    }
  if (atom.isRemote) return undefined
  for (const arg of atom.argv.slice(1)) {
    const word = arg.replace(ASSIGNMENT, "")
    if (word === "") continue
    const target = named(word)
    if (target !== undefined) return target
  }
  return undefined
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

/** Whether the shell would expand `glob` to a secret, tried on one sample name of each kind. */
function globMatchesSecret(glob: string, paths: ProtectedPaths): boolean {
  const pattern = globPattern(glob)
  const databases = ["opencode.db", "opencode-x.db"].map((name) => path.join(paths.dataDir, name)).concat(paths.databases)
  const samples = [
    ...paths.serviceDirs.flatMap((dir) => ["service.json", "service-x.json"].map((name) => path.join(dir, name))),
    ...databases.flatMap((db) => DATABASE_SUFFIXES.map((suffix) => db + suffix)),
    "/proc/1/environ",
    `/proc/${process.pid}/environ`,
    `/proc/${process.pid}/task/${process.pid}/environ`,
  ]
  return samples.some((sample) => pattern.test(sample))
}

/** `*`, `?` and `[...]` as a regular expression; like the shell, none of them matches `/`. */
function globPattern(glob: string): RegExp {
  let source = ""
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!
    const end = char === "[" ? glob.indexOf("]", i + 2) : -1
    if (char === "*") source += "[^/]*"
    else if (char === "?") source += "[^/]"
    else if (end > 0) {
      source += `(?!/)[${glob.slice(i + 1, end).replace(/^!/, "^").replace(/[\\\]]/g, "\\$&")}]`
      i = end
    } else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${source}$`)
}

/** The path before its first glob segment, since `rm -rf ~/.config/*` removes `~/.config/opencode`. */
function literalPrefix(p: string): string {
  const parts = p.split("/")
  const glob = parts.findIndex((part) => GLOB.test(part))
  return glob < 0 ? p : parts.slice(0, glob).join("/") || "/"
}
