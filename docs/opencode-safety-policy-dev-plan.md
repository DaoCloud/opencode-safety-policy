# OpenCode Safety Policy 开发执行流程

> 技术方案以 [设计文档](./opencode-safety-policy-design.md) 为准。本文档只规定：按什么顺序做、每步产出什么、怎么验证、何时提交。

## 1. 使用方式

- 每次只执行一个 Step，指令格式如：“执行 dev-plan 的 P0-3”。
- 每个 Step 按第 3 节的标准循环推进，完成后在第 13 节进度清单中勾选，与代码一起提交。
- Step 中发现设计走不通或需要改接口：先停下，修改设计文档（单独的 `docs:` commit），再继续实现。
- 阶段之间有出口条件（第 5 节）。上一阶段未达标，不进入下一阶段。

## 2. 执行约定

### 2.1 Git

- 在当前仓库根目录开发，只做本地 commit，不开 PR，不 push（另行授权除外）。
- 每个 Step 至少一个 commit。大的 Step 可以拆成多个 commit，但每个 commit 都要通过质量门禁。
- 提交命令：`git commit -s -S -m "<title>"`。标题为英文一行，使用前缀 `feat:` / `fix:` / `test:` / `docs:` / `chore:`。不加 AI 署名，不加 `Co-authored-by`。
- `git add` 显式列出本 Step 的文件，不用 `git add -A`。

### 2.2 质量门禁（每个 commit 前）

| 检查 | 命令 | 要求 |
|---|---|---|
| 单元测试 | `bun test` | 全部通过（P0-1 尚无测试，跳过） |
| 类型检查 | `bunx tsc --noEmit` | 0 error |
| E2E | `bun run test:e2e` | 改动涉及 hook、判定结果、RPC 或 TUI 时全部通过（需要本机 `opencode`，见第 4 节） |
| 零运行时依赖 | `jq '.dependencies // {}' package.json` | 输出 `{}` |
| 工作区干净 | `git status --short` | 只有本 Step 的文件，无调试产物 |

### 2.3 编码约束

- 只用 Bun/Node 内置模块和宿主注入的 `@opencode/plugin`。不引入运行时依赖，也不直接使用 `effect`。RPC 契约用 `@opencode/plugin/rpc` 的 `Rpc.define`，input/output 写成 JSON Schema（Promise API 的 `rpc.register` 只接受 `PortableDefinition`）。
- 纯逻辑与宿主解耦：`tokenizer` / `unwrapper` / `path-util` / `rules/*` / `analyzer` 不接触 `ctx`，只有 `hooks/*`、`state.ts`、`index.ts`、`tui.ts` 接触插件上下文。
- Fail-closed：解析异常一律按 opaque 处理（`strict` 下 `deny`，`relaxed` 下 `ask`），不允许静默 `allow`。
- 拒绝和审批的原因统一以 `[safety-policy:<ruleId>]` 开头。TUI 的 `permission.asked` Toast 依赖这个前缀（设计 5.3）。
- 调试产物只放 `/tmp/ocsp-*`，不进仓库。

## 3. 每个 Step 的标准循环

1. 读该 Step 标注的设计章节。
2. 先写测试。解析和规则类代码严格先写测试再实现。
3. 实现，直到测试通过。
4. 跑质量门禁（2.2）。
5. 与设计有偏差时，同步修改设计文档。
6. 勾选进度清单，commit。

## 4. 环境准备

| 项 | 版本 / 路径 |
|---|---|
| Bun | 1.3.14 |
| OpenCode | v2.4.1（`/usr/local/nodejs/bin/opencode`）。P0 在 v2.3.2 上开发验收，升级后 E2E 套件全部通过 |
| `@opencode/plugin` | devDependency 锁定 `2.3.2`（只用于类型检查）；peerDependency `^2.3.0` |
| 其他 devDependencies | `@tsconfig/bun`、`@types/bun`、`typescript`（参照官方 `packages/plugins/figma`）；`@xterm/headless`（E2E 中渲染 TUI 屏幕） |
| 参考源码（只读） | `/ai-workspace/weizhoublue/git/opencode`（HEAD `22377659`） |
| API 用法参考 | 插件结构：`packages/plugins/figma/`；`Rpc.define` 写法：`packages/core/test/plugin/module.test.ts`（该用例用的是 Effect API，本插件改用 Promise API 和 JSON Schema） |

**E2E 隔离环境**（S2 已验证）：

