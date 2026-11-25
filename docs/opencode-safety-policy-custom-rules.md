# 自定义规则指南

本文面向插件的使用者，说明怎样在自己的机器上给插件添加规则。不需要修改插件代码，也不需要重新打包，保存配置后即可生效。

要给插件新增随版本发布的内置规则，见[内置规则开发指南](opencode-safety-policy-builtin-rules.md)。

## 1. 扩展方式

所有扩展都写在插件配置的 `options` 中：

| 需求 | 使用 |
|---|---|
| 拦截一批命令或工具调用，按严重程度在不同模式下分别处置 | `rulesFile` 外挂规则文件 |
| 少量规则，在 `strict` 和 `relaxed` 下都拒绝 | `extraDeny` |
| 少量规则，在 `strict` 和 `relaxed` 下都至少弹出审批 | `extraAsk` |
| 放行被内置 `high`、`medium` 规则拦下的特定命令 | `extraAllow` |
| `strict` 下放行某些远端只读命令，不再弹出审批 | `sshReadOnlyAllowlist` |
| 拦截发往 BMC、UFM、NICo 管理端点的写请求 | `protectedEndpoints`，见 README 的[配置](../README.md#配置) |

不要直接修改插件目录下的 `rules/*.json`。在线安装升级时会重新下载插件，离线安装和系统级部署升级时要删除旧目录，改动都会丢失。

## 2. 快速上手

下面的例子禁止 Agent 擦除或重置 NICo 节点。

**第 1 步：创建规则文件。** 推荐放在 OpenCode 的全局配置目录下，例如 `/home/alice/.config/opencode/safety-rules.json`：

```json
{
  "rules": [
    {
      "id": "team-nico-wipe",
      "severity": "critical",
      "reason": "禁止通过 Agent 擦除或重置 NICo 节点",
      "command": "nico-cli",
      "subcommands": ["node wipe", "node reset"],
      "examples": {
        "match": ["nico-cli node wipe n1", "nico-cli --region bj node reset n1"],
        "ignore": ["nico-cli node show n1", "echo nico-cli node wipe n1"]
      }
    }
  ]
}
```

文件的顶层是一个对象，`rules` 数组中的每个元素是一条规则。各字段的含义见[第 4 节](#4-字段说明)。

**第 2 步：在插件配置中引用它。** 编辑注册插件的配置文件，用户级是 `~/.config/opencode/opencode.json`，项目级是项目中的 `opencode.json` 或 `.opencode/opencode.json`，见 README 的[安装](../README.md#安装)。给插件条目加上 `options`：

```json
{
  "plugins": [
    {
      "package": "github:DaoCloud/opencode-safety-policy#semver:*",
      "options": { "rulesFile": ["/home/alice/.config/opencode/safety-rules.json"] }
    }
  ]
}
```

- `rulesFile` 是数组，可以列出多个文件。
- 必须写绝对路径。插件不展开 `~` 和 `$HOME`，写成 `~/.config/...` 会报配置错误。
- 离线安装时 `package` 是插件目录的路径，`options` 的写法相同。
- 系统级部署（见设计文档 [8](opencode-safety-policy-design.md#8-分发与部署方案适配-infra-integrate-场景) 的第 2 点）时，`options` 写在 `/etc/opencode/opencode.json` 中，规则文件也放在 `/etc/opencode/` 下，由管理员维护。

**第 3 步：确认生效。** 不用重启 OpenCode，在 TUI 中输入：

```text
/safety test ssh admin@jump 'sudo /usr/local/bin/nico-cli node wipe n1'
```

输出如下，说明规则已经生效：

```text
命令：ssh admin@jump 'sudo /usr/local/bin/nico-cli node wipe n1'
模式：strict
结果：deny [team-nico-wipe] 禁止通过 Agent 擦除或重置 NICo 节点

1. /usr/local/bin/nico-cli node wipe n1
   位置：远端 jump
   拆壳链：ssh → sudo
   判定：deny [team-nico-wipe] 禁止通过 Agent 擦除或重置 NICo 节点
```

此后 Agent 再执行这类命令，命令不会执行，模型收到错误 `[safety-policy:team-nico-wipe] 禁止通过 Agent 擦除或重置 NICo 节点`。

## 3. 规则作用在哪里

插件先把一条 shell 命令拆成若干条**原子命令**，再对每条原子命令逐一匹配规则：

- 按管道、`&&`、`||`、`;`、`$(...)` 等拆开。`nico-cli node show n1 && rm -rf ./tmp` 是两条原子命令。
- 剥掉 `ssh`、`sudo`、`env`、`timeout`、`bash -c`、`xargs`、`kubectl exec` 等外壳，规则看到的是最里层的命令。上面的例子中，规则看到的是 `/usr/local/bin/nico-cli node wipe n1`，位置是远端 `jump`。
- 命令名取 basename，`/usr/local/bin/nico-cli` 按 `nico-cli` 匹配。
- 本机的路径参数展开为绝对路径，并跟踪 `cd`。`cd /data && rm -rf models` 中的 `models` 按 `/data/models` 匹配。
- 各条原子命令的结果按 `deny > ask > allow` 合并，取最严的作为整条命令的结果。

所以规则只需描述最里层的命令，不用考虑 `sudo`、`ssh` 等各种写法。`echo nico-cli node wipe n1` 和 `grep 'nico-cli node wipe' a.log` 的命令名是 `echo` 和 `grep`，不会命中 `command` 为 `nico-cli` 的规则。

MCP 工具等非 shell 工具的调用也按一条原子命令处理，见[第 6 节](#6-拦截-mcp-工具)。

## 4. 字段说明

| 字段 | 规则文件中 | 内联规则中 | 取值 |
|---|---|---|---|
| `id` | 必填 | 必填 | 非空字符串 |
| `severity` | 必填 | 可省略，写了也不影响判定 | `critical`、`high`、`medium` |
| `reason` | 必填 | 可省略 | 非空字符串 |
| `command` | 可选 | 可选 | 字符串，或非空字符串数组 |
| `subcommands` | 可选，需要同时写 `command` | 同左 | 非空字符串数组 |
| `flags` | 可选，需要同时写 `command` | 同左 | 非空字符串数组 |
| `pattern` | 可选 | 可选 | 正则表达式字符串 |
| `http` | 可选 | 可选 | 对象，含 `methods`、`urlPatterns`、`bodyPatterns` |
| `scope` | 可选 | 可选 | `local` 或 `remote` |
| `examples` | 可选 | 可选 | 对象，含 `match`、`ignore` 两个字符串数组 |

- `command`、`pattern`、`http` 至少要写一个。
- 一条规则中写出的匹配条件（`command`、`subcommands`、`flags`、`pattern`、`http`、`scope`）要同时满足才算命中。数组中的多项之间是"任一"关系。
- 字段名区分大小写。不认识的字段（如把 `subcommands` 写成 `subcommand`）会导致加载失败。

### 4.1 `id`

`id` 是你给这条规则起的名字，由你自己决定，插件不解析它的含义。它会出现在这些地方：

- 模型收到的拒绝信息：`[safety-policy:team-nico-wipe] 禁止通过 Agent 擦除或重置 NICo 节点`
- `/safety test` 的输出：`deny [team-nico-wipe] ...`
- 审计日志（`auditLogPath`）中每条记录的 `ruleId`
- `/safety status` 的拦截统计：`team-nico-wipe ×3`

规则如下：

- 必须全局唯一，不是按文件唯一。插件把内置规则、所有 `rulesFile` 文件中的规则和 `extraDeny`、`extraAsk`、`extraAllow` 合到一起检查：同一个文件内不能重复，两个规则文件之间、规则文件与内联规则之间、自定义规则与内置规则之间也不能重复。重复时整个配置加载失败，报错 `duplicate rule id "<id>"`。
- 建议用小写字母和连字符，并加上团队或个人前缀，如 `team-`、`alice-`。内置规则用 `k8s-`、`rm-`、`redfish-` 等领域前缀，以后的版本还会增加新的内置规则，自己的前缀可以避免升级后撞名。
- 不要使用插件内部的 ID：`self-protect`、`config-error`、`policy-error`、`unknown-remote-command`、`opaque`、`dynamic-command`、`protected-endpoint-write`。
- 查看已有的内置规则 ID：`jq -r '.rules[]?.id' <插件目录>/rules/*.json`，或者看设计文档 [4.2](opencode-safety-policy-design.md#42-规则分类明细)。

`id` 和[第 6 节](#6-拦截-mcp-工具)中的"工具 ID"不是一回事。工具 ID 写在 `command` 中，必须与 OpenCode 中的工具名完全一致。

### 4.2 `severity`

决定规则命中后在各模式下怎么处置：

| `severity` | `strict` | `relaxed` | `off` |
|---|---|---|---|
| `critical` | 拒绝 | 拒绝 | 放行 |
| `high` | 拒绝 | 弹出审批 | 放行 |
| `medium` | 弹出审批 | 放行 | 放行 |

- `critical`：不可逆，或会影响整台主机、整个集群，任何时候都不应由 Agent 执行。例如擦除节点、格式化磁盘。
- `high`：破坏性操作，但偶尔确有需要。用户切到 `relaxed` 后可以逐条审批放行。例如删除 Kubernetes 资源、重启服务。
- `medium`：常见的日常操作，`strict` 下需要确认一次。例如删除本机工作区的文件。

OpenCode 的自动审批会放行 `ask`，但不会放行 `deny`。无人值守时也绝不能执行的操作，用 `critical` 或 `extraDeny`。

内联规则的处置由它所在的列表决定，见[第 5 节](#5-内联规则)，`severity` 不起作用。

### 4.3 `reason`

拦截原因。模型会在拒绝信息中看到它，用户在审批框、Toast 和 `/safety test` 中看到它。写清楚禁止什么，必要时说明原因，例如"禁止通过 Agent 擦除或重置 NICo 节点"。

内联规则省略 `reason` 时，默认为 `extraDeny rule "<id>"` 这样的英文文本。建议总是写上。

### 4.4 `command`

命令名，或命令名的数组，任一项相同即命中：

```json
"command": ["rm", "mv"]
```

- 与原子命令的命令名比较，比较前取 basename、去掉开头的反斜杠。`/usr/bin/rm`、`\rm` 都按 `rm` 匹配。
- 区分大小写。
- 写实际执行的程序名，不要写外壳。`sudo kubectl delete ...` 的命令名是 `kubectl`。
- 拦截 MCP 工具时写工具 ID，见[第 6 节](#6-拦截-mcp-工具)。

### 4.5 `subcommands`

子命令列表，任一项命中即可。每一项是一个或多个用空格分隔的词：

```json
"subcommands": ["node wipe", "node reset"]
```

- 以 `-` 开头的参数会被跳过。`nico-cli --region bj node reset n1` 命中 `node reset`。
- 多词项的各个词在位置参数中按顺序出现即可，不要求相邻。
- 插件内置了选项表的命令（`kubectl`、`docker`、`iptables` 系列），第一个词必须是第一个位置参数。其他命令的第一个词可以出现在任意位置参数上。这样未知的带值选项（如 `--region bj`）遮不住子命令，代价是可能误报：

  | 命令 | `subcommands` | 结果 |
  |---|---|---|
  | `nico-cli node show --name reset` | `["node reset"]` | 命中，`--name` 的值 `reset` 被当作位置参数 |
  | `deployctl logs --app release -f` | `["release"]`，`flags` 为 `["-f"]` | 命中 |

  误报不能接受时，改用 `pattern` 限定位置，例如 `"pattern": "^nico-cli node (wipe|reset)( |$)"`。它不再误报上面的命令，但也不再命中 `nico-cli --region bj node reset n1`，要按实际用法取舍。

### 4.6 `flags`

选项列表，任一项命中即可：

```json
"flags": ["--force", "-f"]
```

| 写法 | 也会命中 |
|---|---|
| `-f` | 短选项簇，如 `-rf`、`-fy` |
| `--force` | `--force=yes`，以及前缀缩写，如 `--forc` |
| `--replicas=0` | `--replicas 0` |
| `-destroy` 等其他形式 | 只命中完全相同的参数 |

- `--` 之后的参数不参与匹配。`deployctl release app -- -f` 不命中 `-f`。
- 长选项缩写是 fail-closed 的取舍。前缀可能正好是另一个选项：`flags` 写 `["--delete-all"]` 时，`deployctl --delete app1` 也会命中。
- 插件内置了选项表的命令按表识别：`kubectl`、`docker` 只认完整的选项名；`iptables` 系列接受缩写，但表中的完整选项名只代表自己，`iptables --delete INPUT 1` 不会命中 `--delete-chain`。

### 4.7 `pattern`

JavaScript 正则表达式，在下面这个字符串中搜索，找到即命中：

```text
<命令名> <参数1> <参数2> ...
```

命令名是 basename，参数之间用一个空格连接，参数两边的引号已经去掉。例如 `sudo /usr/bin/rm -rf "/data/models"` 对应 `rm -rf /data/models`。

写 `pattern` 时注意：

- **JSON 转义**：正则中的 `\` 在 JSON 中要写成 `\\`，`"` 写成 `\"`。正则 `\S` 写作 `"\\S"`，`\.` 写作 `"\\."`。
- **路径是绝对路径**：本机路径参数已经展开，正则中按绝对路径写。`cd /data && rm -rf models` 中的参数是 `/data/models`。
- **用 `( |$)` 收尾**：`" /data/models(/\\S*)?( |$)"` 命中 `/data/models` 和 `/data/models/a`，不会命中 `/data/models-old`。
- **大小写**：默认区分大小写。可以用 `(?i:...)` 让一部分忽略大小写，如 `"(?i:drop\\s+table)"`。
- **长选项缩写**：`pattern` 按字面匹配，不识别缩写。
- **带 `command` 的规则**会把 heredoc 和 here-string 的正文（空白折叠为单个空格）接在参数后面再匹配一次。`psql <<SQL` 后面跟的 `DROP TABLE x` 也能被 `pattern` 看到。
- **不带 `command` 的规则**作用于每一条原子命令，一定要用 `^` 锚定命令名，否则会误报：

  | `pattern` | `echo nico-cli wipe` | `grep 'nico-cli wipe' a.log` | `sudo /opt/bin/nico-cli wipe n1` |
  |---|---|---|---|
  | `nico-cli wipe` | 命中 | 命中 | 命中 |
  | `^nico-cli wipe( \|$)` | 不命中 | 不命中 | 命中 |

  更稳妥的做法是同时写上 `command`。不带 `command` 的规则也不看 heredoc 正文，不匹配工具调用。

### 4.8 `http`

匹配 HTTP 请求。请求来自 `curl`、`wget`、HTTPie，以及 `python -c` 等解释器代码中能识别出的调用（如 `requests.delete(...)`），也包括经 `ssh` 在远端发出的请求：

```json
"http": { "methods": ["DELETE"], "urlPatterns": ["//cmdb\\.example\\.com/api/"] }
```

| 子字段 | 说明 |
|---|---|
| `methods` | 方法列表，任一相同即可，不区分大小写。方法无法确定时（如 `curl -X "$M"`）视为命中 |
| `urlPatterns` | 正则列表，任一匹配 URL 即可，不区分大小写。没写协议的 URL 也能被 `//host` 匹配 |
| `bodyPatterns` | 正则列表，任一匹配请求体即可，不区分大小写。请求体无法确定时视为命中 |

- 写了的子字段要同时满足，至少写一个。
- 只有 `http` 的规则只看 HTTP 请求，不看命令名和参数。

### 4.9 `scope`

把规则限定在本机或远端：

- `remote`：只匹配远端执行的原子命令。远端指经 `ssh`、`kubectl exec`、`docker`/`nerdctl`/`podman`/`crictl exec`、`ansible`、`pdsh`、`pssh`、`clush` 执行的命令。
- `local`：只匹配本机命令。
- 不写：本机和远端都匹配。

例如 `"command": "systemctl", "subcommands": ["restart"], "scope": "remote"` 拦截 `ssh n1 systemctl restart nginx`，不影响本机的 `systemctl restart nginx`。

### 4.10 `examples`

规则的示例命令。`match` 列出应该命中的命令，`ignore` 列出不应命中的命令。写了 `examples` 就要同时写这两个数组，可以为空。

外挂规则和内联规则中的 `examples` 只校验格式，不会自动运行。建议仍然写上，作为规则的说明，并把每条示例用 `/safety test` 验证一遍。

## 5. 内联规则

`extraDeny`、`extraAsk`、`extraAllow` 直接写在 `options` 中，适合少量规则。格式与规则文件中的规则相同，`severity` 和 `reason` 可以省略：

```json
{
  "plugins": [
    {
      "package": "github:DaoCloud/opencode-safety-policy#semver:*",
      "options": {
        "extraDeny": [
          { "id": "team-tf-destroy", "reason": "禁止销毁 Terraform 资源", "command": "terraform", "subcommands": ["destroy"] },
          { "id": "team-tf-apply-destroy", "command": "terraform", "subcommands": ["apply"], "flags": ["-destroy"] }
        ],
        "extraAsk": [{ "id": "team-git-push", "reason": "推送代码前需要确认", "command": "git", "subcommands": ["push"] }],
        "extraAllow": [{ "id": "team-dev-context", "command": "kubectl", "pattern": " --context[= ]dev( |$)" }]
      }
    }
  ]
}
```

每条原子命令按以下顺序判定：

1. `off` 模式全部放行，防篡改插件的检查除外。
2. 命中 `extraDeny` 或 `critical` 规则：拒绝。
3. 命中 `extraAllow`：放行。它豁免 `high`、`medium` 规则、`extraAsk` 和远端命令的默认审批，但不能豁免 `critical` 规则、`extraDeny`、防篡改插件，以及命令无法静态分析时的处置。
4. 其余情况，在 `extraAsk`（弹出审批）和 `severity` 处置中取最严的。`extraAsk` 只会把结果提高到"弹出审批"，不会放宽内置规则。

上面配置在 `strict` 下的效果：

| 命令 | 结果 |
|---|---|
| `terraform destroy` | `deny [team-tf-destroy]` |
| `terraform apply -destroy` | `deny [team-tf-apply-destroy]` |
| `terraform apply` | `allow` |
| `git -C repo push` | `ask [team-git-push]` |
| `kubectl --context dev delete pod web-0` | `allow [team-dev-context]`，豁免了 `high` 规则 `k8s-delete` |
| `kubectl --context prod delete pod web-0` | `deny [k8s-delete]` |
| `kubectl --context dev delete ns tmp` | `deny [k8s-delete-namespace]`，`critical` 规则不能豁免 |

`extraAllow` 要写得尽量窄，最好同时限定 `command`、`subcommands` 和关键参数。

## 6. 拦截 MCP 工具

规则也能拦截 MCP 工具等非 shell 工具。插件把一次工具调用当作一条本机原子命令：命令名是工具 ID，唯一的参数是紧凑 JSON 格式的工具输入，例如：

```text
deploy_rollback {"service":"api","env":"prod"}
```

- **工具 ID** 是 `<MCP 服务器名>_<工具名>`。服务器名是 `opencode.json` 中 `mcp` 下的键，工具名由 MCP 服务器定义，以服务器的文档为准。两者中 `[A-Za-z0-9_-]` 以外的字符都会换成 `_`。例如服务器名 `deploy`、工具名 `rollback`，工具 ID 就是 `deploy_rollback`。
- 规则必须用 `command` 列出工具 ID。只有 `pattern` 或 `http` 的规则不匹配工具调用。
- `pattern` 作用于上面这一整行。JSON 是紧凑格式，冒号和逗号后没有空格。字段的顺序由模型决定，不要依赖它。
- 工具 ID 写错时不会报错，规则只是永远不命中，写完要仔细核对。

例如禁止回滚生产环境：

```json
{
  "id": "team-deploy-rollback-prod",
  "severity": "critical",
  "reason": "禁止通过 MCP 回滚生产环境",
  "command": "deploy_rollback",
  "pattern": "\"env\":\"prod\""
}
```

测试时把工具调用写成 `<工具 ID> '<JSON>'`，经 shell 分词后与真实的工具调用相同：

```text
/safety test deploy_rollback '{"service":"api","env":"prod"}'
```

## 7. 远端只读白名单

`strict` 下，远端命令即使没有命中任何规则，也会弹出审批（`unknown-remote-command`），除非它在只读白名单中。内置白名单见插件的 `rules/ssh-readonly.json`，`sshReadOnlyAllowlist` 往里追加条目：

```json
"options": { "sshReadOnlyAllowlist": ["ibdiagnet", "myctl status"] }
```

| 命令 | `strict` 下的结果 |
|---|---|
| `ssh n1 ibdiagnet` | `allow` |
| `ssh n1 myctl --verbose status` | `allow`，`-` 开头的参数被跳过 |
| `ssh n1 myctl --region bj status` | `ask`，带值选项的值 `bj` 被当作位置参数 |
| `ssh n1 'myctl status > /tmp/s.txt'` | `ask`，重定向写文件的命令不算只读 |
| `ssh n1 myctl restart` | `ask` |

- 每个条目是命令前缀：命令名加零到多个子命令词，从第一个位置参数开始逐词比较。`kubectl`、`docker`、`ipmitool` 会先跳过全局选项。
- 白名单只决定"没有命中规则的远端命令"是否需要审批，不会放行命中规则的命令。
- 本机命令读取插件配置等受保护的文件时，也要在白名单中才放行。
- `relaxed` 下一般的远端命令直接放行，白名单不起作用。
- 只加入确实只读的命令。例如 `ibdiagnet` 会写诊断文件并扫描整个 fabric，内置白名单有意没有收录它。

## 8. 生效与排错

### 8.1 何时生效

| 修改 | 生效时间 |
|---|---|
| 规则文件的内容 | 下一次判定。插件每次判定前检查文件是否有变化 |
| `opencode.json` 中的 `options` | OpenCode 发现配置变化后重新加载插件，OpenCode 2.4.1 实测无需重启。没有生效时重启 OpenCode |

Agent 无法修改 `rulesFile` 中的文件和 `~/.config/opencode/` 下的配置，这些文件只能由用户手工编辑。

### 8.2 配置错误

规则文件或 `options` 有错误时，插件拒绝所有工具调用（`off` 模式除外），拒绝原因以 `[safety-policy:config-error]` 开头，后面是具体错误。改正文件后自动恢复，不用重启。常见错误：

| 错误信息 | 原因 |
|---|---|
| `options: "rulesFile" must be an array of absolute paths` | `rulesFile` 不是数组，或路径不是绝对路径（如用了 `~`） |
| `<文件>: ENOENT: no such file or directory ...` | 规则文件不存在 |
| `<文件>: JSON Parse error: ...` | JSON 语法错误，如多余的逗号 |
| `<文件>: rules[0]: rule "r1": unknown field "subcommand"` | 字段名写错 |
| `... "severity" must be one of critical, high, medium` | `severity` 取值错误 |
| `... invalid regex "(foo": ...` | 正则无法编译 |
| `... needs at least one of "command", "pattern" or "http"` | 没有任何匹配条件 |
| `rules: duplicate rule id "k8s-delete"` | `id` 与内置规则重复 |
| `options.extraAsk[0]: duplicate rule id "..."` | 内联规则的 `id` 与其他规则重复 |

`rules[0]` 是出错规则在数组中的下标，从 0 开始。

### 8.3 离线验证

`/safety test` 需要启动 OpenCode。离线安装时，也可以用插件自带的 `cli.ts` 验证，运行它需要 `bun`。把 `options` 写到一个临时文件中，用 `--options` 传入：

```bash
echo '{ "rulesFile": ["/home/alice/.config/opencode/safety-rules.json"] }' > /tmp/safety-options.json
cd ~/work
bun ~/.config/opencode/safety-policy/cli.ts test --options /tmp/safety-options.json "nico-cli node wipe n1"
bun ~/.config/opencode/safety-policy/cli.ts test --mode relaxed --options /tmp/safety-options.json "nico-cli node wipe n1"
```

- `cli.ts` 以当前目录作为命令的工作目录。不要在插件目录或 `~/.config/opencode/` 下运行，否则相对路径参数落在受保护的目录中，结果是 `self-protect`。
- 在线安装时插件在 `~/.cache/opencode/` 下，可以用 `find ~/.cache/opencode -name cli.ts -path '*opencode-safety-policy*'` 找到 `cli.ts`。

## 9. 完整示例

规则文件 `/home/alice/.config/opencode/safety-rules.json`：

```json
{
  "rules": [
    {
      "id": "team-nico-wipe",
      "severity": "critical",
      "reason": "禁止通过 Agent 擦除或重置 NICo 节点",
      "command": "nico-cli",
      "subcommands": ["node wipe", "node reset"]
    },
    {
      "id": "team-deploy-force",
      "severity": "high",
      "reason": "禁止强制发布",
      "command": "deployctl",
      "subcommands": ["release"],
      "flags": ["--force", "-f"]
    },
    {
      "id": "team-rm-models",
      "severity": "critical",
      "reason": "禁止删除或移动模型目录 /data/models",
      "command": ["rm", "mv"],
      "pattern": " /data/models(/\\S*)?( |$)"
    },
    {
      "id": "team-remote-restart",
      "severity": "high",
      "reason": "禁止重启远端主机上的服务",
      "command": "systemctl",
      "subcommands": ["restart"],
      "scope": "remote"
    },
    {
      "id": "team-cmdb-delete",
      "severity": "high",
      "reason": "禁止通过 API 删除 CMDB 记录",
      "http": { "methods": ["DELETE"], "urlPatterns": ["//cmdb\\.example\\.com/api/"] }
    },
    {
      "id": "team-deploy-rollback-prod",
      "severity": "critical",
      "reason": "禁止通过 MCP 回滚生产环境",
      "command": "deploy_rollback",
      "pattern": "\"env\":\"prod\""
    }
  ]
}
```

效果：

| 命令 | `strict` | `relaxed` |
|---|---|---|
| `nico-cli --region bj node reset n1` | `deny [team-nico-wipe]` | `deny [team-nico-wipe]` |
| `nico-cli node show n1` | `allow` | `allow` |
| `deployctl release --force app` | `deny [team-deploy-force]` | `ask [team-deploy-force]` |
| `deployctl release -fy app` | `deny [team-deploy-force]` | `ask [team-deploy-force]` |
| `deployctl status --force` | `allow` | `allow` |
| `cd /data && rm -rf models` | `deny [team-rm-models]` | `deny [team-rm-models]` |
| `ssh gpu1 mv /data/models/a /tmp/` | `deny [team-rm-models]` | `deny [team-rm-models]` |
| `rm -rf /data/models-old` | `ask [rm-local]`，只命中内置规则 | `allow` |
| `ssh n1 systemctl restart nginx` | `deny [team-remote-restart]` | `ask [team-remote-restart]` |
| `systemctl restart nginx` | `allow` | `allow` |
| `curl -X DELETE https://cmdb.example.com/api/hosts/42` | `deny [team-cmdb-delete]` | `ask [team-cmdb-delete]` |
| `python3 -c 'import requests; requests.delete("https://cmdb.example.com/api/hosts/42")'` | `deny [team-cmdb-delete]` | `ask [team-cmdb-delete]` |
| `curl https://cmdb.example.com/api/hosts/42` | `allow` | `allow` |
| MCP 工具 `deploy_rollback`，输入 `{"service":"api","env":"prod"}` | `deny [team-deploy-rollback-prod]` | `deny [team-deploy-rollback-prod]` |
| MCP 工具 `deploy_rollback`，输入 `{"service":"api","env":"dev"}` | `allow` | `allow` |

## 10. 限制

- 不能修改或关闭内置规则。可以用 `extraAllow` 豁免 `high`、`medium` 规则，`critical` 规则不能豁免。
- 命令名和路径按大小写敏感比较。macOS 的文件系统默认不区分大小写，`KUBECTL delete` 这类改了大小写的写法可以绕过规则，见 README 的[安全边界](../README.md#安全边界)。
- 规则只能看到命令的静态文本。远端已有脚本的内容、运行时才确定的变量值都看不到。
- 外挂规则和内联规则的 `examples` 不会自动运行，要自己用 `/safety test` 或 `cli.ts` 验证。
