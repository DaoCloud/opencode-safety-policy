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
 */

import type { Plugin } from "@opencode/plugin"
import { resolveCanonicalPath } from "../path-util"
import { active, type Policy } from "../policy"
import { isProtected, selfProtectVerdict } from "../rules/self-protect"
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
}

export function registerPermissionHook(ctx: Pick<Context, "permission" | "location">, deps: PermissionHookDeps): Promise<Registration> {
  return ctx.permission.hook("evaluate", (event) => evaluate(ctx, deps, event))
}

async function evaluate(ctx: Pick<Context, "location">, deps: PermissionHookDeps, event: Evaluation) {
  if (event.effect === "deny") return
  if (event.action === "shell") return forcePrompt(deps.markers, event)
  if (event.action === "edit") return protectFiles(ctx, deps.policy, event)
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

async function protectFiles(ctx: Pick<Context, "location">, policy: Policy, event: Evaluation) {
  let state
  try {
    state = await active(policy)
  } catch (error) {
    return set(event, "deny", label("config-error", describe(error)))
  }
  if (!state) return
  for (const resource of event.resources) {
    const target = resolveCanonicalPath(resource, ctx.location.directory, policy.home)
    if (!isProtected(target, state.loaded.protect)) continue
    const verdict = selfProtectVerdict(target)
    return set(event, "deny", label(verdict.ruleId, verdict.reason))
  }
}

function set(event: Evaluation, effect: Evaluation["effect"], message: string) {
  event.effect = effect
  event.message = message
}
