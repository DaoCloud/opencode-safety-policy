/**
 * Shell tokenizer (design 3.1 Stage 1).
 *
 * Splits a POSIX/bash command line into simple commands while keeping the information later stages need:
 * list connectors (pipeline upstream), redirects, heredoc bodies, and nested command substitutions.
 * Expansions are never performed; their source text stays in the word and the word is marked `expanded`.
 * Input that cannot be analysed statically yields `opaque` together with every command parsed so far.
 */

export type Connector = ";" | "&&" | "||" | "|" | "&"

export type OpaqueReason =
  | "unterminated-quote"
  | "unterminated-substitution"
  | "invalid-syntax"
  | "unsupported-syntax"
  | "function-definition"
  | "too-deep"
  | "too-long"

export interface Redirect {
  fd?: number
  op: string
  /** Unquoted target word. For `<<` / `<<-` this is the delimiter. */
  target: string
  /** Heredoc body, or the here-string for `<<<`. */
  body?: string
}

export interface Command {
  /** Operator joining this command to the previous one. `"|"` means the previous command is the pipeline upstream. */
  connector?: Connector
  assignments: string[]
  /** Normalized command name, `""` when the command only has assignments or redirects. */
  name: string
  /** Unquoted words, `argv[0]` is the command word before normalization. */
  argv: string[]
  /**
   * `expanded[i]` is true when `argv[i]` contains a parameter/command/arithmetic expansion, an unquoted glob
   * (`*`, `?`, `[...]`) or a brace expansion (`{a,b}`, `{1..3}`).
   */
  expanded: boolean[]
  redirects: Redirect[]
  /** Scripts from `$(...)`, backticks and `<(...)` / `>(...)` found anywhere in this command. */
  substitutions: Script[]
}

export interface Script {
  commands: Command[]
  opaque?: OpaqueReason
}

const MAX_LENGTH = 64 * 1024
const MAX_DEPTH = 16
const META = " \t\n;&|<>()"
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}"])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/
const ARRAY_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*\+?=$/
const PARAMETER = /[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-]/y
const FUNCTION_PARENS = /[ \t]*\([ \t]*\)/y
const REDIRECT_OPS = ["<<<", "<<-", "<<", "<>", "<&", ">>", ">&", ">|", "<", ">"]
const ANSI_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
}

class Abort extends Error {
  constructor(readonly reason: OpaqueReason) {
    super(reason)
  }
}

interface Word {
  text: string
  raw: string
  quoted: boolean
  expanded: boolean
}

interface PendingHeredoc {
  redirect: Redirect
  command: Command
  strip: boolean
  expand: boolean
}

export function tokenize(input: string): Script {
  if (input.length > MAX_LENGTH) return { commands: [], opaque: "too-long" }
  return new Parser(input, 0, 0).parse()
}

/** Strips leading backslashes (`\rm`) and directories (`/usr/bin/rm`). */
export function normalizeName(word: string): string {
  const name = word.replace(/^\\+/, "")
  return name.slice(name.lastIndexOf("/") + 1)
}

/**
 * True when an expanded command word has no literal basename (`$CMD`, `$(which rm)`, `r[m]`, `{rm,-rf,/}`).
 * `"$(go env GOPATH)/bin/sudo"` has the literal basename `sudo`.
 */