- 隔离变量：`XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_STATE_HOME`、`XDG_CACHE_HOME` 指向 `/tmp/ocsp-e2e/xdg/{config,data,state,cache}`。运行任何 `opencode` 命令（包括 `--help`）前都先导出这 4 个变量，否则会写个人目录下的日志。
- 测试项目目录 `/tmp/ocsp-e2e/project`，在该目录的 `opencode.json` 中用本地目录路径注册本仓库，`model` 指向 mock provider。
- 模型：本地 mock LLM（OpenAI 兼容，`providers.mock` 用 `@opencode/ai/providers/openai-compatible`，`baseURL` 指向本机端口），把用户消息中的 `@@CALL <tool> <json>` 依次转成工具调用，不需要真实模型凭据。实现见 Spike 产物 `/tmp/ocsp-spike/mock-llm.ts`。
- 驱动方式：
  - `opencode run --standalone '<消息>'`：非交互，审批自动拒绝，适合验证 deny 与“弹出审批”。
  - `opencode serve --hostname 127.0.0.1 --port <p>` + HTTP API（Basic 认证，用户名 `opencode`，密码见启动日志）：`GET /api/session/:id/permission` 查询审批，`POST /api/session/:id/permission/:requestID/reply` 回复 `once`/`always`/`reject`，`POST /api/rpc/:rpcID/:method` 调用插件 RPC，请求体为 `{ "input": ... }`。插件按 Location 懒加载，对新目录的第一次请求可能返回 `rpc.unavailable`，稍后重试即可。
  - TUI：`opencode --standalone <dir>`，用 `Bun.Terminal` 提供 pty、`@xterm/headless` 渲染屏幕后断言文本。
- 替身命令：拦截失效时命令会真实执行，所以 E2E 前把 `rm`、`kubectl`、`docker`、`ssh`、`nv` 等替身脚本放到 `PATH` 最前，替身只打印参数。规则按命令名判定，替身不影响结果。
- 不修改 `/etc/opencode` 和个人 `~/.config/opencode`（本机为共享环境）。系统级部署放到 R-2，在容器或 VM 中验证。
- Code Mode 嵌套调用 shell 需要 `OPENCODE_FLAGS=full_codemode`。该 flag 只能显式开启，也可以在配置里写 `experimental.full_codemode: true`。

**自动化 E2E 套件**：`test/e2e/` 按上述方式搭建环境，用 `bun run test:e2e`（即 `OCSP_E2E=1 bun test test/e2e`）运行，默认的 `bun test` 跳过这些用例。

- `harness.ts`：每个测试文件在 `/tmp/ocsp-e2e-*` 下建立独立的 HOME、XDG 目录、两个项目目录和替身命令，在测试进程内起 mock LLM，启动 `opencode serve --port 0` 并通过 HTTP API 发消息、回复审批、调用 RPC。环境变量中继承来的 `OPENCODE_*` 全部去掉，并设置 `OPENCODE_DISABLE_AUTOUPDATE=1`。结束时停进程、删临时目录。
- `server.test.ts`：P0-E2E 中 shell 拦截、审批、SSH、自保护、模式切换与 TTL 回落、Code Mode、LOCK、`session_inbox` 与 LLM 回合数。
- `analyzer.test.ts`：P1-1、P1-2 的判定在真实 `opencode serve` 上的结果，脚本输入用项目中的真实文件。
- `tui.test.ts`：`/safety` 补全、命令面板、状态与切换 Toast、强制审批的原因 Toast、LOCK 下拒绝切换。
- 新增危险命令用例时，先确认命令名在替身列表中，不要在命令里写 `/bin/rm` 这类绝对路径。本机存在 `/data`。

## 5. 阶段总览

| 阶段 | Steps | 目标 | 出口条件 |
|---|---|---|---|
| 准备 | D0、S | 文档入库，实测关键假设 | 设计文档附录 A 记录 S1–S9 的结论，S3/S4/S6 的回退方案已选定 |
| P0 | P0-1 … P0-12、P0-E2E | MVP 闭环 | `bun test` 全绿，P0 E2E 清单全部通过 |
| P1 | P1-1 … P1-6、P1-E2E | 深化 `CommandAnalyzer` | P1 E2E 清单全部通过 |
| P2 | P2-1 … P2-5、P2-E2E | 加固与体验 | P2 E2E 清单全部通过 |
| 发布 | R-1 … R-3 | 文档与分发 | 容器/VM 中系统级部署验证通过 |

---

## 6. 准备阶段

### D0 文档入库

- 产出：`docs/opencode-safety-policy-design.md`、`docs/opencode-safety-policy-dev-plan.md`
- commit：`docs: add safety policy design and development plan`

### S Spike：实测关键假设

P0 的核心机制依赖几处只通过读源码推断的行为。先用一次性插件实测，避免写完才发现走不通。

做法：

- 在 `/tmp/ocsp-spike/` 写一次性插件：`package.json`（含 `name` 和 `exports`：`.`、`./server`、`./tui`、`./rpc`）、`index.ts`、`tui.ts`、`rpc.ts`。每个 hook 把入参以 JSON 追加写入 `/tmp/ocsp-spike/trace.jsonl`。
- 在隔离环境中启动 OpenCode，逐项触发并记录结果。
- Spike 代码不入库。结论写进设计文档新增的“附录 A：Spike 验证结果”，注明日期、OpenCode 版本、每项结果和证据（trace 片段）。

