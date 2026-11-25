/**
 * Path canonicalization (design 3.1 Stage 1, 4.2 self-protection).
 *
 * Paths are resolved component by component the way the kernel resolves them: symlinks are followed and `..`
 * applies to the resolved directory. A missing component is kept as is and the walk continues, so a later `..` can
 * still lead back to existing directories (e.g. `mkdir x && rm -rf x/../link/`).
 */

import { lstatSync, readdirSync, readlinkSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { readOption, OPTION_SPECS, type OptionSpec } from "./cli-options"
import { normalizeName } from "./tokenizer"

// Linux gives up with ELOOP after 40 symlinks.
const MAX_LINKS = 40

/** Resolves `input` against the absolute directory `base`, expanding `~` and `~/` like OpenCode does. */
export function resolveCanonicalPath(input: string, base: string, home = os.homedir()): string {
  const expanded = input === "~" ? home : input.startsWith("~/") ? home + input.slice(1) : input
  const absolute = path.isAbsolute(expanded) ? expanded : `${base}/${expanded}`
  // Bun's realpath normalizes `..` lexically before resolving, which is wrong after a symlink.
  const pending = absolute.split("/").reverse()
  let current = "/"
  let links = 0
  while (pending.length) {
    const part = pending.pop()!
    if (part === "" || part === ".") continue
    if (part === "..") {
      current = path.dirname(current)
      continue
    }
    const next = path.join(current, part)
    const target = link(next)
    if (target === undefined) {
      current = next
      continue
    }
    if (++links > MAX_LINKS) {
      pending.push(part)
      break
    }
    if (target.startsWith("/")) current = "/"
    pending.push(...target.split("/").reverse())
  }
  return path.join(current, ...pending.reverse())
}

/** The symlink target, or `undefined` for anything that is not a readable symlink (including missing paths). */
function link(p: string) {
  try {
    return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : undefined
  } catch {
    return undefined
  }
}

/** The directory a `shell` call runs in: `workdir` resolved against the session directory. */
export function effectiveCwd(workdir: string | undefined, locationDirectory: string, home = os.homedir()): string {
  return resolveCanonicalPath(workdir ?? locationDirectory, locationDirectory, home)
}

/** A symlink and its canonical target. */
export type DirLink = readonly [link: string, target: string]

let rootLinks: DirLink[] | undefined

/**
 * The symlinks directly in `dir`, longest target first, e.g. `/bin` -> `/usr/bin` (usrmerge) and `/etc` ->
 * `/private/etc` (macOS). Loops and links to `/` are left out.
 */
export function dirLinks(dir: string): DirLink[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const links: DirLink[] = []
  for (const name of names) {
    const p = path.join(dir, name)
    if (link(p) === undefined) continue
    const target = resolveCanonicalPath(p, dir)
    if (target !== p && target !== "/") links.push([p, target])
  }
  return links.sort((a, b) => b[1].length - a[1].length)
}

/** The canonical path `p` with a link target replaced by the link, e.g. `/usr/bin/x` -> `/bin/x`. */
export function linkAlias(p: string, links: readonly DirLink[]): string | undefined {
  for (const [alias, target] of links) {
    if (p === target || p.startsWith(`${target}/`)) return alias + p.slice(target.length)
  }
  return undefined
}

interface PathCommand {
  spec: OptionSpec
  /** Options whose value is a path operand, e.g. `-t` of `mv`. */
  pathOptions?: string[]
  /** Leading positionals that are not paths, e.g. the mode of `chmod`. */
  leading?: number
}

// The coreutils parse with getopt_long. None of their flags is a prefix of a value name, so the value names are
// enough to expand abbreviated long options.
const spec = (shortValue: string, longValue: string[] = []): OptionSpec => ({
  shortValue,
  longValue: new Set(longValue),
  longNames: longValue,
})
const plain: PathCommand = { spec: spec("") }
const ownership: PathCommand = { spec: spec("", ["reference", "from"]), leading: 1 }
const copy: PathCommand = {
  spec: spec("St", ["suffix", "target-directory", "no-preserve"]),
  pathOptions: ["-t", "--target-directory"],
}

const PATH_COMMANDS: Record<string, PathCommand> = {
  rm: plain,
  rmdir: plain,
  unlink: plain,
  tee: plain,
  shred: { spec: spec("ns", ["iterations", "size", "random-source"]) },
  truncate: { spec: spec("rs", ["reference", "size"]) },
  chmod: { spec: spec("", ["reference"]), leading: 1 },
  chown: ownership,
  chgrp: ownership,
  mv: copy,
  cp: copy,
  sudoedit: { spec: OPTION_SPECS.sudo },
}

/**
 * For path-sensitive commands, rewrites path operands to canonical absolute paths so that rules see
 * `rm -rf /etc` for `rm -rf etc` run in `/`. Arguments with `$` or backticks are left as they are. When a path is
 * under the target of one of `links`, `aliased` has it under the link instead, so that `rm -rf /bin` is also seen
 * as such where `/bin` links to `/usr/bin` (design 3.1 Stage 1).
 */
export function expandPathArgs(
  argv: string[],
  expanded: boolean[],
  cwd: string,
  home = os.homedir(),
  links: readonly DirLink[] = (rootLinks ??= dirLinks("/")),
): { argv: string[]; paths: string[]; aliased?: string[] } {
  const out = [...argv]
  const paths: string[] = []
  const aliases = new Map<number, string>()
  const rewrite = (i: number, prefix = "") => {
    const arg = argv[i]!.slice(prefix.length)
    if (arg === "" || (expanded[i] && /[$`]/.test(arg))) return
    const resolved = resolveCanonicalPath(arg, cwd, home)
    out[i] = prefix + resolved
    paths.push(resolved)
    const alias = linkAlias(resolved, links)
    if (alias !== undefined) aliases.set(i, prefix + alias)
  }
  const result = () => {
    if (!aliases.size) return { argv: out, paths }
    return { argv: out, paths, aliased: out.map((arg, i) => aliases.get(i) ?? arg) }
  }
  const name = normalizeName(argv[0] ?? "")

  if (name === "dd") {
    argv.forEach((arg, i) => {
      if (/^(if|of)=/.test(arg)) rewrite(i, arg.slice(0, 3))
    })
    return result()
  }

  if (name === "find") {
    let i = 1
    while (i < argv.length && /^-([HLP]+|D|O\d*)$/.test(argv[i]!)) i += argv[i] === "-D" ? 2 : 1
    // GNU find searches `.` when no start path is given.
    if (i >= argv.length || /^[-(!),]/.test(argv[i]!)) {
      const at = Math.min(i, argv.length)
      const withDot = [...argv.slice(0, at), ".", ...argv.slice(at)]
      return expandPathArgs(withDot, [...expanded.slice(0, at), false, ...expanded.slice(at)], cwd, home, links)
    }
    for (; i < argv.length && !/^[-(!),]/.test(argv[i]!); i++) rewrite(i)
    return result()
  }

  const command = Object.hasOwn(PATH_COMMANDS, name) ? PATH_COMMANDS[name] : undefined
  if (!command) return result()
  const reference = argv.some((_, i) => i > 0 && readOption(argv, i, command.spec)?.name === "--reference")
  let leading = reference ? 0 : (command.leading ?? 0)
  let ended = false
  for (let i = 1; i < argv.length; ) {
    const arg = argv[i]!
    if (!ended && arg === "--") {
      ended = true
      i++
      continue
    }
    // `chmod -w file`: a symbolic mode that looks like an option.
    const mode = name === "chmod" && leading > 0 && /^-[rwxXst]+$/.test(arg)
    const option = ended || mode ? undefined : readOption(argv, i, command.spec)
    if (option) {
      if (option.value !== undefined && command.pathOptions?.includes(option.name)) {
        if (option.next === i + 2) rewrite(i + 1)
        else rewrite(i, arg.slice(0, arg.length - option.value.length))
      }
      i = option.next
      continue
    }
    if (leading > 0) leading--
    else rewrite(i)
    i++
  }
  return result()
}
