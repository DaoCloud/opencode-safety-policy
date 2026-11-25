/** Option tables for CLIs whose options take values (design 3.1 Stage 1/3, 4.1). */

export interface OptionSpec {
  /** Short option letters that take a value, e.g. `p` for `ssh -p 22` / `ssh -p22`. */
  shortValue: string
  /** Long option names (without `--`) that take a value as the next argument. */
  longValue: ReadonlySet<string>
  /**
   * Options with an optional value, keyed `-x` or `--name`. A short option takes the rest of its cluster; a
   * separate next argument is taken only when it matches the pattern (`parallel -i`, `parallel -l 2`).
   */
  optional?: ReadonlyMap<string, RegExp>
  /**
   * Every long option name, value-taking ones first, for parsers that accept a unique prefix of a long name
   * (getopt_long, Getopt::Long, argparse, optparse). Undefined for parsers that need exact names (pflag, Go flag, bash).
   */
  longNames?: readonly string[]
  /** Getopt::Long: long names are case-insensitive, may start with `+`, and one-letter names are short options. */
  getoptLong?: boolean
}

export interface ParsedOption {
  /** `-x` for a value-taking short option, the whole cluster (`-it`) otherwise, or the full `--name`. */
  name: string
  value?: string
  /** Index of the argument after this option and its value. */
  next: number
  /** Getopt::Long: the rest of a cluster after a number, parsed as a new cluster (`-j` of `-l1j`). */
  rest?: string
}

interface SpecOptions {
  optional?: Record<string, RegExp>
  /** Long options without a value. Listing them enables abbreviated long names. */
  flags?: string[]
  getoptLong?: boolean
}

const spec = (shortValue: string, longValue: string[] = [], options: SpecOptions = {}): OptionSpec => {
  const result: OptionSpec = { shortValue, longValue: new Set(longValue) }
  if (options.optional) result.optional = new Map(Object.entries(options.optional))
  if (options.flags) {
    const optional = Object.keys(options.optional ?? {}).filter((key) => options.getoptLong || key.startsWith("--"))
    result.longNames = [...longValue, ...optional.map((key) => key.replace(/^--?/, "")), ...options.flags]
  }
  if (options.getoptLong) result.getoptLong = true
  return result
}

const NERDCTL_GLOBAL = [
  "namespace",
  "address",
  "host",
  "snapshotter",
  "storage-driver",
  "cni-path",
  "cni-netconfpath",
  "data-root",
  "cgroup-manager",
  "hosts-dir",
  "host-gateway-ip",
  "bridge-ip",
  "log-file",
  "cdi-spec-dirs",
  "userns-remap",
]

const PODMAN_GLOBAL = [
  "connection",
  "url",
  "identity",
  "log-level",
  "root",
  "runroot",
  "runtime",
  "runtime-flag",
  "storage-driver",
  "storage-opt",
  "cgroup-manager",
  "conmon",
  "events-backend",
  "hooks-dir",
  "network-cmd-path",
  "network-config-dir",
  "tmpdir",
  "volumepath",
  "module",
  "ssh",
  "imagestore",
  "db-backend",
  "out",
  "cni-config-dir",
]

// GNU parallel option names (Getopt::Long, from its option table): `=s` / `=i` / `=f` values and flags. Long names
// are matched in lower case, so the upper-case letters are only reachable as short options.
const PARALLEL_VALUE = `a arg-file argfile arg-file-sep argfilesep arg-sep argsep B basefile basenameextensionreplace
  basenamereplace bf bin block block-size blocksize block-timeout blocktimeout bner bnr bt C col-sep colsep
  combine-exec combineexec combine-executable combineexecutable compress-program compressprogram ctag-string
  ctagstring d D debug decompress-program decompressprogram delay delimiter dirnamereplace dnr E env er
  extensionreplace filter group-by groupby H halt halt-on-error haltonerror header I id j J jl joblog jobs L limit
  linkinputsource load max-args maxargs max-chars maxchars max-procs maxprocs max-replace-args maxreplaceargs memfree
  memsuspend min-version minversion n N nice P parens _parset process-slot-var processslotvar profile recend recstart
  res result results retries return rpl rsync-opts rsyncopts s S semaphore-name semaphorename semaphore-timeout
  semaphoretimeout seqreplace shard shell-completion shellcompletion slf slotreplace sql sql-and-worker sqlandworker
  sql-master sqlmaster sql-worker sqlworker ssh ssh-delay sshdelay sshlogin sshloginfile st tag-string tagstring
  tempdir template term-seq termseq _test tf timeout tmpdir tmpl total total-jobs totaljobs transfer-file
  transferfile transfer-files transferfiles trc trim U use-compress-program usecompressprogram use-decompress-program
  usedecompressprogram W wd work-dir workdir xapplyinputsource`.split(/\s+/)