| 编号 | 待验证假设 | 触发方式 | 通过标准 | 失败时的回退 |
|---|---|---|---|---|
| S1 | 本地目录加载：`package.json` 含 `name` 与 `exports` 时，server/tui/rpc 三个入口都能解析，`options` 注入到 `setup` | 测试项目的 `opencode.json` 注册 `/tmp/ocsp-spike` | trace 中出现 `setup` 及 options；TUI 入口加载 | 去掉 `exports`，改用根目录约定文件名（`plugin/src/host.ts` 的 `resolve`） |
| S2 | 隔离环境可行 | 设置候选变量后启动 | 不读写个人配置、DB 和 `service.json` | 改用独立 `HOME=/tmp/ocsp-e2e/home` |
| S3 | `execute.before` 抛错能阻止执行 | 抛错拦截 `echo SPIKE_DENY` | 命令未执行，模型看到原因；记录当前 step 是否结束 | 无。这是项目前提，失败则暂停并重新评估 |
| S4 | evaluate 能强制 ask（直调） | execute.before 登记 callID，evaluate 按 `source.id` 命中后设 `effect = "ask"` 和 `message` | 弹出内置审批；点 `Always` 后再执行同一命令仍弹窗；未登记的命令不受影响 | 改回原方案：execute.before 中插件自行 `permission.assert`（不传 `save`）+ 令牌，evaluate 放行令牌 |
| S5 | full_codemode 嵌套 shell | `OPENCODE_FLAGS=full_codemode`，让模型在 Code Mode 中调用 shell | 记录 execute.before 的 `tool`/`id` 与 evaluate 的 `source.id`/`resources`；`sessionID` + 子串匹配能唯一命中；execute.before 抛错可被 `try/catch` 捕获，且命令未执行 | 子串匹配不可靠时：同一 session 存在未消费的标记就强制 ask |
| S6 | execute.before 与 evaluate 在同一插件实例中触发 | 两个 hook 打印模块级实例 ID | 实例 ID 相同，模块级 `Map` 可共享标记 | 标记改存 `ctx.storage`（key 含 `sessionID` + `callID`，带 TTL） |
| S7 | `ctx.storage` 跨 Location 共享 | 两个不同目录的项目读写同一 key，然后重启 | 互相可见，重启后保留 | 改用状态文件 `~/.local/state/opencode/safety-policy/state.json` |
| S8 | TUI 能力 | `tui.ts` 注册 `/safety` slash，调用 RPC `ping`（契约用 JSON Schema）；订阅 `permission.asked` | slash 可用；RPC 往返成功；能收到事件且带 `message` | RPC 不通时改用 Effect `Schema` 定义契约；收不到事件时，TUI 不展示原因，改由 `/safety status` 显示最近一次命中 |
| S9 | Code Mode `fetch` 经过 evaluate | Code Mode 中 `fetch(url, { method: "POST" })`，目标返回 307 | evaluate 收到 `action: "webfetch"`，`resources` 为 URL，`metadata` 能取到 method；重定向复检也触发 evaluate | P1-4 前重新设计 fetch 拦截方式 |

- commit：`docs: record spike results`

---

## 7. P0：MVP 闭环

### P0-1 包脚手架

- 设计：6、6.1
- 产出：`package.json`、`tsconfig.json`、`.gitignore`、`bun.lock`、`src/types.ts`、`index.ts`（`export default Plugin.define({ id: "opencode-safety-policy", setup })`，暂不注册任何 hook）
- 要点：`dependencies` 为空；devDependencies 见第 4 节；包名先按第 12 节的决定填写。
- 验证：`bun install && bunx tsc --noEmit`
- commit：`chore: scaffold plugin package`

### P0-2 Tokenizer

- 设计：3.1 Stage 1
- 产出：`src/tokenizer.ts`、`test/tokenizer.test.ts`
- 要点：
  - 处理引号和转义。按 `;` `&&` `||` `|` `&` 切分命令段。
  - 识别重定向：`>` `>>` `<` `<<` `<<<` `2>&1`。
  - 把 `$(...)` 和反引号中的内容提取为子命令。
  - 识别前置环境变量赋值，如 `A=1 cmd`。
  - 命令名归一化：去引号、去前导反斜杠（`\rm`）、取 basename（`/usr/bin/rm`）。
  - P0 只提取基本形态的 heredoc 正文。
  - 无法解析时返回 opaque 标记，不抛异常。
- 验证：`bun test test/tokenizer.test.ts`
- commit：`feat: add shell tokenizer`

### P0-3 Unwrapper

- 设计：3.1 Stage 3、3.2 前两行
- 产出：`src/unwrapper.ts`、`test/unwrapper.test.ts`
- 要点：
  - P0 覆盖 `ssh`、`sshpass`、`sudo`、`env`、`timeout`、`nohup`、`bash/sh -c`、`kubectl exec --`、`docker exec`。
  - 为 `ssh`、`kubectl`、`docker` 维护带值选项表。
  - 输出原子命令及 `{ isRemote, targetHost, wrapperChain }`。
  - 最大深度 8，超过按 opaque 处理。
  - 其余 wrapper 放到 P1-1。
- 验证：`bun test test/unwrapper.test.ts`
- commit：`feat: add recursive command unwrapper`

### P0-4 路径规范化

