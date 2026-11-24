/**
 * HTTP request extraction (design 3.1 Stage 3.5, 4.1, 7).
 *
 * Finds the method, URLs and body of every request of a `curl`, `wget` or HTTPie (`http` / `https`) command:
 * - curl: `-X` wins, then `-I` (HEAD), `-G` (GET), `-T` (PUT) and data options (POST). Requests are grouped by
 *   `-:` / `--next`, `--expand-X` is read as `--X`, `@file` bodies are read and `-K` config files are expanded;
 * - wget: `--method` wins, then `--post-data` / `--post-file` (POST). `-e` and `--config` wgetrc commands apply, and
 *   `-i` reads a URL list;
 * - HTTPie: a first positional of letters followed by a URL is the method. Otherwise data items, `--raw` or stdin
 *   make it a POST; OpenCode runs commands with an empty stdin, so `http URL` without `-I` is a POST.
 * A method or body known only at run time is undefined: rules treat an unknown method as a write and an unknown body
 * as matching. An unreadable `-K` / `--config` file makes the extraction opaque.
 *
 * URLs are matched as written and normalized (WHATWG URL parsing, percent-decoded path without repeated `/`).
 * `protectedEndpoints` entries are IP addresses, CIDR blocks or literal host names.
 */

import { OPTION_SPECS, readOption, shortFlags, type OptionSpec } from "./cli-options"
import { normalizeName } from "./tokenizer"
import type { ProtectedEndpoints } from "./types"

export interface HttpRequest {
  /** Upper-case method; undefined when it is only known at run time. */
  method?: string
  /** The URL as written, then its normalized form when it parses. */
  urls: string[]
  /** Lower-case host without brackets and trailing dot; undefined for a path or a URL that does not parse. */
  host?: string
  /** Normalized path. */
  path?: string
  /** Request body; undefined when it is only known at run time. */
  body?: string
}

export interface HttpExtraction {
  requests: HttpRequest[]
  /** Why the requests cannot be known statically. */
  opaque?: string
  /** The command writes local files (`-o`, `--cookie-jar`, a `wget` download). */
  writes?: boolean
}

export interface HttpSources {
  /** Stdin text; undefined when it is unknown. */
  stdin?: string
  /** Reads a file named by the command; undefined when it cannot be read. Remote commands have no reader. */
  read?: (file: string) => string | undefined
}

type Body = string | undefined

interface Option {
  /** `--name` or `-x` of the value-taking option, or `""` for a cluster of flags only. */
  name: string
  value?: string
  dynamic: boolean
  /** Short flags before the value-taking letter. */
  flags: string
  next: number
}

const CURL = OPTION_SPECS.curl
const WGET = OPTION_SPECS.wget
const HTTPIE = OPTION_SPECS.httpie
const HARMLESS = new Set(["-", "/dev/null", "/dev/stdout", "/dev/stderr"])
const DYNAMIC = /[$`]/
const LEADING_EXPANSION = /^(\$\w+|\$\{[^}]*\}|\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`)/
const METHOD = /^[A-Za-z][A-Za-z-]*$/
const QUERY_PATH = /^\/(redfish|ufmRest(V\d+)?)(\/|$)/i
const MAX_CONFIG_DEPTH = 4

