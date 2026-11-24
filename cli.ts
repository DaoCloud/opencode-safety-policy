#!/usr/bin/env bun
/**
 * Offline dry run of a shell command (design 5.3), printed like `/safety test`:
 * `bun ./cli.ts test [--mode strict|relaxed|off] [--options <file>] "<cmd>"`.
 *
 * It uses the built-in rules and the current directory as the Location. `--options` reads a JSON file in the
 * `plugins[].options` format. The mode defaults to `strict`; the environment and the runtime state are not read.
 */

import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { MODES } from "./src/config"
import { createPolicy } from "./src/policy"
import { formatTest } from "./src/report"
import { dryRun } from "./src/rpc-handlers"
import type { Mode } from "./src/types"

const USAGE = '用法：bun ./cli.ts test [--mode strict|relaxed|off] [--options <file>] "<命令>"'

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

let args
try {
  args = parseArgs({
    args: process.argv.slice(2),
    options: { mode: { type: "string" }, options: { type: "string" } },
    allowPositionals: true,
  })
} catch (error) {
  fail(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
}
const { values, positionals } = args
const [action, command] = positionals
if (action !== "test" || !command || positionals.length > 2) fail(USAGE)
const mode = values.mode
if (mode !== undefined && !MODES.includes(mode as Mode)) fail(`--mode 须为 ${MODES.join("、")}\n${USAGE}`)

let options: unknown = {}
if (values.options !== undefined) {
  try {
    options = JSON.parse(readFileSync(values.options, "utf8"))
  } catch (error) {
    fail(`无法读取 ${values.options}：${error instanceof Error ? error.message : String(error)}`)
  }
}
if (mode !== undefined) options = { ...(options as object), mode }

const storage = { get: async () => undefined, set: async () => {} }
const policy = createPolicy({ options, storage, env: {} })
console.log(formatTest(command, await dryRun(policy, process.cwd(), { command })))
