/** Keeps the results of the server-side `/safety` (design 5.3 point 2) out of every model request. */

import type { Plugin } from "@opencode/plugin"
import { SOURCE } from "../command"

export async function registerSessionFilter(ctx: Plugin.Context) {
  for (const name of ["context", "compaction", "generate", "title"] as const)
    await ctx.session.hook(name, (event) => {
      const kept = event.messages.filter((message) => message.metadata?.source !== SOURCE)
      event.messages.splice(0, event.messages.length, ...kept)
    })
}
