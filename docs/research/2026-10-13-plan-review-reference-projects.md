# 子代理委派工具的固定源码核对

检查日期：2026-10-13。范围为下表中的四个参考项目、必要的 Codex 官方加载说明，以及它们对本库安装、切换、恢复和权限边界的启示。本笔记只记录源码事实、推论和最小修订建议；没有安装或运行参考项目，没有调用模型，也没有以 README 宣传或静态测试替代宿主验证。

本笔记保留开发前的源码研究。文中的计划章节编号属于当时的历史语境，旧计划已清理；当前行为以[使用说明](../usage.md)和[实施验收记录](../implementation-review.md)为准，历史推论不代替运行证据。

## 固定核对版本和主要来源

| 项目 | commit | 本次核对的直接来源 |
| --- | --- | --- |
| guilhem/codex-subagent-router | `2487cec70242ceba7b5c887ed1d5b7127ffb6e50` | [route / selectedProfile / record](https://github.com/guilhem/codex-subagent-router/blob/2487cec70242ceba7b5c887ed1d5b7127ffb6e50/plugins/codex-subagent-router/scripts/jev_router.mjs)、[hook 注册](https://github.com/guilhem/codex-subagent-router/blob/2487cec70242ceba7b5c887ed1d5b7127ffb6e50/plugins/codex-subagent-router/hooks/hooks.json)、[跳过条件测试源码](https://github.com/guilhem/codex-subagent-router/blob/2487cec70242ceba7b5c887ed1d5b7127ffb6e50/plugins/codex-subagent-router/tests/jev_router.test.mjs) |
| ruban-24/switchboard | `b9239e89625189474fca2a730cdb193c163d1a43` | [policy.ts](https://github.com/ruban-24/switchboard/blob/b9239e89625189474fca2a730cdb193c163d1a43/src/core/policy.ts)、[Codex 启动器](https://github.com/ruban-24/switchboard/blob/b9239e89625189474fca2a730cdb193c163d1a43/src/native/launcher.ts)、[请求代理](https://github.com/ruban-24/switchboard/blob/b9239e89625189474fca2a730cdb193c163d1a43/src/native/proxy.ts)、[目录读取和合成](https://github.com/ruban-24/switchboard/blob/b9239e89625189474fca2a730cdb193c163d1a43/src/native/codex-catalog.ts) |
| Gioryopool/pi-multi-profiles | `60bb74b75ab9a427fe512e4a561e24a5cc18c83a` | [ProfileManager](https://github.com/Gioryopool/pi-multi-profiles/blob/60bb74b75ab9a427fe512e4a561e24a5cc18c83a/src/profile-manager.ts)、[会话路由契约](https://github.com/Gioryopool/pi-multi-profiles/blob/60bb74b75ab9a427fe512e4a561e24a5cc18c83a/docs/session-routing-contract.md)、[执行任务时解析路由](https://github.com/Gioryopool/pi-multi-profiles/blob/60bb74b75ab9a427fe512e4a561e24a5cc18c83a/src/subagents-runtime/manager.ts) |
| sjp121266-ops/codex-subagent-router-v8（司南） | `018d1675ed376758ce22f34ca51b5d9c7f1a70de` | [validateManagedPlanContract](https://github.com/sjp121266-ops/codex-subagent-router-v8/blob/018d1675ed376758ce22f34ca51b5d9c7f1a70de/subagents/managed-plan-contract.mjs)、[router 和离线检查入口](https://github.com/sjp121266-ops/codex-subagent-router-v8/blob/018d1675ed376758ce22f34ca51b5d9c7f1a70de/subagents/router.mjs) |

官方资料按上述日期检查，属于滚动文档，没有伪造固定 commit：[Custom agents / Subagents](https://developers.openai.com/codex/subagents)、[Build skills](https://developers.openai.com/codex/skills)、[AGENTS.md 发现和合并规则](https://developers.openai.com/codex/guides/agents-md)。

## 六项实质发现

### 1. 显式角色也会跳过外部分类型路由；选择日志不证明实际运行

**源码事实：** guilhem 的 hook 匹配 `spawn_agent`。`route` 在输入包含非 null 的 `model`、`reasoning_effort` 或 `agent_type` 时直接跳过分类；返回的分类必须通过模型、候选、概率与置信度检查。它在返回更新后的工具输入前记录选择结果，分类失败则保留原工具输入。[hook 注册](https://github.com/guilhem/codex-subagent-router/blob/2487cec70242ceba7b5c887ed1d5b7127ffb6e50/plugins/codex-subagent-router/hooks/hooks.json)、[route / selectedProfile / record](https://github.com/guilhem/codex-subagent-router/blob/2487cec70242ceba7b5c887ed1d5b7127ffb6e50/plugins/codex-subagent-router/scripts/jev_router.mjs)。

**对本库的推论：** 以本库命名角色作为 `agent_type` 的调用，不能指望安装该 hook 后再自动重选模型。分类保留默认的行为发生在模型执行之前，也不能当作模型执行失败后的安全重派。测试源码覆盖了显式角色跳过，但本次没有执行这些测试。[跳过条件测试源码](https://github.com/guilhem/codex-subagent-router/blob/2487cec70242ceba7b5c887ed1d5b7127ffb6e50/plugins/codex-subagent-router/tests/jev_router.test.mjs)。

**最小修订：** 第 15.1 节的“显式参数”应明确包括角色；第 15.3 节继续保留未来 hook 的宿主门禁。借鉴稳定理由和用户选择优先，分别报告请求选择、配置部署和运行身份。

### 2. Switchboard 控制真实请求传输，本地配置网页不能照搬其启动器

**源码事实：** `assessInitialModel` 与 `assessInitialRoute` 分别处理模型、effort 和不确定性，提供调整理由、排除候选及默认 effort。Codex 启动器注入 `model_provider="switchboard"`、本地代理地址和临时目录；代理再改写并转发实际请求。[policy.ts](https://github.com/ruban-24/switchboard/blob/b9239e89625189474fca2a730cdb193c163d1a43/src/core/policy.ts)、[launcher.ts](https://github.com/ruban-24/switchboard/blob/b9239e89625189474fca2a730cdb193c163d1a43/src/native/launcher.ts)、[proxy.ts](https://github.com/ruban-24/switchboard/blob/b9239e89625189474fca2a730cdb193c163d1a43/src/native/proxy.ts)。

**权限和目录差异：** 其目录来自 `codex debug models --bundled`，合成时对共同能力取交集、上下文取最小值，并拒绝缺少目录项的模型。这是合成代理模型的能力约束，不能据此证明当前账号已获访问权限。[codex-catalog.ts](https://github.com/ruban-24/switchboard/blob/b9239e89625189474fca2a730cdb193c163d1a43/src/native/codex-catalog.ts)。

**最小修订：** 现有取舍方向正确：采用解释理由与独立校验，保留本库显式主/备用定义。`serve` 执行配置 CLI，不接管供应商或推理请求；账号目录的缺项与账号拒绝保持分离。源码没有为本库的文件事务和原始配置恢复提供等价实现证明。

### 3. Pi 的显式停用与会话关闭不同，原计划有一处措辞需收紧

**源码事实：** `ProfileManager.use` 保留首次基线，在 `pi.setModel` 成功后建立活动快照；`off()` 先恢复基线，成功后才停用。切换失败会尝试恢复原路由，但部分恢复异常被吞掉。[ProfileManager](https://github.com/Gioryopool/pi-multi-profiles/blob/60bb74b75ab9a427fe512e4a561e24a5cc18c83a/src/profile-manager.ts)。

会话契约另规定：`session_shutdown` 释放监听器、清理内存路由；下次 `session_start` 可以重新加载会话内持久活动快照。因此“关闭时先恢复基线”不能泛指关闭会话。任务执行入口在调用 runner 前解析并传入路由，没有在该执行调用中逐次重读档位。[session-routing-contract.md](https://github.com/Gioryopool/pi-multi-profiles/blob/60bb74b75ab9a427fe512e4a561e24a5cc18c83a/docs/session-routing-contract.md)、[manager.ts](https://github.com/Gioryopool/pi-multi-profiles/blob/60bb74b75ab9a427fe512e4a561e24a5cc18c83a/src/subagents-runtime/manager.ts)。

**最小修订：** 第 15.1 节改为“显式 off/deactivation 时先恢复基线”。保留首次基线、成功后再清记录和任务调用时确定路由的设计；本库恢复的是受管理文件，不是 Pi 会话模型。本库回退错误必须显式报告，不能复制吞错行为。

### 4. 司南验证任务契约，不能以此宣称操作系统权限已被强制执行

**源码事实：** `validateManagedPlanContract` 校验父代理责任、写入意图、阶段输入输出、交接、审查和桥接调用形状；部分只读判定通过序列化内容与工程关键词检查。展示规则还包含项目品牌、特定字段和泄漏模式。[managed-plan-contract.mjs](https://github.com/sjp121266-ops/codex-subagent-router-v8/blob/018d1675ed376758ce22f34ca51b5d9c7f1a70de/subagents/managed-plan-contract.mjs)。

**对本库的推论：** 该验证器适合借鉴完整交接和父代理验收，但结构通过与关键词未命中不能证明实际工具权限、sandbox 或任意任务的语义安全。router 的桥接和离线计划检查也不等于本库在 Codex App 中成功派发。[router.mjs](https://github.com/sjp121266-ops/codex-subagent-router-v8/blob/018d1675ed376758ce22f34ca51b5d9c7f1a70de/subagents/router.mjs)。

**最小修订：** 第 15 节将其表述为“契约检查”而非强制权限实现；通用任务使用明确授权、写入范围、成果和停止条件。模型档位始终不扩张权限，权限仍需由宿主与具体工具共同落实。

### 5. 模式切换成功只能证明磁盘配置；每次成功切换都要提醒重启

> 2026-10-19 更新：本节保留当时的要求与研究结论。后续已在 Codex 0.162.1 验证全局角色模型/effort 可在同一进程、同一会话下一轮重新加载，产品要求改为日常全局、项目和会话切档无需重启；首次安装、基础规则更新及恢复后仍需重启。宿主加载证据不证明云端实际模型身份；当前操作要求以使用说明为准。

**官方事实：** 自定义角色文件中的模型和 effort 优先于此前解析的派发值；因此只在调用上添加覆盖参数不足以保证改写固定角色。本库需要一致部署角色与规则。官方还说明 AGENTS 指令链在运行开始时构建，旧指令需要通过新运行或重启重新加载。[Subagents](https://developers.openai.com/codex/subagents)、[AGENTS.md](https://developers.openai.com/codex/guides/agents-md)。

**边界和用户要求：** Pi 的运行 API、Switchboard 的请求代理和 guilhem 的工具 hook 各自介入不同阶段，不能外推为 Codex App 对本库文件切换的实时加载保证。本次用户要求“每次切换后提醒重启”，应作为产品契约落实，不能描述为已经证明所有客户端统一要求重启。

**最小修订：** CLI 人读输出、写命令 JSON 和网页成功结果应一致表达：“配置已保存，请重启目标 Codex 后使用；运行生效未验证”。明确对应 Codex home，服务继续运行，不自动终止代理或重启 Codex。重复选择应说明文件是否变化；恢复及修改当前定义后也要说明加载边界。新启动验证角色发现后，仍需可信运行 metadata 才能报告实际模型身份；重启提醒本身不能代替验证。

### 6. 规则资产与原生 Skill 注册要分开；采用 home 内明确规则入口的最小兼容方案

**官方事实：** 当前 Skill 文档列出仓库和用户 `.agents/skills` 等发现入口，并说明更新检测及缺失时的重启处理；不能只凭这份列表判定所有版本对 legacy `.codex/skills` 一概不支持。[Build skills](https://developers.openai.com/codex/skills)。AGENTS 的全局发现优先读取 home 下非空 `AGENTS.override.md`。补充核对 Codex 0.156.1 版本源码后确认：`project_doc_max_bytes` 限制项目发现，不截断 home 全局规则，详见实施记录。[AGENTS.md](https://developers.openai.com/codex/guides/agents-md)。

**本轮主任务已确定的修订方向：** 完整规则资产继续存于绑定 Codex home 的受管理目录；AGENTS 管理区块明确引用该 home 下的 `SKILL.md` 与 `current-mode.json`，避免只依赖 `$skill` 名称。首版不擅自写共享 `~/.agents/skills`，以免多个 home 的档位混用。该入口提供显式读取规则的路径，不能冒充原生 Skill 列表注册或已验证的自动发现。

**最小门禁：** 部署前检查已知 home override 遮蔽，其他宿主的完整规则读取保留未知，发现入口不可用时阻止部署写入；restore 仍按恢复记录执行，不因无关规则入口故障被阻断。实际角色发现、规则完整加载及原生 Skill 注册继续按目标宿主验证，静态文件存在不足以判定通过。上述措施为规划修订，本笔记没有实施安装器变更。

## 对当时计划的结论与验证范围

第 15 节的总体取舍合理：复用解释、基线、紧凑交接和权限边界，保持 CLI 配置事务为唯一写入路径。必须修正的具体误述是 Pi 的“关闭”范围；另外应补清显式角色跳过、权限契约与宿主执行的差别，以及用户要求的逐次切换重启提示。

没有发现会阻止继续规划的硬性 blocker。发布能力仍有门禁：目标 Codex 版本是否发现本库角色、是否读取完整规则、固定角色与派发参数的真实优先级、账号可用性及实际模型身份。home 内显式 AGENTS 路径缓解 Skill 目录不一致，但不能提前取消这些门禁。

本次仅写这份研究笔记；未修改主计划、网页规格或运行代码。未执行第三方测试、安装依赖、启动服务、读取真实 Codex home/凭据或进行 Git 写操作；没有复制第三方实现，许可声明的打包义务仍须在实际采用代码时核对。
