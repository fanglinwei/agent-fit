# 使用说明

`agent-fit` 0.9.0，npm 包名为 `@fanglinwei/agent-fit`，命令和 Skill 名仍为 `agent-fit`。首版支持 Codex；Node.js 22+。命令、网页和生成的 Skill 使用同一套档位数据。

工具只处理当前格式与版本的配置；独立 home 全程使用显式指定的路径。

## 安装与配置

从 GitHub v0.9.0 Release 下载发行包，或在项目目录运行 `npm pack` 后使用 `npm install -g ./fanglinwei-agent-fit-0.9.0.tgz` 安装。npm registry 获取的是该渠道当前已发布版本；两种方式都需要 Node/npm。本版按全新安装处理，不增加旧配置兼容。已有其他版本配置时，先保留所需自定义方案，用原版本 CLI 对原绑定 home 预览并实际 restore，之后再安装新版并 setup；不自动迁移旧档位或恢复记录。

```sh
npm install -g ./fanglinwei-agent-fit-0.9.0.tgz
agent-fit setup --mode official --dry-run
agent-fit setup --mode official
```

目标目录优先级为 `--codex-home PATH`、`CODEX_HOME`、用户 `~/.codex`。空格路径需要 shell 引号。命令不会设置主代理模型、全局子代理默认、供应商、审批、沙箱、并发或子代理启用开关。

Skill 调用为 `$agent-fit`，默认目录为 `~/.agents/skills/agent-fit/`。

首次 setup 默认官方（official）；同版本重复 setup 保留当前选择与首次恢复基线。npm 安装没有 postinstall 配置动作。`--dry-run` 不创建目标 home、锁或状态文件。

**首次安装、基础规则更新或恢复原配置后需要重启 Codex；日常档位切换与模型/effort 调整无需重启。** 全局角色配置在下一轮加载，项目与会话选择由后续新任务重新查询；已开始的任务继续使用原快照。工具不会自动重启或停止任务。

### 从 GitHub Packages 安装

版本发布到 GitHub Packages 后，可以使用以下命令安装。登录时用 GitHub 用户名，并将拥有 `read:packages` 权限且可读取该包的个人访问令牌（classic）填在密码提示中。

```sh
npm login --scope=@fanglinwei --auth-type=legacy --registry=https://npm.pkg.github.com
npm install -g @fanglinwei/agent-fit
```

安装后按上文执行 `agent-fit setup`。没有 GitHub Packages 访问权限时，仍可从 GitHub Releases 下载 `.tgz` 安装。

