# 使用说明

此工作副本包含尚未发布的四档修改；重新安装时使用本地打包产物。

`subagent-delegation` 0.6.0。首版支持 Codex；Node.js 22+。命令、网页和生成的 Skill 使用同一套档位数据。

终端命令为 `sub-d`，npm 包名为 `subagent-delegation`。内测版仅支持当前配置格式，不提供旧版本兼容、升级或迁移。更换版本前先用原版本 `restore`，再安装新版本并 `setup`；独立 home 全程使用原路径。

## 安装与配置

推荐 npm registry 安装；GitHub 安装另外需要 Git，本地 `.tgz` 安装只需 Node/npm。

```sh
npm install -g subagent-delegation
sub-d setup --mode official --dry-run
sub-d setup --mode official
```

一行安装并配置：

```sh
npm install -g subagent-delegation && sub-d setup --mode official
```

目标目录优先级为 `--codex-home PATH`、`CODEX_HOME`、用户 `~/.codex`。空格路径需要 shell 引号。命令不会设置主代理模型、全局子代理默认、供应商、审批、沙箱、并发或子代理启用开关。

Skill 名称为 `subagent-delegation`，调用为 `$subagent-delegation`，安装目录为 `skills/subagent-delegation`。npm 安装命令获取已发布版本；当前内测开发代码通过 `npm pack` 构建本地包。

首次 setup 默认官方（official）；同版本重复 setup 保留当前选择与首次恢复基线。npm 安装没有 postinstall 配置动作。`--dry-run` 不创建目标 home、锁或状态文件。

所有配置部署变化都提示：**配置已写入，请重启 Codex 后使用新委派规则。** 运行中的任务继续使用原上下文；工具不自动重启、停止任务或保证动态加载。

## 命令表

默认智能体为 Codex；省略 `--agent` 与显式指定 `--agent codex` 等价。业务命令支持 `--codex-home PATH`。除 serve 外都支持 `--json`；写命令支持 `--dry-run` 和 `--expect-revision REV`。

| 命令 | 用途 |
| --- | --- |
| `setup [--mode MODE]` | 首次配置或同版本重新配置，保留无关文件 |
| `mode set MODE` | 切换已安装 home 的档位 |
| `mode list` | 列出内置、自定义及当前选择 |
| `mode show MODE` | 查看四级主/备用、来源与定义版本，不激活 |
| `mode create NAME [--from MODE]` | 复制完整定义，默认从 official，不自动激活 |
| `mode configure MODE --level Lx --model M --effort E` | 修改自定义一个等级 |
| `mode configure MODE --definition-stdin` | stdin 一次保存完整四级 |
| `status [--details] [--project PATH]` | 模式、角色、完整性、规则与覆盖诊断 |
| `explain --level Lx [--mode MODE] [--role ROLE]` | 静态解释任务等级、组合与职责角色，不调用 AI |
| `models check [--verify] [--discover] [--model M --effort E]` | 账号/目录；verify 使用禁用工具的独立 Responses 请求 |
| `restore` | 恢复首次配置前的受影响内容，清理本工具配置 |
| `serve [--port PORT] [--open]` | 前台启动本地设置页面 |
| `--help` / `--version` | 帮助及工具版本，可带 --json，不接受 home 参数 |

`MODE` 使用 `cut`（经济）、`official`（官方，首次配置默认）、`high`（高级）、`fire`（全开）；命令、JSON id、状态记录和网页使用同一值，中文用于说明含义。旧 low、mid 不提供兼容别名或迁移。自定义档位可使用内部 id 或唯一名称。职责为 `task_scan`、`task_execute`、`task_review`、`task_delegate`，explain 省略职责时默认 task_delegate。默认 explain 使用当前有效档位；未安装时需明确 `--mode official` 等内置预览。

名称以 `-` 开头时，在全部选项后使用 `--`：

```sh
sub-d mode create -- '-我的档位'
```

## 查询与切换

```sh
sub-d status
sub-d status --details --json
sub-d status --project "/path/to/project" --details
sub-d mode list
sub-d mode show fire
sub-d mode set cut
sub-d explain --level L4 --role task_review
```

