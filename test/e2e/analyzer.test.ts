/** P1-1 and P1-2 analyzer cases through a real `opencode serve`, with real files for the script inputs. */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { E2E_ENABLED, expectAsked, expectDenied, Harness, STUB_MARK } from "./harness"

setDefaultTimeout(180_000)

let h: Harness

beforeAll(async () => {
  if (!E2E_ENABLED) return
  h = new Harness()
  h.write("danger.sh", "rm -rf /data\n")
  h.write("ok.sh", "echo SCRIPT-OK\n")
  h.write("body-cd.sh", "cd /\nrm -rf etc\n")
  h.write("sub/w.sh", "rm -rf /data\n")
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
})