const CURL_SHORT: Record<string, string> = {
  "-X": "--request",
  "-d": "--data",
  "-F": "--form",
  "-T": "--upload-file",
  "-K": "--config",
  "-o": "--output",
  "-D": "--dump-header",
  "-c": "--cookie-jar",
  "-w": "--write-out",
  "-I": "--head",
  "-G": "--get",
  "-O": "--remote-name",
  "-:": "--next",
}
const CURL_WRITES = new Set(
  `--output --dump-header --cookie-jar --trace --trace-ascii --libcurl --stderr --etag-save --hsts --alt-svc
  --ssl-sessions`.split(/\s+/),
)
const WGET_SHORT: Record<string, string> = {
  "-e": "--execute",
  "-i": "--input-file",
  "-O": "--output-document",
  "-o": "--output-file",
  "-a": "--append-output",
}
const WGET_WRITES = new Set(["--output-file", "--append-output", "--save-cookies", "--warc-file", "--rejected-log"])
// wgetrc commands (lower case, without `_` and `-`) with the same effect as an option.
const WGETRC: Record<string, string> = {
  method: "--method",
  postdata: "--post-data",
  postfile: "--post-file",
  bodydata: "--body-data",
  bodyfile: "--body-file",
  input: "--input-file",
  outputdocument: "--output-document",
  logfile: "--output-file",
  savecookies: "--save-cookies",
  warcfile: "--warc-file",
}
// HTTPie item separators, longest first at a position. `=`, `:=`, `@` and their file forms are data.
const SEPARATORS = [":=@", "=@", ":=", "==", ":@", "=", ":", "@", ";"]
const DATA_SEPARATORS = new Set([":=@", "=@", ":=", "=", "@"])
const FILE_SEPARATORS = new Set([":=@", "=@", "@"])
const CONFIG_ESCAPES: Record<string, string> = { t: "\t", n: "\n", r: "\r", v: "\v" }

/** HTTP requests of a curl, wget or HTTPie command; undefined for other commands. */
export function extractHttp(argv: string[], expanded: boolean[], sources: HttpSources): HttpExtraction | undefined {
  const name = normalizeName(argv[0] ?? "")
  const args = argv.slice(1)
  const dynamic = args.map((arg, i) => !!expanded[i + 1] && DYNAMIC.test(arg))
  if (name === "curl") return curl(args, dynamic, sources)
  if (name === "wget") return wget(args, dynamic, sources)
  if (name === "http" || name === "https") return httpie(args, dynamic, sources, name)
  return undefined
}

/** True when every request is a known GET / HEAD of a Redfish or UFM path and no local file is written. */
export function isReadOnlyQuery(extraction: HttpExtraction | undefined): boolean {
  if (!extraction || extraction.opaque || extraction.writes || !extraction.requests.length) return false
  return extraction.requests.every(
    (request) =>
      (request.method === "GET" || request.method === "HEAD") &&
      request.path !== undefined &&
      QUERY_PATH.test(request.path),
  )
}

/** A request to `raw`; a URL without a scheme gets `scheme`. `target` is what the client parses when it differs. */
export function request(method: string | undefined, raw: string, body: Body, target = raw, scheme = "http"): HttpRequest {
  const parsed = parseUrl(target, scheme)
  const result: HttpRequest = { urls: [...new Set([raw, ...parsed.urls.slice(1)])] }
  if (method !== undefined) result.method = method
  if (parsed.host !== undefined) result.host = parsed.host
  if (parsed.path !== undefined) result.path = parsed.path
  if (body !== undefined) result.body = body
  return result
}

/**
 * `raw` and its normalized form, host and path. A path alone (`/redfish/v1/...`) has no host; a URL that does not
 * parse has only `raw`.
 */
export function parseUrl(raw: string, scheme = "http"): { urls: string[]; host?: string; path?: string } {
  const pathOnly = raw.startsWith("/") && !raw.startsWith("//")
  let url: URL
  try {
    if (pathOnly) url = new URL(raw, "http://path.invalid")
    else url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `${scheme}://${raw}`)
  } catch {
    return { urls: [raw] }
  }
  const path = percentDecode(url.pathname).replace(/\/{2,}/g, "/")
  if (pathOnly) return { urls: [raw, path + url.search], path }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "")
  const authority = (host.includes(":") ? `[${host}]` : host) + (url.port ? `:${url.port}` : "")
  return { urls: [raw, `${url.protocol}//${authority}${path}${url.search}`], host, path }
}

function percentDecode(text: string): string {
  return text.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
}

// ---------------------------------------------------------------------------------------------------------------
// Option reading

