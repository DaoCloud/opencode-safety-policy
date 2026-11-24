/**
 * Interpreter code prescan (design 3.1 Stage 3.5).
 *
 * A small lexer finds the string literals of python, perl, ruby and node code, skipping comments. When the code
 * references a process API, every string literal and every comma-separated run of literals and literal lists
 * (`"rm", ["-rf", "/data"]`) is returned as a shell command. Calls of file deletion APIs with literal paths
 * (`shutil.rmtree("/data")`) are returned as the equivalent `rm` command. Only literals are used: values built at
 * run time are not seen, and an interpolation (`f"{d}"`, `"#{d}"`, `` `${d}` ``) becomes a shell variable.
 *
 * Endpoint literals (a URL with `://`, a Redfish or UFM path, a host name or an IP address) are returned as HTTP
 * requests with the whole code as the body. A literal that is the first argument of a `post` / `put` / `patch` /
 * `delete` call has that method. Otherwise the method is unknown when the code has another write action (a call
 * with a computed URL, `requests.request("POST", u)`, `Net::HTTP::Post`, `method: "PATCH"`) or the URL has
 * `/Actions/`, and GET when it has none.
 */

import { request, type HttpRequest } from "./http-extractor"

export type Language = "python" | "perl" | "ruby" | "node"

type QuoteLike = { text: string; list: boolean; next: number }

type Token =
  | { kind: "string"; value: string }
  /** `qw(...)` and `%w(...)` word lists. */
  | { kind: "list"; values: string[] }
  | { kind: "word"; value: string }
  | { kind: "punct"; value: string }

const PROCESS_API: Record<Language, RegExp> = {
  python: new RegExp(
    String.raw`\b(?:subprocess|system|popen|exec[lv]p?e?|spawn[lv]?p?e?|posix_spawnp?|getoutput|getstatusoutput|` +
      String.raw`create_subprocess_(?:exec|shell))\b`,
  ),
  perl: /\b(?:system|exec|qx)\b|`/,
  ruby: /\b(?:system|exec|spawn|popen\w*|Open3|PTY)\b|%x|`/,
  node: /child_process/,
}

const DELETE_APIS: Record<Language, Record<string, string>> = {
  python: {
    "shutil.rmtree": "rm -rf",
    rmtree: "rm -rf",
    "os.remove": "rm",
    "os.unlink": "rm",
    "os.rmdir": "rmdir",
    "os.removedirs": "rmdir",
  },
  perl: { rmtree: "rm -rf", remove_tree: "rm -rf", unlink: "rm", rmdir: "rmdir" },
  ruby: {
    ...Object.fromEntries(
      ["rm_rf", "rm_r", "remove_dir", "remove_entry", "remove_entry_secure", "rmtree"].map((name) => [
        `FileUtils.${name}`,
        "rm -rf",
      ]),
    ),
    ...Object.fromEntries(["rm", "rm_f", "remove", "remove_file"].map((name) => [`FileUtils.${name}`, "rm"])),
    "File.delete": "rm",
    "File.unlink": "rm",
    "Dir.rmdir": "rmdir",
    "Dir.delete": "rmdir",
    "Dir.unlink": "rmdir",
  },
  node: { rm: "rm -rf", rmSync: "rm -rf", rmdir: "rm -rf", rmdirSync: "rm -rf", unlink: "rm", unlinkSync: "rm" },
}
const WRITE_METHODS = new Set(["post", "put", "patch", "delete"])
const WRITE_SEGMENT = /^(?:Post|Put|Patch|Delete|POST|PUT|PATCH|DELETE)$/
const HOST_LITERAL = /^[\w-]+(?:\.[\w-]+)+(?::\d+)?$/
const IPV6_LITERAL = /^\[?[0-9a-f.]*:[0-9a-f.]*:[0-9a-f:.]*\]?$/i
const NODE_RECEIVER = /^(?:(?:fs|fsp|promises)\.)*/
const PERL_PACKAGE = /^(?:\w+::)*/
const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" }
const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "0": "\0",
  a: "\x07",
  b: "\b",
  f: "\f",
  v: "\v",
  e: "\x1b",
}
const ESCAPE = /\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|(\n)|([\s\S]))/g
const PYTHON_PREFIX = /^(?:[rRuUbBfF]|[rR][bBfF]|[bBfF][rR])$/
const INTERPOLATION: Record<Language, RegExp> = {
  python: /\{\{|\}\}|\{[^{}]*\}/g,
  perl: /(?!)/g,
  ruby: /#\{[^{}]*\}/g,
  node: /\$\{[^{}]*\}/g,
}

