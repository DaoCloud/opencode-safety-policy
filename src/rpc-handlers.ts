/** Server handlers for the RPC contract in `rpc.ts` (design 5.3). The server validates input against the schemas. */

import type { Rpc } from "@opencode/plugin"
import type definition from "../rpc"
import type { Locked, SetModeInput, Status } from "../rpc"
import { LOCK_ENV, type ModeState, type ResolvedMode } from "./state"

type Methods = (typeof definition)["methods"]

export function createRpcHandlers(state: ModeState) {
  return {
    async status(): Promise<Status> {
      return toStatus(await state.resolve())
    },

    async setMode(input: unknown, context: { error: Rpc.ErrorFactory<Methods["setMode"]> }) {
      const { mode, ttlMs } = input as SetModeInput
      const current = await state.resolve()
      if (current.locked) {
        const data: Locked = { mode: current.mode }
        return context.error("locked", `安全模式已被 ${LOCK_ENV} 锁定为 ${current.mode}，不能切换`, data)
      }
      await state.setMode(mode, { ttlMs })
      return toStatus(await state.resolve())
    },
  }
}

function toStatus({ mode, source, locked, expiresAt }: ResolvedMode): Status {
  return expiresAt === undefined ? { mode, source, locked } : { mode, source, locked, expiresAt }
}