- 设计：3.1 Stage 1（effectiveCwd）、4.2 防自篡改
- 产出：`src/path-util.ts`、`test/path-util.test.ts`
- 要点：
  - 实现 `resolveCanonicalPath`：对最近的已存在祖先目录取 realpath，再拼接 relativeTail。
  - 实现 `effectiveCwd(workdir, locationDirectory)`。
  - 将路径敏感命令的相对路径参数展开为绝对路径。
  - 测试在 `/tmp` 下创建临时目录和符号链接，测试结束后清理。
- 验证：`bun test test/path-util.test.ts`
- commit：`feat: add canonical path resolution`

### P0-5 规则引擎

- 设计：4、4.1、5.1
- 产出：`src/rules/loader.ts`、`src/rules/matcher.ts`、`src/rules/index.ts`、`test/rules-examples.test.ts`、`test/rules.test.ts`
- 要点：
  - 规则文件格式为 `{ "rules": [...] }`，匹配语义见设计 4.1。
  - 手写规则校验：`id` 唯一，`severity` 取值合法，不允许未知字段，正则必须可编译，`command`、`pattern`、`http` 至少有一个。非法规则在加载时报错，指明文件和 `id`。
  - `extraAllow` 只豁免 `high` / `medium` 和 `extraAsk`，不能豁免 `critical` 和 `extraDeny`（设计 4.1）。
  - loader 按 `import.meta.dir` 扫描 `rules/` 目录，新增 JSON 文件不用改代码。同时合并 `rulesFile`、`extraDeny`、`extraAsk`、`extraAllow`。
  - `command + subcommands + flags` 匹配时跳过带值的全局参数；`pattern` 预编译。
  - 按 5.1 矩阵把 `severity × mode` 映射为决策，聚合顺序为 `deny > ask > allow`。
  - `http` 匹配在 P1-3 实现。
  - `rules-examples.test.ts` 自动遍历所有规则的 `examples`：`match` 必须命中该规则 `id`，`ignore` 不得命中。本 Step 先用测试内的 fixture 规则验证。
- 验证：`bun test test/rules-examples.test.ts test/rules.test.ts`
- commit：`feat: add declarative rule engine`

### P0-6 内置规则

- 设计：4.2、4.3
- 产出：`rules/cloud-native.json`、`linux-host.json`、`network-db.json`、`spectrum-cumulus.json`、`ib-ufm.json`（CLI 部分）、`oob-redfish.json`（CLI 部分）、`ssh-readonly.json`
- 要点：
  - 每条规则至少 2 个 `match` 和 2 个 `ignore`，`ignore` 要包含字面量误报样例，如 `echo kubectl delete`。
  - 有 `subcommands` 规则且带值全局选项会遮住子命令的 CLI，在 `src/cli-options.ts` 补带值选项表，并登记到 `src/rules/matcher.ts` 的 `COMMAND_SPECS`。
  - `rules-examples.test.ts` 改为同时遍历内置 `rules/` 目录，`package.json` 的 `files` 加入 `rules`。
  - HTTP 规则在 P1-3 补充。
  - 可以按文件拆成多个 commit。
- 验证：`bun test test/rules-examples.test.ts`
- commit：`feat: add built-in <category> rules`

### P0-7 配置与模式状态

- 设计：5.1、5.2、7
- 产出：`src/config.ts`、`src/state.ts`、`test/mode.test.ts`、`test/config.test.ts`
- 要点：
  - 解析并校验 `options`。`rulesFile` 按 mtime 按需刷新。
  - 模式优先级：`OPENCODE_SAFETY_LOCK_MODE` > storage 中的 `safety:state`（含 TTL）> `OPENCODE_SAFETY_MODE` > `options.mode` > `strict`。
  - `state.ts` 只依赖 storage 接口（`get`/`set`）。每次决策时读取，可加秒级缓存。TTL 在读取时判断，过期后回落。
  - LOCK 生效时，`setMode` 抛错。
  - `mode.test.ts` 覆盖注入时钟后的 TTL 回落、叠加 TTL 和 LOCK 优先级。`severity × mode` 决策矩阵已在 `rules.test.ts` 覆盖。
  - `config.test.ts` 覆盖 options 校验和 `rulesFile` 刷新、报错。
- 验证：`bun test test/mode.test.ts test/config.test.ts`
- commit：`feat: add mode state with ttl and lock`

### P0-8 Analyzer（P0 版）与 SSH 策略

