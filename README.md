# opencode-safety-policy

这是 OpenCode 2.x 的安全策略插件。AI Agent 执行 shell 命令、调用工具或发起 HTTP 请求之前，插件先做静态分析，拦下高危操作。分析会穿透 `ssh`、`sudo`、`bash -c`、`kubectl exec` 等多层封装，覆盖以下几类目标：

- 本机与 Linux 服务器：`rm -rf`、`mkfs`、`dd`、`reboot`、`systemctl stop` 等
- Kubernetes 与容器：`kubectl delete`、`helm uninstall`、`docker rm` 等
- NVIDIA Spectrum、InfiniBand 交换机与 UFM
- 带外管理：Redfish 写请求、`ipmitool power` 等
- 网络与数据库：`iptables -F`、`DROP TABLE` 等
- 插件自身：插件文件、安全配置、规则文件、OpenCode Server 凭据和 API，Agent 都无法改动或访问

本插件用于防止误操作，不是强安全边界，见[安全边界](#安全边界)。完整设计见[设计文档](docs/opencode-safety-policy-design.md)。

## 运行模式

| 模式 | 行为 |
|---|---|
| `strict`（默认） | 致命与高危操作直接拒绝。中危的本机清理和未知远端命令弹出审批，只读巡检放行 |
| `relaxed` | 只拒绝致命操作，高危操作弹出审批，常见本机清理与一般 SSH 命令放行 |
| `off` | 全部放行，但仍然阻止篡改插件和安全配置 |

各类操作在每种模式下的处置见设计文档 [5.1](docs/opencode-safety-policy-design.md#51-三种模式的行为矩阵)。

## 安装

要求 OpenCode 2.x 且不低于 2.3.0，CI 使用 2.4.1 测试。下文以 v0.1.1 为例，可用版本见 [Releases](https://github.com/DaoCloud/opencode-safety-policy/releases)。

| 场景 | 方式 |
|---|---|
| 能访问 GitHub 的个人机器 | [在线安装](#在线安装) |
| 不能访问 GitHub 的个人机器 | [离线安装](#离线安装) |
| 跳板机、管理主机等需要强制启用的机器 | [系统级部署](#系统级部署) |

### 在线安装

在 `~/.config/opencode/opencode.json` 中加入：

```json
{
  "plugins": [{ "package": "github:DaoCloud/opencode-safety-policy#semver:*" }]
}
```

重启 OpenCode 后，OpenCode 会从 GitHub 拉取最新的 release tag，装到 `~/.cache/opencode/npm/` 下。`main` 分支上还没发版的提交不会被安装。本机需要装有 `git`，并且能访问 GitHub。

OpenCode 加载插件后会检查一次新版本，之后每 24 小时再查一次。发现新版本时不会自动安装，只在插件列表中标记 `update available`。升级方法：

- TUI：输入 `/plugins` 打开插件列表，按 `ctrl+r` 立即检查，选中本插件后按 `ctrl+u` 升级。
- Desktop：在设置的 Extensions → Plugins 中点 Update。

升级后插件自动重新加载，不用重启 OpenCode。需要固定版本时，把 `#semver:*` 换成 `#v0.1.1` 这样的 tag，固定版本不会提示更新。

### 离线安装

在能联网的机器上，从 Release 下载 tarball 和校验文件：

```bash
VERSION=0.1.1
BASE=https://github.com/DaoCloud/opencode-safety-policy/releases/download/v$VERSION
curl -fL -O "$BASE/daocloud-opencode-safety-policy-$VERSION.tgz" -O "$BASE/SHA256SUMS"
```

把这两个文件拷到目标机器，校验后解压。OpenCode 不能直接从 tarball 安装插件，需要先解压成目录：

```bash
sha256sum -c SHA256SUMS   # macOS 上用 shasum -a 256 -c SHA256SUMS
mkdir -p ~/.config/opencode/safety-policy
tar xzf daocloud-opencode-safety-policy-$VERSION.tgz -C ~/.config/opencode/safety-policy --strip-components=1
```

然后在 `~/.config/opencode/opencode.json` 中注册。相对路径以这个配置文件所在的目录为基准：

```json
{
  "plugins": [{ "package": "./safety-policy" }]
}
```

- 不要解压到会被自动加载的 `~/.config/opencode/plugins/` 下，原因见设计文档 [8](docs/opencode-safety-policy-design.md#8-分发与部署方案适配-infra-integrate-场景) 的第 2 点。
- 升级时先删除 `~/.config/opencode/safety-policy`，再解压新版本，然后重启 OpenCode。

### 系统级部署

跳板机这类多人共用的机器应该强制启用插件。系统级部署时插件文件归 root 所有，项目配置无法卸载它，也无法用同 ID 的插件冒充它。下面以 Linux 为例，这套流程已在一次性容器中验证（见 `test/system/`）。

按[离线安装](#离线安装)下载并校验 tarball，然后解压：

```bash
sudo mkdir -p /etc/opencode/safety-policy
sudo tar --no-same-owner -xzf daocloud-opencode-safety-policy-$VERSION.tgz -C /etc/opencode/safety-policy --strip-components=1
```

在 `/etc/opencode/opencode.json` 中加入下面的配置。文件已存在时，把这些内容合并进去：

```json
{
  "policies": [
    { "action": "plugin.use", "resource": "*", "effect": "deny" },
    { "action": "plugin.use", "resource": "/etc/opencode/safety-policy", "effect": "allow" }
  ],
  "plugins": [{ "package": "./safety-policy", "options": { "mode": "strict" } }]
}
```

- `policies` 只允许加载本插件。其他插件都不会加载，项目中伪造的同 ID 插件也一样。如果还要使用其他受信任的插件，在 `policies` 末尾为它追加一条 `allow`。
- 不要放到会被自动加载的 `/etc/opencode/plugins/` 下，原因同上。
- 要禁止用户在运行时切换模式，在 `/etc/profile.d/opencode-safety.sh` 中加入 `export OPENCODE_SAFETY_LOCK_MODE=strict`。
- 升级时先删除 `/etc/opencode/safety-policy`，再解压新版本，然后重启 OpenCode。

### macOS

在线安装和离线安装与 Linux 相同，用户目录同样是 `~/.config/opencode/` 和 `~/.cache/opencode/`。

系统级部署的流程也相同，区别如下：

- 系统配置目录是 `/Library/Application Support/opencode/`，把上文的 `/etc/opencode` 都换成它。路径中有空格，命令中要加引号：

  ```bash
  SYS="/Library/Application Support/opencode"
  sudo mkdir -p "$SYS/safety-policy"
  sudo tar --no-same-owner -xzf daocloud-opencode-safety-policy-$VERSION.tgz -C "$SYS/safety-policy" --strip-components=1
  ```

  `policies` 中的 `resource` 相应改为 `/Library/Application Support/opencode/safety-policy`。
- `OPENCODE_SAFETY_LOCK_MODE` 写到 `/etc/zshenv`，zsh 是 macOS 的默认 shell，每次启动都会读取它。用户的 shell 是 bash 时写到 `/etc/profile`。OpenCode Desktop 启动时会从用户的登录 shell 读取环境变量，所以同样生效。
- 通过 MDM 下发配置（`ai.opencode.managed.plist`）时，相对路径以 `/Library/Managed Preferences/` 为基准，`package` 和 `resource` 都要写插件目录的绝对路径。

已知限制：

- 插件探测不到 Server 正在监听的端口（Linux 上读取 `/proc`），所以本机任意端口上的 `/api` 请求都会被拦截，`kubectl proxy`、Prometheus 等其他服务也不例外。
- 文件系统默认不区分大小写，见[安全边界](#安全边界)。

CI 在 macOS 上运行单元测试和 E2E 测试。系统级部署只在 Linux 容器中验证过。

### 确认安装

在 TUI 中输入 `/safety status`。如果弹出 Toast `当前模式：strict（source: ...）`，说明插件已经加载。

## 使用

### /safety 命令

`/safety` 是 TUI 命令，不对模型开放。模式设置对所有项目和 Session 生效，重启后依然保留。

| 命令 | 作用 |
|---|---|
| `/safety` 或 `/safety status` | 显示当前模式及其来源、是否被锁定、TTL 剩余时间，以及最近 24 小时的拦截统计 |
| `/safety strict`、`/safety relaxed`、`/safety off` | 切换模式 |
| `/safety relaxed --ttl 30m` | 临时切换，到期后自动回到切换前的模式。TTL 单位为 `s`、`m`、`h` |
| `/safety test <命令>` | 只判定不执行，显示拆壳链和命中的规则 |

- 被拒绝的调用会以 `[safety-policy:<规则 ID>] <原因>` 错误返回给模型，命令不会执行。
- 需要确认的命令会弹出 OpenCode 的审批框，TUI 同时用 Toast 显示原因。即使在审批框中选择始终允许，被插件标记的命令下次仍会弹出审批。

模式的优先级从高到低：

1. 环境变量 `OPENCODE_SAFETY_LOCK_MODE`。它会锁定模式，`/safety` 无法再切换
2. `/safety` 设置的模式
3. 环境变量 `OPENCODE_SAFETY_MODE`
4. 插件配置中的 `options.mode`
5. 默认的 `strict`

### 离线判定

`cli.ts` 不需要启动 OpenCode。它用内置规则判定一条命令，输出与 `/safety test` 相同。运行它需要 `bun`：

```bash
bun ~/.config/opencode/safety-policy/cli.ts test --mode relaxed "ssh node1 'kubectl delete pod web-0'"
```

`--options <file>` 读取一个 JSON 文件，结构与插件的 `options` 相同。

## 配置

插件的 `options` 字段都可以省略：

| 字段 | 说明 |
|---|---|
| `mode` | 默认模式，可选 `strict`、`relaxed`、`off`，默认为 `strict` |
| `alwaysProtectSelf` | `off` 模式下是否仍然保护插件和安全配置，默认为 `true` |
| `protectedEndpoints` | 受保护的管理端点，分为 `bmcCidrs`、`ufmHosts`、`nicoHosts` 三类，每项是 IP、CIDR 或主机名。发往这些端点的写请求在 `strict` 下拒绝，在 `relaxed` 下弹出审批 |
| `rulesFile` | 外挂规则文件，是绝对路径的数组。文件修改后自动重新加载 |
| `extraDeny`、`extraAsk`、`extraAllow` | 内联规则，格式与规则文件中的规则相同，可以省略 `severity` 和 `reason` |
| `sshReadOnlyAllowlist` | 追加到只读白名单的命令前缀，如 `"mlxlink"`。`strict` 下，未命中规则的远端命令只有在白名单中才直接放行，否则弹出审批。读取插件配置等受保护文件的本机命令也要在白名单中 |
| `auditLogPath` | 审计日志的绝对路径，格式为 JSONL，记录拒绝、需确认和模式切换。不配置就不记录 |
| `enableServerSlashCommand` | 为不运行 TUI 的客户端（如 Web UI）注册服务端 `/safety`，默认为 `false`。运行 TUI 时不要开启 |

如果 `options` 非法或规则文件无法加载，插件会拒绝所有工具调用（`off` 模式除外），原因以 `[safety-policy:config-error]` 开头。完整示例见设计文档 [7](docs/opencode-safety-policy-design.md#7-配置示例opencodejson)。

## 扩展规则

在本机增加规则时，写一个规则文件，把它的绝对路径加入 `rulesFile`。文件格式是 `{ "rules": [...] }`：

```json
{
  "rules": [
    {
      "id": "nico-reset",
      "severity": "high",
      "command": "nico-cli",
      "subcommands": ["reset", "wipe"],
      "reason": "禁止通过 Agent 重置 NICo 节点",
      "examples": { "match": ["nico-cli reset node-1"], "ignore": ["nico-cli show node-1"] }
    }
  ]
}
```

- `severity` 的处置：
  - `critical` 在 `strict` 和 `relaxed` 下都拒绝。
  - `high` 在 `strict` 下拒绝，在 `relaxed` 下弹出审批。
  - `medium` 在 `strict` 下弹出审批，在 `relaxed` 下放行。
- 规则作用于拆壳后的每条原子命令，本机和远端都适用。
- 外挂规则中的 `examples` 只校验格式，不会自动运行。改完规则后，用 `/safety test <命令>` 确认判定结果。

每个字段的含义和写法、内联规则、拦截 MCP 工具、排错方法，见[自定义规则指南](docs/opencode-safety-policy-custom-rules.md)。

要为所有用户新增内置规则，见[内置规则开发指南](docs/opencode-safety-policy-builtin-rules.md)。

## 安全边界

- 插件与 Agent 以同一个 OS 用户运行。它能拦下误操作和常见的绕过写法，但挡不住刻意对抗的 Agent，比如在解释器代码里动态拼接命令。生产环境仍然需要远端最小权限凭据，如 Kubeconfig、BMC、UFM 的只读账号。
- 模式切换的 RPC 经本机 Server API 暴露。插件拦截了读取 Server 密码和调用 Server API 的常见写法，但不能覆盖所有写法。需要硬保证时，使用 `OPENCODE_SAFETY_LOCK_MODE`。
- 在线安装和离线安装都是用户级安装，项目配置中的 `"plugins": ["-*"]` 可以卸载它们。如果要打开不可信的仓库，或者需要强制启用插件，请使用系统级部署。
- 用户在 TUI 中直接输入的 `!命令` 不经过插件。
- OpenCode 的自动审批会放行 `ask`，但不会放行 `deny`。无人值守时绝不能放行的操作，要配置成 `deny`。
- 远端已有脚本（如 `ssh host /opt/cleanup.sh`）的内容不可见，插件按未知远端命令处理。
- macOS 的文件系统默认不区分大小写，但规则和受保护路径都按大小写敏感比较。`~/.config/OpenCode/` 这类改了大小写的路径和 `KUBECTL delete` 这类改了大小写的命令名可以绕过检查。

完整说明见设计文档 [1.2](docs/opencode-safety-policy-design.md#12-非目标与安全边界)。

## 开发

```bash
bun install
bun run typecheck
bun test              # 单元测试
bun run test:e2e      # 需要本机的 opencode。macOS 上先执行 sudo ifconfig lo0 alias 127.0.0.2 up
bun run test:system   # 需要 docker 和本机的 opencode，在一次性容器中验证系统级部署
```

- [开发执行流程](docs/opencode-safety-policy-dev-plan.md)
- [内置规则开发指南](docs/opencode-safety-policy-builtin-rules.md)：新增或修改 `rules/` 下的内置规则
- [手工试用指南](docs/opencode-safety-policy-manual-test.md)：用真实模型试用

发布流程：

1. 修改 `package.json` 中的 `version`，合入 `main`。
2. 确认 `main` 上的 CI 通过后，推送同名 tag，例如 `git tag v0.1.0 && git push origin v0.1.0`。tag 推送后，在线安装的用户就能升级到它，不会等 `release.yml` 跑完。
3. `release.yml` 跑完全部测试后，把 tgz 和 `SHA256SUMS` 附到 GitHub Release。
