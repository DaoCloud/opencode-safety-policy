/**
 * TUI entry: the user-only `/safety` command (design 5.3). It calls the Server RPC and reports through toasts, and
 * shows `/safety test` in a dialog, so it never writes to `session_inbox` and is not a tool the Agent can call. It also
 * toasts the reason of prompts forced by this plugin, because the TUI approval dialog does not render `message`.
 *
 * Imports are type-only except the RPC contract and the report text: `@opencode/plugin/tui` pulls in Solid, and
 * `src/state` pulls in the rule loaders.
 */

import type { Plugin } from "@opencode/plugin/tui"
import definition, { type Status, type TestResult } from "./rpc"
import { formatStatus, formatTest, parseCommand, USAGE } from "./src/report"

const TITLE = "安全策略"

// RPC errors reject with a plain `{ type, message, data }` object, other failures with an Error.
function reason(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message)
  return String(error)
}

const plugin: Plugin.Definition = {
  id: "opencode-safety-policy",
  setup(ctx) {
    const rpc = ctx.client.rpc(definition)
    const toast = (message: string, variant: "info" | "success" | "warning" | "error", sessionID?: string) =>
      ctx.ui.toast.show({ title: TITLE, message, variant, ...(sessionID === undefined ? {} : { sessionID }) })

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-safety-policy.safety",
          title: "Safety policy",
          description: "查看或切换安全策略模式",
          palette: true,
          slash: { name: "safety", arguments: true },
          run: async (input?: string) => {
            const request = parseCommand(input)
            if (!request) return toast(USAGE, "warning")
            try {
              if (request.method === "status") toast(formatStatus((await rpc.status({})) as Status), "info")
              else if (request.method === "setMode")
                toast(formatStatus((await rpc.setMode(request.input)) as Status), "success")
              else {
                const result = (await rpc.test(request.input)) as TestResult
                await ctx.ui.dialog.alert({ title: TITLE, message: formatTest(request.input.command, result) })
              }
            } catch (error) {
              toast(reason(error), "error")
            }
          },
        },
      ],
    }))

    const off = ctx.data.on("permission.asked", (event) => {
      const { message, sessionID } = event.data
      if (message?.startsWith("[safety-policy:")) toast(message, "warning", sessionID)
    })
    return () => off()
  },
}

export default plugin