/** The option at `args[i]`, `"dynamic"` when its name is only known at run time, or undefined for a positional. */
function optionAt(args: string[], dynamic: boolean[], i: number, spec: OptionSpec): Option | "dynamic" | undefined {
  const arg = args[i]!
  if (!arg.startsWith("-") || arg === "-") return undefined
  if (dynamic[i] && dynamicName(arg, spec)) return "dynamic"
  const expand = spec === CURL && arg.startsWith("--expand-")
  const option = readOption([expand ? `--${arg.slice(9)}` : arg, ...args.slice(i + 1, i + 2)], 0, spec)!
  const flags = arg.startsWith("--") ? "" : shortFlags(arg, spec)
  const name = arg.startsWith("--") ? option.name : 1 + flags.length < arg.length ? option.name : ""
  const result: Option = { name, dynamic: false, flags, next: i + option.next }
  if (option.value !== undefined) {
    result.value = option.value
    // curl `--expand-X` values may hold `{{variables}}`.
    result.dynamic = !!(option.next === 1 ? dynamic[i] : dynamic[i + 1]) || (expand && option.value.includes("{{"))
  }
  return result
}

/** True when an expansion may change which option `arg` is (`--$NAME`, `-$X`). */
function dynamicName(arg: string, spec: OptionSpec): boolean {
  const at = arg.search(DYNAMIC)
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=")
    return eq < 0 || at < eq
  }
  return at <= 1 + shortFlags(arg, spec).length
}

/** True when a positional may expand to options (`$OPTS`), not only to a URL (`$BMC/redfish/v1`). */
function mayHoldOptions(arg: string): boolean {
  const expansion = LEADING_EXPANSION.exec(arg)?.[0]
  if (expansion === undefined) return arg.startsWith("$")
  return !/^[/:]/.test(arg.slice(expansion.length))
}

function fileBody(file: string | undefined, dynamic: boolean, sources: HttpSources): Body {
  if (file === undefined || dynamic) return undefined
  if (file === "-") return sources.stdin
  return sources.read?.(file)
}

function methodOf(value: string | null | undefined): string | undefined {
  return value && METHOD.test(value) ? value.toUpperCase() : undefined
}

function joinBody(pieces: Body[]): Body {
  return pieces.some((piece) => piece === undefined) ? undefined : pieces.join("&")
}

function writesTo(value: string | undefined, dynamic: boolean): boolean {
  return dynamic || value === undefined || !HARMLESS.has(value)
}

function extraction(requests: HttpRequest[], writes: boolean, opaque?: string): HttpExtraction {
  const result: HttpExtraction = { requests }
  if (opaque !== undefined) result.opaque = opaque
  if (writes) result.writes = true
  return result
}

// ---------------------------------------------------------------------------------------------------------------
// curl

interface CurlGroup {
  /** `-X` value; null when it is only known at run time. */
  method?: string | null
  head?: boolean
  get?: boolean
  upload?: { body: Body }
  data: Body[]
  urls: string[]
  /** A positional may hold options, so the method and body are unknown. */
  unknown?: boolean
}

interface CurlState {
  groups: CurlGroup[]
  writes: boolean
  opaque?: string
  sources: HttpSources
}

function curl(args: string[], dynamic: boolean[], sources: HttpSources): HttpExtraction {
  const state: CurlState = { groups: [{ data: [], urls: [] }], writes: false, sources }
  curlArgs(args, dynamic, state, 0)
  return extraction(state.groups.flatMap(curlRequests), state.writes, state.opaque)
}

function curlArgs(args: string[], dynamic: boolean[], state: CurlState, depth: number) {
  const group = () => state.groups[state.groups.length - 1]!
  for (let i = 0; i < args.length; ) {
    if (args[i] === "--") {
      for (let k = i + 1; k < args.length; k++) curlUrl(group(), args[k]!, dynamic[k]!)
      return
    }
    const option = optionAt(args, dynamic, i, CURL)
    if (option === undefined) curlUrl(group(), args[i]!, dynamic[i]!)
    else if (option === "dynamic") group().unknown = true
    else {
      for (const flag of option.flags) curlOption(`-${flag}`, undefined, false, state, depth)
      if (option.name) curlOption(option.name, option.value, option.dynamic, state, depth)
      i = option.next
      continue
    }
    i++
  }
}

