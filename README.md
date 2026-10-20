# Agent Fit

**为 Codex 子任务匹配模型与推理强度。**

Agent Fit 将任务复杂度、模型档位和委派职责放进一套可查询、可配置、可恢复的规则中。先判断是否值得委派，再为需要委派的任务选择模型、推理强度和备用组合，适用于研究、写作、数据分析、规划、开发与审查。

[快速开始](#快速开始) · [四种档位](#四种档位) · [作用域](#按会话项目或全局配置) · [完整文档](docs/usage.md) · [更新记录](https://github.com/fanglinwei/agent-fit/releases)

## 功能特色

- **四种资源策略**：`cut / official / high / fire`，按 L1–L4 的推理需求配置模型与 effort；也可复制成自己的档位，设置每级主组合和备用。
- **同级任务候选**：在复杂度等级内区分机械处理、有界扫描、深度处理、复杂推理等任务，查询对应的完整组合；任务类型与委派职责分别配置。
- **会话、项目、全局三层作用域**：优先级为会话 > 项目 > 全局。聊天切换默认仅影响当前聊天，项目按 Git worktree 隔离，已开始任务沿用原快照。
- **CLI 与本地配置页面**：查看和编辑档位、浏览委派路由与选择依据、管理账号授权、预览和执行恢复。网页操作复用 CLI，只监听 `127.0.0.1`。
- **配置与模型检测分开**：安装、切档和保存配置只处理本地文件。需要时手动查询目录或验证模型，网页检测前确认主组合和费用。
- **可检查、可恢复**：提供状态诊断、职责核对、配置冲突保护及首次安装前的恢复基线；保留无关配置和管理区块之外的修改。

当前面向 **Codex**，需要 **Node.js 22+** 和支持独立角色 TOML 的 Codex 客户端。已在 macOS 与 Codex CLI 0.162.1 验证相关配置和账号接口，其他环境的验证范围见[实施验收记录](docs/implementation-review.md)。项目处于内测阶段，处理当前配置，并支持 0.7.1 旧目录布局的显式迁移。

## 快速开始

安装命令行工具，预览并应用官方档位：

```sh
npm install -g @fanglinwei/agent-fit
agent-fit setup --mode official --dry-run
agent-fit setup --mode official
```

npm 包名为 [`@fanglinwei/agent-fit`](https://www.npmjs.com/package/@fanglinwei/agent-fit)，安装后的命令和 Skill 名为 `agent-fit`。

**首次配置完成后重启 Codex。** 安装 npm 包本身不会修改 Codex；`setup` 才会写入四个委派角色、AGENTS 管理区块和档位数据，并在共享 Skill 不存在时安装规则。默认目标为 `CODEX_HOME` 或 `~/.codex`，可通过 `--codex-home "/path/to/codex-home"` 指定独立目录。

Skill 默认放在 `~/.agents/skills/agent-fit/`，可由 CCSwitch 统一管理。动态档位存于对应 home 的 `.agent-fit/current-mode.json`，多个 home 共用规则但配置独立。`status`、`explain` 和 `skill path` 只读；日常切档和 `restore` 不改写或删除共享 Skill。

从 0.7.1 迁移时，先执行 `agent-fit setup --dry-run`，再执行 `agent-fit setup`。旧目录保留、移除或软链接到共享目录均可识别；迁移验证安装记录，冲突时保留现场。已有共享规则需要更新时，显式执行 `agent-fit skill update --dry-run` 和 `agent-fit skill update`。完整边界见[目录与迁移](docs/usage.md#skill-目录与旧安装迁移)。

打开本地配置页面：

```sh
agent-fit serve --open
```

页面包含**档位配置、委派规则、账号配置、恢复**。委派规则页按等级展示基线与任务候选，点击可查看选择依据和备用条件；预览其他档位不会切换当前配置。编辑先成为草稿，保存或应用时才写入。

日常全局、项目和会话切档，以及模型与 effort 调整无需重启；后续新任务读取新选择。更新基础 Skill、AGENTS 或角色职责，以及恢复原配置后仍需重启。

## 四种档位

| 档位 | 使用方式 |
| --- | --- |
| `cut` · 经济 | 以较轻组合处理容易核验的任务，复杂部分选择相应等级或任务候选 |
| `official` · 官方 | 首次配置默认档位；依据官方建议制定的本地映射 |
| `high` · 高级 | 使用预设模型的最高受支持推理强度 |
| `fire` · 全开 | 各等级使用 Astra / ultra，委派前须通过当前会话的实际验证 |

```sh
agent-fit mode list
agent-fit mode show official
agent-fit mode set cut
agent-fit status --details
```

L1–L4 表示任务的推理需求：从方法明确的执行，到有边界的局部推理、复杂约束权衡和高不确定性推理。模型与 effort 使用档位中保存的完整组合；相邻等级可以共用组合。完整模型表与分级边界见[使用说明](docs/usage.md#任务等级与委派职责)。`official` 是本项目的预设名称，官方没有固定的 L1–L4 对照表。

### 查询同级任务候选

```sh
# 确定性机械任务
agent-fit explain --level L1 --task mechanical --role task_execute --json

# 有界扫描与复杂推理
agent-fit explain --level L1 --task scan --role task_review --json
agent-fit explain --level L3 --task reasoning --role task_execute --json
```

`explain` 只查询配置，不调用模型或创建子代理。复杂度、任务类型和职责由主代理判断；返回值包含主组合、备用、权限契约及配置来源。未配置的显式候选会报错，不从其他档位补值。支持的类型和编辑方法见[同级任务候选](docs/usage.md#同级任务候选)。

明确选择 `high / fire` 即授权其展示的最高强度组合，预算和宿主支持仍需满足；`fire` 另外要求当前会话的实际调用和可信身份验证。预览档位不构成选择，模型目录列出也不证明实际可调用。

## 按会话、项目或全局配置

```sh
# CLI 默认操作全局；此处显式写出作用域
agent-fit mode set official --scope global

# 仅对指定项目生效
agent-fit mode set cut --scope project --project "/path/to/project"

# 恢复项目对全局档位的继承
agent-fit mode clear --scope project --project "/path/to/project"
```

在 Codex 聊天中用 `$agent-fit` 要求切档时，默认只修改当前会话；明确要求后才修改项目或全局。CLI 操作会话时须绑定目标项目与聊天线程，具体参数见[作用域说明](docs/usage.md#全局项目与会话)。项目和会话配置保存在绑定 home 中，不写入项目仓库。

每次委派保存完整档位快照，重试、质量升级和故障备用沿用该快照。切档影响后续新任务，不改变正在执行的任务，也不重置委派次数。

## 自定义档位

复制现有档位，再调整所需等级：

```sh
agent-fit mode create "我的研究方案" --from official
agent-fit mode configure "我的研究方案" \
  --level L3 --model gpt-6-astra --effort low \
  --fallback-model gpt-6.1-sol --fallback-effort high
agent-fit mode set "我的研究方案"
```

复制包含四级基线、同级任务候选及各自备用，不自动激活。CLI 可修改单级基线；网页或完整 JSON 可编辑候选。局部编辑继承来的自定义档位会生成局部副本，避免覆盖其他作用域。详见[自定义档位](docs/usage.md#自定义档位)。

## 账号与模型检查

```sh
# 查询授权状态与模型目录，不发起推理
agent-fit models check

# 手动验证当前档位的主模型组合，可能产生费用
agent-fit models check --verify
```

网页账号页管理已有授权、登录、取消授权和退出登录；档位页的“检测当前档位主模型”按组合去重，排除备用，并在执行前确认。保存或切换配置不会自动检测模型。

实际验证通过独立 Responses 请求进行，不启动带项目材料的 Codex 任务或工具执行器。请求成功、供应商返回的身份与配置是否生效分别核验；检测结果不代替 `fire` 的会话验证。供应商目录、批量可用性检查和验证边界见[模型检查](docs/usage.md#模型检查)。

## 委派规则如何生效

`setup` 安装的 AGENTS 入口要求 Codex 启动时通过 `agent-fit skill path` 查找并读取规则，并在创建、重试或切换子代理模型前重新核对规则与有效档位。主代理仍负责设计、集成、关键验证和最终结论。

共同规则包括先权衡委派收益与协调成本、保留用户授权和预算、区分复杂度与职责、明确独占写入范围、禁止递归委派，以及完成最小充分验证。质量升级与故障备用分别判断，初次派发、重试和接续共用每任务最多三次委派。

这些规则由宿主读取并遵循；工具提供配置与解释，不自动派发任务，也没有宿主级委派拦截器。实际模型身份、能力和成本需要独立证据。完整契约见 [Skill](adapters/codex/skills/agent-fit/SKILL.md)，预设评估方法见[离线校准指南](adapters/codex/skills/agent-fit/references/calibration.md)。

## 恢复与卸载

**卸载前先恢复原绑定 home。** 先预览，再执行实际恢复；恢复失败或结果未知时保留工具与恢复记录，停止卸载。

```sh
agent-fit restore --dry-run
agent-fit restore && npm uninstall -g @fanglinwei/agent-fit
```

独立 home 的预览和实际恢复都必须传入相同的 `--codex-home`，多个 home 逐一恢复成功后才可卸载。恢复会保留安装前内容、无关文件和管理区块外修改；文件漂移或损坏的恢复基线会阻止覆盖。恢复完成后重启 Codex。

## 文档与开发

- [完整使用说明](docs/usage.md)：命令、作用域、候选、自定义、账号、检测和恢复。
- [文档导航](docs/README.md)：规则、实现与研究记录。
- [实施验收记录](docs/implementation-review.md)：已验证范围及使用边界。
- [GitHub Releases](https://github.com/fanglinwei/agent-fit/releases)：版本与发布说明。

```sh
npm ci --ignore-scripts
npm test
npm pack
```

本地打包产物为 `fanglinwei-agent-fit-0.7.2.tgz`，可用 `npm install -g ./fanglinwei-agent-fit-0.7.2.tgz` 安装。浏览器集成使用已有 Playwright 与 Chrome，运行方法见[开发验证](docs/usage.md#开发验证)。唯一运行依赖为 [smol-toml](https://github.com/squirrelchat/smol-toml)。

## License

[MIT](LICENSE) © 2026 fanglinwei.