- 设计：3.1（Stage 1/3/4）、3.2、4.3、5.1
- 产出：`src/analyzer.ts`、`src/rules/ssh-policy.ts`、`test/analyzer.test.ts`；`test/rules-examples.test.ts` 改为通过 analyzer 全链路执行
- 要点：
  - 纯函数：`analyze({ command, workdir, locationDirectory, mode, rules, readOnly, home }) → { decision, ruleId, reason, atoms }`，`readOnly` 由 `loadReadOnlyList(options.sshReadOnlyAllowlist)` 构建。
  - 远端只读白名单放行；未知远端命令在 `strict` 下 `ask`（`unknown-remote-command`）。
  - 只读白名单按命令前缀匹配，规则命中优先于白名单。`kubectl`、`docker`、`ipmitool` 先跳过全局选项（`ipmitool -H bmc1 sel list`）。输出重定向写文件的远端命令不算只读。
  - 常见 wrapper 已提前到本步：`nice`、`command`、`builtin`、`exec`、`time`、`stdbuf`、`ionice`、`setsid`、`doas`、`su`、`runuser`、`xargs`（输入记为变量参数 `$XARGS_INPUT`）、`eval`。
  - heredoc / here-string 正文纳入匹配：带 `command` 的规则把 stdin 接在参数后再试一次（`psql <<SQL DROP TABLE x`）；shell、`ssh`、`sudo -s`、`su` 无命令时以 stdin 为脚本递归分析（`bash <<EOF`、`ssh host <<EOF`）。
  - 结合 `workdir` 判定，如 `shell({ workdir: "/", command: "rm -rf etc" })`，并跟踪 `cd`/`pushd`、`env -C`、`sudo -D/-i`、`su -` 的目录切换；无法静态确定的目录按占位目录与 `/` 各评估一次，仅经 `/` 推出的 `deny` 降为 `ask`。
  - opaque 脚本与动态命令名（`$CMD`、`/bin/r[m]`、`{rm,-rf,/}`）在 `strict` 下 `deny`、`relaxed` 下 `ask`；tokenizer 把未加引号的 `[...]` 与 `{a,b}`/`{1..3}` 记为 expanded。
- 验证：`bun test`
- commit：`feat: add command analyzer and ssh policy`

### P0-9 execute.before Hook

- 设计：2（架构图与分工表）、1.2
- 产出：`src/policy.ts`、`src/hooks/tool.ts`、`rules/opencode-tools.json`、`test/helpers/fake-context.ts`、`test/plugin.test.ts`
- 要点：
  - `shell`：调用 analyze。`deny` 时抛 `Error("[safety-policy:<id>] <reason>")`。`ask` 时登记标记 `{ sessionID, callID, command, ruleId, reason, expiresAt }`，放在 Map 中（S6 已验证同一实例）。
  - 非 shell 工具（MCP、`opencode_worktree_remove` 等）按设计 4.1 的工具规则判定：`argv` 为 `[<工具 ID>, <紧凑 JSON 输入>]`，只匹配 `command` 列出该工具 ID 的规则。`opencode_worktree_remove` 的 `force: true` 是 `rules/opencode-tools.json` 中的 `high` 规则（`strict` 下 `deny`，`relaxed` 下 `ask`）。
  - 非 shell 工具 `deny` 时抛错。`ask` 时插件自行调用 `ctx.permission.assert({ action: "shell", resources, metadata: { safetyPolicy } })`，不传 `save` 和 `source`。
  - `execute.after`：清理该 callID 的标记。
  - 失败关闭：`parseOptions`、`RuleProvider.get()` 或 analyze 抛错时，`setup` 不能抛出（否则插件不加载，命令无防护），而是照常注册 hook，除 `off` 模式外拒绝所有工具调用（设计 5.2），reason 带上错误信息。
  - `fake-context.ts`：记录 hook 回调，用 `Map` 模拟 storage，记录 `permission.assert` 调用，不依赖 OpenCode 运行时。
- 验证：`bun test test/plugin.test.ts`
- commit：`feat: add tool execute.before guard`

### P0-10 evaluate Hook 与基础自保护

- 设计：2、4.2 最后一行（防自篡改）、5.1 注释
- 产出：`src/hooks/permission.ts`、`src/rules/self-protect.ts`（基础版），扩展 `src/analyzer.ts`、`src/policy.ts`、`src/unwrapper.ts`（`Atom.localCommands`），`test/self-protect.test.ts`，`test/plugin.test.ts` 补充用例
- 要点：
  - `action: "shell"`：已是 `deny` 的不改。直调时按 `source.id` 命中标记；Code Mode 嵌套时按 `sessionID` 加“resources 都是标记命令的子串”命中。命中后设 `effect = "ask"`，并写入 `message`。带 `metadata.safetyPolicy` 的插件自发请求同样锁定 `ask`。
  - `edit`：resources 规范化后命中受保护路径时 `deny`。`read`、`external_directory` 不做自保护（读取限制见 P2-1）。
  - shell 自保护：本机原子命令的输出重定向目标、参数或工作目录落在受保护路径内，且命令不在只读白名单时 `deny`（`self-protect`）；`rm`/`rmdir`/`mv` 作用于固定受保护路径的上级目录时同样 `deny`。
  - 受保护路径：插件包目录、`/etc/opencode/`（macOS 为 `/Library/Application Support/opencode/`）、`OPENCODE_CONFIG_DIR`（默认 `~/.config/opencode/`）、`OPENCODE_CONFIG`、任意 `opencode.json`/`opencode.jsonc` 与 `.opencode/`（豁免 `~/.opencode/plan/`）、`rulesFile`。
  - 自保护在 `strict`/`relaxed` 下总是生效，`off` 模式下受 `alwaysProtectSelf`（默认 `true`）控制。
  - 测试覆盖：模拟 saved 规则已给出 `allow`，evaluate 仍把被标记的命令改成 `ask`。
