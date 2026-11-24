/** The `/safety` TUI entry and the approval toast, driven through a real `opencode` TUI in a headless terminal. */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Terminal } from "@xterm/headless"
import { directive, E2E_ENABLED, Harness, STUB_MARK } from "./harness"

setDefaultTimeout(180_000)

const COLS = 160
const ROWS = 50
const ENTER = "\r"
const ESC = "\x1b"
const BACKSPACE = "\x7f"
const CTRL_P = "\x10"
const DESCRIPTION = "查看或切换安全策略模式"

/** One `opencode --standalone` TUI on a pseudo terminal, rendered by xterm so the test reads what a user would see. */
class Tui {
  private readonly term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  private readonly proc

  constructor(h: Harness, env: Record<string, string> = {}) {
    this.proc = Bun.spawn(["opencode", "--standalone", h.project], {
      cwd: h.project,
      env: h.env({ TERM: "xterm-256color", ...env }),
      terminal: { cols: COLS, rows: ROWS, data: (_terminal, data) => this.term.write(data) },
    })
    // Answer terminal queries the way a real terminal would.
    this.term.onData((data) => this.proc.terminal?.write(data))
  }

  screen() {
    const buffer = this.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < ROWS; i++) lines.push(buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? "")
    return lines.join("\n")
  }

  async waitFor(needle: string, present = true, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.screen().includes(needle) === present) return
      await Bun.sleep(100)
    }
    const dump = this.screen().split("\n").filter((line) => line.trim()).join("\n")
    throw new Error(`screen ${present ? "never showed" : "still shows"} ${JSON.stringify(needle)}:\n${dump}`)
  }

  /** The TUI is up and the plugin has registered `/safety`, which happens after the first frame. */
  async ready() {
    await this.waitFor("ctrl+p commands")
    await this.type("/saf")
    await this.waitFor(DESCRIPTION)
    this.press(BACKSPACE.repeat(4))
    await this.waitFor(DESCRIPTION, false)
  }

  press(keys: string) {
    this.proc.terminal?.write(keys)
  }

  /** One key at a time, like a user typing. */
  async type(text: string) {
    for (const char of text) {
      this.press(char)
      await Bun.sleep(10)
    }
  }

  async close() {
    this.proc.kill()
    const exited = await Promise.race([this.proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)])
    if (!exited) this.proc.kill("SIGKILL")
    this.proc.terminal?.close()
    this.term.dispose()
  }
}

let h: Harness

beforeAll(() => {
  if (E2E_ENABLED) h = new Harness()
})

afterAll(async () => {
  await h?.dispose()
})

describe.skipIf(!E2E_ENABLED)("tui", () => {
  let tui: Tui

  beforeAll(async () => {
    tui = new Tui(h)
    await tui.ready()
  })

  afterAll(async () => {
    await tui?.close()
  })

  test("autocompletes /safety", async () => {
    await tui.type("/saf")
    await tui.waitFor(DESCRIPTION)
    expect(tui.screen()).toMatch(new RegExp(`/safety +${DESCRIPTION}`))
    tui.press(BACKSPACE.repeat(4))
    await tui.waitFor(DESCRIPTION, false)
  })

  test("lists Safety policy in the command palette", async () => {
    tui.press(CTRL_P)
    await tui.type("safety")
    await tui.waitFor("Safety policy")
    tui.press(ESC)
    await tui.waitFor("Safety policy", false)
  })

  test("reports and switches the mode through toasts", async () => {
    await tui.type("/safety status")
    tui.press(ENTER)
    await tui.waitFor("当前模式：strict（source: default）")
    await tui.type("/safety relaxed --ttl 1m")
    tui.press(ENTER)
    await tui.waitFor("当前模式：relaxed（source: runtime，1 分钟后回落）")
    await tui.type("/safety strict")
    tui.press(ENTER)
    await tui.waitFor("当前模式：strict（source: runtime）")
  })

  test("shows the reason of a forced approval and runs the command once allowed", async () => {
    const file = h.write("tmp/tui.txt", "x")
    await tui.type(directive("shell", { command: `rm ${file}` }))
    tui.press(ENTER)
    await tui.waitFor("Permission required")
    await tui.waitFor("[safety-policy:rm-local] 删除本机文件需要确认")
    tui.press(ENTER)
    const ran = `${STUB_MARK} rm ${file}`
    const deadline = Date.now() + 30_000
    while (!h.requests.some((r) => r.results.some((result) => result.includes(ran))) && Date.now() < deadline)
      await Bun.sleep(100)
    expect(h.requests.some((r) => r.results.some((result) => result.includes(ran)))).toBe(true)
  })
})

describe.skipIf(!E2E_ENABLED)("tui with a locked mode", () => {
  let tui: Tui

  beforeAll(async () => {
    tui = new Tui(h, { OPENCODE_SAFETY_LOCK_MODE: "strict" })
    await tui.ready()
  })

  afterAll(async () => {
    await tui?.close()
  })

  test("refuses /safety off", async () => {
    await tui.type("/safety off")
    tui.press(ENTER)
    await tui.waitFor("锁定为 strict")
  })
})
