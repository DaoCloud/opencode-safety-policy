/**
 * P1-1 to P1-5 analyzer cases through a real `opencode serve`, with real files for the script inputs and local HTTP
 * servers for Code Mode `fetch`. The plugin runs without `enableServerSlashCommand`, so it also checks that default.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import {
  E2E_ENABLED,
  expectAllowed,
  expectAsked,
  expectDenied,
  expectRecent,
  Harness,
  safetyPermissions,
  STUB_MARK,
} from "./harness"

setDefaultTimeout(180_000)

let h: Harness

beforeAll(async () => {
  if (!E2E_ENABLED) return
  // Nothing listens on 127.0.0.2:9, so a request that runs fails at once.
  h = new Harness({ protectedEndpoints: { bmcCidrs: ["127.0.0.2/32"] } })
  h.write("danger.sh", "rm -rf /data\n")
  h.write("ok.sh", "echo SCRIPT-OK\n")
  h.write("body-cd.sh", "cd /\nrm -rf etc\n")
  h.write("sub/w.sh", "rm -rf /data\n")
  h.write("danger.py", "import shutil\nshutil.rmtree('/data')\n")
  h.write("ok.py", "print('PY-OK')\n")
  h.write("boot.json", '{"Boot":{"BootSourceOverrideTarget":"Pxe"}}')
  h.write("post.cfg", "url = http://127.0.0.2:9/x\nrequest = POST\n")
  await h.start()
})

afterAll(async () => {
  await h?.dispose()
})

const denied: [string, string][] = [
  // P1-1: wrappers, expansions and indirection that still reach a rule.
  [String.raw`$'\x72\x6d' -rf /data`, "rm-system-path"],
  ["rm -rf {/etc,/tmp/x}", "rm-system-path"],
  ["pdsh -w n[1-3] 'rm -rf /data'", "rm-system-path"],
  ["podman exec c1 rm -rf /data", "rm-system-path"],
  ["chroot /mnt rm -rf /data", "rm-system-path"],
  ["flock /tmp/l -c 'rm -rf /data'", "rm-system-path"],
  ["watch -n1 rm -rf /data", "rm-system-path"],
  ["parallel rm -rf ::: /data", "rm-system-path"],
  ["sudo rm -rf /data", "rm-system-path"],
  [String.raw`r\m -rf /data`, "rm-system-path"],
  [`eval "rm -rf /data"`, "rm-system-path"],
  ["echo cm0gLXJmIC9kYXRh | base64 -d | sh", "opaque"],
  ["f() { rm -rf /data; }; f", "opaque"],
  ["CMD=rm; $CMD -rf /data", "dynamic-command"],
  ["{rm,-rf,/data}", "dynamic-command"],
  ["find /data -delete", "find-delete"],
  ["find /data -exec rm -rf {} +", "find-delete"],
  ["ansible all -m shell -a 'kubectl delete ns prod'", "k8s-delete-namespace"],
  ["nice -n 5 kubectl delete ns prod", "k8s-delete-namespace"],
  ["bash -c 'kubectl delete ns prod'", "k8s-delete-namespace"],
  ["echo /data | xargs rm -rf", "rm-recursive-variable"],
  // P1-2: scripts fed through stdin are read and analyzed where they run.
  ["bash < danger.sh", "rm-system-path"],
  ["ssh n1 sh < danger.sh", "rm-system-path"],
  ["bash < body-cd.sh", "rm-system-path"],
  ["cd sub && bash < w.sh", "rm-system-path"],
  ["echo kubectl delete ns x | ssh n1 sh", "k8s-delete-namespace"],
  ["cat ok.sh | sh", "opaque"],
  ["cat <<'EOF' | ssh n1 bash\nuptime\nEOF", "opaque"],
  ["F=danger.sh; bash < $F", "opaque"],
  ["bash < missing.sh", "opaque"],
  // P1-5: script arguments, interpreter code and scripts written earlier in the command.
  ["bash danger.sh", "rm-system-path"],
  ["python3 danger.py", "rm-system-path"],
  [`python3 -c 'import os; os.system("rm -rf /data")'`, "rm-system-path"],
  [`node -e 'require("fs").rmSync("/data", { recursive: true })'`, "rm-system-path"],
  ["cat > run.sh <<'EOF'\necho hi\nEOF\nbash run.sh", "opaque"],
  ["python3 missing.py", "opaque"],
  // P1-3: HTTP writes to Redfish, UFM and protected endpoints, with bodies and curl configs read from real files.
  ["curl -X PATCH -d {} https://bmc1/redfish/v1/Managers/1/VirtualMedia/CD", "redfish-virtual-media"],
  [
    "curl -X POST https://bmc1/redfish/v1/Managers/1/VirtualMedia/CD/Actions/VirtualMedia.InsertMedia -d '{}'",
    "redfish-virtual-media",
  ],
  ["curl -X PATCH https://bmc1/redfish/v1/Systems/1 -d @boot.json", "redfish-boot-override"],
  ["curl -X POST http://127.0.0.2:9/x", "protected-endpoint-write"],
  ["curl -K post.cfg", "protected-endpoint-write"],
  ["curl -K missing.cfg https://bmc1/x", "opaque"],
  [`python3 -c 'import requests; requests.post("http://127.0.0.2:9/x")'`, "protected-endpoint-write"],
]

describe.skipIf(!E2E_ENABLED)("strict", () => {
  test.each(denied)("denies %p", async (command, ruleId) => {
    expectDenied(await h.shell(command), ruleId)
  })

  test("resolves a script input against the workdir", async () => {
    expectDenied(await h.shell("bash < w.sh", { workdir: path.join(h.project, "sub") }), "rm-system-path")
  })

  test("asks before running a readable script that hits no rule", async () => {
    const call = await h.shell("bash < ok.sh")
    expectAsked(call, "script-file")
    expect(call.permissions[0]!.message).toBe(
      "[safety-policy:script-file] 从本地文件读取脚本执行（ok.sh），执行前内容可能被修改",
    )
    expect(call.result).toContain("SCRIPT-OK")
  })

  test("asks before running a readable interpreter script that hits no rule", async () => {
    const call = await h.shell("python3 ok.py")
    expectAsked(call, "script-file")
    expect(call.result).toContain("PY-OK")
  })

  test("allows a read from a protected endpoint", async () => {
    const call = await h.shell("curl -sS http://127.0.0.2:9/redfish/v1/Systems; echo CURL-RAN")
    expectAllowed(call)
    expect(call.result).toContain("CURL-RAN")
  })
})

describe.skipIf(!E2E_ENABLED)("relaxed", () => {
  beforeAll(async () => {
    expect((await h.rpc("setMode", { mode: "relaxed" })).status).toBe(200)
  })

  afterAll(async () => {
    await h.rpc("setMode", { mode: "strict" })
  })

  test("asks for an opaque command instead of denying it", async () => {
    const call = await h.shell("echo ZWNobyBoaQ== | base64 -d | sh")
    expectAsked(call, "opaque")
    expect(call.result).toContain("hi")
  })

  test("asks for an unreadable script input", async () => {
    const call = await h.shell("bash < missing.sh")
    expectAsked(call, "opaque")
    expect(call.result).not.toContain(STUB_MARK)
  })

  test("still denies a critical hit inside a script", async () => {
    expectDenied(await h.shell("bash < danger.sh"), "rm-system-path")
  })

  test("allows a readable script that hits no rule", async () => {
    const call = await h.shell("bash ok.sh")
    expectAllowed(call)
    expect(call.result).toContain("SCRIPT-OK")
  })

  test("still denies a critical hit in a script written by the same command", async () => {
    expectDenied(await h.shell("cat > run.sh <<'EOF'\nrm -rf /data\nEOF\nbash run.sh"), "rm-system-path")
  })

  test("asks for a protected endpoint write", async () => {
    const call = await h.shell("curl -sS -X POST http://127.0.0.2:9/x; echo CURL-RAN")
    expectAsked(call, "protected-endpoint-write")
    expect(call.result).toContain("CURL-RAN")
  })

  test("still denies a critical Redfish action", async () => {
    const call = await h.shell("curl -X POST https://bmc1/redfish/v1/Systems/1/Actions/ComputerSystem.Reset")
    expectDenied(call, "redfish-power-reset")
  })
})

describe.skipIf(!E2E_ENABLED)("code mode fetch", () => {
  const hits: string[] = []
  let open: ReturnType<typeof Bun.serve>
  let guarded: ReturnType<typeof Bun.serve>

  beforeAll(async () => {
    // 127.0.0.2 is a protected endpoint; 127.0.0.1 answers /<status> with a redirect to it.
    guarded = Bun.serve({
      hostname: "127.0.0.2",
      port: 0,
      fetch(req) {
        hits.push(`${req.method} ${new URL(req.url).pathname}`)
        return new Response("GUARDED-OK")
      },
    })
    open = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url)
        hits.push(`${req.method} open${pathname}`)
        const location = `http://127.0.0.2:${guarded.port}/x`
        return new Response(null, { status: Number(pathname.slice(1)), headers: { location } })
      },
    })
    await h.start({ OPENCODE_FLAGS: "full_codemode" })
  })

  afterAll(() => {
    open?.stop(true)
    guarded?.stop(true)
  })

  async function fetchCall(url: string, method: string) {
    hits.length = 0
    const init = method === "GET" ? "{}" : `{ method: "${method}", body: "{}" }`
    const code = [
      `try { const r = await fetch("${url}", ${init}); return "STATUS " + r.status + " " + (await r.text()) }`,
      "catch (e) { return String(e?.message ?? e) }",
    ].join("\n")
    return h.call("execute", { code })
  }

  test.each([307, 308])("denies a write redirected by %i to a protected endpoint", async (status) => {
    const call = await fetchCall(`http://127.0.0.1:${open.port}/${status}`, "POST")
    expect(call.result).toContain("[safety-policy:protected-endpoint-write]")
    expect(hits).toEqual([`POST open/${status}`])
    expect(safetyPermissions(call.permissions)).toEqual([])
  })

  test("denies a direct write to a protected endpoint", async () => {
    const call = await fetchCall(`http://127.0.0.2:${guarded.port}/x`, "PUT")
    expect(call.result).toContain("[safety-policy:protected-endpoint-write]")
    expect(hits).toEqual([])
  })

  test("counts a denied write once in the recent stats", async () => {
    const before = await h.recent()
    const call = await fetchCall(`http://127.0.0.2:${guarded.port}/x`, "PUT")
    expect(call.result).toContain("[safety-policy:protected-endpoint-write]")
    await expectRecent(h, { deny: before.deny + 1, ask: before.ask })
  })

  test("denies a Redfish action on any host", async () => {
    const reset = "/redfish/v1/Systems/1/Actions/ComputerSystem.Reset"
    const call = await fetchCall(`http://127.0.0.1:${open.port}${reset}`, "POST")
    expect(call.result).toContain("[safety-policy:redfish-power-reset]")
    expect(hits).toEqual([])
  })

  test("denies a read from the local Server API", async () => {
    const call = await fetchCall(`${h.url}/api/session`, "GET")
    expect(call.result).toContain("[safety-policy:self-protect]")
    expect(call.result).not.toContain("STATUS 200")
  })

  test("allows a read from a protected endpoint", async () => {
    const call = await fetchCall(`http://127.0.0.2:${guarded.port}/redfish/v1/Systems`, "GET")
    expect(call.result).toContain("STATUS 200 GUARDED-OK")
    expect(hits).toEqual(["GET /redfish/v1/Systems"])
  })
})

describe.skipIf(!E2E_ENABLED)("server command", () => {
  test("is not registered unless enabled", async () => {
    const sessionID = await h.session()
    const command = h.api("POST", `/api/session/${sessionID}/command`, { name: "safety", text: "status" })
    await expect(command).rejects.toThrow("Command not found: safety")
    expect((await h.api("GET", `/api/session/${sessionID}/inbox`)).data).toEqual([])
  })
})