- 验证：`bun test test/self-protect.test.ts test/plugin.test.ts`
- commit：`feat: add permission evaluate hook`

### P0-11 Server 入口与 RPC

- 设计：5.2、5.3、6
- 产出：`index.ts`、`rpc.ts`（P0 只有 `status`、`setMode`）、`src/rpc-handlers.ts`，`package.json` 增加 `./rpc` 导出
- 要点：
  - `setup` 依次：解析 options → 构建规则引擎 → 注册 hooks 与 RPC。注册挂在插件 scope 上，卸载时由 OpenCode 注销。P0 没有需要 `Cleanup` 释放的资源，不返回 `Cleanup`。
  - RPC `id` 为 `opencode-safety-policy`，契约用 JSON Schema。`status` 返回 `mode`、`source`、`locked`，TTL 生效时带 `expiresAt`。`setMode` 输入 `mode` 与可选 `ttlMs`，返回切换后的状态。
  - `setMode` 在 LOCK 生效时返回声明的 `locked` 错误（带锁定的 `mode`），不抛异常。
- 验证：`plugin.test.ts` 覆盖 setup → hook → RPC 全过程；`bunx tsc --noEmit`
- commit：`feat: wire server plugin entry and rpc`

### P0-12 TUI 入口

- 设计：5.3
- 产出：`tui.ts`
- 要点：用 `keymap.layer` 注册 `/safety`，支持 `status`、`strict`、`relaxed`、`off` 和 `--ttl`（单位 `s`、`m`、`h`）；调用 RPC，用 Toast 展示结果；LOCK 拒绝时展示原因。监听 `permission.asked`，对本插件强制的审批弹 Toast 展示规则原因。
- 验证：`test/tui.test.ts` 用模拟的 TUI Context 覆盖参数解析、Toast 和审批原因；`bunx tsc --noEmit`；真实 TUI 行为放到 P0-E2E 手测
- commit：`feat: add tui safety command`

### P0-E2E

在隔离环境中用 mock LLM 逐项验证（驱动方式见第 4 节），失败项先修复（`fix:` commit）再重测。除 Desktop/Web App 一项外，各项已由 `test/e2e/server.test.ts` 和 `test/e2e/tui.test.ts` 自动化。

- [x] 本机 `rm -rf /data`、`shell({ workdir: "/", command: "rm -rf etc" })`、`kubectl delete`、`docker stop`、`opencode_worktree_remove(force: true)` 被拦截
- [x] `/tmp` 下的常规 `rm` 只弹一次内置审批，直调和 `full_codemode` 两种场景都要测
- [x] Desktop/Web App 的审批弹窗显示规则原因（HTTP API 返回的审批带 `message`，前端 `session-permission-dock.tsx` 渲染该字段，未在浏览器中实测）
- [x] TUI 中被强制审批时，弹 Toast 显示规则原因
- [x] 点 `Always` 后再次执行同一命令，仍弹窗
- [x] Code Mode 中被拒绝的调用不会执行，即使沙箱代码 `try/catch` 了错误
- [x] `ssh host "kubectl delete ..."`、`ssh sw "nv config apply"` 被拦截
- [x] `/safety relaxed --ttl 1m` 生效，到期自动回落
- [x] `/safety status` 的结果跨重启、跨 Session、跨多个工作目录一致
- [x] 全程没有 `session_inbox` 残留，没有幽灵 LLM 回合
- [x] 设置 `OPENCODE_SAFETY_LOCK_MODE` 后，`/safety off` 被拒绝

全部通过后，可打本地 tag `v0.1.0`（不 push）。

---

## 8. P1：深化 CommandAnalyzer

### P1-1 Opaque / 混淆检测与其余 wrapper

- 设计：3.1 Stage 1、Stage 2、Stage 3
- 产出：扩展 tokenizer、unwrapper、analyzer 及其测试
- 要点：
  - 检测动态命令名、函数封装、`eval`、`base64 -d | sh`、`$'\x..'`。
  - 补充 wrapper：`find -exec/-delete`、`ansible -m shell/command/raw`、`pdsh`、`pssh`、`clush`、`nerdctl/crictl/podman exec`、`chroot`、`flock`、`watch`、`parallel`（`nice`、`xargs`、`su -c` 等常见 wrapper 已在 P0-8 完成）。
  - 参数位置的 brace 展开（`rm -rf {/etc,/tmp}`）目前只记为 expanded，规则看到的仍是原文，需展开后再匹配。
  - 只覆盖内置 `ShellParse.scan` 能解析的形态。scan 判为 opaque 的命令，内置 shell 已经会失败。
- commit：`feat: detect opaque and obfuscated commands`

### P1-2 SSH heredoc、管道与重定向

- 设计：3.2（后六行）
- 要点：heredoc / here-string 喂给 shell 与 `ssh` 的正文已在 P0-8 递归分析；本地脚本经 `<` 重定向时读入并扫描；上游为静态文本时解析内容；动态上游标记 `opaqueRemoteStdin`；远端未知脚本标记 `unknownRemoteCommand`。
- commit：`feat: analyze ssh heredoc, pipe and redirect input`

