# Codex configuration

本工具管理四个 task_* 角色、此 Skill、全局档位、home 内的项目/会话配置及 AGENTS.md 中带 agent-fit 标记的区块。AGENTS 启动入口明确引用绑定 home 的 Skill；每次委派前必须按 Skill 检查。指令约束不等于宿主拦截器，原生 Skill 选择器发现与实际运行生效另行核验。

- setup 首次默认 official；内置档位命令与 id 均为 cut、official、high、fire；mode set 切换，mode create/configure 保存自定义档位。
- status --details 查看规则、磁盘角色及潜在覆盖；mode show 与 explain 只预览，不委派。
- models check 只查询账号与目录，目录不证明调用权限；--verify 只有宿主可强制隔离工具、委派及外部副作用时才能运行。
- restore 仅撤销可证明归属的改动，保留安装前内容和管理区块之外的用户修改；基线缺失或损坏时拒绝恢复。
- 卸载前必须按 [Skill 的卸载前恢复规则](../SKILL.md#卸载前恢复) 恢复原绑定 home；预览不算恢复完成，多个 home 逐一恢复。实际恢复失败或结果未知时停止卸载，保留工具和恢复记录。
- 仅支持当前配置格式与版本；不符合时拒绝读写，保持现有文件不变。
- 业务命令支持 --agent codex 与 --codex-home PATH；帮助/版本不接受目标目录。CLI 安装不自动改智能体配置。

作用域为 session > project > global，整份档位覆盖。CLI 不带 --scope 保持全局兼容；聊天切换默认显式 --scope session。非 Git 项目需 --project；会话需主聊天线程 ID，缺失不转为全局。项目与会话状态仅存于绑定 home 的 .agent-fit/scopes.json，清除选择保留自定义定义。

固定角色配置可能覆盖派发参数；作用域查询统一返回未固定模型的 task_delegate，显式传入组合并保留原职责。用户指定配置或需要继承时使用未固定 model/effort 的 task_delegate，并核对宿主默认。任务等级与权限职责互相独立。

## 配置查询与失败分流

主代理先确定复杂度等级与原职责，再执行 `agent-fit explain --codex-home <绑定 home> --scope session --project <项目根> --level <等级> --role <原职责> --json`。JSON 顶层为 `report_schema_version`、`data`、`errors`，先检查进程退出码与 `errors`，再读取 `data`。先核对 `data.scope`、`data.context`、`data.effective_scope` 与目标聊天及项目一致，保存 `configuration_revision` 与完整 `task_profile` 作为该任务后续接续依据。其余所需字段为 `data.mode_id`、`data.level`、`data.requested_role`、`data.primary.model`、`data.primary.effort`、`data.dispatch_role`、`data.permission_contract`；全部按本次选择和职责核对，不能只判断 stdout 非空或 `data` 存在。

| 观察结果 | 处理 |
| --- | --- |
| CLI 不可执行或工具不可用 | 已有该任务有效快照时沿用；新任务必须同时核实 scopes.json 中目标线程与项目的覆盖、定义及全局基线，按完整最近层取值。无法确认时阻断受影响委派，不能只读 current-mode.json 静默采用全局 |
| 退出非零或 `errors` 非空，即使含有 `data` | 保留诊断，先修复查询或配置问题；不使用其中的候选派发，不以直接读表绕过已知错误 |
| JSON 无法解析或必要字段缺失 | 核对原始命令、stdout 与封套结构；标记查询未完成，不编造字段，不当作模型不可用或能力不足 |
| 档位、等级或请求职责不符 | 核对绑定 home 与请求参数，再查询所需配置；不从其他模式补值 |
| 获授权的非活动档位或未安装时预览成功 | `--mode` 不改变已部署角色；返回 task_delegate，评估时显式传入候选 model/effort 并保留原权限契约，不使用候选档位的固定角色 |
| 活动档位查询成功且契约匹配 | 使用返回组合与派发角色，继续核对授权、能力与宿主覆盖；`runtime_verification: unverified` 仍不证明运行身份 |

这些情况处理的是配置链路，不增加模型推理需求。实际任务结果未达原验收时，再按 [质量升级](failure-policy.md#质量升级) 判断是否重试或提高等级；查询修复不能重置原委派计数。

首次安装、更新 Skill、AGENTS 或角色职责内容，以及恢复后须重启 Codex。普通全局、项目和会话切档与当前自定义模型/effort 调整无需重启；本机 Codex 0.162.1 已验证全局角色在同一会话下一轮加载新绑定。项目/会话选择或定义不重写宿主角色；后续新任务重新查询，已有任务沿用完整快照。若日常操作同时部署了基础规则更新，则仍需重启。runtime verification 保持 unverified，直到获得可信宿主证据。非空 AGENTS.override.md、同名角色、管理内容漂移或无法证明的恢复记录会阻止部署。

完整用法、模式表、备用条件与故障处理见项目 docs/usage.md。

fire 每个会话首次委派前须验证 Astra/ultra 的实际调用与可信模型身份；模型、effort、供应商或账号变化后重验。检查失败或无法完成时使用用户指定组合，否则继承父代理实际组合，并使用 task_delegate 保留原职责。全局子代理默认可能覆盖继承，须核对有效组合；没有可信父代理组合时阻断该委派。验证结果不跨会话缓存。

同级任务候选见 [任务路由](task-routing.md)。任务快照中的 levels 每级可含 tasks，各候选保存独立备用；explain 的 task 及 primary 必须对应所选候选。无候选的旧定义仍可查等级基线；显式候选缺失时不猜值。候选编辑与普通路由数据更新无需重启；基础 Skill/AGENTS 规则更新仍需重启。
