import { describe, expect, test } from "bun:test"
import { createModeState, LOCK_ENV, MODE_ENV, STATE_KEY, type ModeStorage } from "../src/state"

const MINUTE = 60_000

function memoryStorage() {
  const data = new Map<string, unknown>()
  const storage: ModeStorage = {
    get: async (key) => data.get(key),
    set: async (key, value) => void data.set(key, structuredClone(value)),
  }
  return { data, storage }
}

function setup(options: { env?: Record<string, string>; configMode?: "strict" | "relaxed" | "off"; cacheMs?: number } = {}) {
  const clock = { t: 1_000_000 }
  const { data, storage } = memoryStorage()
  const env = options.env ?? {}
  const state = createModeState({ storage, env, configMode: options.configMode, now: () => clock.t, cacheMs: options.cacheMs ?? 0 })
  return { clock, data, storage, env, state }
}

describe("mode priority", () => {
  test("defaults to relaxed", async () => {
    expect(await setup().state.resolve()).toEqual({ mode: "relaxed", source: "default", locked: false })
  })

  test("lock > runtime > env > config", async () => {
    const { env, state } = setup({ configMode: "off" })
    expect(await state.resolve()).toMatchObject({ mode: "off", source: "config" })
    env[MODE_ENV] = "relaxed"
    expect(await state.resolve()).toMatchObject({ mode: "relaxed", source: "env" })
    await state.setMode("off")
    expect(await state.resolve()).toMatchObject({ mode: "off", source: "runtime" })
    env[LOCK_ENV] = "strict"
    expect(await state.resolve()).toEqual({ mode: "strict", source: "lock", locked: true })
  })

  test.each([MODE_ENV, LOCK_ENV])("an invalid %s resolves to strict", async (name) => {
    const { state } = setup({ env: { [name]: "OFF" }, configMode: "off" })
    expect((await state.resolve()).mode).toBe("strict")
  })

  test("setMode is rejected while locked", async () => {
    const { data, state } = setup({ env: { [LOCK_ENV]: "relaxed" } })
    await expect(state.setMode("off")).rejects.toThrow(LOCK_ENV)
    expect(data.size).toBe(0)
  })

  test("setMode rejects an invalid mode or ttl", async () => {
    const { state } = setup()
    await expect(state.setMode("lax" as never)).rejects.toThrow("mode")
    for (const ttlMs of [0, -1, 1.5, Number.NaN]) await expect(state.setMode("off", { ttlMs })).rejects.toThrow("ttl")
  })
})

describe("TTL", () => {
  test("an expired state without previousMode falls back to the lower layers", async () => {
    const { clock, state } = setup({ configMode: "relaxed" })
    await state.setMode("off", { ttlMs: 15 * MINUTE })
    clock.t += 15 * MINUTE - 1
    expect(await state.resolve()).toEqual({ mode: "off", source: "runtime", locked: false, expiresAt: 1_000_000 + 15 * MINUTE })
    clock.t += 1
    expect(await state.resolve()).toMatchObject({ mode: "relaxed", source: "config" })
  })

  test("an expired state restores the permanent runtime mode it replaced", async () => {
    const { clock, state } = setup({ configMode: "off" })
    await state.setMode("strict")
    expect((await state.setMode("off", { ttlMs: 10 * MINUTE })).previousMode).toBe("strict")
    clock.t += 10 * MINUTE
    expect(await state.resolve()).toMatchObject({ mode: "strict", source: "runtime" })
  })

  test("stacked TTL states never make a temporary mode permanent", async () => {
    const { clock, state } = setup()
    await state.setMode("relaxed", { ttlMs: 30 * MINUTE })
    clock.t += MINUTE
    await state.setMode("off", { ttlMs: 10 * MINUTE })
    clock.t += 10 * MINUTE
    expect(await state.resolve()).toMatchObject({ mode: "relaxed", source: "default" })
  })

  test("setting a mode without ttl clears the TTL", async () => {
    const { clock, state } = setup()
    await state.setMode("off", { ttlMs: MINUTE })
    await state.setMode("relaxed")
    clock.t += 60 * MINUTE
    expect(await state.resolve()).toEqual({ mode: "relaxed", source: "runtime", locked: false })
  })
})

describe("storage", () => {
  test("another instance sees a change after its cache window", async () => {
    const clock = { t: 0 }
    const { storage } = memoryStorage()
    const a = createModeState({ storage, env: {}, now: () => clock.t, cacheMs: 1000 })
    const b = createModeState({ storage, env: {}, now: () => clock.t, cacheMs: 1000 })
    expect((await b.resolve()).mode).toBe("relaxed")
    await a.setMode("off")
    expect((await a.resolve()).mode).toBe("off")
    expect((await b.resolve()).mode).toBe("relaxed")
    clock.t += 1000
    expect((await b.resolve()).mode).toBe("off")
  })

  test("a malformed state is ignored", async () => {
    const { data, state } = setup({ configMode: "relaxed" })
    data.set(STATE_KEY, { mode: "disabled", expiresAt: null, previousMode: null })
    expect(await state.resolve()).toMatchObject({ mode: "relaxed", source: "config" })
  })

  test("a storage read error resolves to strict", async () => {
    const storage: ModeStorage = {
      get: async () => {
        throw new Error("database is locked")
      },
      set: async () => {},
    }
    const state = createModeState({ storage, env: { [MODE_ENV]: "off" }, configMode: "off" })
    expect(await state.resolve()).toEqual({ mode: "strict", source: "fallback", locked: false })
  })
})