### P1-3 HTTP 提取与受保护端点

- 设计：3.1 Stage 3.5、4.2（oob-redfish、ib-ufm）、7（`protectedEndpoints`）
- 产出：`src/http-extractor.ts`、matcher 的 `http` 支持、`oob-redfish.json` 与 `ib-ufm.json` 的 HTTP 规则、`test/http-script.test.ts`
- 要点：
  - 支持 `-X POST`、`-XPOST`、`--request=DELETE`、`-T`，以及 `-d`/`--json`/`-F` 隐含的 POST。
  - 遇到 `-K` 且配置文件无法解析时，按 opaque 处理。
  - 手写 IPv4/IPv6 CIDR 与主机名匹配，不引入依赖。
  - `script-scanner.ts` 补充受保护端点 + 写动作关键字的预扫（Stage 3.5）。
- commit：`feat: extract http write requests from curl and wget`

### P1-4 webfetch 与 Code Mode fetch

- 设计：4.2 最后一行、5.1（fetch 行）
- 要点：evaluate 处理 `action: "webfetch"`。目标是受保护端点且 method 不是 `GET`/`HEAD` 时 `deny`，重定向复检同样处理。method 的取值字段以 S9 的记录为准。
- commit：`feat: block protected endpoint writes via fetch`

### P1-5 脚本预扫与 TOCTOU

- 设计：3.1 Stage 2（TOCTOU）、Stage 3.5
- 产出：`src/script-scanner.ts`，`test/http-script.test.ts` 补充用例
- 要点：
  - `bash x.sh` 等 shell 脚本参数复用 P1-2 的读取与递归分析。`source`/`.` 与 `./x.sh` 不读文件，只做先写后执行检测。
  - 预扫 python/perl/ruby/node 的内联代码、heredoc 程序、`< x.py` 与脚本参数：调用进程 API 时字符串字面量与字面量列表按 shell 命令分析，文件删除 API 映射为 `rm`。预扫命令只按规则判定。
  - 可读脚本正文未命中规则时，strict 下 ask，relaxed 下放行。P1-2 的 `bash < x.sh` 在 relaxed 下同步改为放行。
  - 脚本路径运行期才确定、脚本不存在，或同一条命令先写后执行时，按 opaque fail-closed，并分析内联写入的正文。
  - 端点 + 写动作关键字的预扫依赖 HTTP 规则，放到 P1-3。
- commit：`feat: prescan inline and local scripts`

### P1-6 /safety test 与 CLI

- 设计：5.3
- 产出：`rpc.ts` 新增 `test`、`src/rpc-handlers.ts`、`tui.ts` 用 Dialog 展示拆壳链与命中规则、`cli.ts`
- 要点：`safety.status` 增加最近拦截统计（从 P0 推迟）。插件实例按 Location 隔离，需先确定计数存放位置。
- 验证：`bun ./cli.ts test "ssh n1 \"sudo bash -c 'rm -rf /data/*'\""` 输出拆壳链，结果为 `deny`
- commit：`feat: add safety test command and cli`

### P1-E2E

- [x] P1-1、P1-2 的判定在真实 `opencode serve` 上与单元测试一致（`test/e2e/analyzer.test.ts`）
- [ ] 按[手工试用指南](./opencode-safety-policy-manual-test.md)用真实模型走一遍，本阶段新增的拦截行为已补进用例
- [ ] `bun test` 全绿，覆盖嵌套引号、heredoc、管道、Redfish/UFM 写请求和脚本预扫
- [ ] `curl -X POST https://<bmc>/redfish/v1/.../VirtualMedia.InsertMedia` 被拦截
- [ ] Code Mode `fetch` 写受保护端点被拦截，包括 307/308 重定向
- [ ] `/safety test "<cmd>"` 在 TUI 中展示拆壳链和命中规则

---

## 9. P2：加固与体验

### P2-1 自保护扩展

- 设计：1.2、4.2 最后一行（防绕过 `/safety` 与审批）
- 要点：拦截读取 `service.json`；拦截读写 OpenCode DB（含 `-wal`/`-shm` 和 `OPENCODE_DB` 指定的路径）以及 `sqlite3` 访问；拦截发往回环地址 `/api/` 的请求。
- commit：`feat: protect server credentials, database and api`

### P2-2 evaluate 的 deny 级复检

- 设计：2（可选复检）、1.2（其他插件改写命令的边界）
- 要点：`shell` 请求没有匹配到标记时，对 resources 重新分析，命中 `deny` 级规则就 `deny`。
- commit：`feat: recheck unmarked shell permission requests`

### P2-3 TUI 展示审批原因

- 设计：5.3
- 要点：`tui.ts` 订阅 `permission.asked`，`message` 以 `[safety-policy:` 开头时弹 Toast。S8 失败时按回退方案处理。
- commit：`feat: show safety reason toast on permission asked`

### P2-4 审计日志

- 设计：6（`audit.ts`）、7（`auditLogPath`）
- 要点：输出 JSONL，每次 `deny`/`ask` 记一条。写入失败不影响决策。
- commit：`feat: add jsonl audit log`

