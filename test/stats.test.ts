import { describe, expect, test } from "bun:test"
import { BLOCK_PREFIX, createStats, RECENT_MS } from "../src/stats"
import { fakeContext } from "./helpers/fake-context"

function setup() {
  const fake = fakeContext()
  const clock = { t: 1_000_000_000 }
  const stats = createStats(fake.ctx.storage, () => clock.t)
  const blocks = () => [...fake.data.keys()].filter((key) => key.startsWith(BLOCK_PREFIX))
  return { ...fake, clock, stats, blocks }
}

describe("stats", () => {
  test("count the last 24 hours and rank the rules", async () => {
    const s = setup()
    const start = s.clock.t
    for (const ruleId of ["b", "a", "c", "a"]) await s.stats.record("deny", ruleId)
    await s.stats.record("ask", "d")
    await s.stats.record("ask")
    const expected = {
      deny: 4,
      ask: 2,
      rules: [
        { ruleId: "a", count: 2 },
        { ruleId: "b", count: 1 },
        { ruleId: "c", count: 1 },
      ],
    }
    expect(await s.stats.recent()).toEqual(expected)
    expect(s.data.get(s.blocks()[0]!)).toEqual({ decision: "deny", ruleId: "b" })
    s.clock.t = start + RECENT_MS
    expect(await s.stats.recent()).toEqual(expected)
    s.clock.t = start + RECENT_MS + 1
    expect(await s.stats.recent()).toEqual({ deny: 0, ask: 0, rules: [] })
  })

  test("a write prunes expired records", async () => {
    const s = setup()
    await s.stats.record("deny", "old")
    await s.stats.record("deny", "old")
    s.clock.t += RECENT_MS / 2
    await s.stats.record("deny", "kept")
    s.clock.t += RECENT_MS / 2 + 1
    await s.stats.record("ask", "new")
    expect(s.blocks().map((key) => s.data.get(key))).toEqual([
      { decision: "deny", ruleId: "kept" },
      { decision: "ask", ruleId: "new" },
    ])
  })

  test("reads every page and skips invalid records", async () => {
    const s = setup()
    const at = String(s.clock.t).padStart(13, "0")
    for (let i = 0; i < 1_500; i++)
      s.data.set(`${BLOCK_PREFIX}${at}:${String(i).padStart(4, "0")}`, { decision: "deny", ruleId: "r" })
    s.data.set(`${BLOCK_PREFIX}${at}:x1`, { decision: "allow", ruleId: "r" })
    s.data.set(`${BLOCK_PREFIX}${at}:x2`, "deny")
    s.data.set("safety:state", { mode: "off" })
    expect(await s.stats.recent()).toEqual({ deny: 1_500, ask: 0, rules: [{ ruleId: "r", count: 1_500 }] })
  })

  test("record never rejects", async () => {
    const s = setup()
    ;(s.ctx.storage as { set: unknown }).set = async () => {
      throw new Error("disk full")
    }
    await s.stats.record("deny", "r")
    ;(s.ctx.storage as { set: unknown; scan: unknown }).set = async () => {}
    ;(s.ctx.storage as { scan: unknown }).scan = () => {
      throw new Error("disk I/O error")
    }
    await s.stats.record("deny", "r")
  })
})
