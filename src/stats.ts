/**
 * Recent block stats (design 5.3).
 *
 * Plugin instances are per Location and do not share memory, so each `deny` or `ask` made by the hooks appends one
 * record to the shared storage. Every record has its own time-ordered key, so concurrent writers never overwrite each
 * other. The command is not stored, as it may hold credentials. Stats are best-effort and must not change a decision:
 * the hooks do not await `record`, which never rejects. Each write prunes up to `PRUNE_BATCH` expired records.
 */

export const BLOCK_PREFIX = "safety:block:"
export const RECENT_MS = 24 * 3_600_000
const PRUNE_BATCH = 100
const PAGE = 1_000
const TOP = 3

export type Block = { decision: "deny" | "ask"; ruleId: string }

/** The subset of `ctx.storage` used here. */
export interface StatsStorage {
  set(key: string, value: Block): Promise<void>
  remove(key: string): Promise<void>
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: readonly { key: string; value: unknown }[]
    next?: string
  }>
}

export interface Recent {
  deny: number
  ask: number
  /** The most hit rules, most first. */
  rules: { ruleId: string; count: number }[]
}

export interface Stats {
  /** Never rejects. */
  record(decision: Block["decision"], ruleId?: string): Promise<void>
  /** Counts the records of the last `RECENT_MS`. */
  recent(): Promise<Recent>
}

export function createStats(storage: StatsStorage, now: () => number = Date.now): Stats {
  // Epoch ms has 13 digits until 2286, so the keys sort by time.
  const key = (at: number) => `${BLOCK_PREFIX}${String(at).padStart(13, "0")}`

  async function write(at: number, block: Block) {
    await storage.set(`${key(at)}:${crypto.randomUUID()}`, block)
    const cutoff = key(at - RECENT_MS)
    const { entries } = await storage.scan({ prefix: BLOCK_PREFIX, limit: PRUNE_BATCH })
    for (const entry of entries) {
      if (entry.key >= cutoff) break
      await storage.remove(entry.key)
    }
  }

  return {
    record(decision, ruleId = "unknown") {
      return write(now(), { decision, ruleId }).catch(() => {})
    },

    async recent() {
      const counts = { deny: 0, ask: 0 }
      const rules = new Map<string, number>()
      let after: string | undefined = key(now() - RECENT_MS)
      while (after !== undefined) {
        const page = await storage.scan({ prefix: BLOCK_PREFIX, after, limit: PAGE })
        for (const { value } of page.entries) {
          const block = parseBlock(value)
          if (!block) continue
          counts[block.decision]++
          rules.set(block.ruleId, (rules.get(block.ruleId) ?? 0) + 1)
        }
        after = page.next
      }
      const top = [...rules]
        .map(([ruleId, count]) => ({ ruleId, count }))
        .sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId))
        .slice(0, TOP)
      return { ...counts, rules: top }
    },
  }
}

function parseBlock(raw: unknown): Block | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const { decision, ruleId } = raw as Record<string, unknown>
  if ((decision !== "deny" && decision !== "ask") || typeof ruleId !== "string") return undefined
  return { decision, ruleId }
}
