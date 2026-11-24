/** A minimal plugin context for hook tests; no OpenCode runtime. Only the members used by the plugin are real. */

import type { Plugin, Rpc } from "@opencode/plugin"

type Callback = (event: any) => Promise<void> | void
type AssertInput = Parameters<Plugin.Context["permission"]["assert"]>[0]
type Handler = (input: unknown, context: unknown) => Promise<unknown>

class ReturnedError {
  constructor(
    readonly type: string,
    readonly message: string,
    readonly data?: unknown,
  ) {}
}

export function fakeContext(init: { directory?: string; options?: Record<string, unknown> } = {}) {
  const hooks = new Map<string, Callback[]>()
  const data = new Map<string, unknown>()
  const asserts: AssertInput[] = []
  const rpcs: Array<{ definition: Rpc.PortableDefinition; handlers: Record<string, Handler> }> = []
  /** Set to make `permission.assert` reject with it. */
  const control: { assertError?: unknown } = {}

  const hook = (domain: string) => async (name: string, callback: Callback) => {
    const key = `${domain}.${name}`
    hooks.set(key, (hooks.get(key) ?? []).concat(callback))
    return { dispose: async () => void hooks.set(key, (hooks.get(key) ?? []).filter((item) => item !== callback)) }
  }

  const ctx = {
    location: { directory: init.directory ?? "/work/repo" },
    options: init.options ?? {},
    storage: {
      get: async (key: string) => data.get(key),
      set: async (key: string, value: unknown) => void data.set(key, structuredClone(value)),
      remove: async (key: string) => void data.delete(key),
      /** Like the OpenCode KV: keys in ascending order, after `after`, with `next` when more remain. */
      scan: async ({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) => {
        const keys = [...data.keys()]
          .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
          .sort()
        const entries = keys.slice(0, limit).map((key) => ({ key, value: structuredClone(data.get(key)) }))
        return keys.length > limit ? { entries, next: entries.at(-1)!.key } : { entries }
      },
    },
    tool: { hook: hook("tool") },
    permission: {
      hook: hook("permission"),
      assert: async (input: AssertInput) => {
        asserts.push(input)
        if (control.assertError !== undefined) throw control.assertError
      },
    },
    rpc: {
      register: async (definition: Rpc.PortableDefinition, handlers: Record<string, Handler>) => {
        rpcs.push({ definition, handlers })
        return { dispose: async () => {}, events: { emit: async () => {} } }
      },
    },
  } as unknown as Plugin.Context

  /** Runs the callbacks registered for `<domain>.<name>` in order, like OpenCode. */
  async function fire(name: string, event: unknown) {
    for (const callback of hooks.get(name) ?? []) await callback(event)
  }

  /**
   * Calls an RPC method like OpenCode and its client: the latest registration wins, a returned error must be declared
   * by the method, and the call rejects with `{ type, message, data }`.
   */
  async function call(rpcID: string, method: string, input: unknown) {
    const entry = rpcs.findLast((item) => item.definition.id === rpcID)
    const handler = entry?.handlers[method]
    if (!entry || !handler) throw new Error(`unknown rpc ${rpcID}.${method}`)
    const error = (type: string, message: string, data?: unknown) => new ReturnedError(type, message, data)
    const result = await handler(input, { signal: new AbortController().signal, error })
    if (!(result instanceof ReturnedError)) return result
    if (!Object.hasOwn(entry.definition.methods[method]?.errors ?? {}, result.type)) throw new Error(`Undeclared RPC error: ${result.type}`)
    throw { type: result.type, message: result.message, data: result.data }
  }

  return { ctx, hooks, data, asserts, control, rpcs, fire, call }
}
