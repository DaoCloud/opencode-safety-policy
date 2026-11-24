/**
 * RPC contract shared by the Server entry and the TUI (design 5.3), served at `/api/rpc/opencode-safety-policy/<method>`.
 *
 * The schemas are JSON Schema to avoid depending on `effect`, so the handler and client types are declared here. The
 * server validates input and output against them: optional output fields must be omitted, not `undefined`. A handler
 * error reaches the client only when the method declares it, so `setMode` returns `locked` instead of throwing.
 */

import { Rpc } from "@opencode/plugin/rpc"
import type { ModeSource } from "./src/state"
import type { Mode } from "./src/types"

const mode = { enum: ["strict", "relaxed", "off"] }

const status = {
  type: "object",
  properties: {
    mode,
    source: { enum: ["lock", "runtime", "env", "config", "default", "fallback"] },
    locked: { type: "boolean" },
    expiresAt: { type: "number" },
  },
  required: ["mode", "source", "locked"],
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
  },
  events: {},
})

export interface Status {
  mode: Mode
  source: ModeSource
  locked: boolean
  /** Epoch ms, set while a runtime TTL is active. */
  expiresAt?: number
}

export interface SetModeInput {
  mode: Mode
  ttlMs?: number
}

/** Data of the `locked` error. */
export interface Locked {
  mode: Mode
}
