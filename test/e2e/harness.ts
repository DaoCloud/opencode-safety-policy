/**
 * End-to-end harness: a real `opencode serve` or TUI with this plugin loaded, driven by a scripted mock LLM.
 *
 * Each harness owns a temp root with its own HOME, XDG dirs and projects, so nothing touches the user's OpenCode
 * config or data. Destructive commands are shadowed on PATH by stubs that only print `STUB-EXECUTED <argv>`, so a
 * command that slips past the plugin does no harm. The suites run only with `OCSP_E2E=1` (`bun run test:e2e`).
 */

import { expect } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Subprocess } from "bun"

export const E2E_ENABLED = process.env.OCSP_E2E === "1"
export const STUB_MARK = "STUB-EXECUTED"
export const REPO = path.resolve(import.meta.dir, "../..")

const STUBS = [
  "ansible",
  "busybox",
  "chroot",
  "clush",
  "crictl",
  "docker",
  "doas",
  "find",
  "flock",
  "kubectl",
  "mv",
  "nerdctl",
  "nv",
  "parallel",
  "pdsh",
  "podman",
  "pssh",
  "rm",
  "rmdir",
  "runuser",
  "ssh",
  "su",
  "sudo",
  "watch",
]

/** The mock LLM turns each `@@CALL <tool> <json>` line of the last user message into one tool call per turn. */
export function directive(tool: string, input: unknown) {
  return `@@CALL ${tool} ${JSON.stringify(input)}`
}

function directives(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("@@CALL "))
    .map((line) => {
      const rest = line.slice(7)
      const space = rest.indexOf(" ")
      return { name: rest.slice(0, space), args: rest.slice(space + 1) }
    })
}

export interface LlmRequest {
  tools: string[]
  user: string
  results: string[]
}

type Message = { role: string; content?: unknown; tool_calls?: unknown[] }

function text(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("\n")
  return ""
}

function respond(stream: boolean, reply: { text?: string; call?: { name: string; args: string } }) {
  const id = `call_${crypto.randomUUID().slice(0, 8)}`
  const created = Math.floor(Date.now() / 1000)
  const base = { id: "mock", created, model: "m1" }
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  const calls = reply.call && [{ id, type: "function", function: { name: reply.call.name, arguments: reply.call.args } }]
  const finish = calls ? "tool_calls" : "stop"
  if (!stream) {
    const message = calls
      ? { role: "assistant", content: null, tool_calls: calls }
      : { role: "assistant", content: reply.text }
    const choices = [{ index: 0, message, finish_reason: finish }]
    return Response.json({ ...base, object: "chat.completion", choices, usage })
  }
  const chunk = (delta: unknown, finish: string | null, extra = {}) => {
    const choices = [{ index: 0, delta, finish_reason: finish }]
    return `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices, ...extra })}\n\n`
  }
  const delta = calls
    ? { role: "assistant", tool_calls: calls.map((call, index) => ({ index, ...call })) }
    : { role: "assistant", content: reply.text }
  const body = chunk(delta, null) + chunk({}, finish, { usage }) + "data: [DONE]\n\n"
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

function startMock() {
  const requests: LlmRequest[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith("/models"))
        return Response.json({ object: "list", data: [{ id: "m1", object: "model" }] })
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await req.json()) as { messages?: Message[]; tools?: any[]; stream?: boolean }
      const messages = body.messages ?? []
      const last = messages.findLastIndex((m) => m.role === "user")
      const user = last >= 0 ? text(messages[last]!.content) : ""
      const after = messages.slice(last + 1)
      const done = after.filter((m) => m.role === "assistant" && m.tool_calls?.length).length
      const results = after.filter((m) => m.role === "tool").map((m) => text(m.content))
      const tools = (body.tools ?? []).map((t) => t.function?.name)
      requests.push({ tools, user, results })
      const stream = body.stream !== false
      if (!tools.length) return respond(stream, { text: "title" })
      const calls = directives(user)
      if (done < calls.length) return respond(stream, { call: calls[done] })
      return respond(stream, { text: "DONE" })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) }
}

export interface Permission {
  id: string
  action: string
  resources: string[]
  message?: string
}

export interface PromptResult {
  sessionID: string
  permissions: Permission[]
  results: string[]
}

export interface RpcResult {
  status: number
  body: any
}

export interface PromptOptions {
  reply?: "once" | "always"
  directory?: string
  sessionID?: string
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop()!
    lines.forEach(onLine)
  }
}