const PARALLEL_FLAG = `0 bar bg _bug cat cf cleanup color color-fail colorfail color-failed colorfailed colour
  colour-fail colourfail colour-failed colourfailed compress controlmaster csv ctag ctrl-c ctrlc dr dry-run dryrun
  embed eta exit fg fifo files files0 filter-host filter-hosts filterhosts g gnu group h hashbang help hgrp hostgroup
  hostgroups hostgrp interactive k keep-order keeporder latest-line latestline lb line-buffer linebuffer
  line-buffered linebuffered link ll m M max-line-length-allowed maxlinelengthallowed nn no-ctrl-c no-ctrlc noctrlc
  no-k nok no-keep-order nokeeporder nonall no-notice nonotice no-run-if-empty norunifempty noswap null
  number-of-cores numberofcores number-of-cpus numberofcpus number-of-sockets numberofsockets number-of-threads
  numberofthreads o onall open-tty output-as-files outputasfiles output-as-files0 outputasfiles0 p pipe
  _pipe-means-argfiles pipe-part pipepart plain plus progress q quote r record-env recordenv regex regexp
  remove-rec-sep removerecsep resume resume-failed resumefailed retry-failed retryfailed round round-robin roundrobin
  rrs semaphore session shebang shell-quote shell_quote shellquote show-limits showlimits shuf silent
  skip-first-line skipfirstline spreadstdin t T tag tee tmux tmux-pane tmuxpane tollef transfer tty u ungroup _unsafe
  use-cores-instead-of-threads usecoresinsteadofthreads use-cpus-instead-of-cores usecpusinsteadofcores
  use-sockets-instead-of-threads usesocketsinsteadofthreads v V verbose version wait will-cite willcite x X xapply
  xargs Y`.split(/\s+/)
// Getopt::Long takes an optional string unless the next argument is `--` or looks like an option (`-` alone is a
// value), an optional number only when it is numeric. A bundled number (`-l1j`) ends where the number does.
const NOT_OPTION = /^(?![-+][^\n])/
const FLOAT = String.raw`[-+]?(?=\.?[0-9])[0-9_]*(\.[0-9_]*)?([eE][-+]?[0-9_]+)?`
const NUMBER = new RegExp(String.raw`^${FLOAT}\n?$`)
const LEADING_NUMBER = new RegExp(`^${FLOAT}`)
// getopt takes an optional argument only when it is attached (`-i{}`, `--replace={}`).
const ATTACHED = /(?!)/

// HTTP client long options (curl 8.9, wget 1.24, HTTPie 3).
const CURL_VALUE = `abstract-unix-socket alt-svc aws-sigv4 cacert capath cert cert-type ciphers config connect-timeout
  connect-to continue-at cookie cookie-jar create-file-mode crlfile curves data data-ascii data-binary data-raw
  data-urlencode delegation dns-interface dns-ipv4-addr dns-ipv6-addr dns-servers doh-url dump-header ech egd-file
  engine etag-compare etag-save expect100-timeout form form-string ftp-account ftp-alternative-to-user ftp-method
  ftp-port ftp-ssl-ccc-mode happy-eyeballs-timeout-ms haproxy-clientip header help hostpubmd5 hostpubsha256 hsts
  interface ip-tos ipfs-gateway json keepalive-cnt keepalive-time key key-type knownhosts krb libcurl limit-rate
  local-port login-options mail-auth mail-from mail-rcpt max-filesize max-redirs max-time netrc-file noproxy
  oauth2-bearer output output-dir parallel-max pass pinnedpubkey preproxy proto proto-default proto-redir proxy
  proxy-cacert proxy-capath proxy-cert proxy-cert-type proxy-ciphers proxy-crlfile proxy-header proxy-key
  proxy-key-type proxy-pass proxy-pinnedpubkey proxy-service-name proxy-tls13-ciphers proxy-tlsauthtype
  proxy-tlspassword proxy-tlsuser proxy-user proxy1.0 pubkey quote random-file range rate referer request
  request-target resolve retry retry-delay retry-max-time sasl-authzid service-name sigalgs socks4 socks4a socks5
  socks5-gssapi-service socks5-hostname speed-limit speed-time ssl-sessions stderr telnet-option tftp-blksize
  time-cond tls-max tls13-ciphers tlsauthtype tlspassword tlsuser trace trace-ascii trace-config unix-socket
  upload-file upload-flags url url-query user user-agent variable vlan-priority write-out`.split(/\s+/)
