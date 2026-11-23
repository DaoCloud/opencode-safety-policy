export type Mode = "strict" | "relaxed" | "off"

export type Severity = "critical" | "high" | "medium"

export type Decision = "allow" | "ask" | "deny"

export type RuleScope = "local" | "remote"

export interface RuleExamples {
  match: string[]
  ignore: string[]
}

export interface HttpMatch {
  methods?: string[]
  urlPatterns?: string[]
  bodyPatterns?: string[]
}

/** Declarative rule (design 4.1). At least one of `command`, `pattern` or `http` is required. */
export interface Rule {
  id: string
  severity: Severity
  reason: string
  /** Command name(s) after basename normalization, e.g. `["docker", "nerdctl", "podman"]`. */
  command?: string | string[]
  /** Any of these must match the positionals; multi-word entries such as `"config apply"` are allowed (design 4.1). */
  subcommands?: string[]
  /** Any of these must be present (`-f` also matches inside `-rf`). */
  flags?: string[]
  /** Regex tested against the command line `name arg1 arg2 ...`. */
  pattern?: string
  http?: HttpMatch
  scope?: RuleScope
  examples?: RuleExamples
}

/** Rule written inline in `opencode.json` (`extraDeny` / `extraAsk` / `extraAllow`). */
export interface InlineRule extends Omit<Rule, "severity" | "reason"> {
  severity?: Severity
  reason?: string
}

export interface ProtectedEndpoints {
  bmcCidrs?: string[]
  ufmHosts?: string[]
  nicoHosts?: string[]
}

/** Plugin options from `plugins[].options` in `opencode.json` (design 7). */
export interface PluginOptions {
  mode?: Mode
  alwaysProtectSelf?: boolean
  auditLogPath?: string
  rulesFile?: string[]
  protectedEndpoints?: ProtectedEndpoints
  sshReadOnlyAllowlist?: string[]
  extraDeny?: InlineRule[]
  extraAsk?: InlineRule[]
  extraAllow?: InlineRule[]
  enableServerSlashCommand?: boolean
}
