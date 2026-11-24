/**
 * `permission.hook("evaluate")` (design 2, Hook 2).
 *
 * Runs after the configured and saved rules, so it can force a prompt that an `allow` rule or an earlier `Always`
 * reply would skip. A `deny` is never changed.
 * - `shell`: a call marked by `execute.before` is asked. A direct call is matched by its call ID. A call nested in Code
 *   Mode has the `execute` call as its source, so it is matched by session and by every resource being part of the
 *   marked command. The plugin's own prompts (`metadata.safetyPolicy`) are always asked. A resource that is not part
 *   of a command `execute.before` checked, such as one another plugin's `shell.hook("create.before")` rewrote or
 *   added, is analyzed on its own, in the location directory, and denied on a `deny` (design 2).
 * - `edit`: writes to a protected path are denied (design 4.2). This also covers Code Mode `Bun.write`, which has no
 *   `execute.before`.
 * - `read` (the read tool, Code Mode `Bun.file`), `edit` and `grep` (its `metadata.path`): Server credentials and the
 *   OpenCode database are denied (design 4.2).
 * - `webfetch`: a request other than GET / HEAD that hits an HTTP rule (Redfish, UFM, `protectedEndpoints`) is denied
 *   in every mode but `off` (design 4.3). An `ask` would offer to save `webfetch: *`, and Code Mode checks redirect
 *   hops only for `deny`. Each hop is evaluated with the method of the first request. The body is not visible, so it
 *   is unknown. The webfetch tool and image downloads send no method and only GET. Any request to the local Server
 *   API is denied like a protected path.
 */

import type { Plugin } from "@opencode/plugin"
import type { Audit } from "../audit"
import { request } from "../http-extractor"
import { resolveCanonicalPath } from "../path-util"
import { active, type Policy } from "../policy"
import { decide } from "../rules"
import { isProtected, isSecret, secretVerdict, selfProtectVerdict } from "../rules/self-protect"
import { isLocalApi, serverApiRequest, serverApiVerdict } from "../rules/server-api"
import type { Stats } from "../stats"
import { analyzeShell, describe, label, type Marker, type Markers } from "./tool"

type Context = Plugin.Context
type Registration = Awaited<ReturnType<Context["permission"]["hook"]>>
/** The fields of the `evaluate` event used here. */
interface Evaluation {
  readonly sessionID: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>
  readonly source?: { readonly id: string }
  effect: "allow" | "ask" | "deny"
  message?: string
}

export interface PermissionHookDeps {
  policy: Policy
  markers: Markers
  stats: Stats
  audit: Audit
}

export function registerPermissionHook(ctx: Pick<Context, "permission" | "location">, deps: PermissionHookDeps): Promise<Registration> {
  return ctx.permission.hook("evaluate", (event) => evaluate(ctx, deps, event))
}

async function evaluate(ctx: Pick<Context, "location">, deps: PermissionHookDeps, event: Evaluation) {
  if (event.effect === "deny") return
  if (event.action === "shell") return guardShell(ctx, deps, event)
  if (event.action === "edit") return protectFiles(ctx, deps, event)
  if (event.action === "read") return protectSecrets(ctx, deps, event, event.resources)
  if (event.action === "grep") return protectSecrets(ctx, deps, event, [String(event.metadata?.path ?? ".")])
  if (event.action === "webfetch") return protectEndpoints(deps, event)
}

async function guardShell(ctx: Pick<Context, "location">, deps: PermissionHookDeps, event: Evaluation) {
  const own = event.metadata?.safetyPolicy === true ? event.resources[0] : undefined
  if (own !== undefined) return set(event, "ask", own)
  const exact = event.source && deps.markers.get(event.sessionID, event.source.id)
  const checked = exact ? [exact] : deps.markers.list(event.sessionID)
  const unchecked = event.resources.filter((resource) => !checked.some((marker) => marker.command.includes(resource)))
  if (unchecked.length) await recheck(ctx, deps, event, unchecked)
  if (event.effect === "deny") return
  const covers = (marker: Marker) => event.resources.every((resource) => marker.command.includes(resource))
  const asks = checked.filter((marker) => marker.decision === "ask")
  const marker = exact ? asks[0] : event.resources.length > 0 ? asks.find(covers) : undefined
  if (marker) set(event, "ask", label(marker.ruleId, marker.reason))
}

async function recheck(ctx: Pick<Context, "location">, deps: PermissionHookDeps, event: Evaluation, commands: string[]) {
  const state = await enforced(deps, event)
  if (!state) return
  for (const command of commands) {
    let verdict
    try {
      verdict = analyzeShell(deps.policy, state, ctx.location.directory, { command })
    } catch (error) {
      return deny(deps, event, "policy-error", describe(error))
    }
    if (verdict.decision === "deny") return deny(deps, event, verdict.ruleId, verdict.reason)
  }
}

async function protectFiles(ctx: Pick<Context, "location">, deps: PermissionHookDeps, event: Evaluation) {
  const state = await enforced(deps, event)
  if (!state) return
  const protect = state.loaded.protect
  for (const resource of event.resources) {
    const target = resolveCanonicalPath(resource, ctx.location.directory, deps.policy.home)
    if (isSecret(target, protect)) return deny(deps, event, "self-protect", secretVerdict(target).reason)
    if (isProtected(target, protect)) return deny(deps, event, "self-protect", selfProtectVerdict(target).reason)
  }
}

async function protectSecrets(
  ctx: Pick<Context, "location">,
  deps: PermissionHookDeps,
  event: Evaluation,
  paths: ReadonlyArray<string>,
) {
  const state = await enforced(deps, event)
  if (!state) return
  for (const p of paths) {
    const target = resolveCanonicalPath(p, ctx.location.directory, deps.policy.home)
    if (!isSecret(target, state.loaded.protect)) continue
    return deny(deps, event, "self-protect", secretVerdict(target).reason)
  }
}

async function protectEndpoints(deps: PermissionHookDeps, event: Evaluation) {
  const method = event.metadata?.method
  const known = typeof method === "string" ? method.toUpperCase() : "GET"
  const write = known !== "GET" && known !== "HEAD"
  const http = event.resources.map((url) => request(known, url, undefined))
  if (!write && !http.some(isLocalApi)) return
  const state = await enforced(deps, event)
  if (!state) return
  const api = serverApiRequest(http, state.loaded.protect.ports)
  if (api) return deny(deps, event, "self-protect", serverApiVerdict(api).reason)
  if (!write || state.mode === "off") return
  const verdict = decide({ argv: [], isRemote: false, http }, state.loaded.rules, "strict")
  if (verdict.decision !== "allow") deny(deps, event, verdict.ruleId!, verdict.reason!)
}

/** The policy the hooks enforce now; a config error denies the event and returns `undefined`. */
async function enforced(deps: PermissionHookDeps, event: Evaluation) {
  try {
    return await active(deps.policy)
  } catch (error) {
    deny(deps, event, "config-error", describe(error))
  }
}

/** Asks are recorded by `execute.before`, so only denies are recorded here. */
function deny(deps: PermissionHookDeps, event: Evaluation, ruleId = "unknown", reason = "") {
  void deps.stats.record("deny", ruleId)
  const { sessionID, action: permission } = event
  const input = event.resources.join("\n")
  const callID = event.source ? { callID: event.source.id } : {}
  void deps.audit.write({ event: "deny", ruleId, reason, sessionID, input, permission, ...callID })
  set(event, "deny", label(ruleId, reason))
}

function set(event: Evaluation, effect: Evaluation["effect"], message: string) {
  event.effect = effect
  event.message = message
}
