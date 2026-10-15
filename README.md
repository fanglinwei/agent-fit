# Subagent Delegation

此工作副本包含尚未发布的四档修改；重新安装时使用本地打包产物。

为 Codex 安装可配置的子代理委派规则：根据任务难度选择模型与推理强度，明确职责、验证与失败处理。适用于研究、写作、数据分析、规划、开发与审查。

- **cut / official / high / fire（经济 / 官方 / 高级 / 全开）**：按 L1–L4 任务难度分配模型与推理强度。
- **自定义档位**：命名自己的配置，逐级设置主模型和备用组合。
- **CLI + 本地网页**：网页操作执行同一个命令行工具。
- **可检查、可恢复**：查看规则与潜在覆盖，查询模型目录，撤销本工具改动。
- **委派有边界**：独占写入、禁止递归委派、最小充分验证；备用模型与重试遵循原授权和预算。

需要 **Node.js 22+** 和支持独立角色 TOML 的 Codex。当前在 macOS、Codex CLI **0.162.1** 验证账号与模型检查接口；其他客户端的加载行为需要核验。

## 快速开始

终端命令为 `sub-d`，npm 包名为 `subagent-delegation`。

按“安装 → 配置 → 重启 Codex → 查询或调整”的流程使用：

从 npm registry 安装并配置官方档位：

```sh
npm install -g subagent-delegation && sub-d setup --mode official
```

**npm 安装本身不修改 Codex。配置部署变化后，请重启 Codex。**

也可在项目根目录构建并安装本地包：

```sh
npm pack
npm install -g ./subagent-delegation-0.6.0.tgz
sub-d setup --mode official
```

指定独立的配置目录，并先预览：

```sh
sub-d setup --codex-home "/path/to/codex-home" --dry-run
sub-d setup --codex-home "/path/to/codex-home"
```

默认目标为 `CODEX_HOME` 或 `~/.codex`，`--codex-home` 优先。当前仅支持 Codex，日常命令可省略 `--agent codex`。

## 日常使用

```sh
# 查看已配置档位、角色、规则与覆盖诊断
sub-d status --details
sub-d mode list

# 切换档位；完成后重启 Codex
sub-d mode set cut
sub-d mode set official
sub-d mode set high
sub-d mode set fire

# 查看完整定义、解释指定任务等级的选择；不调用 AI
sub-d mode show fire
sub-d explain --level L4 --role task_delegate

# 账号与模型目录检查，不发起推理
sub-d models check
# 第三方供应商 Responses 可用性检查，可能消耗额度
sub-d models check --verify --discover

# 启动本地设置页；Ctrl+C 停止
sub-d serve --open
```

网页提供档位配置、委派规则、模型检查和恢复四个页面，只监听 `127.0.0.1`，绑定启动时的 Codex home。编辑先成为草稿，点击保存或应用后才执行对应 CLI 命令；配置版本变化时拒绝旧表单写入。更换目标目录需重新启动服务。

## 档位

内置档位 ID 为 `cut`（经济）、`official`（官方，首次配置默认）、`high`（高级）、`fire`（全开），命令参数与存储值一致。

| 任务等级 | cut（经济） | official（官方） | high（高级） | fire（全开，验证通过后） |
| --- | --- | --- | --- | --- |
| L1：窄范围、容易核验 | Luna / high | Luna / high | Luna / max | Astra / ultra |
| L2：明确目标的多步产出 | Luna / high¹ | Sol 6.1 / medium | Sol 6.1 / ultra | Astra / ultra |
| L3：复杂分析或关键复核 | Sol 6.1 / medium | Sol 6.1 / high | Astra / ultra | Astra / ultra |
| L4：困难推理或深层歧义 | Sol 6.1 / high | Sol 6.1 / xhigh | Astra / ultra | Astra / ultra |

模型完整 id 为 `gpt-6-luna`、`gpt-6.1-sol`、`gpt-6-astra`。这些是委派预设，**不是账号权限或能力保证**；需要修改时先复制为自定义档位。¹ 经济模式的 L2 只适合容易核验的产出，复杂部分必须提高任务等级。