/** Shell commands found in `code`. */
export function scanCode(code: string, language: Language): string[] {
  const tokens = lex(code, language)
  const commands: string[] = []
  const add = (words: string[]) => {
    const text = words.map(quote).join(" ")
    if (text.trim()) commands.push(text)
  }
  const deletes = DELETE_APIS[language]
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]!
    if (token.kind !== "word") continue
    const name = token.value.replace(language === "node" ? NODE_RECEIVER : language === "perl" ? PERL_PACKAGE : /^$/, "")
    if (!Object.hasOwn(deletes, name)) continue
    const start = isPunct(tokens[k + 1], "(") ? k + 2 : k + 1
    const paths = run(tokens, start)
    if (paths?.values.length) commands.push(`${deletes[name]} ${paths.values.map(quote).join(" ")}`)
  }
  if (!PROCESS_API[language].test(code)) return commands
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]!
    if (token.kind === "string" && token.value.trim()) commands.push(token.value)
    const found = run(tokens, k)
    if (!found) continue
    if (found.values.length > 1 || found.next > k + 1) add(found.values)
    if (found.next > k + 1) {
      for (let i = k + 1; i < found.next; i++) {
        const inner = tokens[i]!
        if (inner.kind === "string" && inner.value.trim()) commands.push(inner.value)
      }
      k = found.next - 1
    }
  }
  return commands
}

/** HTTP requests to the endpoint literals of `code`. */
export function scanHttp(code: string, language: Language): HttpRequest[] {
  const tokens = lex(code, language)
  const pinned = new Map<number, string>()
  let unpinned = false
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]!
    if (token.kind === "string" && WRITE_METHODS.has(token.value.toLowerCase())) unpinned = true
    if (token.kind !== "word") continue
    const segments = token.value.split(/\.|::/)
    const last = segments[segments.length - 1]!
    if (segments.some((segment) => WRITE_SEGMENT.test(segment))) unpinned = true
    if (!WRITE_METHODS.has(last)) continue
    const first = tokens[k + 2]
    const end = tokens[k + 3]
    const literal = first?.kind === "string" && !/[$`]/.test(first.value)
    if (isPunct(tokens[k + 1], "(") && literal && (isPunct(end, ",") || isPunct(end, ")")))
      pinned.set(k + 2, last.toUpperCase())
    else unpinned = true
  }
  const requests: HttpRequest[] = []
  tokens.forEach((token, k) => {
    if (token.kind !== "string") return
    const url = token.value
    const ipv6 = IPV6_LITERAL.test(url)
    const endpoint =
      url.includes("://") || (url.startsWith("/") && /redfish|ufmrest/i.test(url)) || HOST_LITERAL.test(url) || ipv6
    if (!endpoint || /\s/.test(url)) return
    const method = pinned.get(k) ?? (unpinned || /\/actions\//i.test(url) ? undefined : "GET")
    requests.push(request(method, url, code, ipv6 && !url.startsWith("[") ? `[${url}]` : url))
  })
  return requests
}

function isPunct(token: Token | undefined, value: string) {
  return token?.kind === "punct" && token.value === value
}

/** A literal, a `qw` list or a `[...]` list of literals at `k`. */
function item(tokens: Token[], k: number): { values: string[]; next: number } | undefined {
  const token = tokens[k]
  if (token?.kind === "string") return { values: [token.value], next: k + 1 }
  if (token?.kind === "list") return { values: token.values, next: k + 1 }
  if (!isPunct(token, "[")) return undefined
  const values: string[] = []
  let i = k + 1
  while (!isPunct(tokens[i], "]")) {
    const inner = tokens[i]
    if (inner?.kind !== "string") return undefined
    values.push(inner.value)
    i++
    if (isPunct(tokens[i], ",")) i++
    else if (!isPunct(tokens[i], "]")) return undefined
  }
  return { values, next: i + 1 }
}

/** Items at `k` separated by commas, flattened. */
function run(tokens: Token[], k: number): { values: string[]; next: number } | undefined {
  let found = item(tokens, k)
  if (!found) return undefined
  const values = [...found.values]
  let next = found.next
  while (isPunct(tokens[next], ",") && (found = item(tokens, next + 1))) {
    values.push(...found.values)
    next = found.next
  }
  return { values, next }
}

function quote(word: string) {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`
}

