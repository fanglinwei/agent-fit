# 文档导航

`agent-fit` 当前版本为 0.7.4，npm 包为 `@fanglinwei/agent-fit`。本工具面向已获授权的 Codex 子任务调配模型与推理资源，本版按全新安装提供。先阅读使用说明；源码研究和校准记录用于追溯依据，不代替当前版本的验收结果。

| 文档 | 用途 |
| --- | --- |
| [使用说明](usage.md) | 安装、命令、档位与同级任务候选、模型检查、网页、冲突与恢复 |
| [实施验收记录](implementation-review.md) | 当前实现、测试与使用边界 |
| [Skill](https://github.com/fanglinwei/agent-fit/blob/main/adapters/codex/skills/agent-fit/SKILL.md) | 启动与每次委派前的简洁流程 |
| [校准记录](https://github.com/fanglinwei/agent-fit/tree/main/docs/calibration) | 冻结输入、预期与实际结果，保留失败和未知项 |
| [参考项目比较](https://github.com/fanglinwei/agent-fit/blob/main/docs/research/2026-10-13-plan-review-reference-projects.md) | 固定提交的借鉴来源与宿主差异 |

npm 安装只安装工具；显式 setup 才配置绑定 home。网页保存或应用会执行实际 CLI，仅处理本地配置；网页账号配置页只管理授权与登录，模型目录查询通过 CLI 手动发起；当前档位主模型也可在档位页点击检测。首次安装、基础规则更新或恢复后重启 Codex；日常全局、项目和会话切档无需重启，后续新任务读取新配置。目录结果不证明调用权限。restore 只撤销当前版本的本工具改动。只处理当前格式与版本的配置。

实际页面随 npm 包交付，通过 `agent-fit serve` 打开。当前版本仅验收 macOS 配置和接口；宿主加载、其他系统和真实推理分别记录未知范围。
