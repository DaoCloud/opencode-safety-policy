/**
 * Shell tokenizer (design 3.1 Stage 1).
 *
 * Splits a POSIX/bash command line into simple commands while keeping the information later stages need:
 * list connectors (pipeline upstream), redirects, heredoc bodies, and nested command substitutions.
 * Brace expansion of argument words is performed as bash does, within a word and character budget. Other
 * expansions are never performed; their source text stays in the word and the word is marked `expanded`.
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
  | "piped-script"
  | "dynamic-args"

export interface Redirect {
  fd?: number
  op: string
  /** Unquoted target word. For `<<` / `<<-` this is the delimiter. */
  target: string
  /** Heredoc body, or the here-string for `<<<` with the newline bash appends. */
  body?: string
}

export interface Command {
  /** Operator joining this command to the previous one. `"|"` means the previous command is the pipeline upstream. */
  connector?: Connector
  assignments: string[]
  /** Normalized command name, `""` when the command only has assignments or redirects. */
  name: string
  /** Unquoted words, `argv[0]` is the command word before normalization. Argument brace expansions are expanded. */
  argv: string[]
  /**
   * `expanded[i]` is true when `argv[i]` contains a parameter/command/arithmetic expansion or an unquoted glob
   * (`*`, `?`, `[...]`), or when the command word contains a brace expansion (`{a,b}`, `{1..3}`).
   */
  expanded: boolean[]
  redirects: Redirect[]
  /** Scripts from `$(...)`, backticks and `<(...)` / `>(...)` found anywhere in this command. */
  substitutions: Script[]
  /** Reads a pipe other than `connector`: the command is inside a piped compound command or is a `coproc`. */
  piped?: true
  /** Number of leading `redirects` that belong to enclosing compound commands and apply before words expand. */
  outerRedirects?: number
  /** Number of leading `redirects` that apply before the pipe replaces stdin: those of groups enclosing the pipe. */
  pipeAt?: number
  /** The simple command writing to the `"|"` connector; unset when it is a compound command. */
  upstream?: Command
}

export interface Script {
  commands: Command[]
  opaque?: OpaqueReason
  /** Set on the script of `>(...)`, which reads its stdin from a pipe. */
  piped?: true
}

/** Limits on the words brace expansion may produce, shared by every parser it is passed to. */
export interface BraceBudget {
  words: number
  chars: number
}

const MAX_LENGTH = 64 * 1024
const MAX_DEPTH = 16
const META = " \t\n;&|<>()"
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}"])
// Words that open a compound command, mapped to the word that closes it.
const OPENERS = new Map([
  ["{", "}"],
  ["if", "fi"],
  ["while", "done"],
  ["until", "done"],
  ["for", "done"],
  ["select", "done"],
])
const CLOSERS = new Set(["}", "fi", "done"])
// `time [-p] [--] [!]` may precede a compound command.
const TIME_PREFIX = new Set(["time", "-p", "--"])
// Loop headers only bind words, so their brace expansions are left alone.
const LOOP_HEADS = new Set(["for", "select"])
const SEQUENCE = /^(?:(-?\d+)\.\.(-?\d+)|([A-Za-z])\.\.([A-Za-z]))(?:\.\.(-?\d+))?$/
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
  /** Offsets in `raw` of unquoted `{`, `,` and `}`, the only characters that can form a brace expansion. */
  braces: number[]
}

interface Group {
  /** Index of the first command of the group. */
  start: number
  close: string
  /** Number of enclosing groups. */
  depth: number
  /** `depth` of the group whose pipe this group reads: itself or an enclosing group. */
  source?: number
  /** A `for` or `select` loop before its body, which is either `do ... done` or `{ ... }`. */
  loop?: boolean
}

interface PendingHeredoc {
  redirect: Redirect
  command: Command
  strip: boolean
  expand: boolean
}

/** A fresh budget: brace expansion beyond 1024 words or 64 KiB is treated as `too-long`. */
export function braceBudget(): BraceBudget {
  return { words: 1024, chars: MAX_LENGTH }
}

