/**
 * Rule set assembly and decisions (design 4, 5.1).
 *
 * Per atom, in order:
 * 1. `off` mode allows everything (self-protection is handled separately);
 * 2. an `extraDeny` rule or a `critical` rule denies;
 * 3. an `extraAllow` rule exempts the atom from the remaining rules;
 * 4. `extraAsk` rules ask, and `high` / `medium` rules follow the 5.1 matrix.
 * With `protectedEndpoints`, the built-in `high` rule `protected-endpoint-write` matches any HTTP request to them
 * that is not a known GET / HEAD.
 * Verdicts are combined as deny > ask > allow; on a tie the first rule wins.
 */

import { endpointMatcher } from "../http-extractor"
import type { Decision, InlineRule, Mode, ProtectedEndpoints, Rule, Severity } from "../types"
import { RuleError, validateInlineRule } from "./loader"
import { compileRule, matchRule, type CompiledRule, type MatchInput } from "./matcher"

export interface RuleSet {
  severity: CompiledRule[]
  deny: CompiledRule[]
  ask: CompiledRule[]
  allow: CompiledRule[]
}

export interface Verdict {
  decision: Decision
  ruleId?: string
  reason?: string
}

export interface RuleSources {
  /** Validated rules from the built-in table and `rulesFile`. */
  rules: Rule[]
  extraDeny?: unknown[]
  extraAsk?: unknown[]
  extraAllow?: unknown[]
  protectedEndpoints?: ProtectedEndpoints
}

const MATRIX: Record<Mode, Record<Severity, Decision>> = {
  strict: { critical: "deny", high: "deny", medium: "ask" },
  relaxed: { critical: "deny", high: "ask", medium: "allow" },
  off: { critical: "allow", high: "allow", medium: "allow" },
}

const RANK: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 }

export const ALLOW: Verdict = { decision: "allow" }

export function severityDecision(severity: Severity, mode: Mode): Decision {
  return MATRIX[mode][severity]
}

export function buildRuleSet(sources: RuleSources): RuleSet {
  const ids = new Set<string>()
  const add = (rule: InlineRule, source: string) => {
    if (ids.has(rule.id)) throw new RuleError(`${source}: duplicate rule id "${rule.id}"`)
    ids.add(rule.id)
    return compileRule(rule)
  }
  const inline = (key: "extraDeny" | "extraAsk" | "extraAllow") =>
    (sources[key] ?? []).map((raw, i) => {
      const source = `options.${key}[${i}]`
      const rule = validateInlineRule(raw, source)
      return add({ ...rule, reason: rule.reason ?? `${key} rule "${rule.id}"` }, source)
    })
  const severity = sources.rules.map((rule) => add(rule, "rules"))
  const hosts = endpointMatcher(sources.protectedEndpoints)
  if (hosts) {
    const rule: Rule = {
      id: "protected-endpoint-write",
      severity: "high",
      reason: "向受保护的管理端点（protectedEndpoints）发送写请求",
      http: {},
    }
    severity.push({ ...add(rule, "options.protectedEndpoints"), http: { hosts, write: true } })
  }
  return {
    severity,
    deny: inline("extraDeny"),
    ask: inline("extraAsk"),
    allow: inline("extraAllow"),
  }
}

export function decide(input: MatchInput, set: RuleSet, mode: Mode): Verdict {
  if (mode === "off") return ALLOW
  const hit = (rules: CompiledRule[], filter: (rule: InlineRule) => boolean = () => true) =>
    rules.find((compiled) => filter(compiled.rule) && matchRule(compiled, input))
  const deny = hit(set.deny) ?? hit(set.severity, (rule) => rule.severity === "critical")
  if (deny) return verdict("deny", deny)
  const allow = hit(set.allow)
  if (allow) return verdict("allow", allow)
  const verdicts: Verdict[] = []
  for (const compiled of set.ask) if (matchRule(compiled, input)) verdicts.push(verdict("ask", compiled))
  for (const compiled of set.severity)
    if (matchRule(compiled, input)) verdicts.push(verdict(severityDecision(compiled.rule.severity!, mode), compiled))
  return combine(verdicts)
}

/** The strongest verdict; the first one wins a tie, so an allowing rule keeps its id. */
export function combine(verdicts: Verdict[]): Verdict {
  return verdicts.reduce((best, next) => (RANK[next.decision] > RANK[best.decision] ? next : best), verdicts[0] ?? ALLOW)
}

function verdict(decision: Decision, compiled: CompiledRule): Verdict {
  return { decision, ruleId: compiled.rule.id, reason: compiled.rule.reason! }
}