export class Harness {
  readonly root = mkdtempSync(path.join(os.tmpdir(), "ocsp-e2e-"))
  readonly project = path.join(this.root, "project")
  readonly project2 = path.join(this.root, "project2")
  private readonly mock = startMock()
  readonly requests = this.mock.requests
  /** Sessions used by `prompt` with their directory, and the model turns they should take: one per call plus a reply. */
  readonly sessions = new Map<string, string>()
  expectedTurns = 0
  private server?: { proc: Subprocess; url: string; auth: string; log: string[] }
  private seq = 0

  constructor() {
    for (const dir of ["home", "stubbin", "xdg/config", "xdg/data", "xdg/state", "xdg/cache"])
      mkdirSync(path.join(this.root, dir), { recursive: true })
    for (const name of STUBS) {
      const file = path.join(this.root, "stubbin", name)
      writeFileSync(file, `#!/bin/sh\necho "${STUB_MARK} ${name} $*"\n`)
      chmodSync(file, 0o755)
    }
    for (const dir of [this.project, this.project2]) {
      mkdirSync(dir)
      Bun.spawnSync(["git", "init", "-q"], { cwd: dir })
      writeFileSync(path.join(dir, "opencode.json"), JSON.stringify(this.config(), null, 2))
    }
  }

  private config() {
    const model = {
      name: "m1",
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: 100000, output: 4096 },
    }
    const settings = { baseURL: this.mock.url, apiKey: "x" }
    return {
      model: "mock/m1",
      providers: {
        mock: { name: "Mock", package: "@opencode/ai/providers/openai-compatible", settings, models: { m1: model } },
      },
      plugins: [{ package: REPO }],
    }
  }

  /** The inherited environment minus any OpenCode settings, pointed at the temp root, plus `extra`. */
  env(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined && !key.startsWith("OPENCODE_")) env[key] = value
    const xdg = path.join(this.root, "xdg")
    return {
      ...env,
      HOME: path.join(this.root, "home"),
      XDG_CONFIG_HOME: path.join(xdg, "config"),
      XDG_DATA_HOME: path.join(xdg, "data"),
      XDG_STATE_HOME: path.join(xdg, "state"),
      XDG_CACHE_HOME: path.join(xdg, "cache"),
      PATH: `${path.join(this.root, "stubbin")}:${process.env.PATH}`,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      ...extra,
    }
  }

  /** Writes a file under the project and returns its absolute path. */
  write(relative: string, content: string) {
    const file = path.join(this.project, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
    return file
  }

  /** Starts (or restarts) `opencode serve` on a free port with `extra` env. */
  async start(extra: Record<string, string> = {}) {
    await this.stop()
    const proc = Bun.spawn(["opencode", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: this.project,
      env: this.env(extra),
      stdout: "pipe",
      stderr: "pipe",
    })
    const log: string[] = []
    const ready = new Promise<{ url: string; password: string }>((resolve, reject) => {
      let url: string | undefined
      let password: string | undefined
      const onLine = (line: string) => {
        log.push(line)
        url ??= /listening on (http:\/\/\S+)/.exec(line)?.[1]
        password ??= /server password (\S+)/.exec(line)?.[1]
        if (url && password) resolve({ url, password })
      }
      void readLines(proc.stdout, onLine)
      void readLines(proc.stderr, onLine)
      void proc.exited.then((code) => reject(new Error(`opencode serve exited with ${code}:\n${log.join("\n")}`)))
      setTimeout(() => reject(new Error(`opencode serve did not start:\n${log.join("\n")}`)), 30_000)
    })
    try {
      const { url, password } = await ready
      const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
      this.server = { proc, url, auth, log }
    } catch (error) {
      proc.kill("SIGKILL")
      throw error
    }
  }

  async stop() {
    const server = this.server
    if (!server) return
    this.server = undefined
    server.proc.kill()
    const timer = setTimeout(() => server.proc.kill("SIGKILL"), 5_000)
    await server.proc.exited
    clearTimeout(timer)
  }

  async dispose() {
    await this.stop()
    this.mock.stop()
    rmSync(this.root, { recursive: true, force: true })
  }

  private async fetch(method: string, route: string, body: unknown, directory: string) {
    const server = this.server
    if (!server) throw new Error("opencode serve is not running")
    const query = `location[directory]=${encodeURIComponent(directory)}`
    return fetch(`${server.url}${route}${route.includes("?") ? "&" : "?"}${query}`, {
      method,
      headers: { authorization: server.auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  async api(method: string, route: string, body?: unknown, directory = this.project): Promise<any> {
    const res = await this.fetch(method, route, body, directory)
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${route} ${res.status} ${text}`)
    return text ? JSON.parse(text) : undefined
  }

  /** Calls a plugin RPC method. Retries while the plugin is still loading for a new location. */
  async rpc(method: string, input: unknown = {}, directory = this.project): Promise<RpcResult> {
    const deadline = Date.now() + 30_000
    while (true) {
      const res = await this.fetch("POST", `/api/rpc/opencode-safety-policy/${method}`, { input }, directory)
      const text = await res.text()
      const body = text ? JSON.parse(text) : undefined
      if (!text.includes("rpc.unavailable") || Date.now() > deadline) return { status: res.status, body }
      await Bun.sleep(200)
    }
  }

  async session(directory = this.project): Promise<string> {
    return (await this.api("POST", "/api/session", {}, directory)).data.id
  }

  /**
   * Sends a prompt and answers every permission request with `reply` until the mock LLM has received the result of
   * every `@@CALL` in it, then waits for the session to go idle. A sequence number keeps prompt texts unique.
   */
  async prompt(body: string, options: PromptOptions = {}): Promise<PromptResult> {
    const directory = options.directory ?? this.project
    const sessionID = options.sessionID ?? (await this.session(directory))
    const text = `#${++this.seq}\n${body}`
    const calls = directives(text).length
    const before = this.requests.length
    this.sessions.set(sessionID, directory)
    this.expectedTurns += calls + 1
    await this.api("POST", `/api/session/${sessionID}/prompt`, { text }, directory)
    const permissions: Permission[] = []
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const route = `/api/session/${sessionID}/permission`
      for (const p of (await this.api("GET", route, undefined, directory)).data as any[]) {
        if (permissions.some((seen) => seen.id === p.id)) continue
        permissions.push({ id: p.id, action: p.action, resources: p.resources, message: p.message })
        await this.api("POST", `${route}/${p.id}/reply`, { decision: options.reply ?? "once" }, directory)
      }
      const done = this.requests.slice(before).find((r) => r.user === text && r.tools.length && r.results.length >= calls)
      if (done) {
        await this.idle(sessionID, directory)
        return { sessionID, permissions, results: done.results }
      }
      await Bun.sleep(100)
    }
    throw new Error(`prompt timed out: ${text}\n${this.server?.log.slice(-20).join("\n")}`)
  }

  async idle(sessionID: string, directory = this.project) {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const active = (await this.api("GET", "/api/session/active", undefined, directory)).data
      if (!active?.[sessionID]) return
      await Bun.sleep(100)
    }
    throw new Error(`session ${sessionID} did not go idle`)
  }

  /** One tool call; `result` is the tool output the model received. */
  async call(tool: string, input: unknown, options: PromptOptions = {}) {
    const { results, ...rest } = await this.prompt(directive(tool, input), options)
    return { ...rest, result: results[0] ?? "" }
  }

  shell(command: string, options: PromptOptions & { workdir?: string } = {}) {
    const { workdir, ...rest } = options
    return this.call("shell", workdir === undefined ? { command } : { command, workdir }, rest)
  }
}

type CallResult = { permissions: Permission[]; result: string }

/** Plugin-forced approvals carry this prefix (design 5.3). */
export function safetyPermissions(permissions: Permission[]) {
  return permissions.filter((p) => p.message?.startsWith("[safety-policy:"))
}

/** The plugin rejected the call before it ran and asked nothing. */
export function expectDenied(call: CallResult, ruleId: string) {
  expect(call.result).toContain(`[safety-policy:${ruleId}]`)
  expect(call.result).not.toContain(STUB_MARK)
  expect(safetyPermissions(call.permissions)).toEqual([])
}

/** Exactly one approval was requested, and it carries the plugin's reason. */
export function expectAsked(call: CallResult, ruleId: string) {
  expect(call.permissions).toHaveLength(1)
  expect(call.permissions[0]!.message ?? "").toStartWith(`[safety-policy:${ruleId}]`)
}

/** The call ran without any approval or plugin message. */
export function expectAllowed(call: CallResult) {
  expect(call.permissions).toEqual([])
  expect(call.result).not.toContain("[safety-policy:")
}
