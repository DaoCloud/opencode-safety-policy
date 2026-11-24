/**
 * Optional JSONL audit log (design 7, `auditLogPath`).
 *
 * Each `deny` or `ask` made by the hooks and each mode switch appends one line. A new file is created with mode 0600,
 * as commands may hold credentials. The log is best-effort and must not change a decision: `write` never rejects, and
 * a failed append is dropped.
 */

import { appendFile } from "node:fs/promises"
import type { Mode } from "./types"

export const INPUT_MAX = 4096

export type AuditEntry =
  | {
      event: "deny" | "ask"
      ruleId: string
      reason: string
      sessionID: string
      input: string
      callID?: string
      /** The tool, for an `execute.before` decision. */
      tool?: string
      /** The permission action, for an `evaluate` decision. */
      permission?: string
      workdir?: string
    }
  | { event: "mode"; mode: Mode; ttlMs?: number }

export interface Audit {
  /** Never rejects. */
  write(entry: AuditEntry): Promise<void>
}

/** Writes nothing when `file` is `undefined`. `directory` is the Location of the plugin instance. */
export function createAudit(file: string | undefined, directory: string, now: () => number = Date.now): Audit {
  return {
    async write(entry) {
      if (file === undefined) return
      const time = new Date(now()).toISOString()
      const long = "input" in entry && entry.input.length > INPUT_MAX
      const input = long ? { input: `${entry.input.slice(0, INPUT_MAX)}…` } : {}
      const line = JSON.stringify({ time, ...entry, ...input, directory })
      await appendFile(file, `${line}\n`, { mode: 0o600 }).catch(() => {})
    },
  }
}
