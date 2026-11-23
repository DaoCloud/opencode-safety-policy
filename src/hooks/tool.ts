/**
 * `execute.before` / `execute.after` hooks (design 2, Hook 1).
 *
 * Every `deny` is thrown here, the only hook that can fail a tool call. A `shell` call that needs approval is only
 * marked, and the `evaluate` hook forces the built-in shell prompt for it, so the user sees one prompt. Other tools
 * that need approval are prompted here with `permission.assert`, without `save` so `Always` cannot store a rule, and
 * without `source` so the TUI lists the resources. Tool calls are matched as `[tool ID, JSON input]` (design 4.1).
 * In `off` mode only shell self-protection applies (design 4.2).
 */

import type { Plugin } from "@opencode/plugin"
import { analyze } from "../analyzer"
import { active, type Policy } from "../policy"
import { decide, type Verdict } from "../rules"

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

export const MARKER_TTL_MS = 60_000
const SUMMARY_MAX = 200

/** A `shell` call that must be approved through the built-in prompt. */
export interface Marker {
  sessionID: string
  callID: string
  command: string
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
    throw blocked("config-error", describe(error))
  }
  if (!state) return
  const { mode, loaded } = state

  const shell = event.tool === "shell" ? shellInput(event.input) : undefined
  if (event.tool === "shell" && !shell) return
  const json = shell ? "" : JSON.stringify(event.input ?? {})
  let verdict: Verdict
  try {
    verdict = shell
      ? analyze({
          ...shell,
          locationDirectory: ctx.location.directory,
          mode,
          rules: loaded.rules,
          readOnly: loaded.readOnly,
          home: deps.policy.home,
          protect: loaded.protect,
        })
      : decide({ argv: [event.tool, json], isRemote: false, tool: true }, loaded.rules, mode)
  } catch (error) {
    throw blocked("policy-error", describe(error))
  }

  if (verdict.decision === "deny") throw blocked(verdict.ruleId, verdict.reason)
  if (verdict.decision !== "ask") return
  if (shell) {
    deps.markers.add({ sessionID: event.sessionID, callID: event.id, command: shell.command, ruleId: verdict.ruleId, reason: verdict.reason })
    return
  }
  await ctx.permission.assert({
    sessionID: event.sessionID,
    agent: event.agent,
    action: "shell",
    resources: [label(verdict.ruleId, verdict.reason), `$ ${event.tool} ${truncate(json)}`],
    metadata: { safetyPolicy: true },
  })
}

/** The shell tool's own decoding rejects anything else, so such input never runs. */
function shellInput(input: unknown): { command: string; workdir?: string } | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const { command, workdir } = input as Record<string, unknown>
  if (typeof command !== "string") return undefined
  return typeof workdir === "string" ? { command, workdir } : { command }
}

export function label(ruleId = "unknown", reason = ""): string {
  return `[safety-policy:${ruleId}] ${reason}`
}

function blocked(ruleId?: string, reason?: string): Error {
  return new Error(label(ruleId, reason))
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text
}