function curlUrl(group: CurlGroup, arg: string, dynamic: boolean) {
  group.urls.push(arg)
  if (dynamic && mayHoldOptions(arg)) group.unknown = true
}

function curlOption(given: string, value: string | undefined, dynamic: boolean, state: CurlState, depth: number) {
  const group = state.groups[state.groups.length - 1]!
  const { sources } = state
  const name = CURL_SHORT[given] ?? given
  switch (name) {
    case "--next":
      state.groups.push({ data: [], urls: [] })
      return
    case "--request":
      group.method = dynamic || value === undefined ? null : value
      return
    case "--head":
      group.head = true
      return
    case "--get":
      group.get = true
      return
    case "--url":
      if (value !== undefined) group.urls.push(value)
      return
    case "--upload-file":
      group.upload = { body: fileBody(value === "." ? "-" : value, dynamic, sources) }
      return
    case "--data":
    case "--data-ascii":
    case "--data-binary":
    case "--json":
      group.data.push(value?.startsWith("@") ? fileBody(value.slice(1), dynamic, sources) : dynamic ? undefined : value)
      return
    case "--data-raw":
    case "--form-string":
      group.data.push(dynamic ? undefined : value)
      return
    case "--data-urlencode": {
      const at = value === undefined ? -1 : value.search(/[@=]/)
      const file = at >= 0 && value![at] === "@"
      group.data.push(file ? fileBody(value!.slice(at + 1), dynamic, sources) : dynamic ? undefined : value)
      return
    }
    case "--form": {
      const content = value?.slice(value.indexOf("=") + 1)
      const file = content !== undefined && /^[@<]/.test(content)
      group.data.push(file ? fileBody(content.slice(1).split(";")[0], dynamic, sources) : dynamic ? undefined : value)
      return
    }
    case "--config":
      return curlConfig(value, dynamic, state, depth)
    case "--remote-name":
    case "--remote-name-all":
      state.writes = true
      return
    case "--write-out":
      if (dynamic || value?.includes("%output")) state.writes = true
      return
  }
  if (CURL_WRITES.has(name) && writesTo(value, dynamic)) state.writes = true
}

function curlRequests(group: CurlGroup): HttpRequest[] {
  const pieces = group.upload ? [...group.data, group.upload.body] : group.data
  const body = group.unknown ? undefined : joinBody(pieces)
  let method: string | undefined
  if (group.unknown) method = undefined
  else if (group.method !== undefined) method = methodOf(group.method)
  else if (group.head) method = "HEAD"
  else if (group.get) method = "GET"
  else if (group.upload) method = "PUT"
  else method = group.data.length ? "POST" : "GET"
  return group.urls.map((url) => request(method, url, body))
}

/** Reads a `-K` file and parses its options in place, with the state of the command line. */
function curlConfig(file: string | undefined, dynamic: boolean, state: CurlState, depth: number) {
  const text = depth < MAX_CONFIG_DEPTH ? fileBody(file, dynamic, state.sources) : undefined
  if (text === undefined) {
    state.opaque ??= `curl 配置文件（-K ${file ?? ""}）无法读取`
    return
  }
  const args = curlConfigArgs(text)
  curlArgs(
    args,
    args.map(() => false),
    state,
    depth + 1,
  )
}