const CURL_FLAG = `anyauth append basic ca-native cert-status compressed compressed-ssh create-dirs crlf digest
  disable disable-eprt disable-epsv disallow-username-in-url doh-cert-status doh-insecure fail fail-early
  fail-with-body false-start form-escape ftp-create-dirs ftp-pasv ftp-pret ftp-skip-pasv-ip ftp-ssl-ccc
  ftp-ssl-control get globoff haproxy-protocol head http0.9 http1.0 http1.1 http2 http2-prior-knowledge http3
  http3-only ignore-content-length include insecure ipv4 ipv6 junk-session-cookies list-only location location-trusted
  mail-rcpt-allowfails manual metalink mptcp negotiate netrc netrc-optional next no-alpn no-buffer no-clobber
  no-keepalive no-npn no-progress-meter no-sessionid ntlm ntlm-wb parallel parallel-immediate path-as-is post301
  post302 post303 progress-bar proxy-anyauth proxy-basic proxy-ca-native proxy-digest proxy-http2 proxy-insecure
  proxy-negotiate proxy-ntlm proxy-ssl-allow-beast proxy-ssl-auto-client-cert proxy-tlsv1 proxytunnel raw
  remote-header-name remote-name remote-name-all remote-time remove-on-error retry-all-errors retry-connrefused
  sasl-ir show-error silent socks5-basic socks5-gssapi socks5-gssapi-nec ssl ssl-allow-beast ssl-auto-client-cert
  ssl-no-revoke ssl-reqd ssl-revoke-best-effort sslv2 sslv3 styled-output suppress-connect-headers tcp-fastopen
  tcp-nodelay tftp-no-options tlsv1 tlsv1.0 tlsv1.1 tlsv1.2 tlsv1.3 tr-encoding trace-ids trace-time use-ascii verbose
  version xattr`.split(/\s+/)
const WGET_VALUE = `accept accept-regex append-output backups base bind-address body-data body-file ca-certificate
  ca-directory certificate certificate-type ciphers compression config connect-timeout crl-file cut-dirs default-page
  directory-prefix dns-timeout domains exclude-directories exclude-domains execute follow-tags ftp-password ftp-user
  header hsts-file http-password http-user ignore-tags include-directories input-file level limit-rate load-cookies
  local-encoding max-redirect method output-document output-file password pinnedpubkey post-data post-file
  prefer-family private-key private-key-type progress proxy-password proxy-user quota random-file read-timeout referer
  regex-type reject reject-regex rejected-log remote-encoding report-speed restrict-file-names retry-on-http-error
  save-cookies secure-protocol start-pos timeout tries use-askpass user user-agent wait waitretry warc-dedup warc-file
  warc-header warc-max-size warc-tempdir`.split(/\s+/)
const WGET_FLAG = `adjust-extension ask-password auth-no-challenge background backup-converted content-disposition
  content-on-error continue convert-file-only convert-links debug delete-after follow-ftp force-directories force-html
  ftps-clear-data-connection ftps-fallback-to-ftp ftps-implicit ftps-resume-ssl help https-only ignore-case
  ignore-length inet4-only inet6-only keep-session-cookies mirror no-cache no-check-certificate no-clobber no-config
  no-cookies no-directories no-dns-cache no-glob no-host-directories no-hsts no-http-keep-alive no-if-modified-since
  no-iri no-netrc no-parent no-passive-ftp no-proxy no-remove-listing no-use-server-timestamps no-verbose
  no-warc-compression no-warc-digests no-warc-keep-log page-requisites preserve-permissions protocol-directories quiet
  random-wait recursive relative retr-symlinks retry-connrefused retry-on-host-error save-headers server-response
  show-progress span-hosts spider strict-comments timestamping trust-server-names unlink verbose version warc-cdx
  xattr`.split(/\s+/)
