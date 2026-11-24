# OpenCode 安全策略插件（`opencode-safety-policy`）设计方案

## 0. 方案速览

### 0.1 运行模式
共提供 **3 种全局运行模式**（跨 Session、跨项目、重启持久化，通过 TUI `/safety` 切换，不暴露为 LLM Tool），支持 `--ttl` 临时降级到期自动回落及 `OPENCODE_SAFETY_LOCK_MODE` 环境变量硬锁定（同用户进程可经本机 Server API 调用 RPC，因此**只有环境变量锁定才是"Agent 无法关闭防护"的硬保证**，详见 [1.2](#12-非目标与安全边界)）：
- **`strict`（严格，默认）**：面向日常生产运维，致命与高危操作直接拒绝（`deny`），中危本机清理与未知远端命令弹窗确认（`ask`），纯只读巡检直接放行（`allow`）。
- **`relaxed`（宽松）**：面向排障/变更窗口，仅硬阻断致命破坏操作，高危操作降级为弹窗确认，常见本机清理与一般 SSH 命令放行。
- **`off`（关闭）**：临时放行所有命令（默认 `alwaysProtectSelf: true`，仍阻止 Agent 篡改插件与安全配置）。

### 0.2 覆盖的目标机器与环境（6 类）
无论在本机直接执行，还是经 `ssh` / `sshpass` / `pdsh` / `pssh` / `clush` / `ansible` / `sudo` / `bash -c` / `kubectl exec` / `docker exec` 多层封装，抑或经 `curl` / `wget` / `http` / 内联脚本 / Code Mode `fetch` 调用 API，均统一覆盖：
1. **本机 / 跳板机 / 通用 Linux GPU 服务器**
2. **Kubernetes 集群与容器运行时**（Docker / containerd / nerdctl / crictl / podman / Helm / etcd）
3. **NVIDIA Spectrum 以太网交换机**（Cumulus Linux：NVUE / NCLU / `switchd` / ONIE）
4. **NVIDIA InfiniBand 交换机与主机侧 IB/GPU 节点**（NVOS / MLNX-OS、`ibportstate` / `mlxconfig` / `flint` / `opensm` / `nvidia-smi`）
5. **NVIDIA UFM 管理平台**（`ufmd` 服务与 `/ufmRest/` REST API）
6. **服务器带外管理平面**（BMC / Redfish / IPMI / NICo，支持按 CIDR 与 VIP 配置 `protectedEndpoints`）

### 0.3 重点拦截的操作类别（7 类）
1. **云原生与容器破坏**：`kubectl delete`/`drain`/`cordon`/`taint`/`scale --replicas=0`、`helm uninstall`、`etcdctl del`、`docker`/`nerdctl`/`crictl` 的 `stop`/`rm`/`rmi`/`prune`。
2. **Linux 文件、磁盘与系统服务**：高危 `rm -rf`、远端 `rm`、`shred`、`find -delete`、`mkfs`/`dd`/`wipefs`/`fdisk`/`lvremove`/`zfs destroy`、`reboot`/`shutdown`/`poweroff`、`systemctl stop/disable/mask`。
3. **Spectrum 交换机（Cumulus）配置变更与重装**：`nv set/unset/config apply/replace/action reboot/reset`、`net add/del/commit`、`ifreload -a`、停重启 `switchd`、`onie-select`、修改 `/etc/network/interfaces` 与 `/etc/nvue.d/`。
4. **IB 交换机 & UFM 破坏操作**：交换机 `reload`/`reset factory`/`shutdown`/`no interface`/`configuration delete`/`image boot`，主机侧 `ibportstate disable/reset`、`mlxconfig set`、`flint`/`mstfwreset`、`nvidia-smi --gpu-reset`，停服 `ufmd` 及 `/ufmRest/` 非 `GET` 写请求。
5. **带外管理（Redfish / IPMI / NICo）防重装机与断电**：`ipmitool power off/reset/cycle`、`chassis bootdev pxe/cdrom`、`mc reset`、`raw`；Redfish 非 `GET` 写请求（`ComputerSystem.Reset`、`VirtualMedia.InsertMedia/EjectMedia`、`PATCH BootSourceOverrideTarget`、`Manager.Reset`、`UpdateService.SimpleUpdate`）及发往 `protectedEndpoints` 的写请求。
6. **通用网络与数据库破坏**：网卡下线、清空路由/防火墙（`ip link set down`、`ip route/addr flush`、`iptables -F`、`nft flush`）、`rsync --delete`、数据库 `DROP`/`TRUNCATE`/`FLUSHALL`。
7. **绕过形态与防自篡改**：SSH 管道/重定向/heredoc 喂脚本、`base64 -d | sh`、`eval`、动态命令名、本地脚本先写后执行（TOCTOU）、Code Mode `fetch` 重定向写受保护端点，以及修改安全插件、`opencode.json`、`rulesFile`，读取 `service.json` Server 密码、直接改写 OpenCode 数据库或调用本机 OpenCode Server API。

> 各模式下的 `deny` / `ask` / `allow` 详细对照见 [5.1 三种模式的行为矩阵](#51-三种模式的行为矩阵)。

---

## 1. 背景与目标

### 1.1 解决的问题
在使用 OpenCode 执行日常运维、集群排障和基础设施集成（如 `infra-integrate` 中的 K8s 集群、GPU 节点、BMC/NICo、网络与存储管理）时，AI Agent 既可能在本机执行命令，也可能通过 `ssh` / `ansible` / `kubectl exec` 等方式登录到远端节点执行命令。需要一套可独立维护、可统一分发的 OpenCode Server Plugin，用来：

1. **拦截高危破坏性命令**：防止误执行云原生（`kubectl delete`、`helm uninstall`、`docker stop/rm` 等）、Linux 主机（`rm -rf`、`mkfs`、`dd`、`reboot` 等）、网络与交换机（NVIDIA Spectrum/Cumulus Linux、NVIDIA InfiniBand/NVOS/MLNX-OS、UFM）以及主机带外管理（Redfish/BMC/IPMI/NICo 重装机、挂载 ISO、电源重置等）高危操作。
2. **穿透远程、嵌套与 HTTP API 执行**：识别 Agent 通过 `ssh`、`sudo`、`bash -c`、`kubectl exec`、`docker exec`、`ansible` 等多层封装发往本机或远端的实际命令，识别通过管道/重定向/heredoc 向 `ssh` 喂脚本的场景，并解析通过 `curl`/`wget`/`httpie` 或内联/本地脚本发往 Redfish / UFM / NICo 等管理端点的写请求。
3. **支持全局运行时模式切换**：支持在 `strict`（严格）/ `relaxed`（宽松）/ `off`（关闭）三种模式间快速切换，并支持跨 Session 持久化与可选 TTL 自动回落。
4. **易于人工扩展与工程化分发**：规则采用声明式 `rules/*.json`（自带 `examples` 自动回归测试）并支持通过 `rulesFile` 外挂规则文件，无需改动代码即可增删规则；源码落在独立仓库 `DaoCloud/opencode-safety-policy` 根目录，支持私有 npm 源分发、离线交付以及系统级托管配置（`/etc/opencode/safety-policy/` + `/etc/opencode/opencode.json`）。

### 1.2 非目标与安全边界
- **定位：防误操作护栏，而非强安全边界**。Agent 与 OpenCode Server 以同一 OS 用户运行，理论上可以读写该用户可访问的一切文件与本机端口。本插件的目标是拦截 Agent 的误操作和常见绕过形态，不承诺抵御刻意对抗的 Agent。硬底线依赖 `OPENCODE_SAFETY_LOCK_MODE`、OS 用户隔离与远端最小权限凭据。
- 本插件是**客户端/Agent 执行前防线**，不替代远端主机或带外管理平面的 RBAC、sudoers、SSH 最小权限或只读凭据（生产环境建议同时给 Agent 分配 Redfish / UFM / NICo / Kubeconfig 只读账号作为硬底线）。
- **用户手动 `!cmd` 边界**：OpenCode 中用户在 TUI 直接输入的 `!cmd`（`packages/core/src/session/shell.ts`）直接调用 `shell.create()`，不经过 `tool.hook("execute.before")` 与 `permission.assert`（只会触发 `shell.hook("create.before")`），属于用户主动执行，不在 AI Agent 拦截范围内。
- **本机 Server API 边界**：插件 RPC（`ctx.rpc.register`）与 `permission.reply`、`permission.saved.update` 等接口都通过本机 OpenCode Server HTTP API 暴露，RPC handler 无法识别调用者身份。service 模式下 Server 密码保存在 `~/.config/opencode/service.json`（`0600`，但与 Agent 同用户可读）；模式状态与已保存权限存放在 OpenCode SQLite 数据库（`~/.local/share/opencode/opencode*.db`，可由 `OPENCODE_DB` 覆盖）。Agent 理论上可以读取密码后 `curl` 调用 `safety.setMode` 或代替用户回复审批，也可以直接改写数据库。插件通过防自篡改规则拦截这些路径与本机 Server 端点的常见访问形态（见 [4.2](#42-规则分类明细)），但无法覆盖所有动态构造的访问。需要硬保证时使用 `OPENCODE_SAFETY_LOCK_MODE`：它在 Server 进程启动时读入，`safety.setMode` 在锁定时直接拒绝。
- **自保护覆盖边界**：shell 自保护只检查静态可见的路径。解释器内联代码与脚本文件中的写入（`python -c "open('opencode.json','w')"`、`node x.js`）不在覆盖范围内；递归删除包含 `.opencode/` 的项目目录（如 `rm -rf .`）不视为自篡改；不在只读白名单中的读取命令（如 `jq . opencode.json`）也会被拒绝，可通过 `sshReadOnlyAllowlist` 放行（该白名单同时作用于远端）。
- **`Unattended` 自动审批边界**：OpenCode 的 `Unattended` 自动审批在 `permission.hook("evaluate")` **之后**执行（`packages/core/src/permission.ts`），且仅会覆写 `"ask"`、不会覆写 `"deny"`。因此凡在无人值守/自动审批模式下**绝不允许自动放行**的高危规则，必须配置为 `deny` 而非依赖 `ask`。
- **Code Mode 拒批可被捕获边界**：Code Mode 默认开启（只要 `execute` 工具未被整体 deny）。所有经 Code Mode `execute` 发起的嵌套工具调用，其错误都会被 `CodeModeTool.create`（`packages/core/src/codemode/tool.ts`）统一转换为 `ToolFailure` 抛回沙箱 JS VM。Promise 插件在 `execute.before` 中抛出的拒绝已被包装为 `Tool.Error`，因此同样会被转换，沙箱代码可以用 `try/catch` 捕获后继续执行下一条语句，当前 step 不会因拒批而终止。受影响范围包括 MCP 工具、`opencode_worktree_remove` 等默认运行在 Code Mode 中的工具，以及启用 `full_codemode` 后的 `shell`（未启用时 `shell` 为直调）。直调时插件抛出的拒绝同样只作为工具错误返回给模型，step 不会结束，模型可以继续发起下一次调用（见附录 A 的 S3）；只有用户在审批弹窗中不带反馈地拒绝（`Permission.DeclinedError`）才会结束 step。每个嵌套调用仍会单独经过 `execute.before` 与 `permission.hook("evaluate")`，被拒绝的调用本身不会执行，但高危操作必须坚持 `deny`，不能依赖"拒批后终止整步"。
- **`permission.hook("evaluate")` 的 `save` 边界**：`permission.hook("evaluate")` 仅允许修改 `event.effect` 与 `event.message`，无法清空上游内置工具（如 `webfetch`、`edit`、`patch`、`CodeModeBun`、`shell`）自带的 `save`。因此本插件对经 `permission.hook("evaluate")` 拦截的受保护端点写请求优先设为 `deny`，避免在弹窗点击 `Always` 时将 `webfetch: *` 等写入持久化白名单。对内置 `shell` 请求，本插件每次都在 hook 中强制 `ask`，已保存的规则无法绕过插件判定（见 [2](#2-总体架构)）。
- **其他插件改写命令边界**：`shell.hook("create.before")` 在内置 `shell` 的 `permission.assert` **之前**触发，且可以改写 `command`/`cwd`。其他插件可能在本插件 `execute.before` 检查之后改写命令。这属于插件供应链信任问题，通过 `ManagedPolicy` 的 `plugin.use` 白名单限制可加载插件（见 [8](#8-分发与部署方案适配-infra-integrate-场景)）。
- 对于远端主机上**预先存在且内容不可见**的脚本（如 `ssh host /opt/cleanup.sh`）或**从公网实时下载执行**的流（如 `curl ... | ssh host sh`），插件无法静态知道内部指令，但可通过策略对这类高风险形态执行 **fail-closed（默认 `deny` 或强制 `ask` 人工审批）**。
- 对于通过脚本刻意混淆、动态拼接 URL/IP 调用 Redfish/UFM API 的对抗性绕过，纯静态预扫无法做到 100% 拦截，需配合管理网段隔离与最小权限凭据共同兜底。
- **运行期值拼入再解析脚本的边界**：变量、`xargs -I`/`find -exec` 的 `{}` 与 `parallel` 未知输入拼入会被 shell 再次解析的文本（`bash -c "echo $X"`、`eval echo $X`、`ssh host "ls $X"`、`xargs -I{} sh -c 'echo {}'`）时，只按一个变量操作数判定，值中的 `;`、`$(...)` 等元字符被再次解析后执行的命令不可见。全部按 opaque 处理会误拦大量常见用法，这类刻意构造的注入属于上文的对抗性绕过。

---

## 2. 总体架构

基于 OpenCode 多入口插件规范（Server Promise API：`@opencode/plugin`、TUI：`@opencode/plugin/tui`、RPC：`./rpc`）构建，采用 **`execute.before` 主决策（deny）+ `evaluate` 强制审批（ask）+ TUI/RPC 零副作用交互 + 全局状态持久化**架构：

```text
                    用户交互层（不暴露为 LLM Tool）
                    TUI 插件（./tui）注册 /safety -> 调用 Server 插件 RPC（./rpc）
                    -> ui.toast / ui.dialog 即时反馈（不写 session_inbox，零 LLM 副作用）
                    -> 监听 permission.asked，对本插件强制的审批弹 Toast 展示原因
                                          │
                                          ▼
                            ┌──────────────────────────┐
                            │   PolicyStateManager     │
                            │  (ctx.storage 全局 KV，   │
                            │   每次决策读取 + 短缓存 + │
                            │   opencode.json options + │
                            │   rulesFile mtime 重载 +  │
                            │   环境变量锁定 + TTL)     │
                            └─────────────┬────────────┘
                                          │ 当前生效模式 & 合并后规则集
             ┌────────────────────────────┴────────────────────────────┐
             ▼                                                         ▼
┌─────────────────────────────────────┐         ┌─────────────────────────────────────┐
│ Hook 1: tool.hook("execute.before") │         │ Hook 2: permission.hook("evaluate") │
│ 作用：工具调用主决策点               │         │ 作用：强制审批 & 底层权限兜底         │
│                                     │         │                                     │
│ • 读 shell 的 input.command +       │         │ • action === "shell"：匹配到已标记   │
│   input.workdir -> 算 effectiveCwd  │         │   调用时强制 effect = "ask" 并写入   │
│ • 词法切分/拆壳/相对路径展开/HTTP/脚本│         │   message（无视已保存的 Always 规则，│
│ • 命中 deny -> throw 转为 Tool.Error │         │   绝不覆写 deny）                    │
│ • shell 命中 ask -> 登记标记          │         │ • action === "webfetch"：受保护端点   │
│   （callID + sessionID + 原始命令），  │         │   非 GET/HEAD 写请求与重定向默认 deny │
│   交给内置 shell 审批弹窗             │         │ • edit/external_directory/read：     │
│ • 非 shell 工具（opencode_worktree_  │         │   nearestExistingAncestor realpath + │
│   remove/MCP）命中 ask -> 主动 assert │         │   拼接剩余相对路径段，防符号链接绕过   │
└──────────────────┬──────────────────┘         └──────────────────┬──────────────────┘
                   │                                               │
                   └───────────────────────┬───────────────────────┘
                                           ▼
                            ┌──────────────────────────┐
                            │   CommandAnalyzer &      │
                            │      RuleEngine          │
                            │ 1. 归一化 & Shell 切分    │
                            │ 2. Wrapper 递归拆壳       │
                            │ 3. workdir/HTTP/脚本预扫  │
                            │ 4. 声明式规则匹配与决策    │
                            └─────────────┬────────────┘
                                          ▼
                            ┌──────────────────────────┐
                            │    AuditLogger（可选）     │
                            │ 记录拦截/放行/模式切换日志  │
                            └──────────────────────────┘
```

### 为什么这样分工（关键源码约束）？
| Hook / 入口 | OpenCode 真实语义 | 本插件中的职责与原因 |
|---|---|---|
| `tool.hook("execute.before")` + `tool.hook("execute.after")` | `execute.before` 是唯一可失败的 hook（`permission`/`shell`/`session` hook 均为 `NoFailures`），入参为 `{ tool, sessionID, agent, messageID, id, input }`，能拿到原始完整 `input.command` 与 `input.workdir`。`tool` 是注册 ID（`effectiveName`），带 namespace 的工具形如 `opencode_worktree_remove`。<br>抛出的错误经 Promise adapter 包装为 `Tool.Error`（模型看到 `type: "unknown"` 与错误信息）：直调时作为工具错误结果返回，step 不结束（`model-request` 只在其中带有 `Permission.DeclinedError` 时才结束 step）；Code Mode 嵌套调用则转为 `ToolFailure`（见 [1.2](#12-非目标与安全边界)）。<br>内置 `shell` 在 `prepare` 中先执行 `ShellParse.scan`：结果为 opaque 时直接失败、不执行命令；解析出命令时发起 `permission.assert({ action: "shell", resources: 各子命令原文切片, save: scan 生成的前缀模式, source: { type: "tool", messageID, id } })`。<br>Code Mode 嵌套调用会分配新的 callID，`permission.nested` 会把其权限请求的 `source.id` 重映射为父 `execute` 的 callID。 | **收口所有 `deny` 决策，并为 `shell` 的 `ask` 打标记**。<br>1) 解析 `effectiveCwd = resolveCanonicalPath(input.workdir ?? ctx.location.directory)`，先对相对路径参数展开再匹配规则，杜绝 `shell({ workdir: "/", command: "rm -rf etc" })` 或 `workdir` 切入插件目录的绕过；<br>2) 命中 `deny`：直接 throw，拒绝原因写入错误信息；<br>3) `shell` 命中 `ask`：**不自行发起审批**，只在进程内登记标记 `{ sessionID, callID: input.id, command, ruleId, reason }`，由 Hook 2 把随后的内置 shell 审批强制为 `ask`。这样只有一次弹窗，不需要单次消费令牌，也不必复刻 `ShellParse.scan` 的资源格式。标记在 `execute.after` 或短 TTL（如 60s）后清理；内置 shell 未解析出任何命令时不会发起审批，此时输入中也没有可执行命令，无需兜底；<br>4) 非 shell 工具（`opencode_worktree_remove`、MCP 写操作等）命中 `ask`：主动调用 `ctx.permission.assert({ sessionID, agent, action: "shell", resources: ["[safety-policy:<ruleId>] <reason>", "$ <tool> <参数摘要>"], metadata: { safetyPolicy: true } })`。**不传 `save`**，避免 `Always` 写入永久规则；**不传 `source`**，因为 TUI 对无 `source` 的 shell 请求会逐行渲染 `resources`，而自定义 action 会退化为盲批 `Tool: <action>`。这类工具内部若再发起自身审批，最多多一次确认，不做去重。 |
| `permission.hook("evaluate")` | 统一拦截所有底层权限请求（含内置工具与 Code Mode `execute` 内注入的 `fetch` / `Bun` 文件 API）。执行顺序：配置中的 `deny` 在 hook **之前**短路（hook 看不到）；随后合并已保存规则（`Always`）得出 `allow`/`ask`，再触发 hook，hook 可改写 `effect` 与 `message`；最后 `Unattended` 只处理 `ask`。<br>事件字段为 `sessionID`、`agent`、`action`、`resources`、`metadata`、`source`、`effect`、`message`，**没有 `id` 字段**，与工具调用关联只能用 `source?.id`。<br>Code Mode `fetch` 重定向走 `assertNotDenied`（仅阻断 `deny`，会静默放行 `ask`）；`FileAccess.resolve` 对工作区内路径生成相对路径、工作区外不做 `realpath`、目录检查为 `<dir>/*`；本 Hook 无法剥离上游自带的 `save`。<br>TUI 权限弹窗不渲染 `message`（Desktop/Web App 会渲染）。 | 专注四件事：<br>1) **强制审批 shell**：`action === "shell"` 时查找 Hook 1 的标记。直调场景按 `event.source?.id === callID` 精确匹配；Code Mode 嵌套场景（`full_codemode`）下 `source.id` 已被重映射为父 `execute` callID，改为按 `sessionID` 相同且每条 `resources` 都是标记命令原文的子串来匹配。命中后设 `event.effect = "ask"`、`event.message = "[safety-policy:<ruleId>] <reason>"`。由于 hook 在合并已保存规则之后执行，用户之前点 `Always` 保存的 `ssh *` 等规则无法跳过该弹窗；`Always` 只会影响插件判定为 `allow` 的命令。子串匹配的误匹配只会多弹一次窗，不会漏拦。对 `metadata.safetyPolicy === true` 的插件自发请求同样锁定 `ask`；<br>2) 可选加固：对未匹配标记的 `shell` 请求，用规则引擎逐条复检 `resources`，命中 `deny` 级规则直接设为 `deny`，兜底其他插件在 `shell.hook("create.before")` 中改写命令；<br>3) 拦截 `action === "webfetch"`（`event.metadata?.method` + URL + `metadata?.redirectedFrom`；注意重定向跳点的 `method` 取自原始请求），对发往 Redfish/UFM/NICo/`protectedEndpoints`/本机 OpenCode Server 的非 `GET`/`HEAD` 写请求（含任意重定向跳点）优先设为 **`"deny"`**，同时规避 `assertNotDenied` 静默放行、`save: ["*"]` 污染与 `Unattended` 自动放行；<br>4) 拦截 `action === "edit"`（`write`/`edit`/`patch`、Code Mode `Bun.write`/`delete`、worktree 等所有文件写入都经此审批）：resources 以 `ctx.location.directory` 解析并按 `resolveCanonicalPath` 逐级跟随符号链接规范化（覆盖尚未创建的新文件目标），命中受保护路径（见 4.2 防自篡改）时设为 `deny`，消除相对路径与符号链接绕过。`read` 与 `external_directory` 只是读取或进入目录，不做自保护；`service.json` 与 OpenCode 数据库的读取拦截见 4.2。 |
| TUI 入口（`./tui`）+ 插件 RPC（`./rpc` + `ctx.rpc.register`） | OpenCode `Host.resolve` 原生支持同包导出 `./server`、`./tui`、`./rpc`；TUI `keymap.layer` 支持 `slash: { name: "safety", arguments: true }` 且直接走 `ui.toast.show` / `ui.dialog.alert`，完全不触碰 `session_inbox`；TUI 可通过 `ctx.client.rpc(definition)` 调用 Server RPC，并可用 `ctx.data.on("permission.asked", ...)` 订阅审批事件。RPC 经本机 Server HTTP API 暴露，handler 拿不到调用者身份。<br>TUI 入口的 `ctx.options` 不来自 `opencode.json` 的 `plugins[].options`（Server 清单只转发包路径，实测为 `{}`）。 | 作为 `/safety` 的主交互通道，彻底避免 `session.synthetic` 滞留 `session_inbox` 引发幽灵 LLM 回合、400 报错或误重置步数，并避免 TUI 自动补全出现重复 `/safety` 条目。TUI 插件监听 `permission.asked`，对 `message` 以 `[safety-policy:` 开头的请求弹 Toast 展示规则原因，弥补 TUI 弹窗不渲染 `message` 的问题。`safety.setMode` 在 `OPENCODE_SAFETY_LOCK_MODE` 生效时直接拒绝。仅在用户显式启用 `options.enableServerSlashCommand: true`（无 TUI 的纯 Desktop/Web 场景）时才降级注册服务端命令（`delivery: "steer", resume: false` + `session.hook("context" \| "compaction" \| "generate")` 过滤）。TUI 不读取 `ctx.options`，所需的模式与配置一律经 RPC 从 Server 获取。 |

> 注意：
> - **不使用** `shell.hook("create.before")` 做拦截：它声明为 `NoFailures`，抛错会导致未预期中断而非正常拒绝；它也会对用户 `!cmd` 触发，且入参中没有 `sessionID` 与调用来源，无法区分 Agent 与用户。
> - 插件**按 Location 实例化**（每个工作目录一个实例，各自执行 `setup()`）。模式状态必须在每次决策时从 `ctx.storage` 读取（可加秒级短缓存），不能只保存在内存中，否则 `/safety` 只对处理 RPC 的那个实例生效。shell 的 `ask` 标记在同一 Location 实例内产生与消费，可以只放在内存中。
> - `setup()` 中通过 `ctx` 注册的 hook 与 RPC 挂在插件 scope 上，`opencode.json` 变更触发整插件重载或卸载时由 OpenCode 自动注销。插件自己持有的资源（如审计日志句柄）才需要由 `setup()` 返回的 `Cleanup` 释放。

---

## 3. 命令解析与多层拆壳引擎（`CommandAnalyzer`）

### 3.1 四阶段处理流水线

```text
原始命令行字符串
  │
  ├─► Stage 1: Shell 词法切分、归一化与工作目录解析（Tokenizer, Normalizer & Cwd Resolver）
  │     • 解析生效工作目录 effectiveCwd = path.join(realpath(nearestExistingAncestor(workdir ?? location.directory)), relativeTail)
  │     • 按 ; / && / || / | / & / $(...) / `...` 拆分为命令段，
  │       同时保留管道上游、输入重定向（<、<<、<<<）与命令替换信息
  │     • 复合命令（{ ... }、( ... )、if/while/until/for/select）记录分组：分组前的管道与分组后的重定向
  │       （} < f、done <<<x）作用于组内每条命令，组内 $(...)、<(...) 同样读这些重定向。组外重定向先于
  │       组内管道生效（{ curl ... | bash; } < /dev/null 中 bash 仍读管道），管道右侧分组之后重定向中的
  │       $(...) 同样读该管道。time [-p] [--] [!] 与 coproc [NAME] 前缀（含 time coproc、time function）
  │       后的分组同样识别，coproc 的命令按读管道处理；for/select 循环体支持
  │       do ... done 与 { ... }，for NAME do 省略 in 列表。复制到组内的重定向累计超过 64 Ki 个 -> opaque
  │     • 命令名归一化：剥离外层引号、前导反斜杠（\rm）与路径前缀（path.basename("/usr/bin/rm") -> "rm"）
  │     • 参数中未加引号的 brace 展开按 bash 语义展开（{a,b}、/{etc,usr}、{1..10..2}、{01..10}、{a..z}，
  │       含嵌套）：累计最多 1024 个词、64 KiB 文本（展开前估算，不先生成再判断），嵌套最多 16 层，
  │       超出即按 opaque fail-closed；顶层命令行一份预算，拆壳得到的所有内层脚本共享另一份；
  │       for/select 循环头的词表不展开
  │     • 关键工具维护明确的带值全局参数表（ssh、kubectl、docker、curl），
  │       避免 --kubeconfig /path、--as admin、-o ProxyCommand=... 干扰子命令提取
  │     • 长选项缩写按各工具解析器的语义识别唯一前缀：getopt_long（sudo、env、timeout、nice、time、
  │       stdbuf、ionice、su/runuser、xargs、chroot、flock、watch 及 rm/chmod/cp 等路径敏感命令）、
  │       argparse（ansible）、optparse（pssh、clush）、Getopt::Long（GNU parallel，长选项不区分大小写，
  │       并接受 + 前缀，如 +halt、--HALT）。精确名优先，否则取表中第一个前缀匹配（真实解析器对歧义前缀
  │       直接报错，取哪个都安全），因此选项表列全无值 flag，避免 flag 被当成带值选项的前缀。getopt 的
  │       可选值参数只接受连写值（xargs -ia 中 a 为替换串、watch -dn 中 n 为 -d 的值）。kubectl、docker、
  │       podman、nerdctl、crictl 等 pflag/cobra CLI 及 flock 锁文件之后的 -c/--command 只认精确名
  │     • 对 rm/shred/chmod/chown/dd/mv/find -delete 等路径敏感命令，将相对路径参数（含 . / .. / *）
  │       基于 effectiveCwd 展开为规范绝对路径，防止 shell({ workdir: "/", command: "rm -rf etc" }) 绕过
  │     • 跟踪 cd/pushd 与 env -C、sudo -D/-i、su - 的目录切换：候选目录只增不减（cd 失败时仍留在原目录），
  │       超过 8 个时追加“未知目录”。未知目录（cd $X、cd -、登录 shell 的 home）分别按深层占位目录和 / 评估，
  │       与目录无关的 deny（如绝对路径 /etc）保持不变，仅经 / 推出的 deny 降为 ask
  │
  ├─► Stage 2: 特征、混淆与 Opaque 检测（Obfuscation & Opaque Detector）
  │     OpenCode 内置 shell 的 ShellParse.scan 遇到 OpaqueReason（command-substitution、
  │     compound-command、dynamic-command-name、部分 heredoc / dynamic-execution 等）时直接让工具失败、
  │     不执行命令；本阶段只需覆盖 scan 能解析、但语义仍无法静态判定的形态，并在 execute.before 中给出
  │     带规则原因的拒绝。识别并标记：
  │     • 动态命令名与函数封装（CMD=rm; $CMD ...、f() { ... }; f ...）-> opaque。命令名中的 glob 与
  │       brace 展开（/bin/r[m]、{rm,-rf,/}）同样视为动态；仅目录部分动态而 basename 为字面量的
  │       （"$(go env GOPATH)/bin/sudo"）按该 basename 判定
  │     • 管道或进程替换向解释器喂脚本：curl ... | bash、base64 -d | sh、cat x | ssh host sh、
  │       bash <(curl ...)、source <(...)、... | python3 -、kubectl exec -i pod -- sh 读管道等，
  │       脚本内容来自运行期数据 -> opaque（piped-script）。/dev/stdin、/dev/fd/0、/proc/self/fd/0
  │       等同 -，运行期才确定的脚本路径（bash $F）也可能是 /dev/stdin，同样按读 stdin 处理，其他
  │       描述符路径（/dev/fd/3）与进程替换 -> opaque。stdin 重定向以最后一个为准：< /dev/stdin、
  │       0</dev/fd/0、<&0 保留原 stdin，本机运行期才确定的目标（< $F、< x.s?）视为不可读的本地
  │       文件（见 3.2），远端命令中则保留原 stdin，<&- 关闭 stdin，<&N、< /dev/fd/N 视为管道输入。
  │       管道右侧命令参数中的 $(...)、<(...) 先于重定向展开，其内层命令同样读该管道（... | echo $(bash)）；输出进程替换 tee >(bash) 的内层命令按读管道处理。管道右侧
  │       为复合命令时组内每条命令都读该管道（... | { cat; bash; }、... | while read l; do bash; done），
  │       coproc bash 同理。管道左侧为字面量 echo / printf 时按静态文本处理（见 3.2）。不带命令的
  │       exec 的 stdin 重定向作用于同一脚本中的后续命令（exec < x.sh; bash），含 command / builtin /
  │       time 前缀、只带选项（exec -a name）以及 eval、source 读入的静态脚本中的 exec。这类 exec 可能
  │       位于子 shell、管道或未执行的分支，替换已有输入（管道、heredoc、文件）时后续命令的 stdin
  │       按管道输入处理
  │     • Heredoc / Here-string 喂 SSH（ssh host bash <<'EOF' ... EOF）
  │     • 本地文件重定向喂 shell 或 SSH（bash < x.sh、ssh host bash < x.sh、ssh host < x.sh）：
  │       读入文件正文按执行位置递归分析（见 3.2）
  │     • 编码/间接执行（eval、$'\x72\x6d'、xargs rm）
  │     • 同命令先写后执行 / 本地脚本 TOCTOU（cat > /tmp/run.sh <<EOF ... && bash /tmp/run.sh）：
  │       若 execute.before 阶段目标脚本尚不存在（ENOENT）或同命令内先写入再执行，
  │       除扫描内联写入正文外，一律按 opaque 走 fail-closed，绝不静默 allow
  │
  ├─► Stage 3: Wrapper 递归拆壳（Recursive Unwrapper，最大深度 8）
  │     逐层剥离外层包装器，并记录执行上下文（isRemote、targetHost、wrapperChain）：
  │     • 权限/环境包装：sudo、su -c、runuser、doas、env、timeout、nohup、nice、stdbuf、ionice、setsid、
  │       time、command、builtin、exec、eval、flock、watch、chroot（内层按根目录 / 解析相对路径，保守判定）
  │     • Shell 嵌套：sh -c、bash -c、zsh -c、dash -c；无 -c 时以 stdin（heredoc / here-string）为脚本
  │       （bash <<EOF、ssh host <<EOF、sudo -s <<EOF、su root <<EOF）
  │     • 远程执行：ssh、sshpass；批量远程 pdsh、pssh/parallel-ssh、clush、ansible ... -m shell/command/raw
  │       （含 ansible.builtin./ansible.legacy. 前缀）的远端命令按远程原子命令判定，clush -c/--copy 等拷贝模式不拆；
  │       pdsh/clush 带值参数表覆盖全部短选项及 pdsh 模块选项（-g、-X、-F、-j、-P）
  │     • ansible -a 按 ansible-core 语义解析：以 { 开头且以 } 结尾的按 JSON 对象取 cmd/argv/_raw_params，
  │       否则按 parse_kv 取 k=v（chdir、stdin、executable 等键可出现在任意位置，\= 等 Python 转义先解码）；
  │       chdir 计入工作目录，stdin 作为 here-doc 喂给远端命令；含 Jinja 模板、JSON 或转义无法解析、
  │       字段类型不符或 executable 非 shell -> opaque（dynamic-args）
  │     • 容器/集群进入：kubectl exec --、docker/nerdctl/podman/crictl exec（含全局参数如 nerdctl -n、
  │       podman --url）；podman exec -l/--cidfile 与 crictl exec --name/--pod/--label/-l 等过滤选项选中容器时，
  │       第一个位置参数起即为命令
  │     • 批处理：xargs；find ... -exec/-execdir/-ok/-okdir（{} 以占位路径代入，*dir 形态目录未知，
  │       find 本身仍保留以匹配 find -delete 规则；内层脚本中被引号包住的输入占位符，如
  │       sh -c "rm -rf '{}'"，仍视为变量操作数）；GNU parallel（::: 及 --arg-sep 自定义分隔符的取值
  │       逐个代入，::::/--arg-file-sep 文件取值视为变量操作数；-i/-e/-l 可选值参数按 Getopt::Long 语义解析：
  │       连写在 -l 后只取开头的数字，其余按新一组短选项解析（-lj 2、-l1j 2），分开写时接受单独的 -，
  │       不接受以 -、--、+ 开头的选项（-i +halt 1）；替换串在每个命令词内按 parallel 的顺序代入：先取
  │       最短的 {= perl =}（结果视为变量操作数，末尾词中未配对的 {= 保留为文本，非末尾词中未配对的 {=
  │       会与后续词合并 -> opaque），再从长到短代入 {}、{.}、{/}、{//}（同 File::Basename 的 dirname）、
  │       {/.}、{#}、{%} 及其位置形式（{1}、{-1 //}，其中空白只认 ASCII，负位置按 Perl 下标回绕一次）；
  │       ::: 取值与 stdin 都按行切分（取值中的换行拆出多个取值，空行也是一个作业，here-string 末尾自带
  │       换行）；每个作业默认一个取值，超出取值个数的位置代入空串；取值按 parallel 规则加引号（只有
  │       [-_.+/a-zA-Z0-9] 不加，空值为 ''），但首个命令词含替换串且其前文本不含空白或 = 时取值不加引号、
  │       由 shell 再解析（parallel {} ::: 'rm -rf /etc'），-q 则改为在代入后给整个词加引号；-I 与取 Perl
  │       真值的 -i/--replace（以最后一次为准）只改名 {}，其他替换串不受影响；-l/-L、-m、-X、--xargs、
  │       -n/-N 大于 1 及多个取值来源把多个取值合成一个作业，此时分别检查每个取值占满所有位置、每个取值
  │       单独一个作业（其余位置为空）、全部取值一起代入三类作业，取值不加引号时取值未知；-N 覆盖 -n，
  │       -n/-N/-L 的值是 Perl 表达式：空白视为未设置，0 不追加取值且 {} 代入空串，非数字的值可能是任意
  │       个数（含 0）；-C/--colsep、--csv、-d、-0、--trim 等拆分取值的选项及多于 64 个取值使取值未知
  │       （视为变量操作数）；代入后总长超出上限 -> opaque（too-long）；-I 空串或含 (...) 的 -I/-i、
  │       --header 及 --rpl、--parens、--plus、--bnr、--seqreplace 等改写替换串的选项 -> opaque
  │       （dynamic-args）；--wd 计入工作目录，含替换串时目录未知；-S 远程执行；--pipe/--spreadstdin
  │       喂 shell -> opaque；无命令时取值本身作为脚本，取值未知时 -> opaque）
  │     • 解释器：python/perl/ruby/node 从管道或 - 读程序、或以进程替换为脚本时 -> opaque；
  │       -c/-e 内联代码与本地脚本由 Stage 3.5 预扫
  │
  ├─► Stage 3.5: HTTP/REST 写请求提取 & 轻量脚本预扫（HttpCommandExtractor & ScriptScanner）
  │     • 对 curl / wget / http（HTTPie）提取 HTTP Method、目标 URL 与请求体片段：
  │       - 兼容 -X POST、-XPOST（连写）、--request=DELETE、-T/--upload-file，
  │         以及带 -d/--data/--data-raw/--data-binary/--json/-F 的隐式 POST；
  │       - 遇到 -K/--config（从外部配置文件读方法/URL）时，若文件不可静默解析则走 opaque fail-closed；
  │       - 对照 Redfish（/redfish/v1/）、UFM（/ufmRest/）、NICo API 及用户配置的
  │         protectedEndpoints（BMC 网段、UFM VIP、NICo VIP）做读写判定：
  │         GET 查询放行，非 GET 写操作按风险等级直接 deny 或 ask。
  │     • 对 python/python3 -c、node -e 内联代码，以及可读取的本地脚本执行
  │       （python3 foo.py / bash foo.sh）做轻量静态预扫，命中敏感路径/端点 + 写动作关键字
  │       （如 /redfish/v1/ + InsertMedia/ComputerSystem.Reset/BootSourceOverride/PATCH/POST）
  │       时按规则拦截或强制 ask；脚本尚不存在时走 TOCTOU fail-closed。
  │
  └─► Stage 4: 规则匹配与风险汇总（RuleEvaluator）
        对拆解出的所有原子命令（含内层命令、HTTP 请求结构、heredoc/脚本正文、opaque 标记）
        逐一匹配声明式规则与专项 Matcher，按“最高风险优先”聚合最终决策：deny > ask > allow
```

### 3.2 SSH 场景专项处理

| SSH 调用形态 | 示例 | 识别与处理方式 |
|---|---|---|
| **直接附带远程命令** | `ssh root@node1 "kubectl delete pod foo"` | 解析 `ssh` 参数（跳过 `-i/-p/-o/-F/-J/-l/-W` 等带值选项及无值 flag），提取 `destination` 后所有参数作为远程命令并递归回送 Stage 1，标记 `isRemote: true` |
| **嵌套引号/多层 shell** | `ssh node1 "sudo bash -c 'rm -rf /data/*'"` | 递归剥离 `ssh` → `sudo` → `bash -c`，还原出 `rm -rf /data/*`（`isRemote: true`） |
| **Heredoc 喂脚本** | `ssh node1 'bash -s' <<'EOF' \n rm -rf /tmp/a \n EOF` | 提取 heredoc 正文作为远端脚本递归分析，每条命令与直接附带的远程命令同等判定：命中规则按规则处置，只读白名单放行，其余在 `strict` 下 `ask` |
| **本地文件重定向** | `ssh node1 'bash -s' < ./cleanup.sh` | 本机 `<` 重定向喂给 shell 或 `ssh` 执行的文件在分析时读入。允许读取范围是不超过 64 KiB 的普通文件，FIFO、设备、目录、不存在、无权限、含 NUL 字节或路径在运行期才确定（`< $F`）的文件视为不可读，`/dev/null` 视为空输入；相对路径按候选工作目录解析。所有候选都不可读时按 fail-closed 处理（`strict` 下 `deny`，`relaxed` 下 `ask`）。可读时正文按执行位置递归分析（`ssh` 为远端），正文中的 `cd` 计入后续命令的候选工作目录，命中规则按规则处置；文件在执行前可能被改写，其余情况在 `strict`、`relaxed` 下均 `ask`。远端命令里的 `<` 指向远端文件，按远端未知命令处理；解释器（`python3 < x.py`）由 Stage 3.5 预扫 |
| **上游静态文本管道** | `echo "docker stop app" \| ssh node1 sh` | 管道左侧为单个字面量 `echo` / `printf` 时，其输出等同 here-string，与 heredoc 同等判定，命中高危直接 `deny`。`echo` 参数含反斜杠或以 `-` 开头（`-n`/`-e`/`-E` 除外），`printf` 带选项、含 `%s`/`%%` 以外的转换或 POSIX 单字符转义以外的转义（含八进制），输出超过 64 KiB，或左侧为复合命令、含展开或重定向时，按不可静态分析的管道处理 |
| **不可静态分析的管道/动态流** | `curl -s ... \| ssh node1 sh`、`base64 -d \| ssh node1 sh` | 标记 `opaqueRemoteStdin`，遵循 **fail-closed**：`strict` 下直接 `deny`，`relaxed` 下强制 `ask` |
| **SSH 远端执行未知脚本** | `ssh node1 /opt/ops/reset.sh` | 标记 `unknownRemoteCommand`：`strict` 下非只读白名单一律 `ask`（或对高危路径/名称 `deny`） |
| **文件同步/覆盖（破坏性）** | `rsync --delete ...`、`scp ... root@node:/etc/...` | 命中 `--delete` 或系统关键路径覆盖规则，按 `deny` / `ask` 处置 |

---

## 4. 安全规则矩阵与声明式扩展机制

规则采用**声明式 JSON 规则表 + 少量专项 Matcher** 组织，支持三层维护方式：
1. **内置分类规则表**（`rules/*.json`，随插件发版）；
2. **外挂独立规则文件**（在 `opencode.json` 中配置 `rulesFile`，运维/个人直接编辑 JSON 即可，无需改动插件源码）；
3. **`opencode.json` 内联扩展**（`extraDeny`、`extraAsk`、`extraAllow`、`protectedEndpoints`、`sshReadOnlyAllowlist`，支持热重载）。

### 4.1 声明式规则格式（人工扩展极简）

90% 的常规命令拦截只需在 JSON 中追加一条声明对象，无需编写 TypeScript 逻辑：

```json
{
  "id": "k8s-delete",
  "severity": "high",
  "command": "kubectl",
  "subcommands": ["delete", "del"],
  "reason": "禁止删除 Kubernetes 资源",
  "examples": {
    "match": ["kubectl delete pod nginx", "kubectl -n prod delete deploy api"],
    "ignore": ["kubectl get pods", "echo kubectl delete"]
  }
}
```

- 支持 `command + subcommands + flags` 结构化匹配（先对命令名执行 `basename`/去反斜杠归一化，再按对应 CLI 的带值选项表跳过如 `kubectl --kubeconfig /path -n prod --as admin` 等前置参数），也支持 `pattern` 正则匹配与 `http`（`methods` + `urlPatterns` + `bodyPatterns`）匹配。
- 每条规则带 `severity`（`"critical" | "high" | "medium"`），分别控制在不同模式下的默认处置（`critical`/`high` 在 `strict` 下默认 `deny`，`medium` 在 `strict` 下默认 `ask`，避免高误报倒逼用户关闭插件）。
- 每条规则自带 `examples.match` / `examples.ignore`，单元测试自动遍历全量 JSON 规则执行回归验证，人工加完规则跑一次 `bun test` 即可确认无误报、无漏报。
- 规则文件格式为 `{ "rules": [ <规则>, ... ] }`。扫描内置目录时，没有 `rules` 字段的文件（如 `ssh-readonly.json`）会被跳过。规则含未知字段、非法 `severity`、无法编译的正则或重复 `id` 时，加载直接报错，并指明来源文件和 `id`。
- 匹配语义（同一条规则的各部分须同时满足）：
  - `command` 可以是字符串或数组，与归一化后的命令名比较。
  - `subcommands` 中任一项命中即可，多词项（如 `"delete namespace"`）的后续词按顺序出现即可，不要求相邻。对有带值选项表的 CLI（`kubectl`、`docker`），首词必须是第一个位置参数。其他 CLI 的首词可以出现在任意位置参数上，避免未知的带值选项（如 `helm -n prod uninstall`）遮住子命令。
  - `flags` 中任一项命中即可。`-f` 也匹配短选项簇（如 `-rf`），`--force` 也匹配 `--force=…`，`--replicas=0` 也匹配 `--replicas 0`。`--` 之后的参数不参与匹配。
    - 长选项的唯一前缀也算命中（`iptables --flu` 命中 `--flush`），因为 getopt_long、argparse 等解析器都接受缩写。有选项表的 CLI（`kubectl`、`docker`）只认精确名。
    - 这是 fail-closed 取舍：前缀可能同时属于别的选项，如 `iptables --delete INPUT 1` 也会命中 `--delete-chain`。
    - `pattern` 正则按字面匹配，不识别缩写。在正则里写长选项的规则需自行覆盖缩写形态。
  - `pattern` 作用于 `命令名 参数1 参数2 …`。本机路径参数已展开为绝对路径。带 `command` 的规则还会把 heredoc / here-string 正文（空白折叠为单个空格）接在参数后再试一次，如 `psql <<SQL DROP TABLE x`。不带 `command` 的规则不看 stdin，避免 `cat <<EOF > x.sh` 写脚本时误报。
  - `scope` 为 `local` / `remote` 时，只匹配本机或远端原子命令。
- 非 shell 工具（MCP 工具、`opencode_worktree_remove` 等）复用同一套规则：
  - 工具调用视为一条本机原子命令，`argv` 为 `[<工具 ID>, <紧凑 JSON 输入>]`。工具 ID 是 OpenCode 的注册名，带 namespace 时形如 `<namespace>_<name>`，例如 MCP 工具 `github_delete_repository`、内置 `opencode_worktree_remove`。
  - 只有 `command` 列出该工具 ID 的规则才会匹配工具调用，`pattern` 作用于 `<工具 ID> <JSON>`，如 `opencode_worktree_remove {"directory":"/repo/wt","force":true}`。不带 `command` 的规则不匹配工具调用，避免对写入文件内容的 `edit` 等工具误报。
  - 这类规则的 `examples` 写成 `<工具 ID> '<JSON>'`，经 shell 分词后与工具调用的 `argv` 相同。
- 内联规则按原子命令逐条判定，优先级如下：
  1. `off` 模式全部放行（防自篡改单独处理）；
  2. 命中 `extraDeny` 或 `critical` 规则：`deny`；
  3. 命中 `extraAllow`：该原子命令放行，豁免 `high` / `medium` 规则和 `extraAsk`，但不能豁免 `critical`、`extraDeny` 和防自篡改；
  4. 其余取 `extraAsk`（`ask`）与 5.1 矩阵结果中的最严者。
  
  内联规则可省略 `severity` 和 `reason`。各原子命令的结果按 `deny > ask > allow` 聚合。

### 4.2 规则分类明细

| 规则文件 / 类别 | 典型高危命令与 API（默认 `deny` 或按模式降级） |
|---|---|
| **`rules/cloud-native.json`**<br>云原生 / Kubernetes / 容器 | `kubectl delete`/`del`、`kubectl drain`、`kubectl cordon`、`kubectl taint`、`kubectl replace --force`、`kubectl rollout undo`、`kubectl scale --replicas=0`、`kubectl patch`（含删除/清空操作）、`helm uninstall`/`delete`、`etcdctl del`、`velero delete`；`docker`/`nerdctl`/`podman`/`crictl`/`ctr` 的 `rm`/`rmi`/`stop`/`kill`/`prune`/`rmp`/`compose down` |
| **`rules/linux-host.json`**<br>Linux 文件、磁盘与服务 | **致命/高危（`critical`/`high`）**：`rm -rf /` / 系统关键路径（`/etc`、`/var`、`/usr`、`/boot`、`/home`、`/data`、`/*`）或远端 SSH 任意 `rm`、`shred`、`find ... -delete`/`-exec rm`、`mkfs*`、`fdisk`、`parted`、`wipefs`、`dd of=/dev/...`、`lvremove`/`vgremove`/`pvremove`、`mdadm --stop/--zero-superblock`、`zfs destroy`、`reboot`/`shutdown`/`poweroff`/`halt`/`init 0/6`、`systemctl stop/disable/mask`、`chmod -R 777 /`、`userdel`、`crontab -r`；<br>**中危（`medium`，`strict` 下 `ask` 减少误报）**：本机工作区或 `/tmp` 下非递归根路径的常规 `rm`/`rmdir`/`unlink`、普通进程 `kill`/`pkill` |
| **`rules/spectrum-cumulus.json`**<br>NVIDIA Spectrum 交换机（Cumulus Linux） | **NVUE**：`nv set`、`nv unset`、`nv config apply`/`detach`/`replace`、`nv action reboot`/`reset`/`install`/`upgrade`；<br>**NCLU & 系统**：`net add`/`del`/`commit`/`abort`、`ifreload -a`、`systemctl stop/restart switchd`、`onie-select`（重装 NOS）、修改 `/etc/network/interfaces` 或 `/etc/nvue.d/` |
| **`rules/ib-ufm.json`**<br>NVIDIA InfiniBand 交换机 & UFM | **IB 交换机（NVOS / MLNX-OS）**：`nv set/unset/config apply/action ...`、`reload`、`reset factory`、`shutdown`、`no interface`、`image boot/install`、`configuration delete`（经 `ssh` 或管道喂入多行 CLI）；<br>**主机侧 IB/GPU 工具**：`ibportstate disable/reset`、`mlxconfig set`、`flint`/`mlxburn`/`mstfwreset`、`opensm` 启停、`nvidia-smi --gpu-reset`；<br>**UFM 服务与 REST API**：`ufmd stop/restart`、`systemctl stop ufm-enterprise`、`ufm_ha_cluster` 切换、非 `GET` 请求发往 `/ufmRest/actions`（端口隔离/节点重启/固件升级）或 `/ufmRest/resources/pkeys` |
| **`rules/oob-redfish.json`**<br>主机带外管理（Redfish / BMC / IPMI / NICo） | **CLI**：`ipmitool power off/reset/cycle`、`ipmitool chassis bootdev pxe/cdrom`、`ipmitool mc reset`、`ipmitool raw`、`ipmitool sensor thresh`/`sdr fill`/`fru edit`/`chassis policy`/`sel clear`/`sel delete` 等 BMC 写操作、`redfishtool` 写子命令；<br>**Redfish REST API（防重装机/断电/刷固件）**：对 `/redfish/v1/` 发起的非 `GET` 请求，重点拦截：<br>• `.../Actions/ComputerSystem.Reset`（强制断电/重启）<br>• `.../Actions/VirtualMedia.InsertMedia` / `EjectMedia`（挂载重装 ISO）<br>• `PATCH /redfish/v1/Systems/...` 含 `BootSourceOverrideTarget`（切换 PXE/CD 触发重装）<br>• `.../Actions/Manager.Reset` / `ResetToDefaults`（重置 BMC）<br>• `.../UpdateService/Actions/UpdateService.SimpleUpdate`（刷固件）<br>**管理端点兜底**：发往用户配置的 `protectedEndpoints`（BMC 网段、NICo VIP、UFM VIP）的任意 `POST`/`PUT`/`PATCH`/`DELETE` 请求默认 `deny`（致命动作）或 `ask` |
| **`rules/opencode-tools.json`**<br>OpenCode 内置工具与 MCP 工具 | `opencode_worktree_remove` 带 `force: true`（丢弃未提交的修改，`high`）。MCP 写操作按 4.1 的工具规则写入 `rulesFile` 或 `extraDeny` / `extraAsk` |
| **`rules/network-db.json`**<br>通用网络 / 数据库 | `ip link set ... down`、`ip addr flush/del`、`ip route flush/del`、`iptables -F/-X`、`nft flush`、`nmcli ... delete/down`、`rsync --delete`；`DROP DATABASE`/`DROP TABLE`/`TRUNCATE`/`FLUSHALL`/`FLUSHDB` |
| **SSH 管道、混淆、内置破坏工具与防自篡改** | 管道/重定向/heredoc 喂给 `ssh ... sh/bash/python`、`base64 -d \| sh`、`eval`、动态命令名 / 本地脚本 TOCTOU；内置 `opencode_worktree_remove`（`opencode` namespace，仅在 Code Mode 中可用，内部以 `action: "edit"` 审批；`force: true` 见 `rules/opencode-tools.json`）；Code Mode `fetch` 发往受保护端点的非 `GET`/`HEAD` 写请求及重定向默认 `deny`；<br>**防自篡改**：受保护路径为本插件包目录、系统配置目录（Linux `/etc/opencode/`，macOS `/Library/Application Support/opencode/`）、全局配置目录（`OPENCODE_CONFIG_DIR`，默认 `$XDG_CONFIG_HOME/opencode/` 即 `~/.config/opencode/`）、`OPENCODE_CONFIG` 指定的文件、任意位置的 `opencode.json`/`opencode.jsonc` 与 `.opencode/` 目录（豁免 plan 模式写计划文件的 `~/.opencode/plan/`）以及 `rulesFile`，均经 `resolveCanonicalPath` 规范化后比对。① 文件写入：evaluate 中 `action === "edit"`（覆盖 `write`/`edit`/`patch`、Code Mode `Bun.write`/`Bun.file().delete()`/`unlink()`）命中即 `deny`；② shell：本机原子命令的输出重定向目标、参数或工作目录（含 `workdir`、`cd`、`env -C`）落在受保护路径内，且命令不在只读白名单（`ssh-readonly.json` + `sshReadOnlyAllowlist`）时 `deny`，重定向写文件时只读命令也不豁免；`rm`/`rmdir`/`mv` 的参数是固定受保护目录或文件的上级目录时同样 `deny`。读取不受限制。`/etc/network/interfaces`、`/etc/nvue.d/` 等主机网络配置不属于自保护范围；<br>**防绕过 `/safety` 与审批**：拦截对 `~/.config/opencode/service.json`（Server 密码）的读取，对 OpenCode 数据库（`~/.local/share/opencode/opencode*.db` 及 `-wal`/`-shm`，或 `OPENCODE_DB` 指定路径）的读写与 `sqlite3` 访问，以及 `curl`/`wget`/`http`/Code Mode `fetch` 发往本机回环地址（`localhost`/`127.0.0.1`/`::1`，不限端口）上 OpenCode Server `/api/` 路径的请求 |

### 4.3 远端 SSH 只读白名单（`rules/ssh-readonly.json`，用于 `strict` 模式减少误报）
在 `strict` 模式下，通过 `ssh` 发往远端的命令如果是**纯只读巡检命令**且不带输出重定向，可直接放行（不弹窗），提高运维排障流畅度：
- **Linux / K8s / 容器只读**：`cd`、`pwd`、`echo`、`ls`、`cat`、`head`、`tail`、`grep`、`rg`、`df`、`du`、`free`、`uptime`、`uname`、`hostname`、`whoami`、`id`、`ps`、`ss`、`ip addr/route/link show`、`systemctl status`、`journalctl`、`dmesg`、`kubectl get/describe/logs/top/cluster-info`、`docker ps/images/logs/inspect`、`crictl ps/pods/logs/inspect`。
- **Spectrum / Cumulus / IB / GPU / UFM 只读**：`nv show`、`net show`、`nvidia-smi`（不含 `--gpu-reset`/`-r`）、`ibstat`、`ibv_devinfo`、`ibswitches`、`iblinkinfo`、`sminfo`、`mlxlink`、`ipmitool sensor/sdr/fru/sel list/chassis status/power status`，以及发往 Redfish / UFM 的纯 `GET` 查询。
  > 注：`ibdiagnet` 会向 `/var/tmp/ibdiagnet2` 写入大量诊断产物并执行全网扫描，**不放入**无条件只读白名单（默认在 `strict` 下走 `ask`，有需要可在 `sshReadOnlyAllowlist` 中按需显式加入）。
- 文件格式为 `{ "commands": [ "<命令名> [子命令...]", ... ] }`，条目与 `sshReadOnlyAllowlist` 相同，是命令前缀，例如 `"kubectl get"`、`"ipmitool sel list"`、`"mlxlink"`。
- 前缀从第一个位置参数开始逐词比较。`kubectl`、`docker`、`ipmitool` 会先跳过全局选项（`kubectl -n prod get pods`、`ipmitool -I lanplus -H bmc sel list`），其他命令的带值选项会被当作位置参数，因此不会命中多词条目。
- 带输出重定向写文件的命令不算只读。`/dev/null`、`/dev/stdout`、`/dev/stderr` 与 `2>&1` 这类 fd 复制不算写文件。
- 白名单只影响"未知远端命令"的默认 `ask`，不覆盖规则。远端命令命中任何规则时按规则判定，例如 `nvidia-smi -r` 命中 `nvidia-smi-reset`，`mlxlink -a DN` 命中 `mlxlink-write`。

---

## 5. 全局模式切换设计（`strict` / `relaxed` / `off`）

### 5.1 三种模式的行为矩阵

| 风险等级 / 场景 | `strict`（严格，默认） | `relaxed`（宽松） | `off`（关闭） |
|---|---|---|---|
| **致命破坏命令（`critical`）**（如 `rm -rf /`、`mkfs`、`dd of=/dev/`、`kubectl delete ns`、`onie-select`、Redfish `VirtualMedia.InsertMedia`/`ComputerSystem.Reset`/`BootSourceOverride`、`ipmitool power off`） | `deny`（硬阻断） | `deny`（仍硬阻断，可选配置降级为 `ask`） | `allow` |
| **高危删除/停服/变更（`high`）**（远端 `rm`、`kubectl delete pod`、`docker stop`、`systemctl stop`、`nv config apply`、UFM REST 写请求） | `deny`（硬阻断） | `ask`（弹窗人工确认） | `allow` |
| **中危本机清理/操作（`medium`）**（本机工作区/`/tmp` 常规 `rm`、普通进程 `kill`/`pkill`） | `ask`（弹窗人工确认，降低误报） | `allow` | `allow` |
| **远端 SSH 只读命令** | `allow` | `allow` | `allow` |
| **远端 SSH 未知/非只读命令** | `ask`（弹窗人工确认） | `allow`（除非命中高危规则） | `allow` |
| **SSH 管道/重定向/heredoc & Opaque / 脚本 TOCTOU** | `deny`（不可分析流） / `ask`（可检出安全正文或 TOCTOU） | `ask`（弹窗人工确认） | `allow` |
| **Code Mode `fetch` 重定向写受保护端点**（防 `assertNotDenied` 静默放行 `ask`） | `deny`（硬阻断） | `deny`（硬阻断） | `allow` |
| **防自篡改（修改安全插件/配置/rulesFile）** | `deny` | `deny` | `deny`（`alwaysProtectSelf: false` 时 `allow`） |

> 本插件对 `shell` 的 `ask` 复用内置 shell 审批弹窗，由 `permission.hook("evaluate")` 强制为 `ask`。用户即使点击 `Always`，保存的规则也只影响插件判定为 `allow` 的命令，被插件标记的命令下次仍会弹窗。非 shell 工具由插件自行发起的审批不附带 `save`。对经 `permission.hook("evaluate")` 拦截的 Code Mode `fetch` 等上游自带 `save: ["*"]` 的请求，受保护端点写操作优先设为 `deny` 以避免白名单污染。在 `Unattended` 无人值守自动审批模式下，绝不允许自动放行的规则必须归入 `deny`。Code Mode 中的拒批可被沙箱 `try/catch` 捕获（见 [1.2](#12-非目标与安全边界)），这也是高危规则坚持 `deny` 的原因。

### 5.2 状态持久化与优先级

利用 OpenCode 的全局 SQLite KV（`ctx.storage`，按 `plugin.id` 自动命名空间隔离，所有项目和 Session 共享，重启后保持）：

- **读取方式**：插件按 Location 实例化，各实例的内存互不共享。每次决策都从 `ctx.storage` 读取 `safety:state`（可加秒级短缓存），TTL 是否过期在读取时计算，保证 `/safety` 切换对所有实例生效。
- **存储 Key**：`safety:state`
- **数据结构**：
  ```json
  {
    "mode": "relaxed",
    "expiresAt": 1763881800000,
    "previousMode": "strict",
    "updatedAt": 1763880000000,
    "updatedBy": "command"
  }
  ```
- **生效优先级（高 → 低）**：
  1. **环境变量强制锁定**：`OPENCODE_SAFETY_LOCK_MODE=strict`（运维可在跳板机全局锁定，禁止运行时关闭）
  2. **运行时 Slash Command 状态**（`ctx.storage` 中的 `safety:state`，支持 `--ttl`，过期自动回落到 `previousMode` 或 `strict`）
  3. **环境变量默认覆盖**：`OPENCODE_SAFETY_MODE=strict|relaxed|off`
  4. **配置文件 `opencode.json` 中的 `plugins[].options.mode`**（修改 `options` 会变更插件 `revision` 触发整插件重载；`rulesFile` 由插件在每次加载前按文件 `mtime` 按需刷新）
  5. **内置默认值**：`strict`
- **TTL 回落**：`expiresAt` 为 `null` 表示不过期。过期后恢复到 `previousMode`；`previousMode` 为 `null` 时按下一优先级（环境变量 → 配置 → `strict`）。不带 TTL 切换时 `previousMode` 为 `null`。带 TTL 切换时，若当前状态不带 TTL，`previousMode` 取当前模式；若当前状态也带 TTL，则继承它的 `previousMode`，避免临时模式在叠加切换后变成永久模式。
- **容错**：环境变量取值非法时按 `strict` 处理（`LOCK_MODE` 非法即锁定为 `strict`）；`ctx.storage` 读取失败时按 `strict` 处理；`safety:state` 内容非法时视为不存在。
- **`rulesFile`**：须为绝对路径数组，文件格式与内置规则相同。按 `mtime`、大小和 inode 判断变更后重新加载。文件缺失、JSON 非法、规则非法或 `id` 与其他规则重复时，每次决策都会报错，由 hook 层按失败关闭处理，直到文件修复。
- **配置失败关闭**：`options` 非法或规则无法加载时，插件照常加载并注册 hook，但除 `off` 模式外拒绝所有工具调用（不只是 `shell`，因为无法确定哪些工具有规则），原因为 `[safety-policy:config-error] <出错的字段或文件及错误>`。模式仍按环境变量、运行时状态与默认值解析，`options.mode` 此时不生效。判定过程本身抛错时同样拒绝该调用，原因为 `[safety-policy:policy-error] <错误>`。

### 5.3 用户专属 `/safety` 交互与零副作用回显机制

采用 OpenCode 原生 **TUI 入口（`./tui`）+ 插件 RPC（`./rpc`）** 架构提供 `/safety` 命令（**不暴露为 LLM 工具**，Agent 无法通过工具调用切换模式；但 RPC 经本机 Server API `/api/rpc/:rpcID/:method` 暴露，同用户进程拿到 Server 密码即可调用，防护措施与边界见 [1.2](#12-非目标与安全边界)）：

1. **主通道（TUI + RPC，零 `session_inbox` 副作用）**：
   - Server 插件（`index.ts`）通过 `ctx.rpc.register` 注册 `rpc.ts` 定义的 RPC。RPC `id` 与插件 id 相同，为 `opencode-safety-policy`，避免被其他插件的同名 RPC 覆盖。HTTP 端点为 `/api/rpc/opencode-safety-policy/<method>`。方法为 `status`、`setMode`、`test`，下文简称 `safety.status` 等。
   - `safety.status` 返回当前模式、来源、是否锁定和 TTL 到期时间。`safety.setMode` 接收模式与可选的 `ttlMs`，返回切换后的状态。
   - `safety.setMode` 在 `OPENCODE_SAFETY_LOCK_MODE` 生效时直接拒绝，返回契约中声明的 `locked` 错误。handler 抛出的普通异常会被 OpenCode 转成不带原因的 `rpc.internal`，TUI 无法展示拒绝原因。
   - TUI 插件（`tui.ts`，基于 `@opencode/plugin/tui`）通过 `ctx.keymap.layer` 注册 `slash: { name: "safety", arguments: true }`（并加入 Command Palette）。layer 必须声明 `mode: "global"`：默认的 `base` 模式在斜杠补全或 Command Palette 打开时不可达，命令只能盲输执行，无法被发现。命令执行时通过 `ctx.client.rpc(definition)` 调用 Server RPC，使用 `ctx.ui.toast.show(...)` 即时展示模式切换/状态，使用 `ctx.ui.dialog.alert(...)` 展示 `/safety test "<cmd>"` 的多行拆壳与命中详情。
   - TUI 插件同时通过 `ctx.data.on("permission.asked", ...)` 监听审批事件，对 `message` 以 `[safety-policy:` 开头的请求弹 Toast 展示规则原因（TUI 审批弹窗本身不渲染 `message`）。
   - **完全不写入 `session_inbox`**（不使用 `delivery: "queue"` 的 `session.synthetic`，彻底杜绝空闲或运行结束时触发幽灵 LLM 回合及过滤后引发的 400 错误，也避免 TUI 自动补全出现重复 `/safety`）。
2. **终端 CLI 与无 TUI 场景兜底**：
   - 独立本地 CLI（`bun ./cli.ts test "<cmd>"`）供规则维护者离线回归和排障。
   - 仅当用户在纯 Desktop/Web App（不运行 TUI）场景显式配置 `options.enableServerSlashCommand: true` 时，服务端才额外注册 `ctx.command.transform("/safety")` 降级入口：使用 `delivery: "steer"` + `resume: false`（随下一条真实用户消息一起消费，不触发单独幽灵回合，但注意运行中调用会消耗 steer 边界）并配合 `session.hook("context" | "compaction" | "generate")` 过滤 `metadata?.source === "safety-policy"`。

| 命令 | 行为 |
|---|---|
| `/safety` 或 `/safety status` | 通过 Toast/Dialog 即时显示当前全局模式、来源、是否被环境变量锁定、TTL 剩余时间（零 LLM 副作用）。最近拦截统计推迟到 P1-6：插件实例按 Location 隔离，内存计数不完整且重启清零 |
| `/safety strict` | 立即全局切换为严格模式（清除 TTL） |
| `/safety relaxed` | 切换为宽松模式 |
| `/safety relaxed --ttl 30m` | 切换为宽松模式，30 分钟后自动回落到切换前的模式（规则见 5.2，默认 `strict`） |
| `/safety off --ttl 15m` | 临时关闭 15 分钟，到期自动回落（防止忘记切回） |
| `/safety test "<cmd>"` | 干跑测试某条命令在当前模式下的拆壳结果与命中规则（TUI 弹窗展示，亦可用 `bun ./cli.ts test "<cmd>"`） |

---

## 6. 仓库目录结构与模块划分

按确认的落地位置，插件直接放在本仓库（`DaoCloud/opencode-safety-policy`）根目录：

```text
opencode-safety-policy/       # 仓库根目录
├── docs/                     # 设计文档与开发流程
├── package.json              # 插件 manifest（exports: "." / "./server" / "./tui" / "./rpc"，零三方依赖）
├── tsconfig.json
├── README.md                 # 安装、配置、/safety 用法与规则扩展说明
├── index.ts                  # Server 插件入口（@opencode/plugin）：define({ id, setup })，注册 hooks/RPC（随插件 scope 自动注销）
├── tui.ts                    # TUI 插件入口（@opencode/plugin/tui）：注册 /safety keymap slash + Toast/Dialog，监听 permission.asked 展示规则原因
├── rpc.ts                    # Server <-> TUI 共享 RPC 契约定义（status / setMode / test）
├── cli.ts                    # 独立本地调试 CLI（bun ./cli.ts test "<cmd>"）
├── rules/                    # 声明式内置规则表（人工扩展直接增改 JSON，自带 examples 自测）
│   ├── cloud-native.json     # K8s / Helm / Docker / Nerdctl / Crictl / Ctr / Etcd
│   ├── linux-host.json       # rm / 磁盘 / 分区 / 服务 / 进程 / 权限 / 重启
│   ├── spectrum-cumulus.json # NVIDIA Spectrum 交换机（Cumulus NVUE / NCLU / switchd / onie-select）
│   ├── ib-ufm.json           # NVIDIA IB 交换机（NVOS / MLNX-OS）/ 主机 IB & GPU 工具 / UFM
│   ├── oob-redfish.json      # Redfish REST 写动作 / IPMI / BMC / NICo 防重装机
│   ├── opencode-tools.json   # OpenCode 内置工具与 MCP 工具（opencode_worktree_remove force 等）
│   ├── network-db.json       # 通用网络配置 / 防火墙 / rsync / 数据库破坏性语句
│   └── ssh-readonly.json     # SSH 远端只读巡检白名单
├── src/
│   ├── types.ts              # Mode, Decision, Rule, HttpRequestInfo, PluginOptions 等类型
│   ├── config.ts             # 解析 options / rulesFile / 环境变量 / 自定义规则合并
│   ├── state.ts              # 基于 ctx.storage 的全局模式读写（每次决策读取 + 短缓存）与 TTL 自动回落
│   ├── policy.ts             # 组装模式与规则：setup 不抛错，配置错误留到每次决策时抛出（失败关闭）
│   ├── path-util.ts          # resolveCanonicalPath(nearestExistingAncestor realpath + relativeTail)
│   ├── tokenizer.ts          # Shell 词法切分（引号、管道、重定向、heredoc、子命令提取）
│   ├── unwrapper.ts          # 递归拆壳引擎（ssh/sshpass/sudo/bash -c/kubectl exec/docker exec/ansible/xargs）
│   ├── http-extractor.ts     # 解析 curl/wget/http 方法与 URL + 敏感网段/VIP 匹配
│   ├── script-scanner.ts     # 轻量预扫 python -c / node -e / 本地脚本中的高危命令与 API 写操作
│   ├── analyzer.ts           # 串联 effectiveCwd + tokenizer + unwrapper + http-extractor + script-scanner
│   ├── rules/
│   │   ├── loader.ts         # 加载内置 rules/*.json + 外挂 rulesFile + options 内联规则
│   │   ├── matcher.ts        # 声明式规则匹配（command/subcommands/flags、pattern、http）
│   │   ├── ssh-policy.ts     # SSH 只读白名单 & 管道/重定向/未知脚本策略
│   │   ├── self-protect.ts   # 防 Agent 篡改插件、opencode.json、rulesFile，读取 service.json、改写 OpenCode DB、调用本机 Server API
│   │   └── index.ts          # 规则汇总与优先级裁决（deny > ask > allow）
│   ├── hooks/
│   │   ├── tool.ts           # tool.hook("execute.before"/"execute.after")（shell+workdir 的 deny 与 ask 标记、opencode_worktree_remove/MCP 的 deny 与自发 assert；标记按插件实例存放）
│   │   ├── permission.ts     # permission.hook("evaluate")（按 source.id / 子串匹配标记强制 shell ask、webfetch deny、edit canonical path）
│   │   └── session-filter.ts # 可选服务端降级命令启用时的 session.hook("context"|"compaction"|"generate") 过滤
│   ├── rpc-handlers.ts       # Server 侧 RPC 处理器（status / setMode / test）
│   ├── command.ts            # 可选降级服务端 /safety Slash Command（默认关闭，仅无 TUI 场景按需开启）
│   └── audit.ts              # 结构化 JSONL 审计日志（写入 ~/.local/state/opencode/ 或自定义路径）
└── test/
    ├── helpers/
    │   └── fake-context.ts   # 模拟 Plugin Context（hook 注册、storage、permission.assert、rpc.register）
    ├── tokenizer.test.ts     # 词法切分、引号、管道、heredoc 单元测试
    ├── unwrapper.test.ts     # ssh/sudo/bash -c/kubectl exec 多层拆壳测试
    ├── path-util.test.ts     # effectiveCwd、nearestExistingAncestor、符号链接规范化测试
    ├── http-script.test.ts   # curl/Redfish/UFM 写请求解析与脚本预扫测试
    ├── rules-examples.test.ts# 自动遍历 rules/*.json 中所有 examples.match/ignore 的回归测试
    ├── mode.test.ts          # strict/relaxed/off 决策矩阵与 TTL 回落测试
    └── plugin.test.ts        # 模拟 Plugin Context 的端到端 Hook、workdir、强制 ask 与 full_codemode 标记匹配测试
```

### 6.1 `package.json` 关键设计
```json
{
  "name": "@daocloud/opencode-safety-policy",
  "version": "0.1.0",
  "description": "Safety policy plugin for OpenCode to guard local and remote SSH destructive commands",
  "type": "module",
  "exports": {
    ".": "./index.ts",
    "./server": "./index.ts",
    "./tui": "./tui.ts",
    "./rpc": "./rpc.ts"
  },
  "files": [
    "index.ts",
    "tui.ts",
    "rpc.ts",
    "cli.ts",
    "rules",
    "src",
    "README.md"
  ],
  "scripts": {
    "test": "bun test",
    "typecheck": "bunx tsc --noEmit"
  },
  "peerDependencies": {
    "@opencode/plugin": "^2.3.0"
  }
}
```
> **零外部运行时依赖**：仅使用 Bun / Node 内置模块和宿主注入的 `@opencode/plugin`，确保内网/离线机房（如 GPU 集群装机环境）可以直接拷贝目录即用，无需联网 `npm install`。
>
> **导入路径**：Server 侧 Promise API 从包根 `@opencode/plugin` 导入（不存在 `@opencode/plugin/promise` 子路径），TUI 侧从 `@opencode/plugin/tui` 导入，RPC 契约用 `@opencode/plugin/rpc` 的 `Rpc.define`，input/output 写成 JSON Schema，避免依赖 `effect`。OpenCode 2.x 的插件 API 仍在快速演进，`peerDependencies` 锁定到已验证的 `^2.3.0`，升级 OpenCode 时需回归 `test/plugin.test.ts`。

---

## 7. 配置示例（`opencode.json`）

```json
{
  "plugins": [
    {
      "package": "@daocloud/opencode-safety-policy",
      "options": {
        "mode": "strict",
        "alwaysProtectSelf": true,
        "auditLogPath": "/var/log/opencode-safety-audit.jsonl",
        "rulesFile": [
          "/etc/opencode/safety-rules.json"
        ],
        "protectedEndpoints": {
          "bmcCidrs": ["10.10.0.0/16"],
          "ufmHosts": ["10.20.0.10", "ufm.internal"],
          "nicoHosts": ["10.30.0.10", "nico.internal"]
        },
        "sshReadOnlyAllowlist": [
          "mlxlink"
        ],
        "extraDeny": [
          {
            "id": "custom-nico-reset",
            "pattern": "^nico-cli\\s+(reset|wipe|delete)\\b",
            "reason": "禁止通过 Agent 重置或删除 NICo 节点配置"
          }
        ],
        "extraAllow": [
          {
            "id": "allow-clean-tmp-build",
            "pattern": "^rm\\s+-rf\\s+/tmp/my-build-[a-z0-9]+$",
            "scope": "local"
          }
        ]
      }
    }
  ]
}
```

---

## 8. 分发与部署方案（适配 `infra-integrate` 场景）

插件源码位于独立仓库 `DaoCloud/opencode-safety-policy`，目标环境包含联网开发机与离线/内网 GPU 管理跳板机，推荐按场景提供三种分发方式：

1. **开发机 / 联网团队（推荐）：发布到公司私有 npm 源**
   - 在仓库根目录执行 `npm publish`（或 CI 在 tag 时自动发布）。
   - 用户只需在 `~/.config/opencode/opencode.json` 添加包名，OpenCode 自动拉取并定期检查更新。
2. **跳板机 / 管理主机（统一强制基线，重要：防自动发现冲突与同 ID 空插件劫持）**
   - **不要**同时将插件放入 `/etc/opencode/plugins/` 并在 `/etc/opencode/opencode.json` 中重复声明——OpenCode Supervisor 先加载自动发现目录（`options: {}`），后加载的 `opencode.json` 条目会因 `Duplicate plugin ID` 失败并丢弃 `options`；而且仅靠自动发现加载的插件，可被项目级 `.opencode/opencode.json` 中的 `"plugins": ["-*"]` 卸载。
   - **关键安全加固（防项目级同 ID 劫持）**：`PluginSupervisor` 处理 `"-*"` 时仅从 `enabled` 集合移除、不会从 `packages` Map 删除先前加载的条目。若不可信仓库在 `.opencode/plugins/` 放置一个导出同 `id: "opencode-safety-policy"` 的空壳插件，它会抢占去重首顺位并导致系统级真实插件因 `Duplicate plugin ID` 失效。因此**必须同步配置 OpenCode 原生 `ManagedPolicy` 的 `policies`（`plugin.use` 白名单）**——`PluginModule.load` 在模块进入 `packages` Map 之前就会先校验 `plugin.use`，直接拦截一切非白名单项目插件。
   - **正确做法**：将本仓库 `package.json` 中 `files` 所列内容推送到**非自动发现目录** `/etc/opencode/safety-policy/`（macOS 为 `/Library/Application Support/opencode/safety-policy/`，Windows 为 `%ProgramData%\opencode\safety-policy\`），在系统级 `opencode.json` 中同时配置 `policies` 与 `plugins`（同一 `policies` 数组按 `findLast` 匹配，后写规则覆盖前写规则；系统级 `managedPolicies` 拥有最高文件策略权威）：
     ```json
     {
       "policies": [
         { "action": "plugin.use", "resource": "*", "effect": "deny" },
         { "action": "plugin.use", "resource": "/etc/opencode/safety-policy", "effect": "allow" }
       ],
       "plugins": [
         {
           "package": "./safety-policy",
           "options": { "mode": "strict" }
         }
       ]
     }
     ```
     （如需允许其他受信任内部插件，在 `policies` 末尾追加对应的 `allow` 条目即可。）这样可同时满足：① 完全离线加载、不走 npm；② 无 `Duplicate plugin ID` 且 `options` 正常注入；③ 系统级 `managedPolicies` 在加载前直接阻断项目伪造插件，同时 `managedSettings` 在项目配置之后合并，抵御 `"-*"` 卸载；④ 限制只有受信任插件能注册 `shell.hook("create.before")`，避免其他插件在本插件检查后改写命令。
   - **macOS MDM 托管特例**：若 macOS 通过 MDM `ai.opencode.managed.plist` 下发配置，OpenCode 会以 `/Library/Managed Preferences/` 为相对路径基准，此时 `package` 与 `policies[].resource` **均必须填写绝对路径** `"/Library/Application Support/opencode/safety-policy"`，不可使用相对路径 `"./safety-policy"`。
   - 如需禁止用户运行时关闭，可在跳板机 `/etc/profile.d/opencode-safety.sh` 中导出 `OPENCODE_SAFETY_LOCK_MODE=strict`。
3. **离线机房交付**：可复用 `infra-integrate` 仓库的 `tools/offline-pack.sh`，或在本仓库用 `npm pack` 生成 tarball 随交付包分发
   - 由于插件**零第三方运行时依赖**且源码可直接被 OpenCode 的 Bun 运行时加载，只需将本仓库 `package.json` 中 `files` 所列内容打进离线交付包，部署时解压到 `/etc/opencode/safety-policy/` 并在 `/etc/opencode/opencode.json` 中按上述本地路径注册即可立即生效。

---

## 9. 实施步骤与验证计划

后续确认方案后，按以下阶段在本仓库落地实现（逐步执行流程见 [opencode-safety-policy-dev-plan.md](./opencode-safety-policy-dev-plan.md)）。先交付可用的最小闭环（MVP），再逐步加深 `CommandAnalyzer`：误报与工作量主要集中在命令静态解析，而静态解析对变量、`eval`、`python -c` 等形态存在天然上限，不宜一次做全。

1. **阶段 1（P0）：MVP 闭环**
   - 建立包目录、`package.json`、类型定义；实现基础 `tokenizer.ts` 与 `unwrapper.ts`（`ssh`/`sshpass`/`sudo`/`bash -c`/`kubectl exec`/`docker exec`）、声明式规则引擎与 `rules/*.json`、`rulesFile` 加载器、基于 `ctx.storage` 的 `strict`/`relaxed`/`off` 状态（每次决策读取）与 TTL 自动回落。
   - 实现 `path-util.ts`（`nearestExistingAncestor` `realpath` + `relativeTail`）、`tool.hook("execute.before"/"execute.after")`（`shell` 联合 `input.workdir` 展开后的 `deny` 与 `ask` 标记、`opencode_worktree_remove` 与 MCP 的 `deny`/自发 `assert`）、`permission.hook("evaluate")`（按 `source.id` / 子串匹配标记强制 shell `ask`、`edit`/`external_directory`/`read` 规范化路径防篡改）、Server `rpc-handlers.ts` + TUI `tui.ts`（`keymap.layer` `/safety` + `Toast`/`Dialog`）。
   - 验证：`bun test test/tokenizer.test.ts test/unwrapper.test.ts test/rules-examples.test.ts test/mode.test.ts test/plugin.test.ts` 全部通过，并在本机 OpenCode 中通过非自动发现本地目录 + `policies` 显式配置实测：
     - 本机 `rm -rf /data`、`shell({ workdir: "/", command: "rm -rf etc" })`、`kubectl delete`、`docker stop`、`opencode_worktree_remove(force: true)` 被拦截；
     - 本机 `/tmp` 常规 `rm` 只弹一次内置 shell 审批（直调与 `full_codemode` 两种场景），Desktop/Web App 弹窗显示规则原因；点击 `Always` 后再次执行同一命令仍弹窗；
     - Code Mode 中被拒绝的调用不会执行，即使沙箱代码 `try/catch` 了该错误；
     - `ssh host "kubectl delete ..."`、`ssh sw "nv config apply"` 被拦截；
     - `/safety relaxed --ttl 1m`、`/safety status` 跨重启、跨 Session、跨多个工作目录（多 Location 实例）生效，零 `session_inbox` 残留、零幽灵 LLM 回合；设置 `OPENCODE_SAFETY_LOCK_MODE` 后 `safety.setMode` 被拒绝。
2. **阶段 2（P1）：深化 `CommandAnalyzer`**
   - 实现 `http-extractor.ts`、`script-scanner.ts`、Stage 2 Opaque / 混淆检测、SSH heredoc / 管道 / 本地文件重定向专项处理、`analyzer.ts` 串联、evaluate 中 `webfetch`（含 Code Mode `fetch`）受保护端点写请求及重定向 `deny`，以及 `/safety test "<cmd>"` 与 `cli.ts`。
   - 验证：`bun test test/http-script.test.ts test/rules-examples.test.ts` 通过（覆盖嵌套引号、heredoc、管道、Redfish/UFM HTTP 写请求解析与脚本预扫），实测 `curl -X POST https://bmc/redfish/v1/.../VirtualMedia.InsertMedia` 以及 Code Mode `fetch`（含 307/308 重定向）写请求被拦截。
3. **阶段 3（P2）：加固与体验**
   - 防绕过 `/safety` 与审批的自保护规则（`service.json`、OpenCode DB、本机 Server `/api/` 端点）、evaluate 中对未匹配 `shell` 请求的 `deny` 级复检、TUI 监听 `permission.asked` 展示规则原因、可选审计日志、可选服务端降级 `/safety` 命令。
   - 验证：实测 `cat ~/.config/opencode/service.json`、`sqlite3 ~/.local/share/opencode/opencode.db ...`、`curl http://127.0.0.1:<port>/api/rpc/...` 被拦截；TUI 中对插件强制的审批弹出原因 Toast。
4. **阶段 4：文档与分发脚本**
   - 补全仓库根目录 `README.md`（含本机安装、私有 npm 发布、`/etc/opencode/safety-policy/` + `/etc/opencode/opencode.json` 托管与 `policies` 防劫持配置、离线安装步骤，以及 [1.2](#12-非目标与安全边界) 中的安全边界说明）。

---

## 附录 A：Spike 验证结果

- 日期：2026-11-23
- 版本：OpenCode v2.3.2（`/usr/local/nodejs/bin/opencode`），Bun 1.3.14
- 方法：
  - 一次性插件 `/tmp/ocsp-spike/plugin`（`package.json` 含 `name` 与 `exports`，导出 server、tui、rpc 三个入口），每个 hook 把入参追加写入 `/tmp/ocsp-spike/trace.jsonl`，并带上模块级实例 ID（`inst`）。
  - 本地 mock LLM：OpenAI 兼容接口，把用户消息中的 `@@CALL <tool> <json>` 依次转成工具调用，不需要真实模型凭据。
  - 隔离环境：`XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_STATE_HOME`、`XDG_CACHE_HOME` 指向 `/tmp/ocsp-e2e/xdg/*`，测试项目为 `/tmp/ocsp-e2e/project`。
  - 驱动方式：`opencode run --standalone`（非交互，审批自动拒绝）；`opencode serve` + HTTP API（回复 `once`/`always`）；pty + `pyte` 驱动 TUI。

| 编号 | 结论 | 证据与说明 |
|---|---|---|
| S1 | 通过 | `setup` 收到 `options: {"hello":"world"}`；TUI 入口加载并执行 `setup`。TUI 入口的 `ctx.options` 为 `{}`，配置不会传给 TUI。 |
| S2 | 通过 | 只设上述 4 个 XDG 变量即可隔离：个人的 `~/.config/opencode/*`、`~/.local/share/opencode/opencode.db`、`service.json` 均未被修改；`--standalone` 与自启的 `serve` 都不连接共享后台服务。注意：未设隔离变量时，哪怕只运行 `opencode <cmd> --help` 也会写个人目录下的 `log/opencode.log`。Server 会只读监听 `~/.claude/skills`、`~/.agents/skills`、`~/.claude/CLAUDE.md`。 |
| S3 | 通过 | `echo SPIKE_DENY > file` 未执行（文件未生成）。模型收到的工具结果为 `{"error":{"type":"unknown","message":"[safety-policy:spike-deny] blocked by spike"}}`。step 没有结束，模型随后发起的 `echo AFTER_DENY` 正常执行。据此修正了 [1.2](#12-非目标与安全边界) 与 [2](#2-总体架构) 中“直调拒批会结束 step”的描述。 |
| S4 | 通过 | evaluate 收到 `source: {type:"tool", messageID, id}`，其中 `id` 等于 `execute.before` 的 `input.id`，可精确匹配。设 `effect = "ask"` 和 `message` 后弹出内置审批（TUI 显示 `Permission required`，API 返回的请求带 `message` 与 `save: ["echo *"]`）。回复 `always` 后保存了 `shell: echo *` 规则，再执行同一命令仍弹窗；未标记的命令不受影响。不需要回退。 |
| S5 | 通过 | `OPENCODE_FLAGS=full_codemode` 下，外层 `execute.before` 收到 `tool: "execute"`、`input: {code}`；嵌套 shell 的 `execute.before` 收到 `tool: "shell"`、新的 `id`（`call_<ascending>`），`messageID` 与外层相同；evaluate 的 `source.id` 是外层 `execute` 的 callID，因此直调匹配失败，`sessionID` + 子串匹配命中。`execute.before` 抛错可被沙箱 `try/catch` 捕获（拿到 `[safety-policy:...]` 原文），命令未执行，被拒绝的调用不会触发 evaluate。 |
| S6 | 通过 | 同一进程内 `setup`、`execute.before`、`evaluate`、`execute.after`、RPC handler 的实例 ID 一致；`serve` 模式下跨多次 prompt 也是同一实例。标记可以放在模块级 `Map`。 |
| S7 | 通过 | 在 `/tmp/ocsp-e2e/project2` 读到 `project` 写入的值，进程重启后保留。源码确认 KV 只按 `plugin:<hex(pluginID)>:` 加前缀，存在全局 DB 表中，不按项目隔离。 |
| S8 | 通过 | TUI 中输入 `/safety hello-tui`，`run` 收到 `"hello-tui"`；RPC `ping`（JSON Schema 契约）往返成功并弹出 Toast；输入不合法时返回 `rpc.invalid_input`。`permission.asked` 事件带 `message` 与 `source`。TUI 审批弹窗确实不显示 `message`。HTTP `POST /api/rpc/ocsp-spike/ping`（Basic 认证，用户名 `opencode`）同样可用。 |
| S9 | 通过 | Code Mode `fetch(url, {method:"POST"})` 触发 evaluate：`action: "webfetch"`，`resources: [url]`，`metadata: {method:"POST", url}`。307 跳转后再次触发 evaluate，`metadata` 为 `{method:"POST", url:<目标>, redirectedFrom:<原 URL>}`。另外：`redirect: "manual"` 被忽略，仍会跟随跳转，每一跳都经过 evaluate；Code Mode 中没有全局 `Request`。 |

关键 trace 片段（已截短）：

```jsonl
{"kind":"execute.before","tool":"shell","messageID":"msg_2081a4679…","id":"call_8b746361","input":{"command":"echo SPIKE_ASK"}}
{"kind":"evaluate","action":"shell","resources":["echo SPIKE_ASK"],"source":{"type":"tool","messageID":"msg_2081a4679…","id":"call_8b746361"},"effect":"allow"}
{"kind":"execute.before","tool":"shell","messageID":"msg_2081c1c8c…","id":"call_2081c1d58001cm1xpS3g1bi2E1","input":{"command":"echo SPIKE_ASK"}}
{"kind":"evaluate","action":"shell","resources":["echo SPIKE_ASK"],"source":{"type":"tool","messageID":"msg_2081c1c8c…","id":"call_bcfe9f5c"},"effect":"allow"}
{"kind":"evaluate","action":"webfetch","resources":["http://127.0.0.1:18557/target"],"metadata":{"method":"POST","url":"http://127.0.0.1:18557/target","redirectedFrom":"http://127.0.0.1:18557/redir"}}
{"side":"tui","kind":"tui.permission.asked","data":{"action":"shell","resources":["echo SPIKE_ASK"],"save":["echo *"],"message":"[safety-policy:spike-ask] forced (direct)"}}
```

结论：S3、S4、S6 均按主方案实施，不启用回退方案。