/** `budget` defaults to a fresh one; pass a shared budget to bound the expansions of many calls together. */
export function tokenize(input: string, budget = braceBudget()): Script {
  if (input.length > MAX_LENGTH) return { commands: [], opaque: "too-long" }
  return new Parser(input, 0, 0, budget).parse()
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

/**
 * Bash brace expansion of one word. `marks` holds the ascending offsets in `raw` of unquoted `{`, `,` and `}`.
 * Returns the raw text of every resulting word, or undefined when the word has no valid brace expansion.
 * Exceeding `budget` aborts with `too-long`, nesting deeper than MAX_DEPTH with `too-deep`.
 */
function expandBraces(raw: string, marks: number[], budget: BraceBudget): string[] | undefined {
  // A `{` pairs with the first `}` that balances it, and its commas are the ones seen while it is innermost.
  const closes = new Map<number, number>()
  const commas = new Map<number, number[]>()
  const open: number[] = []
  for (const mark of marks) {
    if (raw[mark] === "{") open.push(mark)
    else if (!open.length) continue
    else if (raw[mark] === "}") closes.set(open.pop()!, mark)
    else if (commas.has(open.at(-1)!)) commas.get(open.at(-1)!)!.push(mark)
    else commas.set(open.at(-1)!, [mark])
  }
  const length = (words: string[]) => words.reduce((sum, word) => sum + word.length, 0)
  const check = (words: number, chars: number) => {
    if (words > budget.words || chars > budget.chars) throw new Abort("too-long")
  }
  let changed = false
  const expand = (start: number, end: number, depth: number): string[] => {
    if (depth > MAX_DEPTH) throw new Abort("too-deep")
    let words = [""]
    let chars = 0
    let from = start
    for (let brace = start; brace < end; brace++) {
      const close = closes.get(brace)
      if (close === undefined) continue
      let alternatives: string[] | undefined
      let size = 0
      const separators = commas.get(brace)
      if (separators) {
        alternatives = []
        let piece = brace + 1
        for (const to of [...separators, close]) {
          const branch = expand(piece, to, depth + 1)
          alternatives.push(...branch)
          size += length(branch)
          check(alternatives.length, size)
          piece = to + 1
        }
      } else {
        alternatives = sequence(raw.slice(brace + 1, close), budget.words)
        size = length(alternatives ?? [])
      }
      if (!alternatives) continue
      changed = true
      const preamble = brace - from
      const count = words.length * alternatives.length
      chars = chars * alternatives.length + count * preamble + words.length * size
      check(count, chars)
      const text = raw.slice(from, brace)
      words = words.flatMap((word) => alternatives.map((alternative) => word + text + alternative))
      from = close + 1
      brace = close
    }
    chars += words.length * (end - from)
    check(words.length, chars)
    const tail = raw.slice(from, end)
    return words.map((word) => word + tail)
  }
  const pieces = expand(0, raw.length, 0)
  return changed ? pieces : undefined
}

/** Expands the body of `{x..y[..step]}` into raw words, or returns undefined when it is not a sequence. */
function sequence(body: string, limit: number): string[] | undefined {
  const match = SEQUENCE.exec(body)
  if (!match) return undefined
  const [, from, to, fromChar, toChar, step] = match
  const numeric = from !== undefined && to !== undefined
  const first = numeric ? Number(from) : fromChar!.charCodeAt(0)
  const last = numeric ? Number(to) : toChar!.charCodeAt(0)
  const increment = Math.abs(Number(step ?? 1)) || 1
  if (![first, last, increment].every(Number.isSafeInteger)) throw new Abort("too-long")
  if (Math.floor(Math.abs(last - first) / increment) + 1 > limit) throw new Abort("too-long")
  const width = numeric && (/^-?0\d/.test(from) || /^-?0\d/.test(to)) ? Math.max(from.length, to.length) : 0
  const direction = last < first ? -1 : 1
  const words: string[] = []
  for (let value = first; direction * (last - value) >= 0; value += direction * increment) {
    if (!numeric) words.push(String.fromCharCode(value).replace(/[^A-Za-z0-9]/, "\\$&"))
    else if (value < 0) words.push("-" + String(-value).padStart(width - 1, "0"))
    else words.push(String(value).padStart(width, "0"))
  }
  return words
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
  private groups: Group[] = []
  /** The compound command that closed right before the current command. */
  private closed?: Group
  /** For each command, the depth of the group whose pipe it reads, or the number of its groups for its own pipe. */
  private sources: (number | undefined)[] = []
  /** Redirects of compound commands copied to their inner commands, bounded like the input. */
  private copies = 0
  /** The current command while it is only the reserved word `time` and its options. */
  private timed?: Command
  /** The current command when it starts with the reserved word `coproc`. */
  private coproc?: Command
  /** The simple command before a pending `|`. */
  private upstream?: Command

  constructor(
    private readonly src: string,
    start: number,
    private readonly depth: number,
    /** Brace expansion budget shared by every parser of one `tokenize` call. */
    private readonly budget: BraceBudget,
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
          this.close(")")
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
    const last = this.current
    const compound = this.closed !== undefined
    this.finish()
    this.connector = connector
    this.upstream = connector === "|" && !compound && this.commands.at(-1) === last ? last : undefined
  }

  private finish() {
    const closed = this.closed
    this.closed = undefined
    const command = this.current
    if (isEmpty(command) && !command.substitutions.length) return
    const top = this.groups.at(-1)
    // The first command of a group opened at a pipe reads it through the group.
    const own = this.connector === "|" && top?.start !== this.commands.length
    let source = own || command.piped ? this.groups.length : top?.source
    if (closed && !command.argv.length && !command.assignments.length) {
      // Redirects after `}`, `)`, `fi` or `done` apply to every command of the compound command, before the
      // pipes inside it.
      const added = command.redirects.length
      for (let i = closed.start; i < this.commands.length; i++) this.copies += added + this.commands[i]!.redirects.length
      if (this.copies > MAX_LENGTH) throw new Abort("too-long")
      for (let i = closed.start; i < this.commands.length; i++) {
        const inner = this.commands[i]!
        inner.redirects = [...command.redirects, ...inner.redirects]
        inner.outerRedirects = (inner.outerRedirects ?? 0) + added
        if (closed.depth < (this.sources[i] ?? -1)) inner.pipeAt = (inner.pipeAt ?? 0) + added
      }
      // They are expanded and applied with the stdin of the compound command.
      source = closed.source
    }
    if (source !== undefined && !own) command.piped = true
    this.sources.push(source)
    command.name = normalizeName(command.argv[0] ?? "")
    if (this.commands.length) command.connector = this.connector ?? ";"
    if (command.connector === "|" && this.upstream) command.upstream = this.upstream
    this.connector = undefined
    this.upstream = undefined
    this.commands.push(command)
    this.current = newCommand()
  }

  private addWord(word: Word) {
    const command = this.current
    if ((!command.argv.length || command === this.timed) && ASSIGNMENT.test(word.raw)) {
      command.assignments.push(word.text)
      return
    }
    if (!word.quoted && (word.text === "coproc" || word.text === "function") && command === this.timed && this.opens(command)) {
      // `time` may precede them like a compound command.
      command.argv = []
      command.expanded = []
      this.timed = undefined
    }
    const close = word.quoted ? undefined : OPENERS.get(word.text)
    const group = this.groups.at(-1)
    if (close && this.opens(command)) {
      if (word.text === "{" && group?.loop) {
        group.loop = false
        group.close = "}"
        return
      }
      const loop = LOOP_HEADS.has(word.text)
      this.open(close, loop)
      // A loop header stays a command so that its substitutions are kept.
      if (!loop) return
    } else if (!word.quoted && word.text === "do" && command.argv.length === 2 && LOOP_HEADS.has(command.argv[0]!)) {
      // `for NAME do ...` has no word list.
      this.link(";")
      this.addWord(word)
      return
    } else if (!word.quoted && word.text === "!" && command === this.timed && this.opens(command)) {
      return
    } else if (isEmpty(command) && !word.quoted) {
      if (CLOSERS.has(word.text)) this.close(word.text)
      if (word.text === "do" && group?.loop) group.loop = false
      if (KEYWORDS.has(word.text)) return
      if (word.text === "coproc") {
        // A coprocess reads its own pipe, not the pipeline.
        this.coproc = command
        command.piped = true
        this.upstream = undefined
        return
      }
      if (word.text === "time") this.timed = command
      if (word.text === "case") throw new Abort("unsupported-syntax")
      if (word.text === "function") {
        this.flag("function-definition")
        this.skipBlanks()
        this.readWord([])
        this.skipFunctionParens()
        return
      }
    }
    if (command === this.timed && !TIME_PREFIX.has(word.text)) this.timed = undefined
    if (!word.braces.length || LOOP_HEADS.has(command.argv[0] ?? "")) {
      command.argv.push(word.text)
      command.expanded.push(word.expanded)
      return
    }
    const pieces = expandBraces(word.raw, word.braces, this.budget)
    if (!command.argv.length || !pieces) {
      // A brace expansion in the command word makes the command name unknowable.
      command.argv.push(word.text)
      command.expanded.push(word.expanded || !!pieces)
      return
    }
    this.budget.words -= pieces.length
    this.budget.chars -= pieces.reduce((sum, piece) => sum + piece.length, 0)
    for (const piece of pieces) {
      const part = new Parser(piece, 0, this.depth, this.budget).readWord([])
      if (!part.text && !part.quoted) continue
      command.argv.push(part.text)
      command.expanded.push(part.expanded)
    }
  }

  /** Whether a compound command may start at the current word: `time [-p] [--]` or `coproc [NAME]` may precede it. */
  private opens(command: Command): boolean {
    if (isEmpty(command)) return true
    if (command.assignments.length || command.redirects.length) return false
    return (command === this.coproc && command.argv.length === 1) || command === this.timed
  }

  /** Opens a compound command in place of the current command's `time` or `coproc NAME` prefix. */
  private open(close: string, loop = false) {
    const command = this.current
    const top = this.groups.at(-1)
    const depth = this.groups.length
    // Groups nested at the start of a piped group read the pipe through it.
    const own = command === this.coproc || (this.connector === "|" && top?.start !== this.commands.length)
    command.argv = []
    command.expanded = []
    this.timed = this.coproc = undefined
    this.groups.push({ start: this.commands.length, close, depth, source: own ? depth : top?.source, loop })
  }

  /** Closes the innermost group if `close` ends it. Bash rejects any other closer. */
  private close(close: string) {
    const group = this.groups.at(-1)
    if (group?.close !== close) return
    this.groups.pop()
    this.closed = group
  }

  private skipFunctionParens() {
    FUNCTION_PARENS.lastIndex = this.pos
    if (FUNCTION_PARENS.test(this.src)) this.pos = FUNCTION_PARENS.lastIndex
  }

  private openParen() {
    const command = this.current
    if (this.opens(command)) {
      if (this.src[this.pos + 1] === "(") {
        command.argv = []
        command.expanded = []
        this.skipArithmetic(this.pos + 2)
        return
      }
      this.pos++
      this.parens++
      this.open(")")
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
    if (op === "<<<") redirect.body = `${word.text}\n`
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
        const parser = new Parser(body, 0, this.depth, this.budget)
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
    // Unquoted `[...]` globs.
    let bracket = false
    const braces: number[] = []
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
      else if (c === "{" || c === "," || c === "}") braces.push(this.pos - start)
      text += c
      this.pos++
    }
    return { text, raw: src.slice(start, this.pos), quoted, expanded, braces }
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
    const inner = new Parser(this.src, this.pos, this.depth + 1, this.budget, ")")
    subs.push(inner.parse())
    this.pos = inner.pos
  }

  private processSubstitution(): Word {
    const start = this.pos
    const output = this.src[start] === ">"
    this.pos += 2
    this.substitution(this.current.substitutions)
    if (output) this.current.substitutions.at(-1)!.piped = true
    const raw = this.src.slice(start, this.pos)
    return { text: raw, raw, quoted: true, expanded: true, braces: [] }
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
    subs.push(new Parser(content, 0, this.depth + 1, this.budget).parse())
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