/** Command line arguments of a curl config file, parsed like curl `parseconfig`. */
export function curlConfigArgs(text: string): string[] {
  const args: string[] = []
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s+/, "")
    if (!line || "#/*".includes(line[0]!)) continue
    const dashed = line.startsWith("-")
    const name = (dashed ? /^\S+/ : /^[^\s=:]*/).exec(line)![0]
    const rest = line.slice(name.length).replace(dashed ? /^\s+/ : /^[\s=:]+/, "")
    const value = rest.startsWith('"') ? unquoteConfig(rest.slice(1)) : /^\S*/.exec(rest)![0]
    const option = dashed ? name : `--${name}`
    args.push(option)
    if (readOption([option, "v"], 0, CURL)?.next === 2) args.push(value)
  }
  return args
}

function unquoteConfig(text: string): string {
  let value = ""
  for (let i = 0; i < text.length && text[i] !== '"'; i++) {
    const c = text[i]!
    if (c === "\\" && i + 1 < text.length) {
      const next = text[++i]!
      value += CONFIG_ESCAPES[next] ?? next
    } else value += c
  }
  return value
}

// ---------------------------------------------------------------------------------------------------------------
// wget

interface WgetState {
  method?: string | null
  post: boolean
  bodies: Body[]
  urls: string[]
  unknown: boolean
  writes: boolean
  /** `-O` target; null when it is only known at run time. */
  output?: string | null
  spider: boolean
  opaque?: string
  sources: HttpSources
}

function wget(args: string[], dynamic: boolean[], sources: HttpSources): HttpExtraction {
  const state: WgetState = { post: false, bodies: [], urls: [], unknown: false, writes: false, spider: false, sources }
  for (let i = 0; i < args.length; ) {
    if (args[i] === "--") {
      for (let k = i + 1; k < args.length; k++) wgetUrl(state, args[k]!, dynamic[k]!)
      break
    }
    const option = optionAt(args, dynamic, i, WGET)
    if (option === undefined) wgetUrl(state, args[i]!, dynamic[i]!)
    else if (option === "dynamic") state.unknown = true
    else {
      if (option.name) wgetOption(option.name, option.value, option.dynamic, state)
      i = option.next
      continue
    }
    i++
  }
  const known = state.method !== undefined ? methodOf(state.method) : state.post ? "POST" : "GET"
  const method = state.unknown ? undefined : known
  const body = state.unknown ? undefined : joinBody(state.bodies)
  const output = state.output
  const writes = state.writes || !(state.spider || (typeof output === "string" && HARMLESS.has(output)))
  return extraction(
    state.urls.map((url) => request(method, url, body)),
    writes,
    state.opaque,
  )
}

function wgetUrl(state: WgetState, arg: string, dynamic: boolean) {
  state.urls.push(arg)
  if (dynamic && mayHoldOptions(arg)) state.unknown = true
}

function wgetOption(given: string, value: string | undefined, dynamic: boolean, state: WgetState) {
  const name = WGET_SHORT[given] ?? given
  const { sources } = state
  switch (name) {
    case "--execute":
      if (dynamic) state.unknown = true
      else if (value !== undefined) wgetrc(value, state)
      return
    case "--config": {
      const text = fileBody(value, dynamic, sources)
      if (text === undefined) state.opaque ??= `wget 配置文件（--config ${value ?? ""}）无法读取`
      else for (const line of text.split("\n")) wgetrc(line, state)
      return
    }
    case "--method":
      state.method = dynamic || value === undefined ? null : value
      return
    case "--post-data":
    case "--post-file":
    case "--body-data":
    case "--body-file":
      if (name.startsWith("--post")) state.post = true
      state.bodies.push(name.endsWith("file") ? fileBody(value, dynamic, sources) : dynamic ? undefined : value)
      return
    case "--input-file": {
      const text = fileBody(value, dynamic, sources)
      if (text === undefined) state.urls.push("")
      else state.urls.push(...text.split("\n").map((line) => line.trim()).filter(Boolean))
      return
    }
    case "--output-document":
      state.output = dynamic || value === undefined ? null : value
      return
    case "--spider":
      state.spider = true
      return
  }
  if (WGET_WRITES.has(name) && writesTo(value, dynamic)) state.writes = true
}

