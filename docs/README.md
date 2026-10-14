# 文档导航

`subagent-delegation` 当前版本为 0.3.0。先阅读使用说明；计划、研究和静态稿保留设计依据，不代替当前版本的验收结果。

| 文档 | 用途 |
| --- | --- |
| [使用说明](usage.md) | 安装、命令、档位、模型检查、网页、冲突与恢复 |
| [实施验收记录](implementation-review.md) | 实测环境、五轮审查、测试与兼容边界 |
| [Skill](https://github.com/fanglinwei/subagent-delegation/blob/main/adapters/codex/skills/subagent-model-selection/SKILL.md) | 启动与每次委派前的简洁流程 |
| [开发计划](https://github.com/fanglinwei/subagent-delegation/blob/main/docs/superpowers/plans/2026-10-13-npm-delegation-modes.md) | 已确认的行为契约和原实施清单 |
| [网页规格](https://github.com/fanglinwei/subagent-delegation/blob/main/docs/superpowers/specs/2026-10-13-local-web-configuration-design.md) | 交互、命令映射及本地服务边界 |
| [参考项目比较](https://github.com/fanglinwei/subagent-delegation/blob/main/docs/research/2026-10-13-plan-review-reference-projects.md) | 固定提交的借鉴来源与宿主差异 |

npm 安装只安装工具；显式 setup 才配置绑定 home。网页保存或应用会执行实际 CLI。部署变化后重启 Codex。目录结果不证明调用权限。restore 只撤销本工具改动，旧版没有基线时不能自动恢复。

桌面和移动静态稿保留在仓库 `docs/design/`，仅用来说明设计。实际页面随 npm 包交付，通过 `sub-d serve` 打开。当前版本仅验收 macOS 配置和接口；宿主加载、其他系统和真实推理分别记录未知范围。
