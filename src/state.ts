/**
 * Global mode state (design 5.2).
 *
 * Priority, highest first: `OPENCODE_SAFETY_LOCK_MODE`, the runtime state in storage (with TTL),
 * `OPENCODE_SAFETY_MODE`, `options.mode`, then `strict`.
 *
 * Plugin instances are per location and do not share memory, so every decision reads the shared storage, cached for
 * `cacheMs`. TTL is checked on read: an expired state falls back to its `previousMode`, or to the lower layers when it
 * has none. A TTL state never becomes permanent, because a new TTL state inherits the `previousMode` of the one it
 * replaces. Invalid environment values and storage read errors resolve to `strict`.
 */

import { MODES } from "./config"
import type { Mode } from "./types"

export const STATE_KEY = "safety:state"
export const LOCK_ENV = "OPENCODE_SAFETY_LOCK_MODE"
export const MODE_ENV = "OPENCODE_SAFETY_MODE"

/** The subset of `ctx.storage` used here. */
export interface ModeStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: SafetyState): Promise<void>
}

export type SafetyState = {
  mode: Mode
  /** Epoch ms, or null for no TTL. */
  expiresAt: number | null
  /** Mode restored on expiry; null falls back to the lower layers. */
  previousMode: Mode | null
  updatedAt: number
  updatedBy: string
}

export type ModeSource = "lock" | "runtime" | "env" | "config" | "default" | "fallback"

export interface ResolvedMode {
  mode: Mode
  source: ModeSource
  locked: boolean
  /** Set while a runtime TTL is active. */
  expiresAt?: number
}

export interface ModeStateOptions {
  storage: ModeStorage
  env?: Record<string, string | undefined>
  configMode?: Mode
  now?: () => number
  cacheMs?: number
}

export interface ModeState {
  resolve(): Promise<ResolvedMode>
  /** Writes a runtime state. Throws when the mode is locked. */
  setMode(mode: Mode, options?: { ttlMs?: number; by?: string }): Promise<SafetyState>
}

export function createModeState(options: ModeStateOptions): ModeState {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now
  const cacheMs = options.cacheMs ?? 1000
  let cache: { state: SafetyState | undefined; at: number } | undefined

  async function read(fresh: boolean): Promise<SafetyState | undefined> {
    const at = now()
    if (!fresh && cache && at - cache.at < cacheMs) return cache.state
    const state = parseState(await options.storage.get(STATE_KEY))
    cache = { state, at }
    return state
  }

  function lower(): ResolvedMode {
    const mode = envMode(env[MODE_ENV])
    if (mode) return { mode, source: "env", locked: false }
    if (options.configMode) return { mode: options.configMode, source: "config", locked: false }
    return { mode: "relaxed", source: "default", locked: false }
  }

  return {
    async resolve() {
      const lock = envMode(env[LOCK_ENV])
      if (lock) return { mode: lock, source: "lock", locked: true }
      let state: SafetyState | undefined
      try {
        state = await read(false)
      } catch {
        return { mode: "strict", source: "fallback", locked: false }
      }
      return runtime(state, now()) ?? lower()
    },

    async setMode(mode, { ttlMs, by = "command" } = {}) {
      if (envMode(env[LOCK_ENV])) throw new Error(`mode is locked by ${LOCK_ENV}`)
      if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`)
      if (ttlMs !== undefined && !(Number.isSafeInteger(ttlMs) && ttlMs > 0)) throw new Error("ttl must be a positive integer of ms")
      const current = await read(true)
      const at = now()
      const previousMode =
        ttlMs === undefined ? null : current?.expiresAt === null ? current.mode : (current?.previousMode ?? null)
      const state: SafetyState = { mode, expiresAt: ttlMs === undefined ? null : at + ttlMs, previousMode, updatedAt: at, updatedBy: by }
      await options.storage.set(STATE_KEY, state)
      cache = { state, at }
      return state
    },
  }
}

function runtime(state: SafetyState | undefined, at: number): ResolvedMode | undefined {
  if (!state) return undefined
  if (state.expiresAt === null) return { mode: state.mode, source: "runtime", locked: false }
  if (at < state.expiresAt) return { mode: state.mode, source: "runtime", locked: false, expiresAt: state.expiresAt }
  if (state.previousMode) return { mode: state.previousMode, source: "runtime", locked: false }
  return undefined
}

/** Unset or empty means no value. Any other invalid value resolves to `strict`. */
function envMode(value: string | undefined): Mode | undefined {
  if (!value) return undefined
  return MODES.includes(value as Mode) ? (value as Mode) : "strict"
}

function parseState(raw: unknown): SafetyState | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const value = raw as Record<string, unknown>
  if (!MODES.includes(value.mode as Mode)) return undefined
  if (value.expiresAt !== null && !Number.isFinite(value.expiresAt)) return undefined
  if (value.previousMode !== null && !MODES.includes(value.previousMode as Mode)) return undefined
  return {
    mode: value.mode as Mode,
    expiresAt: value.expiresAt as number | null,
    previousMode: value.previousMode as Mode | null,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    updatedBy: typeof value.updatedBy === "string" ? value.updatedBy : "",
  }
}