/** Applies a wgetrc command (`method = POST`) like the option of the same effect. */
function wgetrc(line: string, state: WgetState) {
  const command = /^\s*([\w-]+)\s*=\s*(.*?)\s*$/.exec(line)
  if (!command) return
  const key = command[1]!.toLowerCase().replace(/[-_]/g, "")
  const value = command[2]!
  if (key === "spider") state.spider = /^(on|yes|1)$/i.test(value)
  else if (Object.hasOwn(WGETRC, key)) wgetOption(WGETRC[key]!, value, false, state)
}

// ---------------------------------------------------------------------------------------------------------------
// HTTPie

function httpie(args: string[], dynamic: boolean[], sources: HttpSources, command: string): HttpExtraction {
  let scheme = command
  let ignoreStdin = false
  let offline = false
  let writes = false
  let unknown = false
  const raw: Body[] = []
  const positionals: { arg: string; dynamic: boolean }[] = []
  const flag = (name: string) => {
    if (name === "-I" || name === "--ignore-stdin") ignoreStdin = true
    else if (name === "--offline") offline = true
    else if (name === "-d" || name === "--download") writes = true
  }
  for (let i = 0; i < args.length; ) {
    if (args[i] === "--") {
      for (let k = i + 1; k < args.length; k++) positionals.push({ arg: args[k]!, dynamic: dynamic[k]! })
      break
    }
    const option = optionAt(args, dynamic, i, HTTPIE)
    if (option === undefined) positionals.push({ arg: args[i]!, dynamic: dynamic[i]! })
    else if (option === "dynamic") unknown = true
    else {
      for (const letter of option.flags) flag(`-${letter}`)
      const { name, value } = option
      flag(name)
      if (name === "--raw") raw.push(option.dynamic ? undefined : value)
      else if (name === "--default-scheme" && value !== undefined && !option.dynamic) scheme = value
      else if ((name === "-o" || name === "--output") && writesTo(value, option.dynamic)) writes = true
      else if (name === "--session") writes = true
      i = option.next
      continue
    }
    i++
  }
  if (offline || !positionals.length) return extraction([], writes)
  if (positionals.some((positional) => positional.dynamic && mayHoldOptions(positional.arg))) unknown = true
  let method: string | undefined
  let urls = [positionals[0]!]
  let items = positionals.slice(1)
  const [first, second] = positionals
  if (second && first!.dynamic) {
    // The first positional is the method or the URL.
    unknown = true
    urls = [first!, second]
    items = positionals.slice(2)
  } else if (second && /^[a-zA-Z]+$/.test(first!.arg)) {
    method = first!.arg.toUpperCase()
    urls = [second]
    items = positionals.slice(2)
  }
  const pieces: Body[] = [...raw]
  for (const item of items) {
    const piece = httpieData(item.arg, item.dynamic, sources)
    if (piece !== null) pieces.push(piece)
  }
  if (!ignoreStdin && sources.stdin !== "") pieces.push(sources.stdin)
  method ??= pieces.length || !ignoreStdin ? "POST" : "GET"
  const body = unknown ? undefined : joinBody(pieces)
  return extraction(
    urls.map(({ arg }) => request(unknown ? undefined : method, arg, body, httpieTarget(arg), scheme)),
    writes,
  )
}

/** The body piece of a request item; null for a header or a query parameter. */
function httpieData(item: string, dynamic: boolean, sources: HttpSources): Body | null {
  if (dynamic) return undefined
  let found: { index: number; separator: string } | undefined
  for (let i = 0; i < item.length && !found; i++) {
    if (item[i] === "\\") i++
    else {
      const separator = SEPARATORS.find((candidate) => item.startsWith(candidate, i))
      if (separator) found = { index: i, separator }
    }
  }
  if (!found || !DATA_SEPARATORS.has(found.separator)) return null
  if (!FILE_SEPARATORS.has(found.separator)) return item
  const content = fileBody(item.slice(found.index + found.separator.length), false, sources)
  return content === undefined ? undefined : `${item.slice(0, found.index)}=${content}`
}