`official` 是依据 [OpenAI 官方建议](https://learn.chatgpt.com/docs/agent-configuration/subagents#choosing-models-and-reasoning) 制定的本地映射，官方没有固定 L1–L4 表。`high` 各模型使用最高受支持的 effort；预设写入不证明账号可调用。

`fire` 每个会话首次委派前须实际验证 Astra/ultra，并核对可信运行 metadata 与当前会话上下文。模型、effort、供应商或账号变化后重验，不保存跨会话验证缓存。目录查询和口头确认不能代替验证；`models check --verify` 使用不执行工具的独立 Responses 请求，核对供应商返回的模型与推理强度。

检查失败、未完成或最高组合不可用时，使用用户明确指定的模型与推理强度；未另行指定时继承父代理当前实际组合。通过 `task_delegate` 保留原职责，并核对全局子代理默认与角色覆盖；无法确认父代理组合时阻断该委派。不自动切换 high，不绕过原预算、能力和权限规则。fire 的继承备用是运行时选择，静态 fallback 为 null。

任务等级与权限职责分开：

| 角色 | 职责与模型配置 |
| --- | --- |
| `task_scan` | 只读取证，固定为当前档位的 L1 组合 |
| `task_execute` | 独占范围内执行或产出，固定为 L2 组合 |
| `task_review` | 独立复核，固定为 L3 组合 |
| `task_delegate` | 不固定模型或推理强度，用于 L4、用户指定、继承要求或固定组合不匹配，保留原职责 |

## 自定义档位

```sh
sub-d mode create "我的研究方案" --from official
sub-d mode configure "我的研究方案" \
  --level L4 --model gpt-6-astra --effort low \
  --fallback-model gpt-6.1-sol --fallback-effort high
sub-d mode set "我的研究方案"
```

自定义档位以来源档位的完整快照创建，独立保存 L1–L4 的主模型、推理强度和备用组合，沿用相同的委派权限规则。修改内置方案时先复制为自定义档位。完整定义批量配置见[使用说明](docs/usage.md#自定义档位)。

## 恢复与卸载

```sh
# 先预览，再撤销本工具的配置；恢复后重启 Codex
sub-d restore --dry-run
sub-d restore

# 如需卸载命令工具，在恢复后执行
npm uninstall -g subagent-delegation
```

恢复保留安装前内容及管理区块之外的用户修改，清除本工具新增的角色、Skill、档位与记录。文件漂移、符号链接、缺失或损坏的恢复基线会阻止覆盖。

## 规则如何生效

安装后的 AGENTS 管理区块要求 **Codex 启动时读取 Skill，并在每次子智能体创建、重新委派或模型切换前检查 Skill 与当前档位**。

Skill 安装于 `skills/subagent-delegation`，也可通过 `$subagent-delegation` 显式调用。全部档位共用以下委派规则：

- **按需委派**：先核对授权、用户指定模型、预算与宿主限制；按独立产出、判断或并行收益决定是否委派，遵循用户明确要求。
- **等级与职责分开**：按难度和验证需求选择 L1–L4，再选择扫描、执行或复核职责；不凭领域、文件数或任务长度升级。L4、指定模型、继承要求或固定组合不匹配时使用 `task_delegate`。
- **范围明确、写入独占**：派发目标、允许动作、来源、范围与验收；共享产出指定唯一负责人，不覆盖他人修改。子代理不递归委派，不自行更换模型或渠道，不修改生产、共享环境、第三方系统及代理配置；最终设计、共享裁决、集成和完成声明由主代理负责。
- **验证充分、结果可复核**：完成直接相关的最小充分验证后返回；异常、未知退出状态或部分结果标为 `PARTIAL`，说明证据、未覆盖范围与阻塞。前提失效只阻断受影响部分，继续独立工作。
- **备用有条件、重试有上限**：区分认证、权限、额度、临时故障和能力不足。仅在用户选择、原预算、宿主能力及原验收允许时使用备用；写入任务先确认旧子代理停止。每任务最多三次委派，同一组合最多额外一次，累计重试等待不超过 30 秒；不静默替换用户强制指定的模型。

规则由 Codex 读取并遵循，实际生效取决于宿主加载与运行行为；用户和项目权限规则继续适用。`models check` 查询账号与模型目录，实际调用权限和模型身份需要可信运行证据确认。第三方供应商从自身 `/models` 获取候选，再通过自身 `/responses` 验证；网页在批量调用前确认数量与费用，结果按配置目录保存。模型检查的完整边界见[使用说明](docs/usage.md#模型检查)。

## 更多文档

- [完整使用说明](docs/usage.md)：命令参数、备用策略、JSON、冲突处理、恢复与卸载。
- [Skill](adapters/codex/skills/subagent-delegation/SKILL.md)：完整委派流程。

## 开发验证

```sh
npm ci --ignore-scripts
npm test
npm pack
```

浏览器验证方法见[使用说明](docs/usage.md#开发验证)。唯一运行依赖为 [smol-toml](https://github.com/squirrelchat/smol-toml)（BSD-3-Clause）。

## License

[MIT](LICENSE) © 2026 fanglinwei.
