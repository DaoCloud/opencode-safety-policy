/** The `/safety` TUI entry and the approval toast, driven through a real `opencode` TUI in a headless terminal. */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { directive, E2E_ENABLED, Harness, STUB_MARK } from "./harness"
import { BACKSPACE, CTRL_P, DESCRIPTION, ENTER, ESC, Tui } from "./tui-driver"

setDefaultTimeout(180_000)

let h: Harness

beforeAll(() => {
  if (E2E_ENABLED) h = new Harness()
})

afterAll(async () => {
  await h?.dispose()
})

describe.skipIf(!E2E_ENABLED)("tui", () => {
  let tui: Tui

  beforeAll(async () => {
    tui = new Tui(h)
    await tui.ready()
  })

  afterAll(async () => {
    await tui?.close()
  })

  test("autocompletes /safety", async () => {
    await tui.type("/saf")
    await tui.waitFor(DESCRIPTION)
    expect(tui.screen()).toMatch(new RegExp(`/safety +${DESCRIPTION}`))
    tui.press(BACKSPACE.repeat(4))
    await tui.waitFor(DESCRIPTION, false)
  })

  test("lists Safety policy in the command palette", async () => {
    tui.press(CTRL_P)
    await tui.type("safety")
    await tui.waitFor("Safety policy")
    tui.press(ESC)
    await tui.waitFor("Safety policy", false)
  })

  test("reports and switches the mode through toasts", async () => {
    await tui.type("/safety status")
    tui.press(ENTER)
    await tui.waitFor("当前模式：strict（source: default）")
    await tui.waitForToast("当前模式：strict（source: default）；最近 24 小时无拦截")
    await tui.type("/safety relaxed --ttl 1m")
    tui.press(ENTER)
    await tui.waitFor("当前模式：relaxed（source: runtime，1 分钟后回落）")
    await tui.type("/safety strict")
    tui.press(ENTER)
    await tui.waitFor("当前模式：strict（source: runtime）")
  })

  test("/safety test shows the unwrap chain in a dialog", async () => {
    await tui.type(`/safety test ssh n1 "sudo rm -rf /etc"`)
    tui.press(ENTER)
    await tui.waitFor("拆壳链：ssh → sudo")
    expect(tui.screen()).toContain("结果：deny [rm-system-path]")
    expect(tui.screen()).toContain("位置：远端 n1")
    tui.press(ENTER)
    await tui.waitFor("拆壳链：ssh → sudo", false)
  })

  test("shows the reason of a forced approval and runs the command once allowed", async () => {
    const file = h.write("tmp/tui.txt", "x")
    await tui.type(directive("shell", { command: `rm ${file}` }))
    tui.press(ENTER)
    await tui.waitFor("Permission required")
    await tui.waitForToast("[safety-policy:rm-local] 删除本机文件需要确认")
    tui.press(ENTER)
    const ran = `${STUB_MARK} rm ${file}`
    const deadline = Date.now() + 30_000
    while (!h.requests.some((r) => r.results.some((result) => result.includes(ran))) && Date.now() < deadline)
      await Bun.sleep(100)
    expect(h.requests.some((r) => r.results.some((result) => result.includes(ran)))).toBe(true)
  })

  test("/safety status shows the blocks counted so far", async () => {
    await tui.type("/safety status")
    tui.press(ENTER)
    await tui.waitForToast("当前模式：strict（source: runtime）；最近 24 小时：拒绝 0 次，需确认 1 次（rm-local ×1）")
  })
})

describe.skipIf(!E2E_ENABLED)("tui with a locked mode", () => {
  let tui: Tui

  beforeAll(async () => {
    tui = new Tui(h, { OPENCODE_SAFETY_LOCK_MODE: "strict" })
    await tui.ready()
  })

  afterAll(async () => {
    await tui?.close()
  })

  test("refuses /safety off", async () => {
    await tui.type("/safety off")
    tui.press(ENTER)
    await tui.waitFor("锁定为 strict")
  })
})

describe.skipIf(!E2E_ENABLED)("tui with the server command enabled", () => {
  const entries = () => tui.screen().match(new RegExp(`/safety +${DESCRIPTION}`, "g"))?.length ?? 0
  let s: Harness
  let tui: Tui
  let sessionID: string

  beforeAll(async () => {
    s = new Harness({ enableServerSlashCommand: true })
    await s.start()
    sessionID = await s.session()
    tui = new Tui(s, { OPENCODE_PASSWORD: s.password }, ["--server", s.url, "--session", sessionID])
    await tui.ready()
  })

  afterAll(async () => {
    await tui?.close()
    await s?.dispose()
  })

  test("lists both entries and runs /safety in the TUI plugin, leaving the server command unused", async () => {
    await tui.type("/saf")
    const deadline = Date.now() + 30_000
    while (entries() < 2 && Date.now() < deadline) await Bun.sleep(100)
    expect(entries()).toBe(2)
    tui.press(BACKSPACE.repeat(4))
    await tui.waitFor(DESCRIPTION, false)
    const inbox = async () => (await s.api("GET", `/api/session/${sessionID}/inbox`)).data
    await tui.type("/safety relaxed --ttl 1m")
    tui.press(ENTER)
    await tui.waitForToast("当前模式：relaxed（source: runtime，1 分钟后回落）")
    await tui.type("/safety strict")
    tui.press(ENTER)
    await tui.waitForToast("当前模式：strict（source: runtime）")
    expect(await inbox()).toEqual([])
    await s.api("POST", `/api/session/${sessionID}/command`, { name: "safety", text: "status" })
    expect(await inbox()).toHaveLength(1)
  })
})
