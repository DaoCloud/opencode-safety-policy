/**
 * Policy assembly for the hooks (design 5.2).
 *
 * Creating a policy never throws, because a plugin whose setup fails is not loaded and leaves every tool unguarded.
 * Invalid options or a broken read-only list are kept and rethrown by `load()`; rule files are reloaded by `load()`
 * when they change and throw until fixed. The hooks deny every tool call while `load()` throws, except in `off` mode.
 * The mode does not depend on `load()`: with invalid options it resolves without `options.mode`.
 */

import { createRuleProvider, parseOptions, type RuleProvider } from "./config"
import type { RuleSet } from "./rules"
import { loadReadOnlyList, type ReadOnlyList } from "./rules/ssh-policy"
import { createModeState, type ModeState, type ModeStorage } from "./state"
import type { PluginOptions } from "./types"

export interface Loaded {
  options: PluginOptions
  rules: RuleSet
  readOnly: ReadOnlyList
}

export interface Policy {
  readonly mode: ModeState
  /** Current options and rules. Throws when they are invalid. */
  load(): Loaded
}

export interface PolicyInput {
  /** Raw `plugins[].options`. */
  options: unknown
  storage: ModeStorage
  env?: Record<string, string | undefined>
  now?: () => number
}

export function createPolicy(input: PolicyInput): Policy {
  let ready: { options: PluginOptions; provider: RuleProvider; readOnly: ReadOnlyList } | undefined
  let failure: unknown
  try {
    const options = parseOptions(input.options)
    ready = { options, provider: createRuleProvider(options), readOnly: loadReadOnlyList(options.sshReadOnlyAllowlist) }
  } catch (error) {
    failure = error
  }
  const mode = createModeState({ storage: input.storage, env: input.env, now: input.now, configMode: ready?.options.mode })
  return {
    mode,
    load() {
      if (!ready) throw failure
      return { options: ready.options, rules: ready.provider.get(), readOnly: ready.readOnly }
    },
  }
}
