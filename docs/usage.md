# 使用说明

`agent-fit` 0.7.1，npm 包名为 `@fanglinwei/agent-fit`，命令和 Skill 名仍为 `agent-fit`。首版支持 Codex；Node.js 22+。命令、网页和生成的 Skill 使用同一套档位数据。

工具只处理当前格式与版本的配置；独立 home 全程使用显式指定的路径。

## 安装与配置

从 npm registry 安装，或在项目目录运行 `npm pack` 后使用 `npm install -g ./fanglinwei-agent-fit-0.7.1.tgz` 安装本地包。两种方式都需要 Node/npm。

```sh
npm install -g @fanglinwei/agent-fit
agent-fit setup --mode official --dry-run
agent-fit setup --mode official
```

一行安装并配置：

```sh
npm install -g @fanglinwei/agent-fit && agent-fit setup --mode official
```

目标目录优先级为 `--codex-home PATH`、`CODEX_HOME`、用户 `~/.codex`。空格路径需要 shell 引号。命令不会设置主代理模型、全局子代理默认、供应商、审批、沙箱、并发或子代理启用开关。

Skill 名称为 `agent-fit`，调用为 `$agent-fit`，安装目录为 `skills/agent-fit`。npm 安装命令获取已发布版本；当前内测开发代码通过 `npm pack` 构建本地包。

首次 setup 默认官方（official）；同版本重复 setup 保留当前选择与首次恢复基线。npm 安装没有 postinstall 配置动作。`--dry-run` 不创建目标 home、锁或状态文件。

**首次安装、基础规则更新或恢复原配置后需要重启 Codex；日常档位切换与模型/effort 调整无需重启。** 全局角色配置在下一轮加载，项目与会话选择由后续新任务重新查询；已开始的任务继续使用原快照。工具不会自动重启或停止任务。

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

首次安装、更新基础 Skill、AGENTS 或角色职责内容，以及恢复原配置后需要重启。普通全局、项目和会话切档、当前自定义档位的模型/effort 调整、重复设置无需重启。若同一次操作还部署了基础规则更新，则仍提示重启。

本机 Codex 0.162.1 已验证：同一进程、同一会话的下一轮可重新加载全局角色模型和 effort 绑定，无需重启；项目与会话选择供后续新任务查询。已开始任务沿用原快照。该证据证明宿主配置加载，不等于真实云端子代理模型身份已验证；实际模型身份仍需可信宿主 metadata 核验。

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
| `mechanical`：确定性机械任务 | L1 | Luna / medium |
| `bounded`：普通有界任务 | L2 | Luna / high |
| `scan`：大型有界扫描或审查 | L1/L2 | Luna / xhigh |
| `deep`：大型确定性深度处理 | L1/L2 | Luna / max |
| `complex`：有界复杂任务 | L2/L3 | Sol / medium |
| `uncertain`：高歧义、高耦合或高后果且难验收 | L3/L4 | Astra / low |
| `reasoning`：复杂推理或已证实推理不足 | L3/L4 | Astra / medium |
| `latency`：明确追求低延迟 | 任意等级 | 须显式配置；不自动启用 Terra |

这些是待校准的本地策略，不代表已经验证模型能力或延迟。普通自动 Astra 路由默认 low，复杂推理或有证据的质量升级最多 medium；更高强度需要明确授权。**用户明确选择 high/fire 即授权其展示的最高强度，包含 Astra/ultra**；预览或保存不构成选择，预算、宿主支持和 fire 会话验证继续适用。已选择的自定义档位执行明确保存的组合。

```sh
agent-fit explain --level L1 --task mechanical --role task_execute --json
agent-fit explain --level L1 --task scan --role task_review --json
agent-fit explain --level L3 --task uncertain --role task_scan --json
agent-fit explain --level L3 --task reasoning --role task_execute --json
```

聊天仍须使用会话作用域及目标项目、线程上下文。`--task` 只查表，不自动分类、切档或发模型请求；不传时返回原等级基线。类型与等级不匹配会被拒绝；明确请求但快照未配置时返回 `TASK_ROUTE_NOT_CONFIGURED`，不能借用包内新值或自行拼组合。旧安装尚无候选时，预览并更新基础配置后再查询；本次基础 Skill 更新部署后仍需重启一次。

