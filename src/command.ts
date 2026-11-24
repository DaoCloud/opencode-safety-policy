/**
 * Optional server-side `/safety` for clients without the TUI (design 5.3 point 2). It runs the RPC handlers and posts
 * the result as a synthetic message that does not wake the Session, and `hooks/session-filter.ts` hides it from the
 * model. A running Session would take one more model step for it, so there the result is returned as the error.
 */

import type { Plugin } from "@opencode/plugin"
import type { Status } from "../rpc"
import { formatStatus, formatTest, parseCommand, USAGE } from "./report"
import type { createRpcHandlers } from "./rpc-handlers"

/** `metadata.source` of the results. */
export const SOURCE = "safety-policy"

type Handlers = ReturnType<typeof createRpcHandlers>

export async function registerCommand(ctx: Plugin.Context, handlers: Handlers) {
  await ctx.command.transform((editor) =>
    editor.add({
      name: "safety",
      description: "查看或切换安全策略模式",
      async execute({ sessionID, prompt }) {
        const text = await run(handlers, prompt.text)
        const { time } = await ctx.session.get({ sessionID })
        if (time.busy !== undefined && (time.idle === undefined || time.busy > time.idle)) throw new Error(text)
        const metadata = { source: SOURCE }
        await ctx.session.synthetic({ sessionID, text, description: text, metadata, delivery: "steer", resume: false })
      },
    }),
  )
}

async function run(handlers: Handlers, input: string): Promise<string> {
  const request = parseCommand(input)
  if (!request) throw new Error(USAGE)
  if (request.method === "status") return formatStatus(await handlers.status())
  if (request.method === "test") return formatTest(request.input.command, await handlers.test(request.input))
  const status = await handlers.setMode(request.input, {
    error: (_type: string, message: string, ..._data: unknown[]) => {
      throw new Error(message)
    },
  })
  return formatStatus(status as Status)
}
