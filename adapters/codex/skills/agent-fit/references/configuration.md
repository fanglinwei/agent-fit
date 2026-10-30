# Codex configuration

本工具在绑定 home 内管理四个 task_* 角色、`.agent-fit/current-mode.json` 全局档位、项目/会话配置及 AGENTS.md 中带 agent-fit 标记的区块。共享 Skill 默认位于 `~/.agents/skills/agent-fit/`，只保存通用规则；AGENTS 和角色通过 `agent-fit skill path --codex-home <绑定 home> --json` 查询入口。每次委派前必须按 Skill 检查。指令约束不等于宿主拦截器，原生 Skill 选择器发现与实际运行生效另行核验。

- `setup --dry-run` 预览、`setup` 迁移旧安装。迁移核对原安装摘要、权限和档位归属，保留当前档位及各作用域选择；冲突时保留现场。旧目录已移走或仅保留指向共享目录的软链接均可识别。
- `status`、`explain`、`skill path` 只读；旧安装返回 `MIGRATION_REQUIRED`，不会在查询时迁移。
- `setup` 仅在共享 Skill 尚不存在时安装；已有文件通过 `skill update --dry-run` 预览和 `skill update` 显式更新。日常切档与 home 的 `restore` 不改写或删除共享 Skill。恢复旧安装前先迁移；共享 Skill 删除不属于 home 恢复。