### P2-5 可选服务端 /safety（默认关闭）

- 设计：5.3 第 2 点
- 产出：`src/command.ts`、`src/hooks/session-filter.ts`
- 要点：只在 `enableServerSlashCommand: true` 时注册。
- commit：`feat: add optional server-side safety command`

### P2-E2E

- [ ] 按[手工试用指南](./opencode-safety-policy-manual-test.md)用真实模型走一遍，本阶段新增的拦截行为已补进用例
- [ ] `cat ~/.config/opencode/service.json`、`sqlite3 <db> ...`、`curl http://127.0.0.1:<port>/api/rpc/...` 被拦截
- [ ] TUI 中，插件强制的审批会弹出原因 Toast
- [ ] 审计日志字段完整，日志路径不可写时插件仍正常工作

---

## 10. 发布：文档与分发

### R-1 README

- 设计：8、9 阶段 4
- 内容：本机安装、私有 npm 发布、`/etc/opencode/safety-policy/` 托管与 `policies` 配置、离线安装、规则扩展方法、1.2 中的安全边界说明。
- commit：`docs: add installation and usage guide`

### R-2 系统级部署验证（容器或 VM，不在共享机上做）

- [ ] 按设计 8 第 2 点部署，`options` 正常注入
- [ ] `plugin.use` 白名单拦截项目中同 ID 的空壳插件
- [ ] 项目配置 `"plugins": ["-*"]` 无法卸载本插件
- [ ] 核实设计 8 的推断：插件同时出现在自动发现目录和显式配置中时，确实报 `Duplicate plugin ID`
- [ ] `/etc/profile.d` 中导出 `OPENCODE_SAFETY_LOCK_MODE` 后生效
- 发现与设计不符时，修改设计文档：`docs: correct system deployment notes`

### R-3 打包

- `npm pack --dry-run` 检查 `files` 列表；在干净环境用 tarball 离线安装并加载成功；`npm publish --dry-run` 检查私有源配置。
- commit：`chore: prepare package for publishing`

---

## 11. 测试策略

| 层级 | 覆盖内容 | 手段 |
|---|---|---|
| 单元测试 | tokenizer、unwrapper、path-util、http-extractor、script-scanner、模式矩阵 | `bun test`，纯函数输入输出 |
| 规则回归 | 全部 `rules/*.json` 的 `examples` | `rules-examples.test.ts` 自动遍历，新增规则不用写测试代码 |
| 插件集成 | hook 编排、标记匹配、setup/cleanup、RPC | `fake-context.ts`。只验证插件自身逻辑，不能代替真实 OpenCode 行为 |
| 真实行为 | OpenCode 的审批、Code Mode、TUI、storage | Spike + 各阶段 E2E 清单，可自动化的项放进 `test/e2e/`（`bun run test:e2e`） |
| 手工试用 | 真实模型下的拦截、审批与模式切换 | [手工试用指南](./opencode-safety-policy-manual-test.md)，在各阶段 E2E 和升级 OpenCode 后执行 |

- 每次升级 OpenCode 版本：重跑 `bun run test:e2e` 和 Spike S3–S9，并按手工试用指南走一遍，通过后再放宽 `peerDependencies`。
- 不写只验证常量、默认值或类型的测试。

## 12. 待决事项

| 事项 | 需在何时决定 | 现状 |
|---|---|---|
| 包名 | P0-1 之前 | 已定：`@daocloud/opencode-safety-policy` |
| 私有 npm 源地址与发布权限 | R-3 之前 | 未定 |
| 系统级部署验证用的容器/VM | R-2 之前 | 未定 |

## 13. 进度清单

- [x] D0 文档入库
- [x] S Spike（S1–S9）
- [x] P0-1 包脚手架
- [x] P0-2 Tokenizer
- [x] P0-3 Unwrapper
- [x] P0-4 路径规范化
- [x] P0-5 规则引擎
- [x] P0-6 内置规则
- [x] P0-7 配置与模式状态
- [x] P0-8 Analyzer 与 SSH 策略
- [x] P0-9 execute.before Hook
- [x] P0-10 evaluate Hook 与基础自保护
- [x] P0-11 Server 入口与 RPC
- [x] P0-12 TUI 入口
- [x] P0-E2E
- [x] P1-1 Opaque / 混淆检测
- [x] P1-2 SSH heredoc、管道与重定向
- [ ] P1-3 HTTP 提取与受保护端点
- [ ] P1-4 webfetch 与 Code Mode fetch
- [ ] P1-5 脚本预扫与 TOCTOU
- [ ] P1-6 /safety test 与 CLI
- [ ] P1-E2E
- [ ] P2-1 自保护扩展
- [ ] P2-2 evaluate 的 deny 级复检
- [ ] P2-3 TUI 展示审批原因
- [ ] P2-4 审计日志
- [ ] P2-5 可选服务端 /safety
- [ ] P2-E2E
- [ ] R-1 README
- [ ] R-2 系统级部署验证
- [ ] R-3 打包
