# Agent Fit

为已获授权的 Codex 子任务选择模型与推理强度，支持会话、项目和全局档位。CLI 与本地网页共用配置，主代理按 Skill 决定是否委派并验收结果。

## 快速开始

需要 Node.js 22+。npm 包名为 [`@fanglinwei/agent-fit`](https://www.npmjs.com/package/@fanglinwei/agent-fit)，命令与 Skill 名为 `agent-fit`。

```sh
npm install -g @fanglinwei/agent-fit
agent-fit setup --mode official --dry-run
agent-fit setup --mode official
agent-fit serve --open
```

npm 安装只提供工具，`setup` 才配置 Codex。默认目标为 `CODEX_HOME` 或 `~/.codex`；独立目录全程添加 `--codex-home "/path/to/codex-home"`。首次配置、基础规则更新或恢复后重启 Codex，日常切档无需重启。

已有其他版本配置时，先保留所需自定义方案，用原版本 CLI 对原绑定 home 预览并实际恢复，再安装新版。版本与发行包见 [GitHub Releases](https://github.com/fanglinwei/agent-fit/releases)；本地安装和 Skill 更新见[使用说明](docs/usage.md#安装与配置)。

## 选择与查询

| 档位 | 策略 |
| --- | --- |
| `cut` · 经济 | 较轻组合处理容易核验的任务，复杂部分提高等级 |
| `official` · 官方 | 首次配置默认；依据官方建议制定的本地映射 |
| `high` · 高级 | 预设模型的最高受支持推理强度 |
| `fire` · 全开 | Astra / ultra，委派前须通过当前会话的实际验证 |

```sh
agent-fit mode list
agent-fit mode set cut
agent-fit status --details
agent-fit explain --level L2 --task bounded --role task_execute --json
```

L1–L4 表示任务推理需求，`--task` 查询同级候选；cut/official 包含 Terra 6.1 的视觉、电脑操作和写作路线。`explain` 只查配置，不调用模型或创建子代理。完整组合、职责和选择边界见[使用说明](docs/usage.md#任务等级与委派职责)与 [Skill](adapters/codex/skills/agent-fit/SKILL.md)。

有效档位按 **会话 > 项目 > 全局** 整份选择。CLI 默认全局，聊天中用 `$agent-fit` 切档默认仅当前会话；项目和会话操作见[作用域说明](docs/usage.md#全局项目与会话)。自定义、账号与手动模型检查也见使用说明；配置操作不自动发送模型请求。

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

- [使用说明](docs/usage.md)：CLI、网页、作用域、自定义、模型检查与故障处理。
- [文档导航](docs/README.md)：规则、验证边界及历史证据入口。
- [验证范围](docs/implementation-review.md)：已有验收记录与未覆盖范围。

```sh
npm ci --ignore-scripts
npm test
npm pack
```

打包生成 `fanglinwei-agent-fit-0.8.0.tgz`。浏览器检查见[开发验证](docs/usage.md#开发验证)；唯一运行依赖为 [smol-toml](https://github.com/squirrelchat/smol-toml)。

[MIT](LICENSE) © 2026 fanglinwei.
