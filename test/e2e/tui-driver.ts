/** Drives a real `opencode` TUI in a headless terminal and reads the screen a user would see. */

import { Terminal } from "@xterm/headless"
import type { Harness } from "./harness"

const COLS = 160
const ROWS = 50
export const ENTER = "\r"
export const ESC = "\x1b"
export const BACKSPACE = "\x7f"
export const CTRL_P = "\x10"
export const DESCRIPTION = "查看或切换安全策略模式"

/** One `opencode --standalone` TUI on a pseudo terminal, rendered by xterm so the test reads what a user would see. */
export class Tui {
  private readonly term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  private readonly proc

  /** `server` selects the server: a private one by default. */
  constructor(h: Harness, env: Record<string, string> = {}, server = ["--standalone"]) {
    this.proc = Bun.spawn(["opencode", ...server, h.project], {
      cwd: h.project,
      // A TUI started after another one has saved prompts would open "What's new" over the home screen.
      env: h.env({ TERM: "xterm-256color", OPENCODE_CLI_CONFIG_CONTENT: '{"highlights":false}', ...env }),
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
    const failure = present ? "never showed" : "still shows"
    await this.until(() => this.screen().includes(needle) === present, failure, needle, timeoutMs)
  }

  /** Toasts wrap at any cell, even inside a word, so match the joined toast lines without whitespace. */
  async waitForToast(needle: string) {
    const squeezed = needle.replace(/\s/g, "")
    await this.until(() => this.toast().includes(squeezed), "never toasted", needle)
  }

  /** The text of the boxes at the right edge, where toasts are drawn. */
  private toast() {
    const lines = this.screen().split("\n")
    return lines.map((line) => /┃ {2}([^┃]*)┃ *$/.exec(line)?.[1] ?? "").join("").replace(/\s/g, "")
  }

  private async until(check: () => boolean, failure: string, needle: string, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (check()) return
      await Bun.sleep(100)
    }
    const dump = this.screen().split("\n").filter((line) => line.trim()).join("\n")
    throw new Error(`screen ${failure} ${JSON.stringify(needle)}:\n${dump}`)
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