function lex(code: string, language: Language): Token[] {
  const tokens: Token[] = []
  let i = 0
  const string = (quote: string, decode: (text: string) => string) => {
    const start = i
    while (i < code.length && !code.startsWith(quote, i)) i += code[i] === "\\" ? 2 : 1
    const text = code.slice(start, Math.min(i, code.length))
    i += quote.length
    tokens.push({ kind: "string", value: decode(text) })
  }
  while (i < code.length) {
    const c = code[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (isComment(code, i, language)) {
      if (code.startsWith("/*", i)) {
        const end = code.indexOf("*/", i + 2)
        i = end < 0 ? code.length : end + 2
      } else {
        const end = code.indexOf("\n", i)
        i = end < 0 ? code.length : end
      }
      continue
    }
    if (/[A-Za-z_$]/.test(c) && (c !== "$" || language === "node")) {
      const word = readWord(code, i, language)
      i += word.length
      const next = code[i]
      if (language === "python" && PYTHON_PREFIX.test(word) && (next === "'" || next === '"')) {
        const triple = code.startsWith(next.repeat(3), i) ? next.repeat(3) : next
        i += triple.length
        const raw = /r/i.test(word)
        string(triple, (text) => {
          const decoded = raw ? text : decode(text, language)
          return /f/i.test(word) ? interpolate(decoded, language) : decoded
        })
        continue
      }
      const literal = /[$@%&>]/.test(code[i - word.length - 1] ?? "") ? undefined : quoteLike(code, i, word, language)
      if (literal) {
        i = literal.next
        tokens.push(literalToken(literal))
        continue
      }
      tokens.push({ kind: "word", value: word })
      continue
    }
    if (language === "ruby" && c === "%") {
      const literal = quoteLike(code, i + 1, "%", language)
      if (literal) {
        i = literal.next
        tokens.push(literalToken(literal))
        continue
      }
    }
    if (c === "'" || c === '"' || (c === "`" && language !== "python")) {
      const triple = language === "python" && code.startsWith(c.repeat(3), i) ? c.repeat(3) : c
      i += triple.length
      const raw = c === "'" && (language === "perl" || language === "ruby")
      const interpolated = (language === "ruby" && c !== "'") || (language === "node" && c === "`")
      string(triple, (text) => {
        if (raw) return singleQuoted(text)
        return interpolated ? interpolate(decode(text, language), language) : decode(text, language)
      })
      continue
    }
    tokens.push({ kind: "punct", value: c })
    i++
  }
  return tokens
}

function literalToken(literal: QuoteLike): Token {
  if (literal.list) return { kind: "list", values: literal.text.split(/\s+/).filter(Boolean) }
  return { kind: "string", value: literal.text }
}

function isComment(code: string, i: number, language: Language) {
  if (language === "node") return code.startsWith("//", i) || code.startsWith("/*", i)
  return code[i] === "#" && !(language === "perl" && code[i - 1] === "$")
}

/** An identifier with its dotted (and, for perl and ruby, `::`) parts. */
function readWord(code: string, i: number, language: Language): string {
  const ident = language === "node" ? /^[A-Za-z_$][\w$]*/ : /^[A-Za-z_]\w*/
  let word = ident.exec(code.slice(i))![0]
  for (;;) {
    const rest = code.slice(i + word.length)
    const colons = language !== "python" && language !== "node" && rest.startsWith("::")
    const separator = rest.startsWith(".") ? "." : colons ? "::" : ""
    const part = separator ? ident.exec(rest.slice(separator.length))?.[0] : undefined
    if (!part) return word
    word += separator + part
  }
}

/**
 * Perl `q`, `qq`, `qw`, `qx` and ruby `%`, `%q`, `%Q`, `%w`, `%W`, `%x`, `%i` literals, with the delimiter at `i`
 * (after the operator for perl, after `%` for ruby).
 */
function quoteLike(code: string, i: number, word: string, language: Language): QuoteLike | undefined {
  let kind: string
  if (language === "perl" && ["q", "qq", "qw", "qx"].includes(word)) {
    kind = word.slice(1)
    while (code[i] === " " || code[i] === "\t") i++
    if (code[i] === "#" && /\s/.test(code[i - 1]!)) return undefined
  } else if (language === "ruby" && word === "%") {
    const c = code[i] ?? ""
    kind = ""
    if (/[qQwWxiI]/.test(c)) {
      i++
      kind = c === "Q" ? "" : c.toLowerCase()
    }
  } else return undefined
  const open = code[i]
  if (open === undefined || /[\w\s=,;)]/.test(open)) return undefined
  const close = PAIRS[open] ?? open
  let depth = 0
  let k = i + 1
  for (; k < code.length; k++) {
    const c = code[k]!
    if (c === "\\") {
      k++
      continue
    }
    if (c === open && close !== open) depth++
    else if (c === close && depth-- === 0) break
  }
  const text = code.slice(i + 1, k)
  if (kind === "q") return { text: singleQuoted(text), list: false, next: k + 1 }
  const list = kind === "w" || kind === "i"
  return { text: language === "ruby" ? interpolate(text, language) : text, list, next: k + 1 }
}

/** Replaces the interpolations of `text` with a shell variable, because their value is only known at run time. */
function interpolate(text: string, language: Language): string {
  return text.replace(INTERPOLATION[language], (match) => (match === "{{" ? "{" : match === "}}" ? "}" : "${v}"))
}

function singleQuoted(text: string): string {
  return text.replace(/\\([\\'])/g, "$1")
}

function decode(text: string, language: Language): string {
  return text.replace(ESCAPE, (match, hex, braced, unicode, newline, c) => {
    const code = hex ?? braced ?? unicode
    if (code !== undefined) return String.fromCodePoint(Math.min(Number.parseInt(code, 16), 0x10ffff))
    if (newline !== undefined) return ""
    if (Object.hasOwn(ESCAPES, c)) return ESCAPES[c]!
    return language === "python" && !/['"\\]/.test(c) ? match : c
  })
}