export function isDynamicName(word: string, expanded: boolean): boolean {
  return expanded && /[$`(){}[\]*?]/.test(normalizeName(word))
}

function newCommand(): Command {
  return { assignments: [], name: "", argv: [], expanded: [], redirects: [], substitutions: [] }
}

function isEmpty(command: Command) {
  return !command.argv.length && !command.assignments.length && !command.redirects.length
}

function decodeAnsiC(text: string): string {
  return text.replace(
    /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/gs,
    (_, seq: string) => {
      const kind = seq.charAt(0)
      if ((kind === "x" || kind === "u" || kind === "U") && seq.length > 1) {
        const code = parseInt(seq.slice(1), 16)
        return code <= 0x10ffff ? String.fromCodePoint(code) : ""
      }
      if (kind >= "0" && kind <= "7") return String.fromCharCode(parseInt(seq, 8) & 0xff)
      if (kind === "c" && seq.length === 2) return String.fromCharCode(seq.charCodeAt(1) & 0x1f)
      return ANSI_ESCAPES[seq] ?? `\\${seq}`
    },
  )
}

class Parser {
  pos: number
  private commands: Command[] = []
  private opaque?: OpaqueReason
  private current = newCommand()
  private connector?: Connector
  private parens = 0
  private heredocs: PendingHeredoc[] = []

  constructor(
    private readonly src: string,
    start: number,
    private readonly depth: number,
    private readonly terminator?: ")",
  ) {
    this.pos = start
  }

  parse(): Script {
    try {
      this.loop()
    } catch (error) {
      if (!(error instanceof Abort) || this.depth > 0) throw error
      this.finish()
      return { commands: this.commands, opaque: error.reason }
    }
    return this.opaque ? { commands: this.commands, opaque: this.opaque } : { commands: this.commands }
  }

  private flag(reason: OpaqueReason) {
    this.opaque ??= reason
  }

  private loop() {
    const src = this.src
    for (;;) {
      this.skipBlanks()
      if (this.pos >= src.length) {
        if (this.terminator) throw new Abort("unterminated-substitution")
        if (this.parens > 0) throw new Abort("invalid-syntax")
        this.finish()
        this.readHeredocs()
        return
      }
      const c = src[this.pos]
      const next = src[this.pos + 1]
      if (c === "#") {
        const end = src.indexOf("\n", this.pos)
        this.pos = end < 0 ? src.length : end
        continue
      }
      if (c === "\n") {
        this.pos++
        this.finish()
        this.readHeredocs()
        this.connector ??= ";"
        continue
      }
      if (c === ";") {
        this.pos += next === ";" || next === "&" ? 2 : 1
        this.link(";")
        continue
      }
      if (c === "&") {
        if (next === "&") {
          this.pos += 2
          this.link("&&")
        } else if (next === ">") {
          const op = src.startsWith("&>>", this.pos) ? "&>>" : "&>"
          this.pos += op.length
          this.redirectTarget(op)
        } else {
          this.pos++
          this.link("&")
        }
        continue
      }
      if (c === "|") {
        this.pos += next === "|" || next === "&" ? 2 : 1
        this.link(next === "|" ? "||" : "|")
        continue
      }
      if (c === "(") {
        this.openParen()
        continue
      }
      if (c === ")") {
        this.pos++
        this.finish()
        if (this.parens > 0) {
          this.parens--
          continue
        }
        if (this.terminator !== ")") throw new Abort("invalid-syntax")
        if (this.heredocs.length) this.flag("unsupported-syntax")
        return
      }
      if ((c === "<" || c === ">") && next === "(") {
        this.addWord(this.processSubstitution())
        continue
      }
      if (c === "<" || c === ">") {
        this.redirect()
        continue
      }
      const word = this.readWord(this.current.substitutions)
      const after = src[this.pos]
      if (/^\d+$/.test(word.raw) && (after === "<" || after === ">") && src[this.pos + 1] !== "(") {
        this.redirect(Number(word.text))
        continue
      }
      this.addWord(word)
    }
  }

  private skipBlanks() {
    const src = this.src
    while (this.pos < src.length) {
      const c = src[this.pos]
      if (c === " " || c === "\t") this.pos++
      else if (c === "\\" && src[this.pos + 1] === "\n") this.pos += 2
      else break
    }
  }

  private link(connector: Connector) {
    this.finish()
    this.connector = connector
  }

  private finish() {
    const command = this.current
    if (isEmpty(command) && !command.substitutions.length) return
    command.name = normalizeName(command.argv[0] ?? "")
    if (this.commands.length) command.connector = this.connector ?? ";"
    this.connector = undefined
    this.commands.push(command)
    this.current = newCommand()
  }

  private addWord(word: Word) {
    const command = this.current
    if (!command.argv.length && ASSIGNMENT.test(word.raw)) {
      command.assignments.push(word.text)
      return
    }
    if (isEmpty(command) && !word.quoted) {
      if (KEYWORDS.has(word.text)) return
      if (word.text === "case") throw new Abort("unsupported-syntax")
      if (word.text === "function") {
        this.flag("function-definition")
        this.skipBlanks()
        this.readWord([])
        this.skipFunctionParens()
        return
      }
    }
    command.argv.push(word.text)
    command.expanded.push(word.expanded)
  }

  private skipFunctionParens() {
    FUNCTION_PARENS.lastIndex = this.pos
    if (FUNCTION_PARENS.test(this.src)) this.pos = FUNCTION_PARENS.lastIndex
  }

  private openParen() {
    const command = this.current
    if (isEmpty(command)) {
      if (this.src[this.pos + 1] === "(") {
        this.skipArithmetic(this.pos + 2)
        return
      }
      this.pos++
      this.parens++
      return
    }
    if (command.argv.length === 1 && !command.assignments.length && !command.redirects.length) {
      const start = this.pos
      this.skipFunctionParens()
      if (this.pos > start) {
        this.flag("function-definition")
        this.current = newCommand()
        return
      }
    }
    throw new Abort("invalid-syntax")
  }

  /** Skips `((...))` / `$((...))` starting right after the opening `((`, returns the consumed source text. */
  private skipArithmetic(start: number): string {
    const src = this.src
    let depth = 2
    let i = start
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++
      else if (src[i] === ")") depth--
      i++
    }
    if (depth > 0) throw new Abort("invalid-syntax")
    const text = src.slice(start, i - 2)
    if (text.includes("$(") || text.includes("`")) this.flag("unsupported-syntax")
    this.pos = i
    return text
  }

  private redirect(fd?: number) {
    const op = REDIRECT_OPS.find((candidate) => this.src.startsWith(candidate, this.pos))!
    this.pos += op.length
    this.redirectTarget(op, fd)
  }

  private redirectTarget(op: string, fd?: number) {
    this.skipBlanks()
    const heredoc = op === "<<" || op === "<<-"
    const word = this.readWord(heredoc ? [] : this.current.substitutions)
    if (!word.raw) throw new Abort("invalid-syntax")
    const redirect: Redirect = fd === undefined ? { op, target: word.text } : { fd, op, target: word.text }
    if (op === "<<<") redirect.body = word.text
    this.current.redirects.push(redirect)
    if (heredoc)
      this.heredocs.push({ redirect, command: this.current, strip: op === "<<-", expand: !word.quoted })
  }

  private readHeredocs() {
    const src = this.src
    for (const heredoc of this.heredocs) {
      let body = ""
      while (this.pos < src.length) {
        const newline = src.indexOf("\n", this.pos)
        const end = newline < 0 ? src.length : newline
        let line = src.slice(this.pos, end)
        this.pos = newline < 0 ? end : newline + 1
        if (heredoc.strip) line = line.replace(/^\t+/, "")
        if (line === heredoc.redirect.target) break
        body += line + "\n"
      }
      heredoc.redirect.body = body
      if (heredoc.expand) {
        const parser = new Parser(body, 0, this.depth)
        parser.readDoubleQuoted(heredoc.command.substitutions, false)
        if (parser.opaque) this.flag(parser.opaque)
      }
    }
    this.heredocs = []
  }

  private readWord(subs: Script[]): Word {
    const src = this.src
    const start = this.pos
    let text = ""
    let quoted = false
    let expanded = false
    // Unquoted `[...]` globs and `{a,b}` / `{a..b}` brace expansions.
    let bracket = false
    let braces = 0
    let braceList = false
    while (this.pos < src.length) {
      const c = src.charAt(this.pos)
      if (META.includes(c)) {
        if (c === "(" && ARRAY_PREFIX.test(text) && !quoted) {
          text += this.readArray(subs)
          continue
        }
        break
      }
      if (c === "\\") {
        const escaped = src[this.pos + 1]
        this.pos += 2
        if (escaped === undefined || escaped === "\n") continue
        text += escaped
        quoted = true
        continue
      }
      if (c === "'") {
        const end = src.indexOf("'", this.pos + 1)
        if (end < 0) throw new Abort("unterminated-quote")
        text += src.slice(this.pos + 1, end)
        this.pos = end + 1
        quoted = true
        continue
      }
      if (c === '"') {
        this.pos++
        const part = this.readDoubleQuoted(subs, true)
        text += part.text
        expanded ||= part.expanded
        quoted = true
        continue
      }
      if (c === "$") {
        const next = src[this.pos + 1]
        if (next === "'") {
          text += this.readAnsiC()
          quoted = true
          continue
        }
        if (next === '"') {
          this.pos += 2
          const part = this.readDoubleQuoted(subs, true)
          text += part.text
          expanded ||= part.expanded
          quoted = true
          continue
        }
        const part = this.readDollar(subs)
        text += part
        expanded ||= part !== "$"
        continue
      }
      if (c === "`") {
        text += this.readBacktick(subs)
        expanded = true
        continue
      }
      if (c === "*" || c === "?") expanded = true
      else if (c === "[") bracket = true
      else if (c === "]" && bracket) expanded = true
      else if (c === "{") braces++
      else if (braces > 0 && (c === "," || (c === "." && src[this.pos + 1] === "."))) braceList = true
      else if (c === "}" && braces > 0) {
        braces--
        if (braceList) expanded = true
      }
      text += c
      this.pos++
    }
    return { text, raw: src.slice(start, this.pos), quoted, expanded }
  }

  /** Reads after an opening `"`. With `closed = false` it reads to the end of input (heredoc bodies). */
  private readDoubleQuoted(subs: Script[], closed: boolean): { text: string; expanded: boolean } {
    const src = this.src
    let text = ""
    let expanded = false
    while (this.pos < src.length) {
      const c = src[this.pos]
      if (closed && c === '"') {
        this.pos++
        return { text, expanded }
      }
      if (c === "\\") {
        const escaped = src[this.pos + 1]
        if (escaped === "\n") {
          this.pos += 2
          continue
        }
        if (escaped === "$" || escaped === "`" || escaped === "\\" || (closed && escaped === '"')) {
          text += escaped
          this.pos += 2
          continue
        }
        text += c
        this.pos++
        continue
      }
      if (c === "$") {
        const part = this.readDollar(subs)
        text += part
        expanded ||= part !== "$"
        continue
      }
      if (c === "`") {
        text += this.readBacktick(subs)
        expanded = true
        continue
      }
      text += c
      this.pos++
    }
    if (closed) throw new Abort("unterminated-quote")
    return { text, expanded }
  }

  private readAnsiC(): string {
    const src = this.src
    let i = this.pos + 2
    while (i < src.length && src[i] !== "'") i += src[i] === "\\" ? 2 : 1
    if (i >= src.length) throw new Abort("unterminated-quote")
    const text = decodeAnsiC(src.slice(this.pos + 2, i))
    this.pos = i + 1
    return text
  }

  /** Reads an unquoted `$` construct and returns its source text, or `"$"` when it is a literal dollar sign. */
  private readDollar(subs: Script[]): string {
    const src = this.src
    const start = this.pos
    const next = src[this.pos + 1]
    if (next === "(" && src[this.pos + 2] === "(") {
      this.skipArithmetic(this.pos + 3)
      return src.slice(start, this.pos)
    }
    if (next === "(") {
      this.pos += 2
      this.substitution(subs)
      return src.slice(start, this.pos)
    }
    if (next === "{") {
      this.skipBraces()
      return src.slice(start, this.pos)
    }
    PARAMETER.lastIndex = this.pos + 1
    if (PARAMETER.test(src)) {
      this.pos = PARAMETER.lastIndex
      return src.slice(start, this.pos)
    }
    this.pos++
    return "$"
  }

  private skipBraces() {
    const src = this.src
    let depth = 0
    let i = this.pos + 1
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === "\\") i++
      else if (c === "{") depth++
      else if (c === "}" && --depth === 0) break
      else if (c === "'" || c === '"') {
        const end = src.indexOf(c, i + 1)
        if (end < 0) throw new Abort("unterminated-quote")
        i = end
      }
    }
    if (i >= src.length) throw new Abort("invalid-syntax")
    const text = src.slice(this.pos, i + 1)
    if (text.includes("$(") || text.includes("`")) this.flag("unsupported-syntax")
    this.pos = i + 1
  }

  /** Parses the script of a `$(` / `<(` / `>(` whose opening has already been consumed. */
  private substitution(subs: Script[]) {
    if (this.depth + 1 > MAX_DEPTH) throw new Abort("too-deep")
    const inner = new Parser(this.src, this.pos, this.depth + 1, ")")
    subs.push(inner.parse())
    this.pos = inner.pos
  }

  private processSubstitution(): Word {
    const start = this.pos
    this.pos += 2
    this.substitution(this.current.substitutions)
    const raw = this.src.slice(start, this.pos)
    return { text: raw, raw, quoted: true, expanded: true }
  }

  private readBacktick(subs: Script[]): string {
    const src = this.src
    const start = this.pos
    let content = ""
    let i = this.pos + 1
    for (; i < src.length && src[i] !== "`"; i++) {
      const c = src[i]
      const escaped = src[i + 1]
      if (c === "\\" && (escaped === "`" || escaped === "\\" || escaped === "$")) {
        content += escaped
        i++
      } else content += c
    }
    if (i >= src.length) throw new Abort("unterminated-substitution")
    if (this.depth + 1 > MAX_DEPTH) throw new Abort("too-deep")
    subs.push(new Parser(content, 0, this.depth + 1).parse())
    this.pos = i + 1
    return src.slice(start, this.pos)
  }

  /** Reads `(a b c)` of an array assignment and returns its source text. */
  private readArray(subs: Script[]): string {
    const src = this.src
    const start = this.pos
    this.pos++
    for (;;) {
      while (this.pos < src.length && /[ \t\n]/.test(src.charAt(this.pos))) this.pos++
      if (this.pos >= src.length) throw new Abort("invalid-syntax")
      if (src[this.pos] === ")") {
        this.pos++
        return src.slice(start, this.pos)
      }
      if (!this.readWord(subs).raw) throw new Abort("invalid-syntax")
    }
  }
}
