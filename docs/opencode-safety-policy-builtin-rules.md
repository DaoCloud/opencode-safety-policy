# 内置规则开发指南

本文面向插件的开发者，说明怎样新增或修改内置规则。内置规则放在仓库的 `rules/` 目录下，随版本发布，对所有用户生效。

只想在自己的机器上加规则，见[自定义规则指南](opencode-safety-policy-custom-rules.md)。规则字段的匹配语义以那篇的第 4 节为准，本文只讲内置规则特有的约定、测试和需要同步的文件。

## 1. 什么规则应该内置

- 适合内置：多数用户都会遇到的高危操作，属于设计文档 [0.2](opencode-safety-policy-design.md#02-覆盖的目标机器与环境6-类) 列出的目标环境。例如 `kubectl`、`ipmitool`、`nv` 等通用 CLI 的破坏性子命令，Redfish、UFM 等标准 REST API 的写操作。
- 不适合内置：只在某个团队内部使用的工具，或者带有具体主机名、路径的规则。这类规则由用户写在自己的 `rulesFile` 中。

## 2. 文件地图

| 路径 | 作用 | 什么时候改 |
|---|---|---|
| `rules/<类别>.json` | 内置规则，按类别分文件 | 新增或修改规则 |
| `rules/ssh-readonly.json` | 远端只读白名单 | 新增只读命令，见[第 4 节](#4-修改只读白名单) |
| `test/rules-examples.test.ts` | 遍历所有内置规则，逐条运行 `examples` | 一般不用改 |
| `docs/opencode-safety-policy-design.md` | 4.2 规则分类表、4.3 只读白名单、6 目录结构 | 见 [3.7](#37-同步文档) |
| `README.md` | 开头的覆盖范围列表，“内置规则”一节的文件表 | 新增一类目标或新建规则文件时 |
| `docs/opencode-safety-policy-custom-rules.md` | 规则字段的语义 | 新增或改变规则字段时 |

插件按文件名顺序加载 `rules/` 下所有的 `.json` 文件，不需要在代码中登记。没有 `rules` 字段的文件（如 `ssh-readonly.json`）会被跳过。`package.json` 的 `files` 已包含整个 `rules/` 目录，新文件会自动打进发布包。

现有的规则文件：

| 文件 | 范围 |
|---|---|
| `cloud-native.json` | Kubernetes、Helm、etcd、Velero、容器运行时 |
| `linux-host.json` | 文件删除、磁盘与分区、服务、进程、重启、用户 |
| `spectrum-cumulus.json` | NVIDIA Spectrum 交换机（NVUE、NCLU、switchd、ONIE） |
| `ib-ufm.json` | InfiniBand 交换机、主机侧 IB 与 GPU 工具、UFM |
| `oob-redfish.json` | Redfish、IPMI、BMC |
| `network-db.json` | 网络配置、防火墙、rsync、数据库 |
| `opencode-tools.json` | OpenCode 内置工具与 MCP 工具 |

## 3. 新增一条规则

### 3.1 选择文件

优先放进现有的类别文件，与同一工具的其他规则放在一起。

只有出现一类新的目标时才新建文件。文件名用小写字母和连字符，如 `rules/storage.json`，内容是：

```json
{
  "rules": []
}
```

新建文件后要更新设计文档 4.2 和 6，以及 README 开头的覆盖范围列表和“内置规则”一节的文件表，见 [3.7](#37-同步文档)。

### 3.2 编写规则

以 `rules/cloud-native.json` 中的一条规则为例：

```json
{
  "id": "k8s-delete-namespace",
  "severity": "critical",
  "reason": "禁止删除 Kubernetes 命名空间",
  "command": "kubectl",
  "subcommands": ["delete", "del"],
  "pattern": "(?<!-n|--namespace) (\\S+,)?(ns|namespaces?)([/,]\\S*)?( |$)",
  "examples": {
    "match": [
      "kubectl delete ns prod",
      "kubectl --context prod delete namespace payments",
      "kubectl delete namespaces/payments",
      "ssh master kubectl delete ns,deploy x"
    ],
    "ignore": [
      "kubectl get ns",
      "kubectl delete pod x -n ns",
      "kubectl delete pod x --namespace prod",
      "echo kubectl delete ns prod"
    ]
  }
}
```

内置规则的约定：

| 项目 | 约定 |
|---|---|
| `id` | 小写字母加连字符，以领域开头，如 `k8s-`、`helm-`、`ipmitool-`、`redfish-`、`nvue-`、`ufm-`、`rm-`。全局唯一，见下文 |
| `severity` | 见 [3.3](#33-选择-severity) |
| `reason` | 一句中文，不加句号。`critical` 和 `high` 以"禁止"开头，`medium` 一般以"需要确认"结尾 |
| 字段顺序 | `id`、`severity`、`reason`、`command`、`subcommands`、`flags`、`pattern`、`http`、`scope`、`examples` |
| 格式 | 2 空格缩进，短数组写在一行，长数组每项一行，文件末尾保留换行，与相邻的规则保持一致 |
| 规则顺序 | 具体的规则放在宽泛的规则前面，如 `k8s-delete-namespace` 在 `k8s-delete` 前面。一条命令命中多条规则时，结果显示的规则这样选：有 `critical` 规则时取排在最前的那条；否则取处置最严的，同样严时取排在前面的 |

关于 `id`：

- `id` 是全局唯一的，不是按文件唯一。插件把 `rules/` 下所有 JSON 文件的规则合到一起检查，所以同一个文件内不能重复，不同文件之间也不能重复。例如 `linux-host.json` 已有 `mkfs`，`storage.json` 就不能再用 `mkfs`。
- 内置规则重名时，`bun test` 中的 `built-in rules > load into one rule set with unique ids` 失败。如果带着重名发版，所有用户的插件都会加载失败，拒绝一切工具调用（`config-error`）。
- `id` 会出现在拒绝信息、审计日志和 `/safety status` 的统计中。已发布的 `id` 不要改名。
- 用户自定义的规则不能与内置规则重名，否则整个配置加载失败。新版本增加的 `id` 可能与用户已有的 `id` 撞名，发版时要在 Release 说明中列出新增的规则 `id`。

### 3.3 选择 severity

| `severity` | `strict` | `relaxed` | 适用 | 现有例子 |
|---|---|---|---|---|
| `critical` | 拒绝 | 拒绝 | 不可逆，或影响整台主机、整个集群、整台交换机 | 删除系统路径、`mkfs`、分区、`dd` 写设备、LVM 删除、删除 Kubernetes 命名空间、`etcdctl del`、IPMI 断电与切换启动设备、Redfish 复位、挂载介质和刷固件、`onie-select`、IB 交换机恢复出厂 |
| `high` | 拒绝 | 弹出审批 | 破坏性或会中断业务，但偶尔确有需要 | `kubectl delete`、删除容器、`systemctl stop`、主机重启、`nv config apply`、`iptables -F`、SQL `DROP`、远端 `rm` |
| `medium` | 弹出审批 | 放行 | 常见的日常操作，确认一次即可 | 本机 `rm`、`kill`、`nv set` 暂存、`kubectl patch`、`nvidia-smi` 改配置 |

默认模式是 `relaxed`，但生产环境和无人值守的用户会切到 `strict`。日常运维中频繁出现的合法命令如果定成 `high`，在 `strict` 下会被直接拒绝，这些用户最后只能关掉插件。拿不准时，在 `high` 和 `medium` 之间权衡误报的代价。

### 3.4 选择匹配方式

- 优先用 `command` 加 `subcommands`、`flags`。它能处理全局选项、短选项簇、长选项缩写，比正则可靠。
- 判定依赖参数的值时（路径、资源类型、SQL 语句），用 `pattern`，并同时写上 `command`。
- REST API 用 `http`。
- MCP 工具和 OpenCode 工具的规则放在 `opencode-tools.json`，`command` 写工具 ID，`pattern` 匹配 JSON 输入。

各字段的详细语义见自定义规则指南的[第 4 节](opencode-safety-policy-custom-rules.md#4-字段说明)，容易出错的地方见本文[第 6 节](#6-常见陷阱)。

### 3.5 编写 examples

`test/rules-examples.test.ts` 对每条内置规则强制要求：

- `match` 至少 2 条，`ignore` 至少 2 条。
- 至少一条 `ignore` 包含 `echo `，如 `echo kubectl delete ns prod`，确认规则不会命中只是提到这条命令的文本。

测试的运行方式：

- 每条示例都经过完整的分析流程，包括拆分原子命令、拆壳、路径展开、HTTP 提取。
- 模式为 `strict`，只加载被测的这一条规则，其他内置规则和只读白名单都不加载。
- 工作目录是 `/ocsp-examples/work/project`，HOME 是 `/ocsp-examples/home`。示例中的相对路径和 `~` 会展开到这两个目录下。
- 某条原子命令的 `ruleId` 等于被测规则的 `id`，就算命中。`ignore` 示例只要求被测规则不命中，不关心其他检查的结果。

建议覆盖的写法：

| 类型 | 示例 |
|---|---|
| 基本写法 | `kubectl delete ns prod` |
| 子命令前有全局选项 | `kubectl --context prod delete namespace payments` |
| 经 `ssh`、`sudo`、`bash -c`、`kubectl exec` 包裹 | `ssh master kubectl delete ns,deploy x` |
| 选项的不同写法 | `-rf`、`--force=true`、`--replicas 0` |
| 经 heredoc 喂入 | `"psql -h db <<'SQL'\nDROP TABLE users;\nSQL"` |
| 只读的兄弟子命令（`ignore`） | `kubectl get ns` |
| 关键词作为参数值出现（`ignore`） | `kubectl delete pod x -n ns` |
| 文本提及（`ignore`） | `echo kubectl delete ns prod` |

工具规则的示例写成 `<工具 ID> '<JSON>'`，如 `"opencode_worktree_remove '{\"directory\":\"/repo/wt\",\"force\":true}'"`。

### 3.6 运行测试

```bash
bun test test/rules-examples.test.ts -t k8s-delete-namespace   # 只跑一条规则
bun test test/rules-examples.test.ts                           # 全部内置规则
bun run typecheck && bun test
```

测试名形如 `k8s-delete-namespace match: kubectl delete ns prod`，失败时可以直接看出是哪条示例。

临时验证某条命令时用 `cli.ts`。要在仓库目录之外运行，因为仓库目录就是插件目录，相对路径参数会落在受保护的目录中，结果是 `self-protect`：

```bash
cd /tmp && bun /path/to/opencode-safety-policy/cli.ts test "kubectl -n prod delete ns payments"
```

### 3.7 同步文档

| 改动 | 同步 |
|---|---|
| 新增规则 | 设计文档 [4.2](opencode-safety-policy-design.md#42-规则分类明细) 中对应类别的命令列表 |
| 新增规则文件 | 设计文档 4.2 加一行，[6](opencode-safety-policy-design.md#6-仓库目录结构与模块划分) 的目录树加一行，README 开头的覆盖范围列表，README“内置规则”一节的文件表加一行 |
| 修改只读白名单 | 设计文档 [4.3](opencode-safety-policy-design.md#43-远端-ssh-只读白名单rulesssh-readonlyjson用于-strict-模式减少误报) |
| 新增或改变规则字段 | 设计文档 [4.1](opencode-safety-policy-design.md#41-声明式规则格式人工扩展极简)，自定义规则指南第 4 节 |
| 发版 | 在 Release 说明中列出新增的规则 `id` |

## 4. 修改只读白名单

`rules/ssh-readonly.json` 的格式是：

```json
{
  "commands": ["ls", "kubectl get", "ipmitool sel list"]
}
```

- 条目的语义与用户的 `sshReadOnlyAllowlist` 相同，见自定义规则指南的[第 7 节](opencode-safety-policy-custom-rules.md#7-远端只读白名单)。
- 测试要求：文件只有 `commands` 一个字段，条目不重复，每个条目是用单个空格分隔的词，首尾没有空格。
- 只收录确实只读的命令：不改变系统状态，不写文件。`ibdiagnet` 会写诊断文件并扫描整个 fabric，所以没有收录。
- 白名单不会放行命中规则的命令。只读命令的个别危险选项另写规则拦截，如 `nvidia-smi -r` 由 `nvidia-smi-reset` 拦截。
- 白名单还决定本机命令能否读取插件配置等受保护的文件，加条目时一并考虑。

## 5. 需要改代码的情况

大多数规则只改 JSON。以下情况需要改代码：

| 情况 | 修改 | 测试 |
|---|---|---|
| 新 CLI 的带值全局选项会遮住子命令，或者需要像 `kubectl` 一样只认第一个位置参数、只认完整的长选项，或者长选项名互为前缀（如 `iptables` 的 `--delete` 与 `--delete-chain`） | 在 `src/cli-options.ts` 的 `OPTION_SPECS` 中增加选项表，登记到 `src/rules/matcher.ts` 的 `COMMAND_SPECS`。接受缩写的 CLI（getopt_long 等）在 `spec()` 中传 `flags` 列全无值长选项，表中的完整名就不会被当作别的选项的缩写；只认完整名的 CLI（pflag 等）不传 `flags`。只读白名单也要跳过它的全局选项时，登记到 `src/rules/ssh-policy.ts` 的 `SPECS` | `test/rules.test.ts` |
| 新的外壳命令（类似 `sudo`、`timeout`），或新的远端执行方式（类似 `ssh`、`pdsh`） | `src/unwrapper.ts` 的 `WRAPPERS`，选项表放在 `OPTION_SPECS` | `test/unwrapper.test.ts` |
| 新的 HTTP 客户端，或解释器代码中新的 HTTP 调用写法 | `src/http-extractor.ts`、`src/script-scanner.ts` | `test/http-script.test.ts` |
| 新的规则字段 | `src/types.ts` 的 `Rule`，`src/rules/loader.ts` 的 `RULE_KEYS` 与校验，`src/rules/matcher.ts` | `test/rules.test.ts` |

判断是否需要拆壳支持：用 `cli.ts test` 看输出中的原子命令和"拆壳链"。如果规则要匹配的命令没有被单独拆出来，规则就不会命中。

## 6. 常见陷阱

- **JSON 双重转义**：正则的 `\S` 在 JSON 中写作 `"\\S"`，`\.` 写作 `"\\."`。示例中的引号写作 `\"`。
- **路径已展开**：本机路径参数在匹配前已展开为绝对路径，`pattern` 要按绝对路径写。测试中的相对路径展开到 `/ocsp-examples/work/project` 下。
- **不带 `command` 的 `pattern`**：作用于每一条原子命令，必须用 `^` 锚定命令名，如 `mkfs` 规则的 `"^(mkfs(\\.[\\w-]+)?|mke2fs|mkswap|mkdosfs|mkntfs)( |$)"`。它不看 heredoc 正文，也不匹配工具调用。
- **子命令位置**：除内置了选项表的 `kubectl`、`docker`、`iptables` 系列外，`subcommands` 的第一个词可以出现在任意位置参数上，带值选项的值也算位置参数。`deployctl logs --app release` 会命中 `["release"]`。误报严重时，给这个 CLI 增加选项表（第 5 节），或改用 `pattern`。
- **长选项前缀**：`flags` 中的长选项也匹配它的任何前缀，这个前缀可能正好是另一个选项。例如 `flags` 写 `["--delete-all"]` 时，`deployctl --delete app1` 也会命中。`kubectl`、`docker` 只认完整名称；`iptables` 系列按选项表识别，`iptables --delete INPUT 1` 不命中 `--delete-chain`。其他 CLI 的选项名互为前缀时，用 `cli.ts test` 检查相邻的选项，误报严重时增加选项表（第 5 节）。`pattern` 不识别缩写，在正则中写长选项要自己覆盖缩写形态，能用 `flags` 时优先用 `flags`。
- **heredoc 正文**：带 `command` 的规则会把 heredoc 正文接在参数后再匹配一次。这让 `sql-drop` 能看到 `psql <<SQL` 中的语句，但也意味着正文中的文字可能引起误报。
- **大小写**：命令名区分大小写。SQL 关键字这类需要忽略大小写的内容，用 `(?i:...)`，如 `sql-drop`。
- **正则语法**：插件运行在 Bun 上，正则按 JavaScript 语法编译，支持后行断言 `(?<!...)` 和局部修饰符 `(?i:...)`。
- **作用范围**：规则默认同时作用于本机和远端，只想拦截其中一边时写 `scope`。

## 7. 提交前检查

- `bun test test/rules-examples.test.ts` 通过。
- `bun run typecheck` 和 `bun test` 通过。改了代码时，有条件的话再跑 `bun run test:e2e`，它需要本机安装 `opencode`。
- 用 `cli.ts test` 验证几条真实的命令，包括应该放行的常见命令。
- 按 [3.7](#37-同步文档) 同步了文档。

PR 提交后，CI 在 Linux 和 macOS 上运行类型检查、单元测试和 E2E 测试（OpenCode 2.4.1），并在 Linux 容器中验证系统级部署。
