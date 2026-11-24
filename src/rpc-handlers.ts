/** Server handlers for the RPC contract in `rpc.ts` (design 5.3). The server validates input against the schemas. */

import type { Rpc } from "@opencode/plugin"
import type definition from "../rpc"
import type { Locked, SetModeInput, Status, TestInput, TestResult } from "../rpc"
import type { Analysis } from "./analyzer"
import { analyzeShell, describe } from "./hooks/tool"
import { active, type Policy } from "./policy"
import { LOCK_ENV, type ResolvedMode } from "./state"
import type { Stats } from "./stats"
import type { Mode } from "./types"

type Methods = (typeof definition)["methods"]

export interface RpcDeps {
  policy: Policy
  stats: Stats
  /** The directory of the plugin instance's Location. */
  directory: string
}

export function createRpcHandlers({ policy, stats, directory }: RpcDeps) {
  const state = policy.mode
  return {
    async status(): Promise<Status> {
      const status = toStatus(await state.resolve())
      const recent = await stats.recent().catch(() => undefined)
      return recent ? { ...status, recent } : status
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

    test(input: unknown): Promise<TestResult> {
      return dryRun(policy, directory, input as TestInput)
    },
  }
}

/** Judges a `shell` call like `execute.before`, without running it or counting it in the stats. */
export async function dryRun(policy: Policy, directory: string, input: TestInput): Promise<TestResult> {
  let state
  try {
    state = await active(policy)
  } catch (error) {
    const { mode } = await policy.mode.resolve()
    return { mode, decision: "deny", ruleId: "config-error", reason: describe(error), atoms: [] }
  }
  if (!state) return { mode: "off", decision: "allow", atoms: [] }
  const { command, workdir } = input
  const shell = workdir === undefined ? { command } : { command, workdir }
  try {
    return toResult(state.mode, analyzeShell(policy, state, directory, shell))
  } catch (error) {
    return { mode: state.mode, decision: "deny", ruleId: "policy-error", reason: describe(error), atoms: [] }
  }
}

function toStatus({ mode, source, locked, expiresAt }: ResolvedMode): Status {
  return expiresAt === undefined ? { mode, source, locked } : { mode, source, locked, expiresAt }
}

function toResult(mode: Mode, { decision, ruleId, reason, atoms }: Analysis): TestResult {
  return compact({ mode, decision, ruleId, reason, atoms: atoms.map(compact) })
}

/** The RPC output schema rejects `undefined` fields. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