详细查询分开呈现已配置值、预设值、潜在覆盖与运行未验证。检查相关项目及祖先目录，不扫描全电脑；不输出账号凭据、私有指令、完整 TOML 或认证记录。范围外注册路径与未确定的 profile 只报告候选及未检查原因，不跟随任意文件。

同一档位重复切换不重写；仅保存非活动定义不要求重启。配置版本或格式不匹配时，读取与写入都会被拒绝，不做自动转换。

无需全局安装的 npm 查询，以及本地包查询：

```sh
npm exec --package=subagent-delegation@0.6.0 -- sub-d status --details
npm exec --package="/path/to/subagent-delegation-0.6.0.tgz" -- sub-d status --details
```

## 任务等级与委派职责

| 任务等级 | cut（经济） | official（官方） | high（高级） | fire（全开，验证通过后） |
| --- | --- | --- | --- | --- |
| L1：窄范围、容易核验 | Luna / high | Luna / high | Luna / max | Astra / ultra |
| L2：明确目标的多步产出 | Luna / high¹ | Sol 6.1 / medium | Sol 6.1 / ultra | Astra / ultra |
| L3：复杂分析或关键复核 | Sol 6.1 / medium | Sol 6.1 / high | Astra / ultra | Astra / ultra |
| L4：困难推理或深层歧义 | Sol 6.1 / high | Sol 6.1 / xhigh | Astra / ultra | Astra / ultra |

完整 id：`gpt-6-luna`、`gpt-6.1-sol`、`gpt-6-astra`；备用另使用 `gpt-6-sol`。名称不证明价格、能力或账号权限。高影响结果需要独立证据与专业验证。

