/**
 * Server entry (design 2, 5.3). Every registration is bound to the plugin scope, so OpenCode disposes them when the
 * plugin is unloaded or reloaded, and no `Cleanup` is returned.
 */

import { Plugin } from "@opencode/plugin"
import definition from "./rpc"
import { registerPermissionHook } from "./src/hooks/permission"
import { createMarkers, registerToolHooks } from "./src/hooks/tool"
import { createPolicy } from "./src/policy"
import { createRpcHandlers } from "./src/rpc-handlers"

export default Plugin.define({
  id: "opencode-safety-policy",
  async setup(ctx) {
    const policy = createPolicy({ options: ctx.options, storage: ctx.storage })
    const markers = createMarkers()
    await registerToolHooks(ctx, { policy, markers })
    await registerPermissionHook(ctx, { policy, markers })
    await ctx.rpc.register(definition, createRpcHandlers(policy.mode))
  },
})
