/**
 * `execute.before` / `execute.after` hooks (design 2, Hook 1).
 *
 * Every `deny` is thrown here, the only hook that can fail a tool call. A `shell` call that needs approval is only
 * marked, and the `evaluate` hook forces the built-in shell prompt for it, so the user sees one prompt. An allowed
 * `shell` call is marked too, so `evaluate` knows which commands were checked. Other tools
 * that need approval are prompted here with `permission.assert`, without `save` so `Always` cannot store a rule, and
 * without `source` so the TUI lists the resources. Tool calls are matched as `[tool ID, JSON input]` (design 4.1).
 * In `off` mode only shell self-protection applies (design 4.2). Every `deny` and `ask` is counted in the recent
 * block stats (design 5.3).
 */

import type { Plugin } from "@opencode/plugin"
import { analyze, type Analysis } from "../analyzer"
import type { Audit } from "../audit"
import { active, type Loaded, type Policy } from "../policy"
import { decide, type Verdict } from "../rules"
import type { Stats } from "../stats"
import type { Mode } from "../types"

type Context = Plugin.Context
type Registration = Awaited<ReturnType<Context["tool"]["hook"]>>
/** The fields of the `execute.before` event used here. */
interface BeforeEvent {
  tool: string
  sessionID: string
  agent: string
  id: string
  input: unknown
}

type Enforced = { mode: Mode; loaded: Loaded }
export type ShellInput = { command: string; workdir?: string }

export const MARKER_TTL_MS = 60_000
const SUMMARY_MAX = 200

/** A checked `shell` call: allowed, or to be approved through the built-in prompt. */
export interface Marker {
  sessionID: string
  callID: string
  command: string
  decision: "allow" | "ask"
  ruleId?: string
  reason?: string
  expiresAt: number
}

export interface Markers {
  add(marker: Omit<Marker, "expiresAt">): void
  get(sessionID: string, callID: string): Marker | undefined
  list(sessionID: string): Marker[]
  delete(sessionID: string, callID: string): void
}

/** Per plugin instance, so one instance's cleanup cannot drop another's markers. Expired markers are pruned on access. */
export function createMarkers(now: () => number = Date.now, ttlMs = MARKER_TTL_MS): Markers {
  const markers = new Map<string, Marker>()
  const key = (sessionID: string, callID: string) => `${sessionID}\n${callID}`
  const prune = () => {
    const at = now()
    for (const [id, marker] of markers) if (marker.expiresAt <= at) markers.delete(id)
  }
  return {
    add(marker) {
      prune()
      markers.set(key(marker.sessionID, marker.callID), { ...marker, expiresAt: now() + ttlMs })
    },
    get(sessionID, callID) {
      prune()
      return markers.get(key(sessionID, callID))
    },
    list(sessionID) {
      prune()
      return [...markers.values()].filter((marker) => marker.sessionID === sessionID)
    },
    delete(sessionID, callID) {
      markers.delete(key(sessionID, callID))
    },
  }
}

export interface ToolHookDeps {
  policy: Policy
  markers: Markers
  stats: Stats
  audit: Audit
}

export function registerToolHooks(ctx: Pick<Context, "tool" | "permission" | "location">, deps: ToolHookDeps): Promise<Registration[]> {
  return Promise.all([
    ctx.tool.hook("execute.before", (event) => before(ctx, deps, event)),
    ctx.tool.hook("execute.after", (event) => deps.markers.delete(event.sessionID, event.id)),
  ])
}

async function before(ctx: Pick<Context, "permission" | "location">, deps: ToolHookDeps, event: BeforeEvent) {
  let state
  try {
    state = await active(deps.policy)
  } catch (error) {
    throw blocked(deps, event, "config-error", describe(error))
  }
  if (!state) return
  const { mode, loaded } = state

  const shell = event.tool === "shell" ? shellInput(event.input) : undefined
  if (event.tool === "shell" && !shell) return
  const json = shell ? "" : JSON.stringify(event.input ?? {})
  let verdict: Verdict
  try {
    verdict = shell
      ? analyzeShell(deps.policy, state, ctx.location.directory, shell)
      : decide({ argv: [event.tool, json], isRemote: false, tool: true }, loaded.rules, mode)
  } catch (error) {
    throw blocked(deps, event, "policy-error", describe(error))
  }

  if (verdict.decision === "deny") throw blocked(deps, event, verdict.ruleId, verdict.reason)
  if (shell) {
    const { decision, ruleId, reason } = verdict
    deps.markers.add({ sessionID: event.sessionID, callID: event.id, command: shell.command, decision, ruleId, reason })
  }
  if (verdict.decision !== "ask") return
  report(deps, event, "ask", verdict.ruleId, verdict.reason)
  if (shell) return
  await ctx.permission.assert({
    sessionID: event.sessionID,
    agent: event.agent,
    action: "shell",
    resources: [label(verdict.ruleId, verdict.reason), `$ ${event.tool} ${truncate(json)}`],
    metadata: { safetyPolicy: true },
  })
}

/** The analysis behind a `shell` verdict, shared with the dry run of the `test` RPC. */
export function analyzeShell(policy: Policy, state: Enforced, locationDirectory: string, shell: ShellInput): Analysis {
  const { mode, loaded } = state
  const { rules, readOnly, protect } = loaded
  return analyze({ ...shell, locationDirectory, mode, rules, readOnly, home: policy.home, protect })
}

/** The shell tool's own decoding rejects anything else, so such input never runs. */
function shellInput(input: unknown): ShellInput | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const { command, workdir } = input as Record<string, unknown>
  if (typeof command !== "string") return undefined
  return typeof workdir === "string" ? { command, workdir } : { command }
}

export function label(ruleId = "unknown", reason = ""): string {
  return `[safety-policy:${ruleId}] ${reason}`
}

function blocked(deps: ToolHookDeps, event: BeforeEvent, ruleId?: string, reason?: string): Error {
  report(deps, event, "deny", ruleId, reason)
  return new Error(label(ruleId, reason))
}

function report(deps: ToolHookDeps, event: BeforeEvent, decision: "deny" | "ask", ruleId = "unknown", reason = "") {
  void deps.stats.record(decision, ruleId)
  const shell = event.tool === "shell" ? shellInput(event.input) : undefined
  const input = shell ? shell.command : JSON.stringify(event.input ?? {})
  const { sessionID, tool, id: callID } = event
  const workdir = shell?.workdir === undefined ? {} : { workdir: shell.workdir }
  void deps.audit.write({ event: decision, ruleId, reason, sessionID, input, callID, tool, ...workdir })
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text
}