每级可选 `tasks`，键为上表类型，每项完整包含 `model`、`effort`、`fallback`（可为 null）。复制档位、三层作用域和任务快照均保留候选；单级 CLI 配置只改基线，候选通过整表 JSON 或网页“任务候选 JSON”编辑，`{}` 清空本级候选。例如 L1 的 `tasks.latency` 可保存用户明确提供的 Terra 模型 ID、high 及适当备用；必须满足原能力要求，不能凭模型名承诺低延迟。

三个作用域的复制内容均与同一作用域下 `mode show <源档位>` 显示的完整定义一致。源档位对应已部署快照时复制该快照；旧快照没有的候选不会因复制而自动加入。

候选使用自己的备用。质量升级可以在原 L3/L4 中由 uncertain 的 Astra/low 转向 reasoning 的 Astra/medium；先证实推理不足，继续沿用原快照、职责与验收，计入同一任务最多三次委派。不能用故障备用代替质量升级，也不自动转到更高强度。

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

`explain --mode MODE` 查询非活动档位或在未安装时预览，只返回候选组合，不改变已部署角色；派发角色统一为 `task_delegate`，获授权评估时显式传入候选 model/effort 并保留原权限契约。为旧调用兼容，省略 --scope 的全局查询仅在固定角色组合匹配且不是 L4 时返回固定角色；显式作用域查询统一使用 task_delegate。

同一档位重复切换不重写、不提醒重启；普通切档及当前自定义定义更新也不要求重启。仅保存非活动定义不激活该档位。配置版本或格式不匹配时，读取与写入都会被拒绝，不做自动转换。

无需全局安装的 npm 查询，以及本地包查询：

```sh
npm exec --package=@fanglinwei/agent-fit@0.7.1 -- agent-fit status --details
npm exec --package="/path/to/fanglinwei-agent-fit-0.7.1.tgz" -- agent-fit status --details
```

## 委派收益检查

主代理先决定执行方式，再为需要委派的任务选择等级与模型。依次考虑主会话直接完成、独立工具调用并行，以及有明确收益的子代理委派。工具并行仍由同一主代理解释结果，不能替代独立复核。用户禁止子代理时不委派；用户明确要求委派或项目要求独立复核时，在授权、预算与宿主限制内执行，无法满足时说明阻塞。

收益可以来自模型适配、独立判断、上下文隔离或缩短总耗时。开销包含启动、上下文交接、等待、汇总、验证与返工。估算采用已有观测或保守值，未知开销不算零；不为估算额外调用模型，不用模型名称推断账单。收益不明确而主代理具备能力时继续本地完成；必要能力、证据或前提缺失时保留原验收并报告受影响部分。

比较耗时时，两侧使用相同验收口径。委派侧先按依赖和可用槽位计算实际可重叠的执行时间，再计入协调开销；共享文件、构建状态或运行资源有冲突时不能直接并行。只为提速而委派，须扣除开销后仍有明确余量；独立复核等质量收益可以值得额外时间，但须单独说明。用一句话说明执行方式和主要理由，预计节省不等于已测得加速。

| 场景 | 选择与理由 |
| --- | --- |
| 两个已知文件各读 3 秒，子代理交接需 35 秒 | 独立读取可直接工具并行，由主会话判断；换模型不足以抵消交接成本 |
| 两项独立调查各 90 秒，串行预计 180 秒；两个空闲槽，每名代理启动 40 秒，另需交接 35 秒、汇总 25 秒、验证 20 秒 | 委派预计 40 + 90 + 35 + 25 + 20 = 210 秒；只有提速诉求时由主会话完成 |
| 45 秒的复核需 60 秒交接，但项目要求独立复核 | 保留独立复核，按原职责派发；无法执行则报告阻塞，不用作者自查替代 |
| 两项独立研究各 8 分钟，委派总开销约 1 分钟且有两个空闲槽 | 委派预计约 9 分钟，对比串行约 16 分钟，有明确余量；同模型也可获得并行收益 |

