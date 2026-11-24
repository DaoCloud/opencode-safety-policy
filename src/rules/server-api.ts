/**
 * The local OpenCode Server API (design 4.2, "防绕过 `/safety` 与审批").
 *
 * A request is denied when it goes to `/api` or `/api/...` on a local address and a Server port. Local addresses are
 * `localhost` and `*.localhost`, `127.0.0.0/8`, `0.0.0.0`, `::1`, `::`, their IPv4-mapped forms and the addresses of
 * this host's interfaces. Server ports are the TCP ports this process listens on (the plugin runs in the Server
 * process; Linux only) and those of the background services registered in `service*.json`. When this process's
 * ports cannot be found, every port counts.
 */

import { readdirSync, readFileSync, readlinkSync } from "node:fs"
import { isIPv4, isIPv6 } from "node:net"
import os from "node:os"
import path from "node:path"
import type { HttpRequest } from "../http-extractor"
import type { Verdict } from "./index"

const DEFAULT_PORTS: Record<string, number> = { "http:": 80, "ws:": 80, "https:": 443, "wss:": 443 }
const MAPPED = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/
const SERVICE_FILE = /^service.*\.json$/
// `/proc/net/tcp*` state of a listening socket.
const LISTEN = "0A"

/** Server ports, or `undefined` when every port counts. */
export type ServerPorts = () => ReadonlySet<number> | undefined

/** A request to `/api` on a local address, whatever its port. */
export function isLocalApi(request: HttpRequest): boolean {
  const { host, path: p } = request
  return host !== undefined && p !== undefined && (p === "/api" || p.startsWith("/api/")) && isLocalHost(host)
}

/** The first request to the API of a local OpenCode Server. */
export function serverApiRequest(requests: HttpRequest[], ports: ServerPorts): HttpRequest | undefined {
  const local = requests.filter(isLocalApi)
  if (!local.length) return undefined
  const known = ports()
  return local.find((request) => known === undefined || known.has(portOf(request) ?? -1))
}

export function serverApiVerdict(request: HttpRequest): Verdict {
  const url = request.urls.at(-1)
  return { decision: "deny", ruleId: "self-protect", reason: `禁止调用本机 OpenCode Server API（${url}）` }
}

/** This process's listening ports and those registered in the `service*.json` files of `dirs`. */
export function serverPorts(
  dirs: string[],
  own: () => number[] | undefined = listeningPorts,
): ReadonlySet<number> | undefined {
  const ports = own()
  if (!ports?.length) return undefined
  return new Set([...ports, ...dirs.flatMap(registeredPorts)])
}

/** The TCP ports this process listens on; `undefined` without `/proc`. */
export function listeningPorts(): number[] | undefined {
  const inodes = new Set<string>()
  try {
    for (const fd of readdirSync("/proc/self/fd")) {
      const inode = /^socket:\[(\d+)\]$/.exec(readLink(`/proc/self/fd/${fd}`))?.[1]
      if (inode) inodes.add(inode)
    }
  } catch {
    return undefined
  }
  const ports: number[] = []
  for (const file of ["/proc/self/net/tcp", "/proc/self/net/tcp6"]) {
    for (const line of readText(file).split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/)
      if (fields[3] === LISTEN && inodes.has(fields[9]!)) ports.push(Number.parseInt(fields[1]!.split(":").at(-1)!, 16))
    }
  }
  return ports
}

/** The `url` port of a service registration and the `port` of a service configuration. */
function registeredPorts(dir: string): number[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => SERVICE_FILE.test(name))
  } catch {
    return []
  }
  return names.flatMap((name) => {
    try {
      const info = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as { url?: unknown; port?: unknown }
      const port = typeof info.url === "string" ? portOf({ urls: [info.url] }) : undefined
      return [port, info.port].filter((p): p is number => typeof p === "number")
    } catch {
      return []
    }
  })
}

function isLocalHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true
  const mapped = MAPPED.exec(host)
  if (mapped) {
    const [high, low] = [Number.parseInt(mapped[1]!, 16), Number.parseInt(mapped[2]!, 16)]
    return isLocalHost([high >> 8, high & 255, low >> 8, low & 255].join("."))
  }
  if (isIPv4(host) && (host.startsWith("127.") || host === "0.0.0.0")) return true
  if (isIPv6(host) && (host === "::1" || host === "::")) return true
  return Object.values(os.networkInterfaces()).some((list) => list?.some((item) => item.address === host))
}

function portOf(request: Pick<HttpRequest, "urls">): number | undefined {
  try {
    const url = new URL(request.urls.at(-1)!)
    return url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol]
  } catch {
    return undefined
  }
}

function readLink(file: string): string {
  try {
    return readlinkSync(file)
  } catch {
    return ""
  }
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}