/** The URL HTTPie requests for `:3000/x` (localhost shorthand). */
function httpieTarget(url: string): string {
  const shorthand = /^:(?!:)(\d*)(\/?[\s\S]*)$/.exec(url)
  return shorthand ? `localhost${shorthand[1] ? `:${shorthand[1]}` : ""}${shorthand[2]}` : url
}

// ---------------------------------------------------------------------------------------------------------------
// Protected endpoints

interface Endpoint {
  version?: 4 | 6
  /** The network address, masked to `prefix` bits. */
  address?: bigint
  prefix: number
  host?: string
}

/** Parses a `protectedEndpoints` entry: an IP address, a CIDR block or a host name; undefined when it is invalid. */
export function parseEndpoint(entry: string): Endpoint | undefined {
  if (/[[\]@?#\s]/.test(entry)) return undefined
  const slash = entry.indexOf("/")
  const text = slash < 0 ? entry : entry.slice(0, slash)
  const prefixText = slash < 0 ? undefined : entry.slice(slash + 1)
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return undefined
  let url: URL
  try {
    url = new URL(`http://${text.includes(":") ? `[${text}]` : text}/`)
  } catch {
    return undefined
  }
  if (url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined
  const address = parseAddress(url.hostname.replace(/^\[(.*)\]$/, "$1"))
  if (!address) {
    const host = url.hostname.replace(/\.$/, "")
    return prefixText === undefined && /^[a-z0-9_.-]+$/.test(host) ? { prefix: 0, host } : undefined
  }
  const bits = address.version === 4 ? 32 : 128
  const prefix = prefixText === undefined ? bits : Number(prefixText)
  if (prefix > bits) return undefined
  return { version: address.version, address: mask(address.value, prefix, bits), prefix }
}

/** Returns a test of request hosts against `endpoints`; undefined when there are no entries. */
export function endpointMatcher(endpoints: ProtectedEndpoints | undefined): ((host: string) => boolean) | undefined {
  const entries = Object.values(endpoints ?? {})
    .flat()
    .flatMap((entry) => parseEndpoint(entry) ?? [])
  if (!entries.length) return undefined
  return (host) => {
    const address = parseAddress(host)
    const mapped =
      address?.version === 6 && address.value >> 32n === 0xffffn
        ? { version: 4 as const, value: address.value & 0xffffffffn }
        : undefined
    return entries.some((entry) => {
      if (entry.host !== undefined) return entry.host === host
      return [address, mapped].some((candidate) => {
        if (!candidate || candidate.version !== entry.version) return false
        return mask(candidate.value, entry.prefix, entry.version === 4 ? 32 : 128) === entry.address
      })
    })
  }
}

/** A dotted IPv4 address or an IPv6 address as serialized by the URL parser (hex groups, `::`). */
function parseAddress(host: string): { version: 4 | 6; value: bigint } | undefined {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const parts = host.split(".").map(Number)
    if (parts.some((part) => part > 255)) return undefined
    return { version: 4, value: parts.reduce((value, part) => (value << 8n) | BigInt(part), 0n) }
  }
  if (!host.includes(":") || !/^[0-9a-f:]+$/i.test(host)) return undefined
  const halves = host.split("::")
  if (halves.length > 2) return undefined
  const groups = (half: string | undefined) => (half ? half.split(":") : [])
  const head = groups(halves[0])
  const tail = groups(halves[1])
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  const all = [...head, ...Array<string>(Math.max(fill, 0)).fill("0"), ...tail]
  if (all.length !== 8 || all.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return undefined
  return { version: 6, value: all.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n) }
}

function mask(value: bigint, prefix: number, bits: number): bigint {
  const host = BigInt(bits - prefix)
  return (value >> host) << host
}
