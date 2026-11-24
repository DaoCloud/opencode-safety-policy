/**
 * `permission.hook("evaluate")` (design 2, Hook 2).
 *
 * Runs after the configured and saved rules, so it can force a prompt that an `allow` rule or an earlier `Always`
 * reply would skip. A `deny` is never changed.
 * - `shell`: a call marked by `execute.before` is asked. A direct call is matched by its call ID. A call nested in Code
 *   Mode has the `execute` call as its source, so it is matched by session and by every resource being part of the
 *   marked command. The plugin's own prompts (`metadata.safetyPolicy`) are always asked.
 * - `edit`: writes to a protected path are denied (design 4.2). This also covers Code Mode `Bun.write`, which has no
 *   `execute.before`.
 * - `webfetch`: a request other than GET / HEAD that hits an HTTP rule (Redfish, UFM, `protectedEndpoints`) is denied
 *   in every mode but `off` (design 4.3). An `ask` would offer to save `webfetch: *`, and Code Mode checks redirect
 *   hops only for `deny`. Each hop is evaluated with the method of the first request. The body is not visible, so it
 *   is unknown. The webfetch tool and image downloads send no method and only GET.
 */

import type { Plugin } from "@opencode/plugin"
import { request } from "../http-extractor"
import { resolveCanonicalPath } from "../path-util"
import { active, type Policy } from "../policy"
import { decide } from "../rules"
import { isProtected, selfProtectVerdict } from "../rules/self-protect"
import type { Stats } from "../stats"
import { describe, label, type Markers } from "./tool"

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
}

export function registerPermissionHook(ctx: Pick<Context, "permission" | "location">, deps: PermissionHookDeps): Promise<Registration> {
  return ctx.permission.hook("evaluate", (event) => evaluate(ctx, deps, event))
}

async function evaluate(ctx: Pick<Context, "location">, deps: PermissionHookDeps, event: Evaluation) {
  if (event.effect === "deny") return
  if (event.action === "shell") return forcePrompt(deps.markers, event)
  if (event.action === "edit") return protectFiles(ctx, deps, event)
  if (event.action === "webfetch") return protectEndpoints(deps, event)
}

function forcePrompt(markers: Markers, event: Evaluation) {
  const own = event.metadata?.safetyPolicy === true ? event.resources[0] : undefined
  if (own !== undefined) return set(event, "ask", own)
  const marker =
    (event.source && markers.get(event.sessionID, event.source.id)) ??
    markers
      .list(event.sessionID)
      .find((item) => event.resources.length > 0 && event.resources.every((resource) => item.command.includes(resource)))
  if (marker) set(event, "ask", label(marker.ruleId, marker.reason))
}

async function protectFiles(ctx: Pick<Context, "location">, deps: PermissionHookDeps, event: Evaluation) {
  const state = await enforced(deps, event)
  if (!state) return
  for (const resource of event.resources) {
    const target = resolveCanonicalPath(resource, ctx.location.directory, deps.policy.home)
    if (!isProtected(target, state.loaded.protect)) continue
    const verdict = selfProtectVerdict(target)
    return deny(deps.stats, event, verdict.ruleId, verdict.reason)
  }
}

async function protectEndpoints(deps: PermissionHookDeps, event: Evaluation) {
  const method = event.metadata?.method
  const known = typeof method === "string" ? method.toUpperCase() : "GET"
  if (known === "GET" || known === "HEAD") return
  const state = await enforced(deps, event)
  if (!state || state.mode === "off") return
  const http = event.resources.map((url) => request(known, url, undefined))
  const verdict = decide({ argv: [], isRemote: false, http }, state.loaded.rules, "strict")
  if (verdict.decision !== "allow") deny(deps.stats, event, verdict.ruleId!, verdict.reason!)
}

/** The policy the hooks enforce now; a config error denies the event and returns `undefined`. */
async function enforced(deps: PermissionHookDeps, event: Evaluation) {
  try {
    return await active(deps.policy)
  } catch (error) {
    deny(deps.stats, event, "config-error", describe(error))
  }
}

/** Shell asks are counted by `execute.before`, so only denies are recorded here. */
function deny(stats: Stats, event: Evaluation, ruleId?: string, reason?: string) {
  void stats.record("deny", ruleId)
  set(event, "deny", label(ruleId, reason))
}

function set(event: Evaluation, effect: Evaluation["effect"], message: string) {
  event.effect = effect
  event.message = message
}