维护者发布正式 GitHub Release 时，[发布工作流](../.github/workflows/publish-npm.yml)会核对标签为 `v<version>`、与 `package.json` 和 `VERSION` 一致，并在测试通过后用 Actions 的 `GITHUB_TOKEN` 发布。工作流须存在于发布标签所指的提交；已有 Release 不会补发。首次创建的软件包默认是私有的，可在 GitHub 软件包设置中调整[可见性与权限](https://docs.github.com/zh/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)。

## Skill 目录与旧安装迁移

共享 Skill 保存通用规则和说明；每个 Codex home 的当前档位保存在 `.agent-fit/current-mode.json`，作用域、自定义档位、角色和恢复记录仍属于该 home。CCSwitch 同步规则时不再携带当前运行配置。旧共享目录中遗留的 `references/current-mode.json` 会保留，但迁移后不参与查询、切档或恢复。

支持 0.7.1 的旧布局：Skill 留在 `<home>/skills/agent-fit/`、已搬到共享目录并移除旧位置、旧位置软链接到共享目录。新规则通过 CLI 解析入口，不在角色或 AGENTS 中写死 Skill 的绝对路径。

```sh
agent-fit status --details --json
# MIGRATION_REQUIRED 表示旧布局；以上查询不会修改文件。
agent-fit setup --dry-run
agent-fit setup
# 普通 setup 不覆盖已有共享规则；更新规则须显式执行：
agent-fit skill update --dry-run
agent-fit skill update
agent-fit skill path --json
```

独立 home 在各命令中添加相同的 `--codex-home PATH`。迁移保留已部署的模型组合、自定义档位和项目/会话选择，不以新包内置预设替代旧快照。旧档位、规则、角色和权限须与原安装记录一致；两个位置内容存在无法确认的差异，或旧 Skill 有尚未恢复的安装前内容时，报告冲突并保留所有文件与恢复记录。

`setup` 仅在共享规则不存在时安装；已有规则的更新使用独立锁、内容摘要和逐文件安全回退，未登记的修改不会被覆盖。home 配置事务与共享规则安装是两个步骤；home 已写入但共享安装失败时，报告保留写入状态，修复目录后重试 `setup`。共享 Skill 根可解析符号链接，内部文件、状态、恢复记录与角色路径不跟随符号链接。两个 home 共用规则时，切档、配置和恢复互不改写对方的数据。

`restore` 只恢复当前 home 的运行配置和规则；共享 Skill 与迁移后保留的旧 Skill 资产由用户统一管理，不随某个 home 的恢复删除。恢复 0.7.1 旧布局前先执行上述迁移；共享 Skill 的删除属于单独的管理操作。

## 全局、项目与会话

有效优先级为 **session > project > global**。每层选择完整 L1–L4，主组合与备用不跨层拼接。账号认证属于绑定 home；主会话自身模型不受影响。项目/会话数据保存在 home 的 `.agent-fit/scopes.json`，不写项目仓库。

CLI 保留默认全局行为，操作局部配置须显式指定 `--scope`。聊天中调用 `$agent-fit` 要求切换时，Skill 默认使用 session，明确要求才修改 project/global。

```sh
agent-fit mode set official --scope global
agent-fit mode set cut --scope project --project /path/to/project
# 聊天内的工具环境可使用当前 CODEX_THREAD_ID；从其他调用者操作须指定 --thread。
agent-fit mode set high --scope session --project /path/to/project --thread <目标聊天ID>
agent-fit mode show --scope session --project /path/to/project --thread <目标聊天ID>
agent-fit explain --scope session --project /path/to/project --thread <目标聊天ID> --level L2 --role task_execute --json
agent-fit mode clear --scope session --project /path/to/project --thread <目标聊天ID>
agent-fit mode clear --scope project --project /path/to/project
agent-fit mode delete <自定义ID> --scope project --project /path/to/project
agent-fit serve --project /path/to/project --thread <目标聊天ID>
```

Git 目录解析到当前 worktree 根，子目录共用，不同 worktree 独立。非 Git 项目显式指定项目目录。规范化后的项目路径是标识，移动项目后需重新选择。会话绑定线程，恢复原聊天保留选择，新聊天与 fork 出来的聊天不继承会话覆盖。子代理自己的线程 ID 不能当成顶层聊天 ID。

内置档位处处可见；全局自定义向下可见，项目自定义只向该项目的会话可见，会话自定义仅当前聊天可见。编辑上层自定义定义时自动复制到当前层，报告新 ID；若原定义当前有效，则选择该局部副本。清除选择保留定义；删除被任何层引用的定义会报 MODE_IN_USE，须先替换引用。全局 clear 恢复 official。配置损坏、版本不支持或当前有效引用失效时明确报错，不静默使用下层。

网页提供明确的作用域选择与有效来源；服务绑定启动时的项目和可选线程，不接受网页任意传入其他路径/线程。未绑定线程时会话选项禁用。手动主模型检测按当前页面作用域解析有效档位，只检测该档位主组合；切换和保存不会触发检测。恢复页面撤销整个 home 的工具安装，包含所有作用域，不能用来仅清除当前层。

作用域 explain 返回完整 `task_profile`、`configuration_revision`、`context`、`effective_scope`，以及 `task_delegate` 派发建议。主代理保存任务快照，后续重试、升级与备用沿用该完整档位；新任务重新查询。显式传 model/effort，当前宿主使用 `fork_turns="none"` 并完整交接职责与上下文。切换不会改变运行中的子代理，也不重置三次委派上限。

## 命令表

默认智能体为 Codex；省略 `--agent` 与显式指定 `--agent codex` 等价。业务命令支持 `--codex-home PATH`。除 serve 外都支持 `--json`；写命令支持 `--dry-run` 和 `--expect-revision REV`。

| 命令 | 用途 |
| --- | --- |
| `setup [--mode MODE]` | 首次配置或同版本重新配置，保留无关文件 |
| `mode set MODE` | 切换已安装 home 的档位 |
| `mode list` | 列出内置、自定义及当前选择 |
| `mode clear` / `mode delete MODE` | 清除本层选择 / 删除无引用的本层自定义档位 |
| `mode show [MODE]` | 查看四级主/备用、来源与定义版本，不激活 |
| `mode create NAME [--from MODE]` | 复制完整定义，默认从 official，不自动激活 |
| `mode configure MODE --level Lx --model M --effort E` | 修改自定义一个等级 |
| `mode configure MODE --definition-stdin` | stdin 一次保存完整四级 |
| `status [--details] [--project PATH]` | 模式、角色、完整性、规则与覆盖诊断 |
| `explain --level Lx [--task TYPE] [--mode MODE] [--role ROLE]` | 静态解释任务等级、组合与职责角色，不调用 AI |
| `models check [--verify] [--discover] [--model M --effort E]` | 账号/目录；verify 使用禁用工具的独立 Responses 请求 |
| `restore` | 恢复首次配置前的受影响内容，清理本工具配置 |
| `serve [--port PORT] [--open]` | 前台启动本地设置页面 |
| `--help` / `--version` | 帮助及工具版本，可带 --json，不接受 home 参数 |

`MODE` 使用 `cut`（经济）、`official`（官方，首次配置默认）、`high`（高级）、`fire`（全开）；命令、JSON id、状态记录和网页使用同一值，中文用于说明含义。自定义档位可使用内部 id 或唯一名称。职责为 `task_scan`、`task_execute`、`task_review`、`task_delegate`，explain 省略职责时默认 task_delegate。默认 explain 使用当前有效档位；未安装时需明确 `--mode official` 等内置预览。

名称以 `-` 开头时，在全部选项后使用 `--`：

```sh
agent-fit mode create -- '-我的档位'
```

## 同级任务候选

L1–L4 保留为推理复杂度；在最终等级内通过 `--task` 选择模型与 effort，不把任务规模、职责或时延混成新的等级。先检查高后果且难验收时至少 L3 的保障下限，再选候选。

| 类型 | 等级 | cut / official 主候选 |
| --- | --- | --- |
| `mechanical`：确定性机械任务 | L1 | 经济用途 / medium |
| `bounded`：普通有界任务 | L2 | 经济用途 / high |
| `scan`：大型有界扫描或审查 | L1/L2 | 经济用途 / xhigh |
| `deep`：大型确定性深度处理 | L1/L2 | 经济用途 / max |
| `complex`：有界复杂任务 | L2/L3 | 通用用途 / medium |
| `uncertain`：高歧义、高耦合或高后果且难验收 | L3/L4 | 旗舰用途 / low |
| `reasoning`：复杂推理或已证实推理不足 | L3/L4 | 旗舰用途 / medium |
| `visual`：视觉理解与图像推理 | L1/L2/L3 | 专长用途 / low、medium、high |
| `computer`：有界电脑操作 | L1/L2/L3 | 专长用途 / low、medium、high |
| `writing`：自然写作与修订 | L1/L2/L3 | 专长用途 / low、medium、high |
| `latency`：明确追求低延迟 | 任意等级 | 须显式配置，不保证实际延迟 |

这些是待校准的本地策略，不代表已经验证模型能力或延迟。普通旗舰候选默认 low，复杂推理或有证据的质量升级最多 medium；更高强度需要明确授权。**用户明确选择 high/fire 即授权其展示的高强度组合**；预览或保存不构成选择，预算、宿主支持和 fire 会话验证继续适用。已选择的自定义档位执行明确保存的组合。

先判断等级，再核对组合的工具、输入、上下文与验收能力。无法明确匹配任务候选时使用本级基线，仍需能力检查；候选适用依据与 L2/L3 complex 的边界见 [任务路由](../adapters/codex/skills/agent-fit/references/task-routing.md#基线与候选的选择边界)。同一组合改标签不构成质量升级，也不存在固定的跨模型升级顺序。

```sh
agent-fit explain --level L1 --task mechanical --role task_execute --json
agent-fit explain --level L1 --task scan --role task_review --json
agent-fit explain --level L3 --task uncertain --role task_scan --json
agent-fit explain --level L3 --task reasoning --role task_execute --json
```

聊天仍须使用会话作用域及目标项目、线程上下文。`--task` 只查表，不自动分类、切档或发模型请求；不传时返回原等级基线。类型与等级不匹配会被拒绝；明确请求但快照未配置时返回 `TASK_ROUTE_NOT_CONFIGURED`，不能借用包内新值或自行拼组合。已部署快照缺少候选时，先预览并更新配置再查询；基础规则更新后需重启。

每级可选 `tasks`，键为上表类型，每项完整包含 `model`、`effort`、`fallback`（可为 null）。复制档位、三层作用域和任务快照均保留候选；单级 CLI 配置只改基线，候选通过整表 JSON 或网页“任务候选 JSON”编辑，`{}` 清空本级候选。三个专长候选各带有通用备用组合；latency 仍须独立显式配置，不能凭模型名承诺低延迟。

三个作用域的复制内容均与同一作用域下 `mode show <源档位>` 显示的完整定义一致。源档位对应已部署快照时复制该快照；旧快照没有的候选不会因复制而自动加入。

候选使用自己的备用。质量升级可以在原 L3/L4 中由 uncertain 的旗舰模型/low 转向 reasoning 的旗舰模型/medium；先证实推理不足，继续沿用原快照、职责与验收，计入同一任务最多三次委派。不能用故障备用代替质量升级，也不自动转到更高强度。

如果已有可信证据表明首选组合不受当前会话的模型供应商或宿主支持，可以在首次派发前跳过它。给原 `explain --scope session` 查询加 `--unsupported-model MODEL --unsupported-effort EFFORT`；这两个值必须与首选完全匹配。报告的 `primary` 仍是配置里的首选，`dispatch_candidate` 改为该路线自己的备用。核对备用满足原授权、预算和验收后才派发。查询不发模型请求、不记委派次数、不保存排除状态；不能用于非活动档位，内置 fire 仍走自己的会话验证。见[派发前排除](../adapters/codex/skills/agent-fit/references/failure-policy.md#派发前排除)。

当前档位的手动主模型检测同时覆盖基线和任务候选，按组合去重、排除备用，确认框列出数量。配置、切档、查询与账号页面仍不自动检测。

## 查询与切换

```sh
agent-fit status
agent-fit status --details --json
agent-fit status --project "/path/to/project" --details
agent-fit mode list
agent-fit mode show fire
agent-fit mode set cut
agent-fit explain --level L4 --role task_review
```

详细查询分开呈现已配置值、预设值、潜在覆盖与运行未验证。检查相关项目及祖先目录，不扫描全电脑；不输出账号凭据、私有指令、完整 TOML 或认证记录。范围外注册路径与未确定的 profile 只报告候选及未检查原因，不跟随任意文件。

`explain --mode MODE` 查询非活动档位或在未安装时预览，只返回候选组合，不改变已部署角色；派发角色统一为 `task_delegate`，获授权评估时显式传入候选 model/effort 并保留原权限契约。省略 --scope 的全局查询仅在固定角色组合匹配且不是 L4 时返回固定角色；显式作用域查询统一使用 task_delegate。

同一档位重复切换不重写、不提醒重启；普通切档及当前自定义定义更新也不要求重启。仅保存非活动定义不激活该档位。配置版本或格式不匹配时，读取与写入都会被拒绝，不做自动转换。

无需全局安装的 npm 查询，以及本地包查询：

```sh
npm exec --package="/path/to/fanglinwei-agent-fit-0.9.0.tgz" -- agent-fit status --details
```

## 委派收益检查

主代理先核对委派授权，再比较直接完成、工具并行和子代理委派。计入启动、交接、等待、汇总、验证与返工；收益不明确时由主会话完成。工具并行不能替代独立复核，项目要求的独立复核仍须满足。

收益判断与并行约束由 [Skill 的委派收益检查](../adapters/codex/skills/agent-fit/SKILL.md#委派收益检查)统一规定。CLI 不测量收益、不派发任务；没有对照测量不宣称实际加速。

拆分针对上下文、并行、独立验证、权限或能力与成本约束，不按岗位凑齐角色。主会话配合工具和按需加载的 Skills 足以完成时无需拆分；明确委派和强制独立复核的原要求仍保留。交接提供自包含任务、可访问的权威材料和验收，审查不以作者结论为前提，回传精炼结论及可复核证据；完成即返回，复用须有上下文收益且满足原独立性要求，细节见[派发模板](../adapters/codex/skills/agent-fit/references/dispatch-contract.md)。

上下文、文件和权限隔离分别核实：新线程或 `fork_turns="none"` 不自动创建独立工作树或受限沙箱，也不能保证独立判断。指令限制不等于环境强制隔离；缺少所需隔离时停止受影响部分，不能借此扩大权限。

## 任务等级与委派职责

L1–L4 表示推理需求，职责限定允许的动作。主代理判定等级与职责，CLI 只查配置；高影响且缺乏可靠验收时采用至少 L3 的保障下限，必要材料、工具和证据仍须满足。

| 等级 | 需求 | cut | official | high | fire |
| --- | --- | --- | --- | --- | --- |
| L1 | 方法、输入与验收明确 | 经济用途 / high | 经济用途 / high | 经济用途 / max | 旗舰用途 / ultra |
| L2 | 有边界的局部分析或有限方案选择 | 经济用途 / high | 通用用途 / medium | 通用用途 / ultra | 旗舰用途 / ultra |
| L3 | 权衡相互影响的约束或矛盾证据 | 通用用途 / medium | 通用用途 / high | 旗舰用途 / ultra | 旗舰用途 / ultra |
| L4 | 关键假设未知或强耦合的开放问题 | 通用用途 / high | 通用用途 / xhigh | 旗舰用途 / ultra | 旗舰用途 / ultra |

上表使用用途，具体模型以绑定 home 的 `mode show` 或 `explain` 为准。cut/L2 面向易核验产出，复杂部分提高等级。相邻等级可共用组合；跨模型同名 effort 不证明等效，模型名称不证明能力、价格或权限。`official` 是依据[官方建议](https://learn.chatgpt.com/docs/agent-configuration/subagents#choosing-models-and-reasoning)制定的本地映射，官方没有固定 L1–L4 表。

| 职责 | 允许范围 | 固定绑定 |
| --- | --- | --- |
| `task_scan` | 只读取证 | L1 |
| `task_execute` | 明确独占范围内产出 | L2 |
| `task_review` | 独立复核 | L3 |
| `task_delegate` | 保留原请求职责 | 无固定 model/effort |

固定组合不匹配、L4、用户指定或继承时使用 task_delegate。作用域查询也统一返回 task_delegate，显式传 model/effort 与 `fork_turns="none"`，完整交接；省略参数不证明继承。

`high/fire` 的最高强度须经明确选档授权。fire 每会话先验证实际调用、可信身份及上下文匹配，模型/effort/账号/供应商变化后重验；独立 CLI passed 不能单独放行。失败时仅使用用户指定组合，否则继承已确认的父代理实际组合，不能自动切 high。

分级、快照、能力检查与权限的完整合同见 [Skill](../adapters/codex/skills/agent-fit/SKILL.md)，交接字段见[派发模板](../adapters/codex/skills/agent-fit/references/dispatch-contract.md)。

## 组合校准

预设映射仍需按任务验收。用户要求评估或调优时，按[离线校准指南](../adapters/codex/skills/agent-fit/references/calibration.md)冻结输入、候选、预算与独立预期，分别验证配置契约、分级判断和实际产出。保留首次失败及未知项，运行身份未核验时模型归因标 PARTIAL。

先比较质量，再比较返工、端到端耗时与可信资源用量；批量子问题不算独立重复，较强模型调用比例不等于验收通过率。日常任务不自动对照、采集账本或修改默认映射，普通切档也不以追加评测为前提。

## 职责与模型一致性检查

`status --details --json` 的 `roles` 并列返回预期等级、model/effort 与磁盘配置。`matches_mode` 核对文件可解析、名称正确及组合匹配；task_delegate 必须同时省略 model 和 effort。未安装时该值为 null。

不匹配返回 `ROLE_CONTRACT_MISMATCH`，已安装 home 标为 drifted，写入在覆盖前停止；摘要、路径、符号链接和恢复保护继续适用，不自动修复用户修改。磁盘一致不证明实际模型、账号权限或职责已执行。

## 备用与模型不可用

| 档位 | L1 备用 | L2 备用 | L3 备用 | L4 备用 |
| --- | --- | --- | --- | --- |
| cut | 通用用途/medium | 通用用途/medium | 通用备用用途/medium | 通用备用用途/high |
| official | 通用用途/medium | 通用备用用途/medium | 通用备用用途/high | 通用备用用途/xhigh |
| high | 通用用途/high | 通用备用用途/ultra | 通用用途/ultra | 通用用途/ultra |
| fire | 用户指定，否则继承父代理 | 同左 | 同左 | 同左 |

候选使用自己的备用，主代理从原任务完整快照取值。已选择的 cut/official/high 或自定义档位，在授权、预算、能力和宿主均允许时可使用本级非空 fallback；仅保存或预览不算选择，null 不借用其他档位。用户锁定模型或禁止备用优先。

认证、权限、额度、账单及未知原因停止受影响路径；模型不可用、effort 不支持或有限重试后的临时故障才按条件接续。初次、重试、质量升级及备用共用每任务最多三次委派，同组合最多额外一次，累计重试等待不超过 30 秒并遵守 Retry-After；宿主重试未知时不叠加，拆分不重置。

写入任务先确认旧 worker 已停止并检查部分产出。主代理通过 task_delegate 显式派发，CLI 不自动重派或更换账号/供应商。完整分流和 fire 例外见[失败处理](../adapters/codex/skills/agent-fit/references/failure-policy.md)。

## 验收失败与质量升级

请求成功但产出未达原验收时，先指出可复核失败，再区分前提缺失、方法遗漏和推理不足。前提先补齐；有限重试或质量升级使用原任务快照，保留职责、验收、预算与累计次数，不能用可用性 fallback 代替升级。

比较实际 model + effort；相同组合改等级或标签不算升级。写入者停止未知、次数耗尽、组合被锁定或无合适候选时停止受影响委派，报告 PARTIAL/BLOCKED 并继续独立工作。完整条件见[质量升级](../adapters/codex/skills/agent-fit/references/failure-policy.md#质量升级)。

## 自定义档位

```sh
agent-fit mode create "我的研究方案" --from fire
agent-fit mode configure "我的研究方案" \
  --level L4 --model gpt-6-astra --effort low \
  --fallback-model gpt-6.1-sol --fallback-effort high
agent-fit mode set "我的研究方案"
```

自定义名称不能与内置档位的 id、中文名或现有自定义名称/id 重复；自定义档位可按名称或 custom-* id 选择。

名称 trim + Unicode NFC 归一化，1–80 个码点，不能含控制字符、无效 Unicode 或与既有名称/id 混淆。名称只用于显示与查找，不拼文件路径；内部 id 为 UUID。模型 1–200、effort 1–40 个码点，拒绝无效 Unicode、控制字符和首尾空白。目录未知不等于标识无效。

创建是完整快照，之后不跟随来源变化。内置档位不可修改或删除，修改前先复制；无引用的本层自定义档位可用 `mode delete` 删除。不支持重命名或增加任务等级，自定义也不能扩大权限。

单级修改主组合时，未明确提供备用会清空原备用；完全相同的主组合重复保存保留已有备用。`--clear-fallback` 与备用参数互斥，主配置仍需完整。

四级一次保存的 stdin 格式：

```sh
agent-fit mode configure "我的研究方案" --definition-stdin <<'JSON'
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

最高 64 KiB UTF-8 JSON；必须明确全部等级与备用/null；每级可选 tasks，候选也须完整提供 model、effort 和 fallback/null，拒绝未知字段、无效类型/等级、缺级、半对参数或主备用相同。与单级参数互斥。活动定义与部署角色同一事务保存；非活动定义只保存，不激活。

### 专长路线

cut/official 的 visual/computer/writing 使用同一专长用途，L1 low、L2 medium、L3 high；故障备用为通用模型 medium、medium、high。high/fire 按原高强度策略处理这三类任务，L4 不提供专长路线。

先确定复杂度与保障要求，再核对主要工作是否属于专长、关键事实和约束是否已知、结果是否可核验。开放研究、强耦合或高后果且难验收的任务仍使用基线或 uncertain/reasoning；含有图片或产出文章不足以选择专长候选。电脑操作仍须原工具与写入授权，不能扩大只读职责。

```sh
agent-fit explain --level L1 --task visual --role task_scan --json
agent-fit explain --level L2 --task computer --role task_execute --json
agent-fit explain --level L3 --task writing --role task_review --json
```

聊天中补齐 Skill 要求的 session、project 与 thread 参数。已有自定义定义和任务快照不自动合并新候选；可从当前内置定义创建新档位，或通过完整定义编辑。配置与规则同步后重启一次 Codex，随后按新任务查询；不需要先追加模型评测。

### 模型绑定与换代

内置策略在 [modes.json](../adapters/codex/modes.json) 中引用用途别名，包内默认模型 id 集中在 [model-bindings.json](../adapters/codex/model-bindings.json)。同用途换代无需改写策略或更新共享 Skill。五种用途为 `economy`（经济）、`general`（通用）、`general_backup`（通用备用）、`frontier`（旗舰）、`visual_work`（视觉、电脑操作和写作）。

```sh
agent-fit models check --codex-home "$CODEX_HOME"
agent-fit models bind general "$NEW_MODEL" --dry-run --codex-home "$CODEX_HOME"
agent-fit models bind general "$NEW_MODEL" --apply "$PREVIEW_TOKEN" --codex-home "$CODEX_HOME"
```

从目录选定具体 id 后，预览会列出每个受影响档位、等级或任务类型的主选和备用变更；令牌对应这个 home、当前配置和这份变化。确认模型能力、预算及变化范围后，用预览返回的令牌应用（JSON 字段 `data.model_binding.preview_token`）。应用会重新查目录；配置有变化、目录未完成，或新组合不在可见目录及支持的 effort 中，均不会写入。不会自动晋升新模型、调整 effort 或调用推理。自定义供应商的目录不提供 effort，不能用于此命令；需要时可直接保存自定义档位中的具体组合。

更新存入绑定 home 的 `.agent-fit/model-bindings.json`，覆盖包内默认绑定。该 home 后续所有作用域的内置档位使用更新后的组合；当前全局内置档位如受影响，其快照和角色配置一并更新。已开始任务、自定义档位和其他 home 的组合不变。需要撤销某条绑定时，用原模型 id 重新预览并应用。模型目录不证明能力或实际调用；`fire` 仍须按新组合重新验证。

### 配置与模型检查分开执行

setup、设置或激活内置/自定义档位、应用当前自定义修改，以及重复设置当前档位只处理本地配置，不启动 Codex 账号/模型检查进程，不查询供应商目录、不发送推理请求，也不生成模型检查记录。配置结果与退出码仅反映本地配置操作，模型不可用或历史记录目录异常不影响配置保存。

需要检查时显式运行 `agent-fit models check` 或 `agent-fit models check --verify`，也可在档位配置页点击“检测当前档位主模型”。网页账号配置页只管理授权与登录。手动实际验证可能产生费用，保留期限、身份核对与错误处理。新记录的 trigger 为 manual；旧自动检查记录保留为历史，不用于证明当前可用性或替代 fire 的会话验证。

## 账号配置

网页账号配置页只管理授权与登录，不查询模型目录、不验证调用可用性、不展示模型检查记录。通用目录查询、批量扫描和历史记录动作继续被网页后端拒绝；档位页通过专用入口检测当前主模型。

网页优先复用服务绑定的 `CODEX_HOME` 中已有 Codex 登录，以及当前供应商配置与环境变量凭据。账号区域显示配置目录与授权来源；读取状态不会重新登录。已有 API Key 登录状态不证明该密钥具有目标模型权限。

需要新授权时，可在账号配置页使用 ChatGPT 浏览器授权、设备码登录或 OpenAI API Key 登录。由官方 `account/login/start` 发起、`account/login/completed` 通知完成，授权可取消；成功后重新读取账号状态。刷新页面可以继续查看同一个本地服务中的待授权状态，停止服务会终止等待。授权等待最多 10 分钟，单次协议请求最多 30 秒。设备码方式可能需要在 ChatGPT 安全设置或工作区设置中启用。切换登录和退出登录须在页面确认，将影响所有复用该 home 的客户端；不会修改第三方供应商环境变量或配置凭据。

凭据由 Codex 官方认证存储管理。API Key 使用密码输入框，通过受保护的本机接口和 stdio RPC 传给 Codex，不进入命令参数、页面持久存储、服务最近操作或检查记录。官方 OAuth 链接与设备码仅在授权等待期间展示，完成、取消或过期后清除。授权地址只接受官方 HTTPS 地址。

## 模型检查

通过 CLI 手动查询模型目录或验证实际调用；`models check --verify --expect-revision REV` 可绑定配置版本，若版本变化则返回 `CONFIG_CHANGED`，不发起验证并记录未完成结果。

每次手动目录检查或实际调用验证都会保存独立 JSON 记录到 `<CODEX_HOME>/.agent-fit-checks/`。成功、失败与未完成都会记录；取消尚未发起的验证不产生记录。记录包含时间、检查类型、CLI 版本、配置版本、供应商、脱敏账号状态、目录、组合参数、请求/权限/实际身份状态与诊断码，不保存账号标识、邮箱、认证令牌或原始 RPC。目录权限为 `0700`，文件为 `0600`，完成后原子保存。

可直接查看保存的 JSON 记录，刷新页面或重启服务不会删除记录。记录目录独立于配置版本核对，新增记录不会造成草稿冲突；恢复委派配置也会保留记录。历史仅作回看，不自动恢复成当前检查结果或作为新会话 fire 的验证凭证。配置版本、供应商、账号及会话适用性仍须核对。CLI 报告记录保存状态，不能将未保存的结果描述为已保存。

```sh
agent-fit models check
agent-fit models check --model gpt-6-astra --effort low --json
agent-fit models check --verify
# 第三方供应商：从其目录逐一验证 Responses 可调用性，可能消耗额度
agent-fit models check --verify --discover
```

日常配置操作不附带账号或模型检查；显式检查、绑定预览与应用会查询所选 home 的目录。

检查通过 stdio app-server 在空临时目录读取当前 home 的账号与生效配置，无认证刷新参数、无项目加载，不输出原始 RPC、stderr、邮箱、账号 ID 或凭据。官方默认上下文的目录使用 Codex `model/list`，最多 100 页，单帧 1 MiB、总接收 8 MiB。第三方供应商或自定义 API 地址使用同一供应商的 `GET /models` 获取候选，不使用 Codex 目录补齐。沿用同一配置的地址、请求头、查询参数和授权，最多 1000 个候选、响应最多 2 MiB；只保留模型标识，不猜测推理强度。当前支持完整单页列表；有后续分页会明确标记未完成并停止批量验证。目录整轮共享 30 秒期限。自定义供应商的空账号不直接判无权限。

`/responses` 需要给定模型，不能直接枚举模型。CLI 的 `--verify --discover` 可能消耗额度或产生费用，会向同一供应商的 `POST /responses` 逐一发送固定短文本；不指定推理强度，使用供应商默认参数。绑定目录版本后候选变化时，返回 `PROVIDER_CATALOG_CHANGED`，不发送批量请求。CLI 可用 `--verify --discover --expect-catalog HASH` 绑定此前目录检查的 `catalog.revision`，不能与单个模型参数混用。整轮最多 90 秒，未完成、超时、额度受限与协议错误记为未确认，不自动重试；供应商明确拒绝权限或返回模型不存在记为不可用。CLI 报告本次可调用、不可用、未确认数量。响应报告了不同模型时归为未确认，不纳入可用列表。

默认参数请求成功只表示该供应商本次接受该模型请求，不证明指定推理强度或严格身份通过，不能代替 fire 的会话验证。所有结果按配置目录保存为独立的 `availability` 历史记录。供应商没有 `/models` 或读取失败时明确告知，不自动借用 Codex 目录；仍可手动提供模型与推理强度进行实际 Responses 验证。

分别查看：目录是否完整、effort 是否支持、账号实际请求权限、可信实际身份。目录列出模型不证明请求成功；目录缺项仍 unknown。桌面会话、启动参数、profile 与 CLI 上下文匹配未核验，检查结果不能冒充桌面账号能力。

实际验证使用固定短文本的独立 Responses 请求：`tools: []`、`tool_choice: "none"`、`store: false`，不加载项目、不启动 Codex 任务线程、没有工具执行器。沿用当前供应商地址、请求头、查询参数与环境变量凭据，或该 home 的 Codex 文件授权；不会改用其他供应商、执行取密钥命令或跟随重定向。特殊授权和系统凭据库暂不支持时明确停止，不读取其他目录或猜测凭据。ChatGPT 文件授权只用于官方 Codex 地址，失效后须重新登录；不自行刷新或保存令牌。目录查询仍共享 30 秒，实际验证整轮最多 90 秒、响应最多 2 MiB，不自动重试。指定模型与推理强度的严格验证成功必须有完整响应完成事件，以及响应元数据中的 model 和 reasoning.effort 同时匹配；请求成功但缺少身份元数据返回未完成，身份不同返回失败。供应商的响应元数据不能独立证明其上游路由，且不证明桌面会话上下文匹配。旧记录的 PROBE_ISOLATION_UNSUPPORTED 仍保留原结果，重新检查才会运行新流程。

账号页与独立验证共用供应商凭据选择：显式配置 `env_key` 时使用对应环境变量，否则使用显式供应商 token；没有这两项时，默认 OpenAI 使用绑定 home 的 Codex 登录。不会仅因环境中存在 `OPENAI_API_KEY` 就宣称该变量已被当前供应商采用。指定的环境变量缺失时不借用文件登录或另一份配置凭据。

每轮实际验证私下绑定请求地址、请求头和授权，发请求前、成功响应后及整轮结束时核对。账号切换、退出登录或所用授权变化时返回 `PROBE_AUTH_CHANGED`、`authorization_changed: true`，停止后续请求，整轮结果标为未完成；已检查项目也失去当前可用性证明。授权绑定及其摘要不进入普通 `configuration_revision`、网页或历史；历史仅保留授权是否变化的状态。

### 验证报告的不同层次

`check_status` 表示检查子结果，`status` 和进程退出码表示整条命令结果。历史保存失败时保留 check_status，status 为 incomplete、history.status 为 failed、退出非零，不能称为已保存或整条命令通过。

`verification_summary` 分开返回 request_succeeded、reported_identity_matched、session_context_matched、fire_gate_satisfied 和 missing_evidence。布尔 null 表示证据不足；独立 CLI 不核实正在聊天的宿主上下文，所以即使请求和响应身份匹配，session_context_matched 与 fire_gate_satisfied 仍为 null。失败或配置/授权变化会使 fire_gate_satisfied 为 false。不能用 check_status=passed 代替 fire 放行，也不能把这些供应商响应字段称为对其上游路由的独立证明。

每个 checked_pairs 条目保存 source_revision 和 valid_for_current_configuration。后者描述本轮检查结束时：检测到配置/授权变化为 false，未完成或无法核实则为 null。历史记录保留当时的值，不在读取时重新认证；历史 matched 或 true 不说明对读取时的配置或聊天仍有效，使用前须重新核对。记录白名单保留这些字段，不保存认证绑定。

共享 Skill 通过 manifest 核对文件完整性。status、mode show、explain、skill path 增加 skill_revision、skill_integrity；home 的 configuration_revision 不因共享规则变化而改变。规则不完整、被修改或未登记时，rules.integrity 不再显示 clean，并给出具体诊断；只读查询和安全恢复仍可进行，但新委派必须先核验规则。用户修改不会被自动覆盖。

## 本地网页

```sh
agent-fit serve --codex-home "/path/to/codex-home" --open
agent-fit serve --port 17321
```

仅监听 `127.0.0.1`，默认端口 0 自动分配，也可指定 1024–65535；占用即失败。`--open` 失败时复制终端 URL。Ctrl+C 等待正在执行的 CLI 安全完成后停止服务。home、项目和可选线程在启动时绑定，换上下文需重新启动。

| 页面 | 操作 |
| --- | --- |
| 档位 | 编辑草稿后保存或应用；候选 JSON 随整表事务提交 |
| 委派规则 | 展示有效来源、四级基线和候选；点击查询依据、备用及权限，其他档位为只读预览 |
| 账号配置 | 管理已有授权、登录、取消和退出；不展示模型目录或历史 |
| 恢复 | 预览并撤销整个 home 的安装，包含全部作用域 |

“检测当前档位主模型”需点击确认，可能产生费用。仅检测当前已保存档位的基线与候选，按 model/effort 去重，排除备用；未安装、非当前档位、有草稿、授权切换中或其他操作执行时禁用。确认框列出组合与次数，取消零请求；配置操作不自动检测。

检测使用 `models check --verify --expect-revision REV`。配置、来源或授权变化后旧结果失效；可调用、响应身份与 fire 会话验证分别报告，详见[模型检查](#模型检查)。

配置、规则与恢复动作仅执行白名单 CLI，账号页使用官方 RPC；不执行任意 shell。接口校验 Host/Origin、会话 Cookie 与 CSRF token，使用 CSP；不开放远程监听或 CORS。桌面侧栏、手机顶部导航，详情和变更确认随屏宽排列。

版本冲突保留草稿且零写入，先“刷新后比较”再保存。断线或结果未知时先刷新，不自动重试写操作；查询失败不保留旧解释。草稿仅在内存，页面关闭可能丢失；取消草稿不会删除已创建的档位。

## JSON、退出码与冲突

JSON stdout 只有统一 envelope：

```json
{"report_schema_version":1,"data":{},"errors":[]}
```

`restart.required` 仅在首次安装、基础规则更新或实际恢复成功时为 true；普通路由调整为 false，部分写入或结果未知时为 null。预览始终为 false，因为尚未写入；提示文字会区分正式应用后是否需要重启。状态查询无法确认用户是否已经重启，不重复发出无条件重启警告。

状态含 `configuration_revision`、CLI/配置版本、四级定义、角色、完整性与诊断。写报告含 `result`、`configuration_status`、变化路径、前后版本、`restart`、`runtime_verification`。`applied/written` 才是已写入；`preview/not_written` 是预览；失败分未写、已回退、部分残留，不能都当成功。

`--expect-revision` 是可选的终端乐观锁，网页写动作必须携带；版本不匹配报 `CONFIG_CHANGED`。来源版本不会被模型检查结束时的新配置版本替换。未确认的读取返回 null 版本，不猜测。

| 退出码 | 含义 |
| --- | --- |
| 0 | 命令完成；模型目录完整不等于调用已验证 |
| 1 | 关键配置/读写失败、检查未完成、记录保存失败或安全门禁不支持；配置可能已保存 |
| 2 | 参数、定义或选择无效 |
| 3 | 目录明确不支持目标参数，或严格调用验证失败 |

常见诊断：

- `RULES_SHADOWED`：非空 home AGENTS.override.md 遮蔽入口。工具不改 override；用户自行合并原规则并停用 override，或选择未遮蔽 home。
- `MANAGED_FILE_DRIFT` / `MANAGED_RULES_DRIFT`：人工改动、删除或 chmod；保留用户内容，核对后重新操作，无 force 覆盖开关。
- `BUSY`：有写入锁或读取持续变化。先确认其他命令已停止；不要自动删除锁。进程崩溃后可能需人工核对锁与残留。
- `VERSION_MISMATCH`：配置版本与当前工具不一致，拒绝读写并保持文件不变。
- `STATE_INVALID`：状态格式、路径或档位引用不受支持，保持文件不变。
- `RESTORE_METADATA_INVALID`：恢复记录缺失或损坏，使用原备份或人工核对，不猜测恢复。
- `MODEL_ACCESS_UNKNOWN` / `MODEL_NOT_LISTED`：权限未知；不能当作可用或不可用的最终证明。

配置文件采用逐文件原子替换、共同独占锁、完整观察复读、状态最后写入和普通失败回退。回退不覆盖并发编辑，残留单独报告。多文件在进程崩溃/断电时并非一个原子事务；不要在应用期间手工修改管理文件。

## 恢复与卸载

**安全规则：调用卸载指令前，必须先按 restore 流程恢复原始配置。** 先确认原绑定 home，用可用的本工具版本预览，再实际恢复；只有实际恢复退出码为 0（JSON 的 `errors` 为空）后才执行卸载。`--dry-run` 不代表已恢复。恢复失败、结果未知或 home 无法确认时停止卸载，保留命令工具、状态和恢复记录，不直接删除包、Skill 或状态目录来代替恢复。

以下示例使用默认 home；独立 home 的两次 restore 均须添加相同的 `--codex-home <原路径>`。多个 home 应逐一恢复，全部成功后再卸载共享的 npm 工具。

```sh
agent-fit restore --dry-run
# 预览确认后执行；恢复失败时不会继续卸载
agent-fit restore && npm uninstall -g @fanglinwei/agent-fit
```

restore 后重启 Codex。它不会卸载 npm 工具、删除整个 home、清理账号或重启应用。这条顺序要求由 Skill 和安装后的 AGENTS 规则约束；直接执行 npm 卸载不会自动代做 restore。

首次 setup 记录受影响文件的原存在状态与普通权限，仅允许接管同内容公开工具资产；AGENTS 只记录管理区块与校验元数据，不保存完整私有正文、config 或认证文件。同版本档位切换与自定义配置保留首次基线。

恢复清理本 home 中本工具新增的四角色、规则区块、当前档位、全部自定义与元数据；保留共享 Skill、用户原文件和后续标记外正文。只非递归删除本工具创建的空目录，home 与无关文件保留。冲突先完整预检，失败不猜测删除。

工具统一使用 Node.js 22+ 和 npm，不需要 Python；安装与配置入口为 `agent-fit setup`。

## 开发验证

```sh
npm ci --ignore-scripts
npm test
npm pack
```

`npm test` 验证安装、档位、查询、恢复和本地服务；安装保护用例覆盖用户配置保留、冲突、符号链接、失败回退及输出脱敏。

浏览器集成入口自动隔离用户 home 与 Codex home，防止安装共享 Skill 到真实用户目录。浏览器集成脚本不安装额外依赖；使用开发环境已存在的 Playwright 和 Chrome：

```sh
PLAYWRIGHT_MODULE=/path/to/playwright CHROME_PATH=/path/to/chrome npm run test:browser
```

已有验收记录与未覆盖范围见[验证范围](implementation-review.md)。历史校准材料不随 npm 包交付，不代表当前安装或发布状态。
