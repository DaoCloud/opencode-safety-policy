/**
 * RPC contract shared by the Server entry and the TUI (design 5.3), served at `/api/rpc/opencode-safety-policy/<method>`.
 *
 * The schemas are JSON Schema to avoid depending on `effect`, so the handler and client types are declared here. The
 * server validates input and output against them: optional output fields must be omitted, not `undefined`. A handler
 * error reaches the client only when the method declares it, so `setMode` returns `locked` instead of throwing.
 */

import { Rpc } from "@opencode/plugin/rpc"
import type { AtomReport } from "./src/analyzer"
import type { ModeSource } from "./src/state"
import type { Recent } from "./src/stats"
import type { Decision, Mode } from "./src/types"

const mode = { enum: ["strict", "relaxed", "off"] }
const strings = { type: "array", items: { type: "string" } }
const verdict = { decision: { enum: ["allow", "ask", "deny"] }, ruleId: { type: "string" }, reason: { type: "string" } }

const recent = {
  type: "object",
  properties: {
    deny: { type: "integer" },
    ask: { type: "integer" },
    rules: {
      type: "array",
      items: {
        type: "object",
        properties: { ruleId: { type: "string" }, count: { type: "integer" } },
        required: ["ruleId", "count"],
      },
    },
  },
  required: ["deny", "ask", "rules"],
}

const status = {
  type: "object",
  properties: {
    mode,
    source: { enum: ["lock", "runtime", "env", "config", "default", "fallback"] },
    locked: { type: "boolean" },
    expiresAt: { type: "number" },
    recent,
  },
  required: ["mode", "source", "locked"],
}

const atom = {
  type: "object",
  properties: {
    argv: strings,
    isRemote: { type: "boolean" },
    targetHost: { type: "string" },
    wrapperChain: strings,
    ...verdict,
  },
  required: ["argv", "isRemote", "wrapperChain", "decision"],
}

export default Rpc.define({
  id: "opencode-safety-policy",
  methods: {
    status: { input: { type: "object" }, output: status },
    setMode: {
      input: {
        type: "object",
        properties: { mode, ttlMs: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
        required: ["mode"],
      },
      output: status,
      errors: { locked: { type: "object", properties: { mode }, required: ["mode"] } },
    },
    test: {
      input: {
        type: "object",
        properties: { command: { type: "string" }, workdir: { type: "string" } },
        required: ["command"],
      },
      output: {
        type: "object",
        properties: { mode, ...verdict, atoms: { type: "array", items: atom } },
        required: ["mode", "decision", "atoms"],
      },
    },
  },
  events: {},
})

export interface Status {
  mode: Mode
  source: ModeSource
  locked: boolean
  /** Epoch ms, set while a runtime TTL is active. */
  expiresAt?: number
  /** Only from `status`, omitted when the stats cannot be read. */
  recent?: Recent
}

export interface SetModeInput {
  mode: Mode
  ttlMs?: number
}

/** Data of the `locked` error. */
export interface Locked {
  mode: Mode
}

/** A `shell` call to judge without running it. */
export interface TestInput {
  command: string
  workdir?: string
}

export interface TestResult {
  mode: Mode
  decision: Decision
  ruleId?: string
  reason?: string
  atoms: AtomReport[]
}