`official` 是依据 [OpenAI 官方建议](https://learn.chatgpt.com/docs/agent-configuration/subagents#choosing-models-and-reasoning) 制定的本地映射，官方没有固定 L1–L4 表。`high` 各模型使用最高受支持的 effort；预设写入不证明账号可调用。

`fire` 每个会话首次委派前须实际验证 Astra/ultra，并核对可信运行 metadata 与当前会话上下文。模型、effort、供应商或账号变化后重验，不保存跨会话验证缓存。目录查询和口头确认不能代替验证；`models check --verify` 通过独立 Responses 请求验证，不启动 Codex 任务线程或工具执行器。

检查失败、未完成或最高组合不可用时，使用用户明确指定的模型与推理强度；未另行指定时继承父代理当前实际组合。通过 `task_delegate` 保留原职责，并核对全局子代理默认与角色覆盖；无法确认父代理组合时阻断该委派。不自动切换 high，不绕过原预算、能力和权限规则。fire 的继承备用是运行时选择，静态 fallback 为 null。

四个职责：

- `task_scan`：L1 固定预设，只读取证。
- `task_execute`：L2 固定预设，只在明确独占范围产出。
- `task_review`：L3 固定预设，独立复核。
- `task_delegate`：不固定 model/effort，用于用户指定、继承、L4 或固定组合不匹配；保留原请求职责。

等级与职责互相独立。例如经济模式下复杂产出升为 L3 时，不能继续用固定 Luna 的 task_execute 覆盖选择；应使用 task_delegate 请求 Sol/medium，同时保留范围内产出的权限契约。继承需核对宿主全局默认，省略参数不证明继承。

AGENTS 管理入口要求启动时读取 Skill，每次创建、重新委派或模型变化前按 Skill 检查。用户选择、预算、宿主和项目规则优先，工具不自动授权委派。主代理保留最终设计、共享裁决、集成、关键验证及完成声明。子代理禁止递归、外部环境和代理配置改动；独占写入、局部适配/阻断、最小充分验证及 PARTIAL 返回在全部档位保留。

本工具不额外限制 Git 操作或图像生成，也不设置 `features.image_generation`。实际工具能力与操作授权遵循宿主、用户和项目规则。

## 备用与模型不可用

| 档位 | L1 备用 | L2 备用 | L3 备用 | L4 备用 |
| --- | --- | --- | --- | --- |
| cut（经济） | Sol 6.1/medium | Sol 6.1/medium | Sol 6/medium | Sol 6/high |
| official（官方） | Sol 6.1/medium | Sol 6/medium | Sol 6/high | Sol 6/xhigh |
| high（高级） | Sol 6.1/high | Sol 6/ultra | Sol 6.1/ultra | Sol 6.1/ultra |
| fire（全开） | 用户指定，否则继承父代理 | 同左 | 同左 | 同左 |

cut、official、high 默认允许原已授权任务自动使用本级唯一备用，无需逐次确认；用户明确锁定模型或禁止降级时不切换。模型不可用、effort 不支持，或临时故障有限重试后仍失败时可触发；认证、权限、额度、账单限制及原因 unknown 时停止受影响路径。每任务最多三次委派（包含主组合重试与备用），同一组合最多额外一次，累计重试等待不超过 30 秒并遵守 Retry-After；宿主内部重试次数未知时不叠加。备用耗尽后报告原因、实际组合和部分产出，不自动尝试其他模型或切换档位。L3、L4 不自动降到 Luna。

备用是候选，需要同时满足用户选择、原预算、宿主支持、原工具/输入能力、原职责与验收不变。写入任务还必须确认旧 worker 已停止并检查部分产出。接续由主代理按生成的 Skill 使用 task_delegate 显式指定备用组合执行，CLI 和网页仅配置、展示与检查，不转发推理或自动重派，不换账号或供应商。配置写入和测试通过不证明宿主运行时已接续。

Astra 不可用：先区分认证、权限、额度、临时故障或能力不支持。允许备用且全部条件满足才用当前档位的候选，fire 使用用户指定组合，否则继承父代理；用户强制只用 Astra、预算不允许或旧 worker 停止未知时，受影响部分 BLOCKED，继续其他独立工作。缺资料或工具故障先补前提，不能靠强模型掩盖。

每任务最多三次父代理发起的委派，同一组合最多额外一次；累计等待不超过 30 秒并遵守 Retry-After。宿主已重试或次数未知时不追加。异常或部分结果标 PARTIAL，不自动撤销其他人的修改。完整分类见 [失败处理](../adapters/codex/skills/subagent-delegation/references/failure-policy.md)。

## 自定义档位

```sh
sub-d mode create "我的研究方案" --from fire
sub-d mode configure "我的研究方案" \
  --level L4 --model gpt-6-astra --effort low \
  --fallback-model gpt-6.1-sol --fallback-effort high
sub-d mode set "我的研究方案"
```

自定义名称不能与内置档位的 id、中文名或现有自定义名称/id 重复；自定义档位可按名称或 custom-* id 选择。

名称 trim + Unicode NFC 归一化，1–80 个码点，不能含控制字符、无效 Unicode 或与既有名称/id 混淆。名称只用于显示与查找，不拼文件路径；内部 id 为 UUID。模型 1–200、effort 1–40 个码点，拒绝无效 Unicode、控制字符和首尾空白。目录未知不等于标识无效。

创建是完整快照，之后不跟随来源变化。内置档位不可改，先复制；不支持重命名、删除单个档位或增加任务等级。自定义也不能扩大权限。

单级修改主组合时，未明确提供备用会清空原备用；完全相同的主组合重复保存保留已有备用。`--clear-fallback` 与备用参数互斥，主配置仍需完整。

四级一次保存的 stdin 格式：

```sh
sub-d mode configure "我的研究方案" --definition-stdin <<'JSON'
{
  "levels": {
    "L1": {"model": "gpt-6-luna", "effort": "high", "fallback": {"model": "gpt-6.1-sol", "effort": "medium"}},
    "L2": {"model": "gpt-6.1-sol", "effort": "medium", "fallback": null},
    "L3": {"model": "gpt-6.1-sol", "effort": "high", "fallback": null},
    "L4": {"model": "gpt-6-astra", "effort": "low", "fallback": {"model": "gpt-6.1-sol", "effort": "high"}}
  }
}
JSON
```

最高 64 KiB UTF-8 JSON；必须明确全部等级与备用/null，拒绝未知字段、缺级、半对参数或主备用相同。与单级参数互斥。活动定义与部署角色同一事务保存；非活动定义只保存，不激活。

## 模型检查

网页优先复用服务绑定的 `CODEX_HOME` 中已有 Codex 登录，以及当前供应商配置与环境变量凭据。账号区域和实际验证确认框会告知检查目录与授权来源；读取状态不会重新登录。目录、账号登录状态和实际调用权限分别呈现，已有 API Key 登录状态不证明该密钥具有目标模型权限。

网页实际验证将确认时的配置版本随请求传入；若确认后配置发生变化，返回 `CONFIG_CHANGED`，不发起验证并记录此次未完成结果。CLI 可用 `models check --verify --expect-revision REV` 启用同一保护。目录检查后如页面状态版本落后，会重新读取状态并核对，保留已有草稿。

需要新授权时，可在模型检查页使用 ChatGPT 浏览器授权、设备码登录或 OpenAI API Key 登录。由官方 `account/login/start` 发起、`account/login/completed` 通知完成，授权可取消；成功后重新读取账号状态。刷新页面可以继续查看同一个本地服务中的待授权状态，停止服务会终止等待。授权等待最多 10 分钟，单次协议请求最多 30 秒。设备码方式可能需要在 ChatGPT 安全设置或工作区设置中启用。切换登录和退出登录须在页面确认，将影响所有复用该 home 的客户端；不会修改第三方供应商环境变量或配置凭据。

凭据由 Codex 官方认证存储管理。API Key 使用密码输入框，通过受保护的本机接口和 stdio RPC 传给 Codex，不进入命令参数、页面持久存储、服务最近操作或检查记录。官方 OAuth 链接与设备码仅在授权等待期间展示，完成、取消或过期后清除。授权地址只接受官方 HTTPS 地址。

每次目录检查、实际调用验证及应用配置后的附带检查都会保存独立 JSON 记录到 `<CODEX_HOME>/.subagent-delegation-checks/`。成功、失败与未完成都会记录；取消尚未发起的验证不产生记录。记录包含时间、检查类型、CLI 版本、配置版本、供应商、脱敏账号状态、目录、组合参数、请求/权限/实际身份状态与诊断码，不保存账号标识、邮箱、认证令牌或原始 RPC。目录权限为 `0700`，文件为 `0600`，完成写入后才出现在列表中。

网页支持按时间回看、分页加载及查看完整结构化结果，刷新页面或重启服务不会丢失记录。记录目录独立于配置版本核对，新增记录不会造成草稿冲突；恢复委派配置也会保留记录。历史仅作回看，不自动恢复成当前检查结果或作为新会话 fire 的验证凭证。配置版本、供应商、账号及会话适用性仍须核对。保存或读取失败会明确提示，不能将未保存的结果描述为已保存。

```sh
sub-d models check
sub-d models check --model gpt-6-astra --effort low --json
sub-d models check --verify
# 第三方供应商：从其目录逐一验证 Responses 可调用性，可能消耗额度
sub-d models check --verify --discover
```

setup、切换、活动自定义部署实际改变后，解锁再查询所选 home 的账号及模型目录；失败不撤销合法配置。查询和定义保存、restore、dry-run、无变化操作不会附带检查。

检查通过 stdio app-server 在空临时目录读取当前 home 的账号与生效配置，无认证刷新参数、无项目加载，不输出原始 RPC、stderr、邮箱、账号 ID 或凭据。官方默认上下文的目录使用 Codex `model/list`，最多 100 页，单帧 1 MiB、总接收 8 MiB。第三方供应商或自定义 API 地址使用同一供应商的 `GET /models` 获取候选，不使用 Codex 目录补齐。沿用同一配置的地址、请求头、查询参数和授权，最多 1000 个候选、响应最多 2 MiB；只保留模型标识，不猜测推理强度。当前支持完整单页列表；有后续分页会明确标记未完成并停止批量验证。目录整轮共享 30 秒期限。自定义供应商的空账号不直接判无权限。

`/responses` 需要给定模型，不能直接枚举模型。网页“验证供应商可用模型”在展示候选数量、完整清单与费用提示并确认后，才向同一供应商的 `POST /responses` 逐一发送固定短文本；不指定推理强度，使用供应商默认参数。候选在确认后变化时，返回 `PROVIDER_CATALOG_CHANGED`，不发送批量请求。CLI 可用 `--verify --discover --expect-catalog HASH` 绑定此前目录检查的 `catalog.revision`，不能与单个模型参数混用。整轮最多 90 秒，未完成、超时、额度受限与协议错误记为未确认，不自动重试；供应商明确拒绝权限或返回模型不存在记为不可用。页面展示本次可调用、不可用、未确认数量，并支持仅显示本次可调用。响应报告了不同模型时归为未确认，不纳入可用列表。

默认参数请求成功只表示该供应商本次接受该模型请求，不证明指定推理强度或严格身份通过，不能代替 fire 的会话验证。所有结果按配置目录保存为独立的 `availability` 历史记录。供应商没有 `/models` 或读取失败时明确告知，不自动借用 Codex 目录；仍可手动提供模型与推理强度进行实际 Responses 验证。

分别查看：目录是否完整、effort 是否支持、账号实际请求权限、可信实际身份。目录列出模型不证明请求成功；目录缺项仍 unknown。桌面会话、启动参数、profile 与 CLI 上下文匹配未核验，检查结果不能冒充桌面账号能力。

实际验证使用固定短文本的独立 Responses 请求：`tools: []`、`tool_choice: "none"`、`store: false`，不加载项目、不启动 Codex 任务线程、没有工具执行器。沿用当前供应商地址、请求头、查询参数与环境变量凭据，或该 home 的 Codex 文件授权；不会改用其他供应商、执行取密钥命令或跟随重定向。特殊授权和系统凭据库暂不支持时明确停止，不读取其他目录或猜测凭据。ChatGPT 文件授权只用于官方 Codex 地址，失效后须重新登录；不自行刷新或保存令牌。目录查询仍共享 30 秒，实际验证整轮最多 90 秒、响应最多 2 MiB，不自动重试。指定模型与推理强度的严格验证成功必须有完整响应完成事件，以及响应元数据中的 model 和 reasoning.effort 同时匹配；请求成功但缺少身份元数据返回未完成，身份不同返回失败。供应商的响应元数据不能独立证明其上游路由，且不证明桌面会话上下文匹配。旧记录的 PROBE_ISOLATION_UNSUPPORTED 仍保留原结果，重新检查才会运行新流程。

## 本地网页

```sh
sub-d serve --codex-home "/path/to/codex-home" --open
sub-d serve --port 17321
```

只监听 `127.0.0.1`。默认端口 0 自动分配，指定端口允许 1024–65535；占用即失败。`--open` 打开浏览器，失败时手动复制终端 URL；Ctrl+C 等待正在执行的 CLI 安全完成后停止服务。

服务绑定一个 home 和启动 cwd。换 home 时重新启动。四页入口为档位、委派规则、模型检查、恢复。先编辑草稿，再保存/应用；自定义四级由一个 stdin 命令事务提交。未保存的非活动定义不能直接激活。取消只清除草稿；已创建的档位会保留。

桌面左侧导航切换页面，上方选择档位，中央查看或编辑 L1–L4 模型分配，右侧核对变更并应用或预览。手机使用顶部导航，变更确认放在模型配置下方。可用性证据和备用条件按需展开；仅选择档位不会写入配置，应用后仍需重启 Codex。

页面通过白名单动作实际 spawn 本包 CLI，显示命令与结果；不直接写配置、不执行任意 shell。HTTP 使用精确 Host/Origin、会话 Cookie、随机 CSRF token、CSP；不支持远程监听、CORS、CDN、守护进程或自动排队。

配置版本冲突保留草稿并零写入，点击“刷新后比较”后再决定保存。断线或结果未知不自动重试写操作，先刷新状态。页面关闭/重载可能丢失内存草稿，未使用浏览器持久存储。

## JSON、退出码与冲突

JSON stdout 只有统一 envelope：

```json
{"report_schema_version":1,"data":{},"errors":[]}
```

状态含 `configuration_revision`、CLI/配置版本、四级定义、角色、完整性与诊断。写报告含 `result`、`configuration_status`、变化路径、前后版本、后检查、`restart`、`runtime_verification`。`applied/written` 才是已写入；`preview/not_written` 是预览；失败分未写、已回退、部分残留，不能都当成功。

`--expect-revision` 是可选的终端乐观锁，网页写动作必须携带；版本不匹配报 `CONFIG_CHANGED`。来源版本不会被模型检查结束时的新配置版本替换。未确认的读取返回 null 版本，不猜测。

| 退出码 | 含义 |
| --- | --- |
| 0 | 命令完成；模型目录完整不等于调用已验证 |
| 1 | 关键配置/读写失败、检查未完成或安全门禁不支持 |
| 2 | 参数、定义或选择无效 |
| 3 | 目录明确不支持目标参数，或严格调用验证失败 |

常见诊断：

- `RULES_SHADOWED`：非空 home AGENTS.override.md 遮蔽入口。工具不改 override；用户自行合并原规则并停用 override，或选择未遮蔽 home。
- `MANAGED_FILE_DRIFT` / `MANAGED_RULES_DRIFT`：人工改动、删除或 chmod；保留用户内容，核对后重新操作，无 force 覆盖开关。
- `BUSY`：有写入锁或读取持续变化。先确认其他命令已停止；不要自动删除锁。进程崩溃后可能需人工核对锁与残留。
- `VERSION_MISMATCH`：配置版本与当前工具不一致；用原版本 restore 后再重新配置，当前工具不迁移或覆盖。
- `STATE_INVALID`：状态格式、路径或档位引用不受支持，保持文件不变。
- `RESTORE_METADATA_INVALID`：恢复记录缺失或损坏，使用原备份或人工核对，不猜测恢复。
- `MODEL_ACCESS_UNKNOWN` / `MODEL_NOT_LISTED`：权限未知；不能当作可用或不可用的最终证明。

配置文件采用逐文件原子替换、共同独占锁、完整观察复读、状态最后写入和普通失败回退。回退不覆盖并发编辑，残留单独报告。多文件在进程崩溃/断电时并非一个原子事务；不要在应用期间手工修改管理文件。

## 恢复与卸载

```sh
sub-d restore --dry-run
sub-d restore
npm uninstall -g subagent-delegation
```

restore 后重启 Codex。它不会卸载 npm 工具、删除整个 home、清理账号或重启应用。npm 卸载也不会代做 restore。

首次 setup 记录受影响文件的原存在状态与普通权限，仅允许接管同内容公开工具资产；AGENTS 只记录管理区块与校验元数据，不保存完整私有正文、config 或认证文件。同版本档位切换与自定义配置保留首次基线。

恢复清理本工具新增 Skill、四角色、规则区块、当前档位、全部自定义与元数据；保留用户原文件和后续标记外正文。只非递归删除本工具创建的空目录，home 与无关文件保留。冲突先完整预检，失败不猜测删除。

工具统一使用 Node.js 22+ 和 npm，不需要 Python；安装与配置入口为 `sub-d setup`。

## 开发验证

```sh
npm ci --ignore-scripts
npm test
npm pack
```

`npm test` 验证安装、档位、查询、恢复和本地服务；安装保护用例覆盖用户配置保留、冲突、符号链接、失败回退及输出脱敏。

浏览器集成脚本不安装额外依赖；使用开发环境已存在的 Playwright 和 Chrome：

```sh
PLAYWRIGHT_MODULE=/path/to/playwright CHROME_PATH=/path/to/chrome npm run test:browser
```

跨平台 API 设计不代替实机验收；Linux/Windows、其他 Codex 客户端及真实账号推理仍需单独验证。当前验证结果与边界见 [实施验收记录](implementation-review.md)。