const HTTPIE_VALUE = `boundary raw pretty style response-charset response-mime format-options print output session
  session-read-only auth auth-type proxy max-redirects max-headers timeout verify ssl ciphers cert cert-key
  cert-key-pass default-scheme history-print`.split(/\s+/)
const HTTPIE_FLAG = `json form multipart compress unsorted sorted headers meta body verbose all stream download
  continue quiet ignore-netrc offline follow check-status path-as-is chunked ignore-stdin help manual version
  traceback debug`.split(/\s+/)

// Help and version flags of GNU getopt_long tools.
const GNU = ["help", "version"]

export const OPTION_SPECS = {
  ssh: spec("BbcDEeFIiJLlmOoPpQRSWw"),
  sshpass: spec("pfdP"),
  sudo: spec(
    "CDghpRrtTUu",
    [
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
      "auth-type",
      "login-class",
    ],
    {
      flags: [
        "background",
        "preserve-env",
        "edit",
        "set-home",
        "login",
        "remove-timestamp",
        "list",
        "preserve-groups",
        "shell",
        "validate",
        "askpass",
        "bell",
        "reset-timestamp",
        "no-update",
        "non-interactive",
        "stdin",
        ...GNU,
      ],
    },
  ),
  // `-a` / `--argv0` exist since coreutils 9.5.
  env: spec("auCS", ["unset", "chdir", "split-string", "argv0"], {
    flags: [
      "ignore-environment",
      "null",
      "debug",
      "list-signal-handling",
      "default-signal",
      "ignore-signal",
      "block-signal",
      ...GNU,
    ],
  }),
  timeout: spec("sk", ["signal", "kill-after"], { flags: ["foreground", "preserve-status", "verbose", ...GNU] }),
  nohup: spec(""),
  nice: spec("n", ["adjustment"], { flags: GNU }),
  exec: spec("a"),
  time: spec("fo", ["format", "output", "output-file"], { flags: ["append", "portability", "quiet", "verbose", ...GNU] }),
  stdbuf: spec("ioe", ["input", "output", "error"], { flags: GNU }),
  ionice: spec("cnpPu", ["class", "classdata", "pid", "pgid", "uid"], { flags: ["ignore", ...GNU] }),
  doas: spec("Cu"),
  // `su` and `runuser` share util-linux option parsing; `-u` only exists in `runuser`.
  su: spec("cgGsuw", ["command", "session-command", "group", "supp-group", "shell", "user", "whitelist-environment"], {
    flags: ["fast", "login", "preserve-environment", "pty", "no-pty", ...GNU],
  }),
  xargs: spec("adEILnPs", ["arg-file", "delimiter", "max-args", "max-procs", "max-chars", "process-slot-var"], {
    optional: { "-e": ATTACHED, "-i": ATTACHED, "-l": ATTACHED },
    flags: [
      "null",
      "eof",
      "replace",
      "max-lines",
      "open-tty",
      "interactive",
      "no-run-if-empty",
      "verbose",
      "show-limits",
      "exit",
      ...GNU,
    ],
  }),
  ipmitool: spec("AbBCdDefHIklLmNoOpPRStTUyz"),
  // iptables 1.8 (`IPT_OPTSTRING`, `original_opts`). `ebtables` and `arptables` share the command options. An optional
  // value may also be the next argument unless it starts with `-` or `!` (`xs_has_arg`).
  iptables: spec(
    "ACDEIMNPRcdijopstgm",
    [
      "append",
      "delete",
      "check",
      "insert",
      "replace",
      "new-chain",
      "rename-chain",
      "policy",
      "source",
      "destination",
      "src",
      "dst",
      "protocol",
      "in-interface",
      "jump",
      "table",
      "match",
      "out-interface",
      "modprobe",
      "set-counters",
      "goto",
    ],
    {
      optional: Object.fromEntries(
        ["L", "list", "S", "list-rules", "F", "flush", "Z", "zero", "X", "delete-chain", "w", "wait", "W", "wait-interval"]
          .map((name) => [name.length === 1 ? `-${name}` : `--${name}`, /^(?![-!])/]),
      ),
      flags: ["numeric", "verbose", "exact", "fragments", "version", "help", "line-numbers", "ipv4", "ipv6"],
    },
  ),
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
  nerdctl: spec("naH", NERDCTL_GLOBAL),
  // `nerdctl` and `podman` global options are also accepted after `exec`.
  nerdctlExec: spec("euwnaH", ["env", "env-file", "user", "workdir", ...NERDCTL_GLOBAL]),
  podman: spec("c", PODMAN_GLOBAL),
  podmanExec: spec("euwc", [
    "env",
    "env-file",
    "user",
    "workdir",
    "detach-keys",
    "preserve-fd",
    "preserve-fds",
    "cidfile",
    "wait",
    ...PODMAN_GLOBAL,
  ]),
  crictl: spec("cirt", [
    "config",
    "image-endpoint",
    "runtime-endpoint",
    "timeout",
    "tracing-endpoint",
    "tracing-sampling-rate-per-million",
  ]),
  crictlExec: spec("rpn", [
    "timeout",
    "transport",
    "name",
    "pod",
    "image",
    "state",
    "label",
    "last",
    "tls-sni",
    "tls-server-name",
    "tls-ca",
    "tls-cert",
    "tls-key",
  ]),
  ansible: spec(
    "aBcefilmMPtTu",
    [
      "args",
      "background",
      "connection",
      "extra-vars",
      "forks",
      "inventory",
      "inventory-file",
      "limit",
      "module-name",
      "module-path",
      "poll",
      "tree",
      "timeout",
      "user",
      "become-method",
      "become-user",
      "private-key",
      "key-file",
      "vault-id",
      "vault-password-file",
      "vault-pass-file",
      "ssh-common-args",
      "sftp-extra-args",
      "scp-extra-args",
      "ssh-extra-args",
      "playbook-dir",
      "task-timeout",
      "connection-password-file",
      "conn-pass-file",
      "become-password-file",
      "become-pass-file",
    ],
    {
      flags: [
        "ask-become-pass",
        "ask-pass",
        "ask-vault-pass",
        "ask-vault-password",
        "become",
        "check",
        "diff",
        "flush-cache",
        "list-hosts",
        "one-line",
        "verbose",
        ...GNU,
      ],
    },
  ),
  // Core options plus those of the genders (`-F`), dshgroup / netgroup (`-g`, `-X`) and slurm (`-j`, `-P`) modules.
  pdsh: spec("wxgXltufRMFjPIT"),
  pssh: spec(
    "hHlpoetOxX",
    ["hosts", "host", "user", "par", "outdir", "errdir", "timeout", "option", "extra-args", "extra-arg"],
    { flags: ["verbose", "askpass", "inline", "inline-stdout", "send-input", "print", ...GNU] },
  ),
  clush: spec(
    "wxgXsEOfloutmR",
    [
      "groupsource",
      "conf",
      "option",
      "groupsconf",
      "group",
      "engine",
      "hostfile",
      "machinefile",
      "topology",
      "pick",
      "axis",
      "color",
      "outdir",
      "errdir",
      "dest",
      "fanout",
      "grooming",
      "user",
      "options",
      "connect_timeout",
      "command_timeout",
      "mode",
      "worker",
      "remote",
    ],
    {
      flags: [
        "all",
        "copy",
        "debug",
        "diff",
        "dshbak",
        "groupbase",
        "maxrc",
        "nostdin",
        "progress",
        "quiet",
        "rcopy",
        "regroup",
        "verbose",
        ...GNU,
      ],
    },
  ),
  chroot: spec("", ["userspec", "groups"], { flags: ["skip-chdir", ...GNU] }),
  flock: spec("wE", ["timeout", "wait", "conflict-exit-code"], {
    flags: ["shared", "exclusive", "unlock", "nonblocking", "nb", "close", "no-fork", "verbose", ...GNU],
  }),
  watch: spec("nq", ["interval", "equexit"], {
    optional: { "-d": ATTACHED },
    flags: [
      "color",
      "no-color",
      "differences",
      "beep",
      "errexit",
      "chgexit",
      "exec",
      "precise",
      "no-rerun",
      "no-title",
      "no-wrap",
      ...GNU,
    ],
  }),
  parallel: spec("aBCdDEHIjJLnNPsSUW", PARALLEL_VALUE, {
    optional: {
      "-i": NOT_OPTION,
      "--replace": NOT_OPTION,
      "-e": NOT_OPTION,
      "--eof": NOT_OPTION,
      "-l": NUMBER,
      "--max-lines": NUMBER,
      "--maxlines": NUMBER,
    },
    flags: PARALLEL_FLAG,
    getoptLong: true,
  }),
  // curl 7 accepts a unique prefix of a long name and curl 8 needs the exact name, so prefixes are expanded.
  curl: spec("EKCbcdDFPHhmoxUQreXYytzTuAw", CURL_VALUE, { flags: CURL_FLAG }),
  wget: spec("eoaiBtOTwQPUlARDIX", WGET_VALUE, { flags: WGET_FLAG }),
  httpie: spec("spoaAP", HTTPIE_VALUE, { flags: HTTPIE_FLAG }),
  // Interpreter options that take a value, including the program options (`python -c`, `perl -e`).
  python: spec("cmQWX", ["check-hash-based-pycs"]),
  perl: spec("eEIMm"),
  ruby: spec("eICrEF"),
  node: spec("eprC", [
    "eval",
    "print",
    "require",
    "import",
    "loader",
    "experimental-loader",
    "input-type",
    "env-file",
    "conditions",
    "title",
  ]),
} satisfies Record<string, OptionSpec>

