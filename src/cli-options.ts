/** Option tables for CLIs whose options take values (design 3.1 Stage 1/3, 4.1). */

export interface OptionSpec {
  /** Short option letters that take a value, e.g. `p` for `ssh -p 22` / `ssh -p22`. */
  shortValue: string
  /** Long option names (without `--`) that take a value as the next argument. */
  longValue: ReadonlySet<string>
}

export interface ParsedOption {
  /** `-x` for a value-taking short option, the whole cluster (`-it`) otherwise, or `--name`. */
  name: string
  value?: string
  /** Index of the argument after this option and its value. */
  next: number
}

const spec = (shortValue: string, longValue: string[] = []): OptionSpec => ({ shortValue, longValue: new Set(longValue) })

export const OPTION_SPECS = {
  ssh: spec("BbcDEeFIiJLlmOoPpQRSWw"),
  sshpass: spec("pfdP"),
  sudo: spec("CDghpRrtTUu", [
    "close-from",
    "chdir",
    "group",
    "host",
    "prompt",
    "chroot",
    "role",
    "type",
    "command-timeout",
    "other-user",
    "user",
  ]),
  env: spec("uCS", ["unset", "chdir", "split-string"]),
  timeout: spec("sk", ["signal", "kill-after"]),
  nohup: spec(""),
  shell: spec("", ["rcfile", "init-file"]),
  // Global options plus the value-taking options of `kubectl exec`.
  kubectl: spec("nsvcf", [
    "as",
    "as-group",
    "as-uid",
    "cache-dir",
    "certificate-authority",
    "client-certificate",
    "client-key",
    "cluster",
    "context",
    "kubeconfig",
    "kuberc",
    "log-backtrace-at",
    "log-dir",
    "log-file",
    "log-file-max-size",
    "log-flush-frequency",
    "namespace",
    "password",
    "profile",
    "profile-output",
    "request-timeout",
    "server",
    "stderrthreshold",
    "tls-server-name",
    "token",
    "user",
    "username",
    "v",
    "vmodule",
    "container",
    "filename",
    "pod-running-timeout",
  ]),
  docker: spec("Hcl", ["config", "context", "host", "log-level", "tlscacert", "tlscert", "tlskey"]),
  dockerExec: spec("euw", ["env", "env-file", "user", "workdir", "detach-keys"]),
} satisfies Record<string, OptionSpec>

/** Parses the option at `args[i]`. Returns undefined for positionals, `-` and `--`. */
export function readOption(args: readonly string[], i: number, spec: OptionSpec): ParsedOption | undefined {
  const arg = args[i]
  if (arg === undefined || arg === "-" || arg === "--" || !arg.startsWith("-")) return undefined
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=")
    if (eq >= 0) return { name: arg.slice(0, eq), value: arg.slice(eq + 1), next: i + 1 }
    if (spec.longValue.has(arg.slice(2))) return { name: arg, value: args[i + 1], next: i + 2 }
    return { name: arg, next: i + 1 }
  }
  for (let k = 1; k < arg.length; k++) {
    const c = arg.charAt(k)
    if (!spec.shortValue.includes(c)) continue
    const attached = arg.slice(k + 1)
    if (attached) return { name: `-${c}`, value: attached, next: i + 1 }
    return { name: `-${c}`, value: args[i + 1], next: i + 2 }
  }
  return { name: arg, next: i + 1 }
}

/** Returns the index of the first positional at or after `start`. A `--` terminator is consumed. */
export function skipOptions(args: readonly string[], start: number, spec: OptionSpec): number {
  let i = start
  while (i < args.length) {
    if (args[i] === "--") return i + 1
    const option = readOption(args, i, spec)
    if (!option) return i
    i = option.next
  }
  return i
}

/** Flag letters of a short option cluster that come before its value-taking letter, e.g. `Ee` for `-Eeu`. */
export function shortFlags(arg: string, spec: OptionSpec): string {
  if (!arg.startsWith("-") || arg.startsWith("--")) return ""
  let flags = ""
  for (const c of arg.slice(1)) {
    if (spec.shortValue.includes(c)) break
    flags += c
  }
  return flags
}
