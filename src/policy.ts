/**
 * Policy assembly for the hooks (design 5.2).
 *
 * Creating a policy never throws, because a plugin whose setup fails is not loaded and leaves every tool unguarded.
 * Invalid options or a broken read-only list are kept and rethrown by `load()`; rule files are reloaded by `load()`
 * when they change and throw until fixed. The hooks deny every tool call while `load()` throws, except in `off` mode.
 * The mode does not depend on `load()`: with invalid options it resolves without `options.mode`.
 */

import os from "node:os"
import { createRuleProvider, parseOptions, type RuleProvider } from "./config"
import type { RuleSet } from "./rules"
import { protectedPaths, type ProtectedPaths } from "./rules/self-protect"
import { loadReadOnlyList, type ReadOnlyList } from "./rules/ssh-policy"
import { createModeState, type ModeState, type ModeStorage } from "./state"
import type { Mode, PluginOptions } from "./types"

export interface Loaded {
  options: PluginOptions
  rules: RuleSet
  readOnly: ReadOnlyList
  protect: ProtectedPaths
}

export interface Policy {
  readonly mode: ModeState
  /** Expands `~` and locates the global configuration. */
  readonly home: string
  /** Current options and rules. Throws when they are invalid. */
  load(): Loaded
}

export interface PolicyInput {
  /** Raw `plugins[].options`. */
  options: unknown
  storage: ModeStorage
  env?: Record<string, string | undefined>
  home?: string
  now?: () => number
}

export function createPolicy(input: PolicyInput): Policy {
  const home = input.home ?? os.homedir()
  let ready: { options: PluginOptions; provider: RuleProvider; readOnly: ReadOnlyList; protect: ProtectedPaths } | undefined
  let failure: unknown
  try {
    const options = parseOptions(input.options)
    ready = {
      options,
      provider: createRuleProvider(options),
      readOnly: loadReadOnlyList(options.sshReadOnlyAllowlist),
      protect: protectedPaths({ home, env: input.env, rulesFile: options.rulesFile }),
    }
  } catch (error) {
    failure = error
  }
  const mode = createModeState({ storage: input.storage, env: input.env, now: input.now, configMode: ready?.options.mode })
  return {
    mode,
    home,
    load() {
      if (!ready) throw failure
      return { options: ready.options, rules: ready.provider.get(), readOnly: ready.readOnly, protect: ready.protect }
    },
  }
}

/**
 * What the hooks enforce now. In `off` mode only self-protection applies, and nothing does when `alwaysProtectSelf`
 * is `false` or `load()` throws (`undefined`). Outside `off` mode `load()` errors are rethrown.
 */
export async function active(policy: Policy): Promise<{ mode: Mode; loaded: Loaded } | undefined> {
  const { mode } = await policy.mode.resolve()
  let loaded: Loaded
  try {
    loaded = policy.load()
  } catch (error) {
    if (mode === "off") return undefined
    throw error
  }
  if (mode === "off" && loaded.options.alwaysProtectSelf === false) return undefined
  return { mode, loaded }
}
