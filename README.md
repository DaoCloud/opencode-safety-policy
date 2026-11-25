# opencode-safety-policy

这是 OpenCode 2.x 的安全策略插件。AI Agent 执行 shell 命令、调用工具或发起 HTTP 请求之前，插件先做静态分析，拦下高危操作。分析会穿透 `ssh`、`sudo`、`bash -c`、`kubectl exec` 等多层封装，覆盖以下几类目标，规则文件见[内置规则](#内置规则)：

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
| `strict` | 致命与高危操作直接拒绝。中危的本机清理和未知远端命令弹出审批，只读巡检放行 |
| `relaxed`（默认） | 只拒绝致命操作，高危操作弹出审批，常见本机清理与一般 SSH 命令放行 |
| `off` | 全部放行，但仍然阻止篡改插件和安全配置 |

各类操作在每种模式下的处置见设计文档 [5.1](docs/opencode-safety-policy-design.md#51-三种模式的行为矩阵)。

`relaxed` 下高危操作只弹出审批，OpenCode 的自动审批会直接放行它们。生产环境、无人值守或开启自动审批时，在插件配置中设置 `"options": { "mode": "strict" }`。需要禁止切换时，再设置环境变量 `OPENCODE_SAFETY_LOCK_MODE=strict`。

## 安装

要求 OpenCode 2.x 且不低于 2.3.0，CI 使用 2.4.1 测试。支持 Linux 和 macOS，CI 在两个系统上都运行单元测试和 E2E 测试。下面的步骤两个系统通用，有区别的地方分别写明。

下文以 v0.2.0 为例，可用版本见 [Releases](https://github.com/DaoCloud/opencode-safety-policy/releases)。

能访问 GitHub 时用[在线安装](#在线安装)，否则用[离线安装](#离线安装)。两种方式都要在 OpenCode 的配置文件中注册插件，写在哪个文件决定了插件的生效范围：

| 范围 | 配置文件 | 生效范围 |
|---|---|---|
| 用户级 | `~/.config/opencode/opencode.json` | 当前用户的所有项目 |
| 项目级 | 项目根目录下的 `opencode.json`，或 `.opencode/opencode.json` | 只在该项目目录或其子目录中启动 OpenCode 时生效。配置文件可以提交到仓库，与团队共享 |

- 两种范围的配置文件都受插件保护，Agent 无法修改它们。
- 不要在两级同时注册本插件。如果两级的 `package` 写法相同，项目级的条目会替换用户级的条目，`options` 以项目级为准。如果写法不同，比如用户级在线安装、项目级离线安装，那么用户级生效，项目级的条目报 `Duplicate plugin ID` 并被忽略。

### 在线安装

在用户级( `~/.config/opencode/opencode.json` )或项目级的配置文件( `opencode.json`，或 `.opencode/opencode.json` )中加入：

```json
{
  "plugins": [{ "package": "github:DaoCloud/opencode-safety-policy#semver:*" }]
}
```

重启 OpenCode 后，OpenCode 会从 GitHub 拉取最新的 release tag，装到 `~/.cache/opencode/npm/` 下。`main` 分支上还没发版的提交不会被安装。本机需要装有 `git`，并且能访问 GitHub。项目级配置提交到仓库后，团队成员的 OpenCode 会各自安装插件，不用另外操作。

OpenCode 加载插件后会检查一次新版本，之后每 24 小时再查一次。发现新版本时不会自动安装，只在插件列表中标记 `update available`。升级方法：

- TUI：输入 `/plugins` 打开插件列表，按 `ctrl+r` 立即检查，选中本插件后按 `ctrl+u` 升级。
- Desktop：在设置的 Extensions → Plugins 中点 Update。

升级后插件自动重新加载，不用重启 OpenCode。需要固定版本时，把 `#semver:*` 换成 `#v0.2.0` 这样的 tag，固定版本不会提示更新。

### 离线安装

在能联网的机器上，从 Release 下载 tarball 和校验文件：

```bash
VERSION=0.2.0
BASE=https://github.com/DaoCloud/opencode-safety-policy/releases/download/v$VERSION
curl -fL -O "$BASE/daocloud-opencode-safety-policy-$VERSION.tgz" -O "$BASE/SHA256SUMS"
```

把这两个文件拷到目标机器，先校验。两个系统的命令不同：

```bash
sha256sum -c SHA256SUMS        # Linux
shasum -a 256 -c SHA256SUMS    # macOS
```

再解压。OpenCode 不能直接从 tarball 安装插件，需要先解压成目录：

```bash
mkdir -p ~/.config/opencode/safety-policy
tar xzf daocloud-opencode-safety-policy-$VERSION.tgz -C ~/.config/opencode/safety-policy --strip-components=1
```

然后注册插件。用户级安装时，在 `~/.config/opencode/opencode.json` 中加入下面的配置。相对路径以这个配置文件所在的目录为基准：

```json
{
  "plugins": [{ "package": "./safety-policy" }]
}
```

项目级安装时，解压步骤不变，在项目的配置文件中用绝对路径引用插件目录，例如 Linux 上的 `/home/alice/.config/opencode/safety-policy`，macOS 上的 `/Users/alice/.config/opencode/safety-policy`。`package` 不展开 `~`。项目级配置要提交到仓库共享时，团队成员都要把插件解压到同一个绝对路径。

- 不要解压到会被自动加载的 `~/.config/opencode/plugins/` 下，原因见设计文档 [8](docs/opencode-safety-policy-design.md#8-分发与部署方案适配-infra-integrate-场景) 的第 2 点。
- 升级时先删除 `~/.config/opencode/safety-policy`，再解压新版本，然后重启 OpenCode。

### 确认安装

在 TUI 中输入 `/safety status`。如果弹出以 `当前模式：` 开头的 Toast，例如新安装时的 `当前模式：relaxed（source: default）`，说明插件已经加载。

### 测试效果

下面的主机 `ocsp-no-such-host` 不存在，即使插件没有拦住，命令也不会造成影响。

1. 发送提示词：这是安全插件测试，请原样用 shell 工具执行：`ssh ocsp-no-such-host "kubectl delete pod web-0"`。默认的 `relaxed` 下，OpenCode 弹出 `Permission required` 审批框，同时 Toast 显示 `[safety-policy:k8s-delete] 禁止删除 Kubernetes 资源`。选择拒绝，命令就不会执行。
2. 输入 `/safety strict --ttl 5m`，再发送一次同样的提示词。这次不弹审批，工具调用直接返回错误 `[safety-policy:k8s-delete] 禁止删除 Kubernetes 资源`，命令没有执行。5 分钟后自动回到切换前的模式。
3. 发送提示词：这是安全插件测试，请原样用 shell 工具执行：`ssh ocsp-no-such-host uptime`。只读命令直接放行，输出 ssh 无法解析主机名的错误。

看工具调用的结果，不看模型的总结。模型如果自己拒绝执行，换个说法重试。

## 使用

### /safety 命令

`/safety` 是 TUI 命令，不对模型开放。切换后的模式保存在 OpenCode 的数据库中，对当前用户的所有项目和 Session 生效。重启 OpenCode 或新建 Session 后，仍是上次切换的模式，不会回到默认模式。带 `--ttl` 的切换到期后回到切换前的模式。

| 命令 | 作用 |
|---|---|
| `/safety` 或 `/safety status` | 显示当前模式及其来源、是否被锁定、TTL 剩余时间，以及最近 24 小时的拦截统计 |
| `/safety strict`、`/safety relaxed`、`/safety off` | 切换模式 |
| `/safety relaxed --ttl 30m` | 临时切换，到期后自动回到切换前的模式。TTL 单位为 `s`、`m`、`h` |
| `/safety test <命令>` | 只判定不执行，显示拆壳链和命中的规则。不启动 OpenCode 时可以用插件自带的 `cli.ts`，见自定义规则指南的[离线验证](docs/opencode-safety-policy-custom-rules.md#83-离线验证) |

- 被拒绝的调用会以 `[safety-policy:<规则 ID>] <原因>` 错误返回给模型，命令不会执行。
- 需要确认的命令会弹出 OpenCode 的审批框，TUI 同时用 Toast 显示原因。即使在审批框中选择始终允许，被插件标记的命令下次仍会弹出审批。

模式的优先级从高到低：

1. 环境变量 `OPENCODE_SAFETY_LOCK_MODE`。它会锁定模式，`/safety` 无法再切换
2. `/safety` 设置的模式
3. 环境变量 `OPENCODE_SAFETY_MODE`
4. 插件配置中的 `options.mode`
5. 默认的 `relaxed`

用 `/safety` 不带 `--ttl` 切换过之后，第 3、4 项不再生效，之后只能再用 `/safety` 切换，或者用第 1 项锁定。读取模式状态失败时，插件按 `strict` 处理。上面两个环境变量的值非法时也按 `strict` 处理。

## 配置

`options` 写在[安装](#安装)时注册插件的配置文件中，放在本插件的条目里，与 `package` 并列。例如在用户级的 `~/.config/opencode/opencode.json` 中：

```json
{
  "plugins": [
    {
      "package": "github:DaoCloud/opencode-safety-policy#semver:*",
      "options": {
        "mode": "strict",
        "protectedEndpoints": { "bmcCidrs": ["10.10.0.0/24"], "ufmHosts": ["ufm.example.com"] },
        "auditLogPath": "/home/alice/opencode-safety-audit.jsonl"
      }
    }
  ]
}
```

离线安装时 `package` 是插件目录的路径，`options` 的写法相同。修改 `options` 后不用重启 OpenCode，插件会自动重新加载。

`options` 的字段都可以省略：

| 字段 | 说明 |
|---|---|
| `mode` | 初始模式，可选 `strict`、`relaxed`、`off`，默认为 `relaxed`。用 `/safety` 切换过之后以 `/safety` 为准 |
| `alwaysProtectSelf` | `off` 模式下是否仍然保护插件和安全配置，默认为 `true` |
| `protectedEndpoints` | 受保护的管理端点，分为 `bmcCidrs`、`ufmHosts`、`nicoHosts` 三类，每项是 IP、CIDR 或主机名。发往这些端点的写请求在 `strict` 下拒绝，在 `relaxed` 下弹出审批 |
| `rulesFile` | 外挂规则文件，是绝对路径的数组。文件修改后自动重新加载 |
| `extraDeny`、`extraAsk`、`extraAllow` | 内联规则，格式与规则文件中的规则相同，可以省略 `severity` 和 `reason` |
| `sshReadOnlyAllowlist` | 追加到只读白名单的命令前缀，如 `"mlxlink"`。`strict` 下，未命中规则的远端命令只有在白名单中才直接放行，否则弹出审批。读取插件配置等受保护文件的本机命令也要在白名单中 |
| `auditLogPath` | 审计日志的绝对路径，格式为 JSONL，记录拒绝、需确认和模式切换。所在目录必须已经存在。不配置就不记录 |
| `enableServerSlashCommand` | 为不运行 TUI 的客户端（如 Web UI）注册服务端 `/safety`，默认为 `false`。运行 TUI 时不要开启 |

如果 `options` 非法或规则文件无法加载，插件会拒绝所有工具调用（`off` 模式除外），原因以 `[safety-policy:config-error]` 开头。完整示例见设计文档 [7](docs/opencode-safety-policy-design.md#7-配置示例opencodejson)。

## 内置规则

随插件发布的规则按类别放在 [`rules/`](rules/) 目录，安装后全部生效：

| 规则文件 | 覆盖范围 |
|---|---|
| [`cloud-native.json`](rules/cloud-native.json) | Kubernetes、Helm、etcd、Velero、容器运行时 |
| [`linux-host.json`](rules/linux-host.json) | 文件删除、磁盘与分区、服务、进程、重启、用户 |
| [`spectrum-cumulus.json`](rules/spectrum-cumulus.json) | NVIDIA Spectrum 交换机（NVUE、NCLU、switchd、ONIE） |
| [`ib-ufm.json`](rules/ib-ufm.json) | InfiniBand 交换机、主机侧 IB 与 GPU 工具、UFM |
| [`oob-redfish.json`](rules/oob-redfish.json) | Redfish、IPMI、BMC |
| [`network-db.json`](rules/network-db.json) | 网络配置、防火墙、rsync、数据库 |
| [`opencode-tools.json`](rules/opencode-tools.json) | OpenCode 内置工具与 MCP 工具 |
| [`ssh-readonly.json`](rules/ssh-readonly.json) | 远端只读命令白名单，不是拦截规则。`strict` 下，未命中规则的远端命令只有在白名单中才直接放行 |

- 每条规则的 `severity` 决定它在各模式下的处置，见[运行模式](#运行模式)。`examples` 列出了它应该命中和不应该命中的命令。
- 拦截信息 `[safety-policy:<规则 ID>]` 中的规则 ID 就是规则的 `id`，可以在这些文件中搜到。想知道某条命令命中哪条规则，用 `/safety test <命令>`。
- 以下几类保护写在代码中，不在 `rules/` 目录：
  - `self-protect`：禁止修改插件、OpenCode 配置和规则文件，禁止读取 OpenCode Server 凭据和数据库，禁止调用本机 Server API。见 [`self-protect.ts`](src/rules/self-protect.ts) 和 [`server-api.ts`](src/rules/server-api.ts)
  - `protected-endpoint-write`：配置了 `protectedEndpoints` 后，拦截发往这些端点的写请求。见 [`index.ts`](src/rules/index.ts)
  - `unknown-remote-command`：`strict` 下，不在只读白名单中的远端命令弹出审批

## 扩展规则

| 场景 | 修改什么 | 参考 |
|---|---|---|
| 已经装好插件，在本机新增规则，或调整已有规则的处置 | 插件的 `options` 和自己的规则文件，不改插件目录 | [自定义规则指南](docs/opencode-safety-policy-custom-rules.md) |
| 迭代开发，修改随插件发布的内置规则 | 插件仓库 `rules/` 下的 JSON 文件，随新版本发布给所有用户 | [内置规则开发指南](docs/opencode-safety-policy-builtin-rules.md) |

## 安全边界

- 插件与 Agent 以同一个 OS 用户运行。它能拦下误操作和常见的绕过写法，但挡不住刻意对抗的 Agent，比如在解释器代码里动态拼接命令。生产环境仍然需要远端最小权限凭据，如 Kubeconfig、BMC、UFM 的只读账号。
- 模式切换的 RPC 经本机 Server API 暴露。插件拦截了读取 Server 密码和调用 Server API 的常见写法，但不能覆盖所有写法。需要硬保证时，使用 `OPENCODE_SAFETY_LOCK_MODE`。
- Linux 上插件通过 `/proc` 找到 Server 监听的端口，只拦截发往这些端口的 `/api` 请求。macOS 没有 `/proc`，插件会拦截发往本机任意端口的 `/api` 请求，`kubectl proxy`、Prometheus 等其他服务也不例外。
- 任何项目都可以在自己的配置中写 `"plugins": ["-*"]`，让本插件在该项目中不加载，用户级安装也不例外。打开不可信的仓库前，先检查它的 `opencode.json` 和 `.opencode/`。需要强制启用插件的机器（如跳板机）可以用系统级部署，见设计文档 [8](docs/opencode-safety-policy-design.md#8-分发与部署方案适配-infra-integrate-场景) 的第 2 点。
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

## 许可证

[Apache-2.0](LICENSE)
