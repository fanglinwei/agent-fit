# 参考源码与设计取舍

核对日期：2026-10-13。仅静态阅读以下固定版本，未安装、运行参考项目或调用模型。来源用于追溯设计，当前行为以[使用说明](../usage.md)和 [Skill](../../adapters/codex/skills/agent-fit/SKILL.md)为准。

## 固定来源

| 项目 | commit | 本次核对的直接来源 |
| --- | --- | --- |
| guilhem/codex-subagent-router | `2487cec70242ceba7b5c887ed1d5b7127ffb6e50` | [route / selectedProfile / record](https://github.com/guilhem/codex-subagent-router/blob/2487cec70242ceba7b5c887ed1d5b7127ffb6e50/plugins/codex-subagent-router/scripts/jev_router.mjs)、[hook 注册](https://github.com/guilhem/codex-subagent-router/blob/2487cec70242ceba7b5c887ed1d5b7127ffb6e50/plugins/codex-subagent-router/hooks/hooks.json)、[跳过条件测试源码](https://github.com/guilhem/codex-subagent-router/blob/2487cec70242ceba7b5c887ed1d5b7127ffb6e50/plugins/codex-subagent-router/tests/jev_router.test.mjs) |
| ruban-24/switchboard | `b9239e89625189474fca2a730cdb193c163d1a43` | [policy.ts](https://github.com/ruban-24/switchboard/blob/b9239e89625189474fca2a730cdb193c163d1a43/src/core/policy.ts)、[Codex 启动器](https://github.com/ruban-24/switchboard/blob/b9239e89625189474fca2a730cdb193c163d1a43/src/native/launcher.ts)、[请求代理](https://github.com/ruban-24/switchboard/blob/b9239e89625189474fca2a730cdb193c163d1a43/src/native/proxy.ts)、[目录读取和合成](https://github.com/ruban-24/switchboard/blob/b9239e89625189474fca2a730cdb193c163d1a43/src/native/codex-catalog.ts) |
| Gioryopool/pi-multi-profiles | `60bb74b75ab9a427fe512e4a561e24a5cc18c83a` | [ProfileManager](https://github.com/Gioryopool/pi-multi-profiles/blob/60bb74b75ab9a427fe512e4a561e24a5cc18c83a/src/profile-manager.ts)、[会话路由契约](https://github.com/Gioryopool/pi-multi-profiles/blob/60bb74b75ab9a427fe512e4a561e24a5cc18c83a/docs/session-routing-contract.md)、[执行任务时解析路由](https://github.com/Gioryopool/pi-multi-profiles/blob/60bb74b75ab9a427fe512e4a561e24a5cc18c83a/src/subagents-runtime/manager.ts) |
| sjp121266-ops/codex-subagent-router-v8（司南） | `018d1675ed376758ce22f34ca51b5d9c7f1a70de` | [validateManagedPlanContract](https://github.com/sjp121266-ops/codex-subagent-router-v8/blob/018d1675ed376758ce22f34ca51b5d9c7f1a70de/subagents/managed-plan-contract.mjs)、[router 和离线检查入口](https://github.com/sjp121266-ops/codex-subagent-router-v8/blob/018d1675ed376758ce22f34ca51b5d9c7f1a70de/subagents/router.mjs) |


## 保留的结论

- **guilhem router**：显式 model、effort 或角色会跳过分类；选择日志发生在执行前，不能证明运行身份或失败后已重派。
- **Switchboard**：启动器与代理接管请求传输。本库仅通过 CLI 管理配置，不照搬供应商代理；目录能力与账号请求权限分别核验。
- **Pi profiles**：显式 off 成功恢复基线后才停用；会话关闭只是释放内存与监听器，下次启动仍可加载快照。本库借鉴首次基线与任务快照，不复制静默吞掉恢复异常的行为。
- **司南**：结构化契约可借鉴完整交接与父代理验收；结构和关键词检查不能证明实际 sandbox 或工具权限。
- **宿主加载**：配置写入与真实生效分开记录。早期“每次切档重启”要求已被后续验证替代；当前重启边界见[安装说明](../usage.md#安装与配置)。
- **规则入口**：原生 Skill 发现与显式 AGENTS 读取分开核验。早期 home 内固定路径方案已被 CLI 解析共享 Skill 入口替代，见[目录说明](../usage.md#skill-目录与旧安装迁移)。

官方滚动文档：[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Skills](https://learn.chatgpt.com/docs/build-skills)、[AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。官方页面与第三方源码并非本库的运行验证；采用第三方代码前仍须核对许可。
