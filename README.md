# Agent Fit

为已获授权的 Codex 子任务选择模型与推理强度，支持会话、项目和全局档位。CLI 与本地网页共用配置，主代理按 Skill 决定是否委派并验收结果。

## 快速开始

需要 Node.js 22+。这份说明对应当前源码。安装正式版本请从 [GitHub Releases](https://github.com/fanglinwei/agent-fit/releases) 下载 `.tgz`，按对应标签的 README 使用；已发布到 GitHub Packages 的版本可按[包仓库安装说明](docs/usage.md#从-github-packages-安装)安装。

旧档位不兼容。已有配置时，先按[换版说明](docs/usage.md#安装与配置)用原版本恢复配置。

要试用当前源码，在项目目录打包并用输出的文件名安装。包名带的是 `package.json` 中的版本号，即使同名也可能与正式发行包内容不同。

```sh
npm pack
npm install -g ./fanglinwei-agent-fit-0.9.0.tgz
agent-fit setup --mode mid --dry-run
agent-fit setup --mode mid
agent-fit serve --open
```

npm 安装只提供工具，`setup` 才配置 Codex。默认目标为 `CODEX_HOME` 或 `~/.codex`；独立目录全程添加 `--codex-home "/path/to/codex-home"`。首次配置、基础规则更新或恢复后重启 Codex，日常切档无需重启。网页访问码见启动终端。

## 选择与查询

| 档位 | 策略 |
| --- | --- |
| `low` · 经济 | 较轻组合处理容易核验的任务，复杂部分提高等级 |
| `mid` · 官方 | 首次配置默认；依据官方建议制定的本地映射 |
| `heigh` · 高级 | 按预设使用高强度组合 |

```sh
agent-fit mode list
agent-fit mode set low
agent-fit status --details
agent-fit explain --level L2 --task bounded --role task_execute --json
```

L1–L4 表示任务推理需求，`--task` 查询同级候选；low/mid 包含视觉、电脑操作和写作专长路线。`explain` 只查配置，不调用模型或创建子代理。内置档位按用途绑定模型，可[显式预览和应用换代](docs/usage.md#模型绑定与换代)。完整组合、职责和选择边界见[使用说明](docs/usage.md#任务等级与委派职责)与 [Skill](adapters/codex/skills/agent-fit/SKILL.md)。

有效档位按 **会话 > 项目 > 全局** 整份选择。CLI 默认全局，聊天中用 `$agent-fit` 切档默认仅当前会话；项目和会话操作见[作用域说明](docs/usage.md#全局项目与会话)。自定义、账号与手动模型检查也见使用说明；配置操作不自动发送模型请求。

## 子代理如何分工

主代理先判断直接完成、并行调用工具或委派哪种更合适。委派前按 [Skill](adapters/codex/skills/agent-fit/SKILL.md) 核对授权、收益、档位和能力，再按[派发契约](adapters/codex/skills/agent-fit/references/dispatch-contract.md)交接并验收。CLI 只提供配置和诊断，不代替宿主派发或提供隔离。

## Marketplace 插件

在 Codex 插件管理中添加仓库 `https://github.com/fanglinwei/agent-fit` 为 marketplace 来源，安装并启用 **Agent Fit**，然后重启 Codex。本地验证也可将当前仓库作为来源。

插件提供规则，仍需安装 CLI 并完成 `setup`。共享 Skill 与插件规则来自同一源码：共享版本通过 `agent-fit skill update` 更新，插件版本通过插件管理更新。二者应保持同版本；已有配置无需重新 setup。清单位于 `.agents/plugins/marketplace.json` 与 `.codex-plugin/plugin.json`。

## 恢复与卸载

卸载前先恢复原绑定 home：

```sh
agent-fit restore --dry-run
agent-fit restore && npm uninstall -g @fanglinwei/agent-fit
```

预览不算恢复完成；独立 home 的两次命令使用相同路径，多个 home 全部实际恢复成功后才卸载。失败或结果未知时保留工具和恢复记录。恢复完成后重启 Codex，完整保护边界见[恢复说明](docs/usage.md#恢复与卸载)。

## 文档与开发

- [使用说明](docs/usage.md) · [开发验证与打包](docs/usage.md#开发验证)
- [文档导航](docs/README.md)：派发规则、历史验收、校准证据与参考资料。

[MIT](LICENSE) © 2026 fanglinwei.