- setup 首次默认 official；内置档位命令与 id 均为 cut、official、high、fire；mode set 切换，mode create/configure 保存自定义档位。
- status --details 查看规则、磁盘角色及潜在覆盖；mode show 与 explain 只预览，不委派。
- models check 只查询账号与目录，目录不证明调用权限；--verify 只有宿主可强制隔离工具、委派及外部副作用时才能运行。
- restore 仅撤销可证明归属的改动，保留安装前内容和管理区块之外的用户修改；基线缺失或损坏时拒绝恢复。
- 卸载前必须按 [Skill 的卸载前恢复规则](../SKILL.md#卸载前恢复) 恢复原绑定 home；预览不算恢复完成，多个 home 逐一恢复。实际恢复失败或结果未知时停止卸载，保留工具和恢复记录。
- 仅支持当前配置格式与版本；不符合时拒绝读写，保持现有文件不变。
- 业务命令支持 --agent codex 与 --codex-home PATH；帮助/版本不接受目标目录。CLI 安装不自动改智能体配置。

CLI 不带 --scope 保持全局兼容；聊天切换默认显式 --scope session。作用域优先级、隔离、存储与清除规则按下文 [作用域完整契约](#作用域完整契约) 执行。

固定角色配置可能覆盖派发参数；作用域查询统一返回未固定模型的 task_delegate，显式传入组合并保留原职责。用户指定配置或需要继承时使用未固定 model/effort 的 task_delegate，并核对宿主默认。任务等级与权限职责互相独立。

## 配置查询与失败分流

主代理先确定复杂度等级与原职责，再执行 `agent-fit explain --codex-home <绑定 home> --scope session --project <项目根> --level <等级> --role <原职责> --json`。JSON 顶层为 `report_schema_version`、`data`、`errors`，先检查进程退出码与 `errors`，再读取 `data`。先核对 `data.scope`、`data.context`、`data.effective_scope` 与目标聊天及项目一致，`data.skill_integrity` 须为 clean，保存 `configuration_revision`、`skill_revision` 与完整 `task_profile` 作为该任务后续接续依据。其余所需字段为 `data.mode_id`、`data.level`、`data.requested_role`、`data.primary.model`、`data.primary.effort`、`data.dispatch_role`、`data.permission_contract`；全部按本次选择和职责核对，不能只判断 stdout 非空或 `data` 存在。

| 观察结果 | 处理 |
| --- | --- |
| CLI 不可执行或工具不可用 | 已有该任务有效快照时沿用；新任务必须同时核实 scopes.json 中目标线程与项目的覆盖、定义及全局基线，按完整最近层取值。无法确认时阻断受影响委派，不能只读 current-mode.json 静默采用全局 |
| 退出非零或 `errors` 非空，即使含有 `data` | 保留诊断，先修复查询或配置问题；不使用其中的候选派发，不以直接读表绕过已知错误 |
| JSON 无法解析或必要字段缺失 | 核对原始命令、stdout 与封套结构；标记查询未完成，不编造字段，不当作模型不可用或能力不足 |
| 档位、等级或请求职责不符 | 核对绑定 home 与请求参数，再查询所需配置；不从其他模式补值 |
| 获授权的非活动档位或未安装时预览成功 | `--mode` 不改变已部署角色；返回 task_delegate，评估时显式传入候选 model/effort 并保留原权限契约，不使用候选档位的固定角色 |
| 活动档位查询成功且契约匹配 | 使用返回组合与派发角色，继续核对授权、能力与宿主覆盖；`runtime_verification: unverified` 仍不证明运行身份 |

这些情况处理的是配置链路，不增加模型推理需求。实际任务结果未达原验收时，再按 [质量升级](failure-policy.md#质量升级) 判断是否重试或提高等级；查询修复不能重置原委派计数。

## 生效与重启

首次安装、更新 Skill、AGENTS 或角色职责内容，以及恢复后须重启 Codex。普通全局、项目和会话切档与当前自定义模型/effort 调整无需重启；本机 Codex 0.162.1 已验证全局角色在同一会话下一轮加载新绑定。项目/会话选择或定义不重写宿主角色；后续新任务重新查询，已有任务沿用完整快照。若日常操作同时部署了基础规则更新，则仍需重启。runtime verification 保持 unverified，直到获得可信宿主证据。非空 AGENTS.override.md、同名角色、管理内容漂移或无法证明的恢复记录会阻止部署。

完整用法、模式表、备用条件与故障处理见项目 docs/usage.md。

fire 每个会话首次委派前须验证 Astra/ultra 的实际调用与可信模型身份；模型、effort、供应商或账号变化后重验。检查失败或无法完成时使用用户指定组合，否则继承父代理实际组合，并使用 task_delegate 保留原职责。全局子代理默认可能覆盖继承，须核对有效组合；没有可信父代理组合时阻断该委派。验证结果不跨会话缓存。

同级任务候选见 [任务路由](task-routing.md)。任务快照中的 levels 每级可含 tasks，各候选保存独立备用；explain 的 task 及 primary 必须对应所选候选。无候选的旧定义仍可查等级基线；显式候选缺失时不猜值。候选编辑与普通路由数据更新无需重启；基础 Skill/AGENTS 规则更新仍需重启。

## Marketplace 插件前提

通过 marketplace 安装本 Skill 后，仍需 Node.js 22+、`@fanglinwei/agent-fit` CLI 和已完成 `setup` 的目标 Codex home。插件安装仅提供规则，不自动安装 CLI、写入角色或切换档位。

首次使用先确认 `agent-fit --version` 可用，再用 `agent-fit status --codex-home <绑定 home> --json` 检查配置。CLI 缺失或尚未配置时，说明缺少的前提并提供 README 中的安装与 setup 步骤；不凭预设猜测有效档位，不自动执行安装或 setup。用户已授权初始化时可按其范围完成配置。插件缓存中的规则由插件更新管理；`agent-fit skill update` 管理的是共享 Skill，不更新插件缓存。

## 卸载前恢复

执行本工具的卸载指令（包括 `npm uninstall`、`npm remove`）前，必须先按恢复流程，用可用的本工具版本对原绑定 home 执行 `agent-fit restore --dry-run` 预览，再执行实际 `agent-fit restore`。使用独立 home 时，两步均显式传入相同的 `--codex-home <原路径>`；涉及多个 home 时逐一恢复，不能只恢复默认 home。

只有实际恢复成功后才可卸载；退出码须为 0，使用 JSON 时还须确认 `errors` 为空。`--dry-run` 仅预览，不算恢复完成。恢复失败、结果未知或目标 home 无法确认时，停止卸载，保留命令工具、状态与恢复记录，报告原因；不得直接删除包、Skill 或状态目录来代替恢复。

## 作用域完整契约

有效档位优先级为 **会话 > 项目 > 全局**，整份选择 L1–L4 主组合与备用，不逐字段合并。配置仅管理子代理路由，不改变主会话模型或账号认证。

- 聊天中调用本 Skill 并要求切换档位时，默认执行 `agent-fit mode set <档位> --scope session --project <项目根>`；只有用户明确要求才用 `--scope project` 或 `--scope global`。单纯读取本 Skill 不改变任何选择。
- 会话绑定目标聊天的线程 ID。主会话工具中的 `CODEX_THREAD_ID` 可作为默认值，其他调用者必须显式传入 `--thread <目标聊天 ID>`；子代理的环境 ID 不是主聊天 ID。无法确认目标线程时阻断会话操作，不降为全局。
- Git 项目以当前 worktree 根目录为准；子目录共用，不同 worktree 独立。非 Git 项目明确指定 `--project`，不要把随意的工具工作目录当项目。不同 home 的配置独立。
- 项目/会话选择及其自定义档位保存在绑定 home 的 `.agent-fit/scopes.json`。恢复同一聊天保留选择，新聊天或 fork 不继承会话覆盖。项目移动路径后重新选择项目档位。
- `mode clear --scope session|project` 仅清除该层选择，保留定义并恢复继承；全局 clear 恢复 official。删除自定义定义用 `mode delete`，存在选择引用时阻止删除。较小作用域修改上层自定义档位时先生成局部副本，不覆盖共享定义。
- 每个任务首次派发前记录查询的 `configuration_revision`、`effective_scope` 和完整 `task_profile`，作为该任务快照。后续重试、质量升级与备用接续从此快照按等级取值；途中切换或编辑档位只影响新任务，不重置原任务次数。新任务重新查询。

作用域查询返回 `task_delegate`，显式传入 model + effort；当前宿主显式组合使用 `fork_turns="none"`，因此交接中必须包含完整目标、必要上下文、原职责与验收。不要为局部切换重写全局角色或主会话模型。重启与加载时机按上文 [生效与重启](#生效与重启) 执行；静态配置和请求参数不证明实际模型身份。

## 规则完整性与派发准备

configuration_revision 描述 home 的路由配置，skill_revision 独立描述共享规则。status、mode show、explain、skill path 返回 skill_integrity：clean、modified（已登记内容被修改）、incomplete（缺文件）、invalid（清单损坏）、untracked（未登记清单）、unavailable 或 not_installed。status 顶层 integrity 描述 home 配置，rules.integrity 同时反映共享规则状态，不能只看顶层 clean。

规则异常保留用户文件和只读查询/安全恢复能力；explain 成功不授予派发，skill_integrity 非 clean 时先修复受影响规则。已有任务保留原规则摘要与快照；规则发生未核验变化时不据此新派发。skill path 在可读时仍返回入口与完整性，不能仅凭路径存在判定可派发。