/** Parses the option at `args[i]`. Returns undefined for positionals, `-` and `--`. */
export function readOption(args: readonly string[], i: number, spec: OptionSpec): ParsedOption | undefined {
  const arg = args[i]
  if (arg === undefined || arg === "-" || arg === "--") return undefined
  const long = arg.startsWith("--") ? 2 : spec.getoptLong && arg.length > 1 && arg.startsWith("+") ? 1 : 0
  if (!long && !arg.startsWith("-")) return undefined
  const optional = (name: string): ParsedOption => {
    const next = args[i + 1]
    if (next === undefined || !spec.optional!.get(name)!.test(next)) return { name, next: i + 1 }
    return { name, value: next, next: i + 2 }
  }
  if (long) {
    const eq = arg.indexOf("=")
    const key = longName(eq < 0 ? arg.slice(long) : arg.slice(long, eq), spec)
    const name = spec.getoptLong && key.length === 1 ? `-${key}` : `--${key}`
    if (eq >= 0) return { name, value: arg.slice(eq + 1), next: i + 1 }
    if (spec.longValue.has(key)) return { name, value: args[i + 1], next: i + 2 }
    if (spec.optional?.has(name)) return optional(name)
    return { name, next: i + 1 }
  }
  for (let k = 1; k < arg.length; k++) {
    const c = arg.charAt(k)
    const isOptional = spec.optional?.has(`-${c}`) ?? false
    if (!spec.shortValue.includes(c) && !isOptional) continue
    const attached = arg.slice(k + 1)
    if (attached && spec.getoptLong && spec.optional?.get(`-${c}`) === NUMBER) {
      const number = LEADING_NUMBER.exec(attached)?.[0] ?? ""
      const rest = attached.slice(number.length)
      return { name: `-${c}`, ...(number && { value: number }), next: i + 1, ...(rest && { rest: `-${rest}` }) }
    }
    if (attached) return { name: `-${c}`, value: attached, next: i + 1 }
    if (isOptional) return optional(`-${c}`)
    return { name: `-${c}`, value: args[i + 1], next: i + 2 }
  }
  return { name: arg, next: i + 1 }
}

/**
 * The long option name `given` stands for. A unique prefix is expanded and an exact name wins over longer ones, as
 * in the parsers with `longNames`. An ambiguous prefix makes those parsers fail, so any expansion of it is safe.
 */
function longName(given: string, spec: OptionSpec): string {
  const key = spec.getoptLong ? given.toLowerCase() : given
  const names = spec.longNames
  if (!names || key === "" || names.includes(key)) return key
  return names.find((name) => name.startsWith(key)) ?? key
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
    if (spec.shortValue.includes(c) || spec.optional?.has(`-${c}`)) break
    flags += c
  }
  return flags
}
