/**
 * Server entry (design 2, 5.3). Every registration is bound to the plugin scope, so OpenCode disposes them when the
 * plugin is unloaded or reloaded, and no `Cleanup` is returned.
 */

import { Plugin } from "@opencode/plugin"
import definition from "./rpc"
import { createAudit } from "./src/audit"
import { registerCommand } from "./src/command"
import { registerPermissionHook } from "./src/hooks/permission"
import { registerSessionFilter } from "./src/hooks/session-filter"
import { createMarkers, registerToolHooks } from "./src/hooks/tool"
import { createPolicy } from "./src/policy"
import { createRpcHandlers } from "./src/rpc-handlers"
import { createStats } from "./src/stats"

export default Plugin.define({
  id: "opencode-safety-policy",
  async setup(ctx) {
    const policy = createPolicy({ options: ctx.options, storage: ctx.storage })
    const markers = createMarkers()
    const stats = createStats(ctx.storage)
    const audit = createAudit(policy.auditLogPath, ctx.location.directory)
    await registerToolHooks(ctx, { policy, markers, stats, audit })
    await registerPermissionHook(ctx, { policy, markers, stats, audit })
    const handlers = createRpcHandlers({ policy, stats, audit, directory: ctx.location.directory })
    await ctx.rpc.register(definition, handlers)
    if (!policy.serverCommand) return
    await registerSessionFilter(ctx)
    await registerCommand(ctx, handlers)
  },
})