上述时间仅为说明判断方法的假设，不是固定门槛或宿主性能承诺。此检查借鉴 [codex-auto-model-router 的收益与协调开销判断](https://github.com/orange-the-weak/codex-auto-model-router/blob/main/SKILL.md)，沿用本工具的授权边界、四档模型配置和失败策略，不引入其自动授权或固定时间阈值。判断由主代理按 Skill 执行，CLI 的 `explain` 仍只静态解释等级与角色；它不会测量成本、派发任务或证明收益。基础规则更新部署后需重启 Codex，日常档位切换无需重启；工作区文件变更不表示已安装 home 已更新。

## 任务等级与委派职责

先按歧义、耦合与实际推理需求判断复杂度，再检查错误后果、可验证性、输入/工具/上下文能力，最后从当前档位读取 model + effort。职责决定允许做什么，等级决定使用哪个配置；角色名称不决定等级。CLI 的 `explain --level` 只解释传入的等级，不调用分类模型，也不评估任务文本。

复杂度与职责由主代理判断，配置查表与 JSON 解析直接使用工具，不为此额外派发子代理。选好等级后执行 `agent-fit explain --codex-home <绑定 home> --level <等级> --role <原职责> --json`；退出码为 0、顶层 `errors` 为空，且 `data.mode_id`、`data.level`、`data.requested_role` 正确后，再使用 `data.primary`、`data.dispatch_role` 和 `data.permission_contract`。日常委派使用当前模式，获授权的非活动候选评估才传 `--mode`。工具不可用与查询失败分别按 [配置查询说明](../adapters/codex/skills/agent-fit/references/configuration.md#配置查询与失败分流) 处理；静态结果不证明实际运行身份或可用性。

| 等级 | 判定依据 | 不足以单独升级的因素 |
| --- | --- | --- |
| L1：明确执行 | 方法、输入和验收已知，几乎不需要选择方案 | 文件多、文本长、重复步骤多 |
| L2：有边界的推理 | 目标与验收明确，需要局部分析或有限方案选择 | 开发、调试、审查等职责名称 |
| L3：复杂推理 | 相互影响的约束、竞争假设或矛盾证据需要权衡 | 单纯多步，或要求执行者独立 |
| L4：高不确定性推理 | 关键假设尚未建立，需要构造并检验多条解释，或处理强耦合的开放问题 | 缺少资料、凭据或环境不通；这些情况先补前提 |

高影响且缺乏可靠验收时采用至少 L3 的本地保障下限，说明复杂度与保障调整各自的理由；这不是经过实测的能力保证。易于确定验收的机械任务可保留 L1。所选组合仍须满足实际能力和原验收，独立或专业验证遵循原任务要求；更强模型不能替代必要证据。

| 任务等级 | cut（经济） | official（官方） | high（高级） | fire（全开，验证通过后） |
| --- | --- | --- | --- | --- |
| L1：明确执行 | Luna / high | Luna / high | Luna / max | Astra / ultra |
| L2：有边界的推理 | Luna / high¹ | Sol 6.1 / medium | Sol 6.1 / ultra | Astra / ultra |
| L3：复杂推理 | Sol 6.1 / medium | Sol 6.1 / high | Astra / ultra | Astra / ultra |
| L4：高不确定性推理 | Sol 6.1 / high | Sol 6.1 / xhigh | Astra / ultra | Astra / ultra |

L1–L4 是任务需求，cut/official/high/fire 是资源策略。相邻等级共用组合有效：cut 的 L1/L2、high 的 L3/L4、fire 的全部等级相同，不能据此宣称存在四档实际能力。¹ cut 的 L2 仅用于容易核验的产出，复杂部分提高等级。model 与 effort 含义不同，但执行时使用配置中的完整组合，不临时拼接；跨模型同名 effort 不证明等效，更高 effort 也不保证更合适。

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

| 场景 | 选择与理由 |
| --- | --- |
| 核对 20 个名称是否符合给定精确格式 | L1，只读复核；固定复核角色组合不符时使用 task_delegate，保留只读权限 |
| 按已批准表替换 200 个文件，可确定核验 | L1 的机械产出；文件数不证明需要复杂推理，写入范围与共享资源仍须明确 |
| 在单模块实现验收明确的小功能 | L2 的局部推理；并非所有实现任务都需要 L3 |
| 只读取证，分析异步状态与持久化竞争的矛盾证据 | L3 的复杂推理；不能因只读而固定使用 L1 |
| 多机制交互且关键假设未知，需要构造与检验多条解释 | L4；若缺少必需材料，先补前提 |
| 操作机械但涉及权限边界，错误后果高且缺乏可靠验收 | 说明复杂度可能为 L1，因保障下限采用至少 L3；无法满足原验收时补前提或阻断 |

一次派发用一句话说明即可，例如：“跨模块状态约束与矛盾证据需要 L3，采用 official 的 Sol 6.1/high，通过 task_delegate 保留只读取证职责。”不用逐次生成评分表。

AGENTS 管理入口要求启动时读取 Skill，每次创建、重新委派或模型变化前按 Skill 检查。用户选择、预算、宿主和项目规则优先，工具不自动授权委派。主代理保留最终设计、共享裁决、集成、关键验证及完成声明。子代理禁止递归、外部环境和代理配置改动；独占写入、局部适配/阻断、最小充分验证及 PARTIAL 返回在全部档位保留。

本工具不额外限制 Git 操作或图像生成，也不设置 `features.image_generation`。实际工具能力与操作授权遵循宿主、用户和项目规则。

## 组合校准

当前映射是待校准预设。日常委派不自动运行对照、训练路由器、采集任务账本或修改默认配置；用户要求评估或调优时，按 [离线校准指南](../adapters/codex/skills/agent-fit/references/calibration.md) 冻结任务、候选、预算与原验收，独立执行并记录结果。指南随 Skill 部署到 `references/calibration.md`，普通任务不必加载。

先由主代理预检本次涉及的配置查询、JSON 封套与职责契约，再进入模型候选评估；预检不发模型请求，查询故障不记为候选能力失败。分级规则核验检查“等级判断是否一致”；组合能力评估检查“实际任务是否通过原验收”，三者不能互相替代。优先比较不同的 model + effort，不对 high 的 L3/L4 或 fire 的相同组合重复计费。范围用于限定职责与上下文；时延要求只在满足质量的候选间取舍，不对任务信号强制打分。

分级边界核验分别记录任务本身复杂度、保障后的拟采用等级、是否需先补前提及理由；被测上下文不手工猜模型组合，主代理再用 CLI 取值。输入和预期分开冻结，覆盖文件数、职责名称、时限等干扰；同一批案例不算多次独立重复，未发现违规证据时保留原分级与默认映射。

结果按请求组合与可信运行 metadata 分别记录；运行身份未验证时，模型归因标 PARTIAL。保留全部首次尝试、失败和未知项，批量子问题不冒充独立重复样本，缺失耗时或资源证据不能填零。先核对质量，再比较返工、端到端耗时和可信资源用量；较强模型调用比例不等于验收通过率。只有证据稳定并在独立样本复核后，才按用户授权保存自定义档位；样本不足保留原映射。

失败接续另用冻结场景核对下一步动作、组合、原职责、已用次数与停止理由，不实际执行案例任务；决策核验通过不证明宿主已执行重派。预期答案与输入分开保存，规则部署文字检查不能替代该核验。

任务信号借鉴 [codex-auto-model-router](https://github.com/orange-the-weak/codex-auto-model-router/blob/main/references/routing-criteria.md)，校准思路借鉴 [RouteLLM](https://github.com/lm-sys/RouteLLM)，验收后再考虑升级的思路参考 [FrugalGPT 的模型级联](https://arxiv.org/abs/2305.05176)。本工具不移植其模型列表、训练系统或研究中的成本收益数字；职责配置检查继续借鉴 Castwright，复杂度判定不按职责固定。

## 职责与模型一致性检查

`agent-fit status --details --json` 的 `roles` 为每个受管理角色并列给出 `task_level`、`expected_model`、`expected_effort`，以及 `configured_name`、`configured_model`、`configured_effort`。`matches_mode` 同时检查文件存在且可解析、角色名称正确、模型和 effort 与当前已部署档位一致；未安装时为 `null`。

| 角色 | 核对要求 |
| --- | --- |
| `task_scan` | 文件名与 `name` 对应，model 和 effort 均匹配当前 L1 |
| `task_execute` | 文件名与 `name` 对应，model 和 effort 均匹配当前 L2 |
| `task_review` | 文件名与 `name` 对应，model 和 effort 均匹配当前 L3 |
| `task_delegate` | 文件名与 `name` 对应，必须同时省略 model 和 effort；预期等级与组合为 `null`，实际继承仍需宿主证据 |

任一项不匹配时，已安装 home 的诊断返回 `ROLE_CONTRACT_MISMATCH`，完整性标为 `drifted`，配置写入在覆盖前停止。该语义检查独立于文件摘要检查；它不会自动修复用户修改。原有文件漂移、注册路径冲突、符号链接与恢复保护继续适用，`restore` 仍须通过原有恢复条件。

开发测试以 `ROLES` 为本工具的职责登记源，双向核对发布资产中的角色 TOML 与 `assets/codex/config.toml` 注册表，包含嵌套目录中的多余定义，并检查官方初始模板显式设置两个模型参数；所有档位生成时继续使用各自的组合。这借鉴 [Castwright 的角色、模型和 effort 对应检查](https://github.com/dudarenok-maker/Castwright/blob/main/.claude/skills/model-routing/SKILL.md)，只约束本工具发布的四个角色，不要求用户将其他自定义角色纳入本工具登记。

以上结果描述磁盘配置及声明的职责对应关系，不能证明自然语言职责已被执行、账号可调用或实际运行模型与 effort 已生效；运行验证仍单独报告。

## 备用与模型不可用

| 档位 | L1 备用 | L2 备用 | L3 备用 | L4 备用 |
| --- | --- | --- | --- | --- |
| cut（经济） | Sol 6.1/medium | Sol 6.1/medium | Sol 6/medium | Sol 6/high |
| official（官方） | Sol 6.1/medium | Sol 6/medium | Sol 6/high | Sol 6/xhigh |
| high（高级） | Sol 6.1/high | Sol 6/ultra | Sol 6.1/ultra | Sol 6.1/ultra |
| fire（全开） | 用户指定，否则继承父代理 | 同左 | 同左 | 同左 |

cut、official、high 默认允许原已授权任务自动使用本级唯一备用，无需逐次确认；用户明确锁定模型或禁止降级时不切换。模型不可用、effort 不支持，或临时故障有限重试后仍失败时可触发；认证、权限、额度、账单限制及原因 unknown 时停止受影响路径。每任务最多三次委派（初次、重试、质量升级与备用共用），同一组合最多额外一次，累计重试等待不超过 30 秒并遵守 Retry-After；宿主内部重试次数未知时不叠加。备用耗尽后报告原因、实际组合和部分产出，不自动尝试其他模型或切换档位。L3、L4 不自动降到 Luna。

自定义档位采用同样条件与预算：用户选择已保存的档位后，本级非空 fallback（包括从内置档位按值复制的备用）允许自动接续；仅创建、保存或预览候选不构成选择。fallback 为 null 时没有可用性备用，不借用其他档位或 fire 的父代理继承规则；用户锁定模型或禁止备用仍优先。

备用是候选，需要同时满足用户选择、原预算、宿主支持、原工具/输入能力、原职责与验收不变。写入任务还必须确认旧 worker 已停止并检查部分产出。接续由主代理按生成的 Skill 使用 task_delegate 显式指定备用组合执行，CLI 和网页仅配置、展示与检查，不转发推理或自动重派，不换账号或供应商。配置写入和测试通过不证明宿主运行时已接续。

Astra 不可用：先区分认证、权限、额度、临时故障或能力不支持。允许备用且全部条件满足才用当前档位的候选，fire 使用用户指定组合，否则继承父代理；用户强制只用 Astra、预算不允许或旧 worker 停止未知时，受影响部分 BLOCKED，继续其他独立工作。缺资料或工具故障先补前提，不能靠强模型掩盖。

每任务最多三次父代理发起的委派，同一组合最多额外一次；拆分困难部分不重置计数。累计重试等待不超过 30 秒并遵守 Retry-After。宿主已重试或次数未知时不追加。异常或部分结果标 PARTIAL，不自动撤销其他人的修改。完整分类见 [失败处理](../adapters/codex/skills/agent-fit/references/failure-policy.md)。

## 验收失败与质量升级

请求成功而结果未达原验收属于质量问题，不能当作模型不可用。主代理先指出可复核的失败，再区分材料/环境前提、方法或交接遗漏、推理不足；前提缺失先补齐，方法遗漏可补正后有限重试，推理不足或新暴露复杂约束才重评困难部分等级。用户选择、原预算与宿主能力允许时，选择原任务快照中的同级任务候选或更高等级主组合，保留原职责和验收；本级 fallback 仅供可用性接续。

比较实际 model + effort，相邻等级组合相同不重派；可核对下一不同组合，但自定义高等级不保证能力更强。high 的 L3→L4 与 fire 的升等级都没有实际组合提升，无适合候选时报告上限。若有新证据或具体方法修正，可以在余量内重试原组合，并如实称为重试；不机械地先加 effort 或先换模型。

例如使用等级基线时，official/L2 产出未通过原测试，且证据显示遗漏跨模块状态约束，可将困难部分重评为 L3，使用 Sol 6.1/high，通过 task_delegate 保留产出职责。凭据无效则停止认证路径，不按质量升级。每次接续先确认旧写入者停止并检查已有产出；初次、重试、质量升级和备用共用三次总额，拆分不重置。次数耗尽、用户锁定组合、预算不足或无合适候选时停止受影响委派，报告 PARTIAL/BLOCKED，继续独立工作。CLI 不执行自动升级或重派。

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

配置操作不附带账号或模型检查；仅在用户显式执行模型检查命令，或在档位页确认检测时查询所选 home。

检查通过 stdio app-server 在空临时目录读取当前 home 的账号与生效配置，无认证刷新参数、无项目加载，不输出原始 RPC、stderr、邮箱、账号 ID 或凭据。官方默认上下文的目录使用 Codex `model/list`，最多 100 页，单帧 1 MiB、总接收 8 MiB。第三方供应商或自定义 API 地址使用同一供应商的 `GET /models` 获取候选，不使用 Codex 目录补齐。沿用同一配置的地址、请求头、查询参数和授权，最多 1000 个候选、响应最多 2 MiB；只保留模型标识，不猜测推理强度。当前支持完整单页列表；有后续分页会明确标记未完成并停止批量验证。目录整轮共享 30 秒期限。自定义供应商的空账号不直接判无权限。

`/responses` 需要给定模型，不能直接枚举模型。CLI 的 `--verify --discover` 可能消耗额度或产生费用，会向同一供应商的 `POST /responses` 逐一发送固定短文本；不指定推理强度，使用供应商默认参数。绑定目录版本后候选变化时，返回 `PROVIDER_CATALOG_CHANGED`，不发送批量请求。CLI 可用 `--verify --discover --expect-catalog HASH` 绑定此前目录检查的 `catalog.revision`，不能与单个模型参数混用。整轮最多 90 秒，未完成、超时、额度受限与协议错误记为未确认，不自动重试；供应商明确拒绝权限或返回模型不存在记为不可用。CLI 报告本次可调用、不可用、未确认数量。响应报告了不同模型时归为未确认，不纳入可用列表。

默认参数请求成功只表示该供应商本次接受该模型请求，不证明指定推理强度或严格身份通过，不能代替 fire 的会话验证。所有结果按配置目录保存为独立的 `availability` 历史记录。供应商没有 `/models` 或读取失败时明确告知，不自动借用 Codex 目录；仍可手动提供模型与推理强度进行实际 Responses 验证。

分别查看：目录是否完整、effort 是否支持、账号实际请求权限、可信实际身份。目录列出模型不证明请求成功；目录缺项仍 unknown。桌面会话、启动参数、profile 与 CLI 上下文匹配未核验，检查结果不能冒充桌面账号能力。

实际验证使用固定短文本的独立 Responses 请求：`tools: []`、`tool_choice: "none"`、`store: false`，不加载项目、不启动 Codex 任务线程、没有工具执行器。沿用当前供应商地址、请求头、查询参数与环境变量凭据，或该 home 的 Codex 文件授权；不会改用其他供应商、执行取密钥命令或跟随重定向。特殊授权和系统凭据库暂不支持时明确停止，不读取其他目录或猜测凭据。ChatGPT 文件授权只用于官方 Codex 地址，失效后须重新登录；不自行刷新或保存令牌。目录查询仍共享 30 秒，实际验证整轮最多 90 秒、响应最多 2 MiB，不自动重试。指定模型与推理强度的严格验证成功必须有完整响应完成事件，以及响应元数据中的 model 和 reasoning.effort 同时匹配；请求成功但缺少身份元数据返回未完成，身份不同返回失败。供应商的响应元数据不能独立证明其上游路由，且不证明桌面会话上下文匹配。旧记录的 PROBE_ISOLATION_UNSUPPORTED 仍保留原结果，重新检查才会运行新流程。

账号页与独立验证共用供应商凭据选择：显式配置 `env_key` 时使用对应环境变量，否则使用显式供应商 token；没有这两项时，默认 OpenAI 使用绑定 home 的 Codex 登录。不会仅因环境中存在 `OPENAI_API_KEY` 就宣称该变量已被当前供应商采用。指定的环境变量缺失时不借用文件登录或另一份配置凭据。

每轮实际验证私下绑定请求地址、请求头和授权，发请求前、成功响应后及整轮结束时核对。账号切换、退出登录或所用授权变化时返回 `PROBE_AUTH_CHANGED`、`authorization_changed: true`，停止后续请求，整轮结果标为未完成；已检查项目也失去当前可用性证明。授权绑定及其摘要不进入普通 `configuration_revision`、网页或历史；历史仅保留授权是否变化的状态。

## 本地网页

```sh
agent-fit serve --codex-home "/path/to/codex-home" --open
agent-fit serve --port 17321
```

只监听 `127.0.0.1`。默认端口 0 自动分配，指定端口允许 1024–65535；占用即失败。`--open` 打开浏览器，失败时手动复制终端 URL；Ctrl+C 等待正在执行的 CLI 安全完成后停止服务。

服务绑定一个 home 和启动 cwd。换 home 时重新启动。四页入口为档位、委派规则、账号配置、恢复。先编辑草稿，再保存/应用；自定义四级由一个 stdin 命令事务提交。未保存的非活动定义不能直接激活。取消只清除草稿；已创建的档位会保留。

委派规则页默认展示当前作用域已保存且生效的档位，顶部标明作用域与继承来源。四级概览直接展示 L1–L4 默认模型与推理强度；每级列出判断依据、典型任务和适用任务候选的路由，缺失候选明确标为“未配置”，不猜测或借用等级默认。内置 high/fire 的普通任务按本级最高组合显示，低延迟候选仍须显式配置。其他档位仅供只读预览，查看不切换配置，也不构成最高强度授权。

点击等级或任务即可查询选择依据、备用与条件；职责和权限在详情中按需展开，完整模型 ID、来源与诊断继续折叠。桌面在右侧显示详情，窄屏在所选等级下显示。切换查看档位、刷新配置或查询失败时不保留旧解释冒充新结果；版本冲突后先刷新。页面不自动调用模型检测，静态路由不证明账号可用性或运行身份；需要编辑时使用“前往档位配置”。

档位页的“检测当前档位主模型”由用户点击并确认后触发，使用已保存且设为当前的档位，按 model/effort 去重检测 L1–L4 基线及同级任务候选，实际调用次数由去重后的组合数量决定，备用不参与。未安装、查看非当前档位、有未保存草稿、授权切换中或其他操作执行时禁用。确认框展示档位、完整组合、次数与费用提示，取消不发请求；保存、激活、刷新与重新设置均不自动触发检测。

检测复用 `models check --verify --expect-revision REV`，实际调用与响应身份分别呈现。请求成功但缺少身份元数据时保留“可调用 / 身份未确认”，不描述为严格验证通过；返回不同模型或强度时标记未确认。配置版本变化、来源未确认或登录切换后，旧结果失效或清除。结果仅代表本次请求，不代替 fire 的当前会话验证；CLI 仍按原规则保存记录，账号页不展示目录和检测历史。

桌面左侧导航切换页面，上方选择档位，中央查看或编辑 L1–L4 模型分配，右侧核对变更并应用或预览。手机使用顶部导航，变更确认放在模型配置下方。备用组合按需展开；仅选择档位不会写入配置；应用日常档位切换无需重启，后续新任务读取新配置。首次安装、基础规则更新或恢复后仍需重启。

档位、规则和恢复页面通过白名单动作实际 spawn 本包 CLI，显示命令与结果；账号页仅使用官方账号 RPC。页面不直接写配置、不执行任意 shell。HTTP 使用精确 Host/Origin、会话 Cookie、随机 CSRF token、CSP；不支持远程监听、CORS、CDN、守护进程或自动排队。

配置版本冲突保留草稿并零写入，点击“刷新后比较”后再决定保存。断线或结果未知不自动重试写操作，先刷新状态。页面关闭/重载可能丢失内存草稿，未使用浏览器持久存储。

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

恢复清理本工具新增 Skill、四角色、规则区块、当前档位、全部自定义与元数据；保留用户原文件和后续标记外正文。只非递归删除本工具创建的空目录，home 与无关文件保留。冲突先完整预检，失败不猜测删除。

工具统一使用 Node.js 22+ 和 npm，不需要 Python；安装与配置入口为 `agent-fit setup`。

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
