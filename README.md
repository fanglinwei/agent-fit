# Subagent Delegation

为 Codex 配置子智能体的模型选择规则。适用于研究、写作、数据分析、规划、开发与审查。

- **low / mid / fire（经济 / 适中 / 性能）**：按 L1–L4 任务难度分配模型与推理强度。
- **自定义档位**：命名自己的配置，逐级设置主模型和备用组合。
- **CLI + 本地网页**：网页操作执行同一个命令行工具。
- **可检查、可恢复**：查看规则与潜在覆盖，查询模型目录，撤销本工具改动。

需要 **Node.js 22+** 和支持独立角色 TOML 的 Codex。当前在 macOS、Codex CLI **0.156.1** 验证配置接口；其他客户端的加载行为需要核验。

## 文档与开发

- [完整使用说明](docs/usage.md)：命令、备用策略、JSON、冲突处理、迁移与卸载。
- [Skill](adapters/codex/skills/subagent-model-selection/SKILL.md)：保持简洁的委派流程。
- [验收与兼容边界](docs/implementation-review.md)：版本记录、验证结果和未验证范围。

## 安装

日常命令使用 `sub-d`（Subagent Delegation），原命令 `subagent-delegation` 继续可用。npm 包名保持 `subagent-delegation`。

默认智能体为 Codex，日常命令无需添加 `--agent codex`；显式指定仍然可用。

从 npm registry 安装命令工具：

```sh
npm install -g subagent-delegation
```

安装并显式配置，一行完成：

```sh
npm install -g subagent-delegation && sub-d setup --mode mid
```

**npm 安装本身不修改 Codex。配置部署变化后，请重启 Codex。**

指定独立的配置目录，并先预览：

```sh
sub-d setup --codex-home "/path/to/codex-home" --dry-run
sub-d setup --codex-home "/path/to/codex-home"
```

也可下载或本地构建 `.tgz` 后安装：

```sh
npm install -g ./subagent-delegation-0.3.0.tgz
npm exec --package=./subagent-delegation-0.3.0.tgz -- sub-d status --details
```

也可从 [GitHub Release v0.3.0](https://github.com/fanglinwei/subagent-delegation/releases/tag/v0.3.0) 下载安装包，或使用 `npm install -g github:fanglinwei/subagent-delegation#v0.3.0`。

## 升级到 0.3.0

```sh
npm install -g subagent-delegation@0.3.0
sub-d setup --dry-run
sub-d setup
```

`setup` 保留已有档位、自定义定义和首次恢复基线。若使用独立目录，两次 setup 都添加原来的 `--codex-home`。升级部署后重启 Codex。旧脚本中的 `economy / balanced / performance` 或中文档位参数需改为 `low / mid / fire`；旧安装记录仍可读取与恢复。

## 日常使用

```sh
# 查看已配置档位、角色、规则与覆盖诊断
sub-d status --details

# 切换档位；完成后重启 Codex
sub-d mode set low
sub-d mode set mid
sub-d mode set fire

# 查看完整定义、解释指定任务等级的选择
sub-d mode show fire
sub-d explain --level L4 --role task_review

# 账号与模型目录检查，不发起推理
sub-d models check

# 启动本地设置页；Ctrl+C 停止
sub-d serve --open
```

网页显示完整产品名称 **Subagent Delegation**；桌面采用侧栏、等级配置表和变更预览，移动端按等级折叠。网页绑定启动时的 Codex home。编辑先成为草稿，点击保存或应用后才执行 CLI；配置版本变化时拒绝旧表单写入。

## 档位

命令名称为 `low`（经济）、`mid`（适中，首次配置默认）、`fire`（性能）。内置档位仅接受这三个名称。旧安装记录仍可读取和恢复；历史内部 id 不作为命令参数。

| 任务等级 | 经济 | 适中 | 性能 |
| --- | --- | --- | --- |
| L1：窄范围、容易核验 | Luna / high | Luna / high | Luna / high |
| L2：明确目标的多步产出 | Luna / high¹ | Sol 6.1 / medium | Sol 6.1 / high |
| L3：复杂分析或关键复核 | Sol 6.1 / medium | Sol 6.1 / high | Astra / low |
| L4：困难推理或深层歧义 | Sol 6.1 / high | Sol 6.1 / high | Astra / low |

模型完整 id 为 `gpt-6-luna`、`gpt-6.1-sol`、`gpt-6-astra`。这些是可编辑的委派预设，**不是账号权限或能力保证**。¹ 经济模式的 L2 只适合容易核验的产出，复杂部分必须提高任务等级。

任务等级与权限职责分开。三个固定角色用于扫描、产出、复核；用户指定模型、继承要求或组合不匹配时使用未固定模型的 `task_delegate`，保留原职责限制。

## 自定义与恢复

```sh
sub-d mode create "我的研究方案" --from mid
sub-d mode configure "我的研究方案" \
  --level L4 --model gpt-6-astra --effort low \
  --fallback-model gpt-6.1-sol --fallback-effort high
sub-d mode set "我的研究方案"

# 先预览，再撤销本工具的配置；恢复后重启 Codex
sub-d restore --dry-run
sub-d restore
```

恢复保留安装前内容及管理区块之外的用户修改，清除本工具新增的角色、Skill、档位与记录。文件漂移、符号链接、缺失或损坏的恢复基线会阻止覆盖；旧版 0.1.0 没有安装前基线，不能自动恢复。

## 规则如何生效

安装后的 AGENTS 管理区块要求 **Codex 启动时读取 Skill，并在每次子智能体创建、重新委派或模型切换前检查 Skill 与当前档位**。Skill 保留用户选择优先、独占写入、禁止递归委派、只读 Git、最小充分验证和 PARTIAL 返回规则。

这是宿主读取后遵守的指令约束。工具不注入委派拦截器，不承诺绕过用户或项目权限，也不把配置文件存在当作运行生效。`models check` 的目录结果不证明调用权限；当前客户端的 `--verify` 因无法证明严格工具隔离而返回 `PROBE_ISOLATION_UNSUPPORTED`，不会发起推理。

## 开发验证

```sh
npm ci --ignore-scripts
npm test
npm pack
```

浏览器验证方法见[使用说明](docs/usage.md#开发验证)。唯一运行依赖为 [smol-toml](https://github.com/squirrelchat/smol-toml)（BSD-3-Clause）；无安装时自动配置或遥测。

## License

[MIT](LICENSE) © 2026 fanglinwei.
