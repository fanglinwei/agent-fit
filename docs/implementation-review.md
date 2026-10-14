# 0.3.0 发布验收

日期：2026-10-14。以下为 0.3.0 的验证；后文 0.2.0 记录保留为历史依据。

- 新增短命令 `sub-d`，完整命令仍可用；Codex 为默认目标。
- 内置命令统一为 `low / mid / fire`，旧内部 id 保留在安装记录中；历史参数需更新，旧同名自定义档位可通过 custom-* id 选择。
- 本地网页重新设计，显示完整产品名 Subagent Delegation；保留草稿、预览、真实 CLI 应用、冲突保护与重启提醒。
- README 和使用说明补齐 npm 安装、0.3.0 升级、档位参数迁移与网页布局。

验证环境：macOS、Node.js 24.19.0、既有 npm、Chrome 和 Playwright。所有配置测试使用临时 home。

| 检查 | 结果 |
| --- | --- |
| Node 测试 | 103 项通过，0 失败或跳过；升级恢复测试改用动态下一版本，继续验证版本保护 |
| Python 保护测试 | 10 项通过；默认 Node 20 不满足要求，切换 Node 24 后通过 |
| Chrome 集成 | setup、自定义创建/保存/激活、冲突保留与比较、模型检查错误、规则解释、恢复及键盘焦点通过；四页在 375/768/1280/1440px 无页面溢出，零脚本错误 |
| 隔离 npm 安装 | 两个命令入口均报告 0.3.0；0.2.0 → 0.3.0 保留活动自定义名称、模型和首次恢复基线；三档切换、包内网页与源文件一致、恢复原始 AGENTS 通过 |
| 发布包 | 27 个公开运行/文档文件，MIT；未加入开发测试、账号配置或安装生命周期脚本 |

模型目录仍不证明请求权限；实际推理门禁保持关闭。未验证其他操作系统、全部 Node 22.x、桌面会话实际加载或读屏器。恢复与并发边界延续后文说明。

---

# 0.2.0 实施与验收

日期：2026-10-13。实现对应已确认计划，并补入用户要求：启动 Codex 时读取 Skill，每次创建、重新委派或模型变化前按当前档位检查。通过绑定 home 的 AGENTS 入口及角色指令要求执行，没有宿主委派拦截器。

## 实现范围

| 计划任务 | 交付与验证入口 |
| --- | --- |
| 1–2：npm、数据与 Skill | bin、精确依赖、三档四级数据、简洁 Skill；cli/modes 测试 |
| 3–4：安装与切换 | 共同事务、修订号、所有权、基线、锁、普通失败回退及重启提示；install 测试 |
| 5–6：查询与自定义 | 安全字段投影、项目候选、解释、UUID 定义、整表 stdin 与活动部署；status/custom/cli 测试 |
| 7：模型检查 | 同 home 的限时 stdio RPC 账号/目录检查；models 模拟协议测试；实际推理门禁关闭 |
| 8：恢复 | 首次基线、标记外正文保留、全部自定义清理、安全回退；restore 测试 |
| 9–10：本地网页 | loopback、动作白名单、真实 CLI、版本冲突、四页面、原生表单；server 与 Chrome 集成 |
| 11：交付 | Python 兼容入口、本地 npm 包、README/使用说明、MIT；Python 基线与隔离安装验收 |

主代理、供应商、审批、沙箱、并发及既有 default 不由本工具修改。四个子代理保留只读 Git、禁止递归、独占产出、局部适配/阻断、最小充分验证与 PARTIAL 返回规则。自定义模型只能修改主/备用组合。explain 省略职责时统一默认 task_delegate，避免由难度推导写权限；显式职责保持原权限契约。

Skill 的当前档位 JSON 由 setup 生成，源码不预设所有用户的活动档位。AGENTS 引用该 home 的实际路径，不擅自写共享 `~/.agents/skills`。原生 Skill 注册、显式规则读取与宿主强制执行分别判断。

## 五轮审查

| 轮次 | 范围 | 发现与处理 |
| --- | --- | --- |
| R1 | 需求、接口、调用路径 | 修复未安装 explain 静默预览、查询漂移退出码、根规则/祖先候选及既有注册/全局子代理默认的诊断遗漏 |
| R2 | 输入、并发、恢复 | 修复临时文件准备后并发编辑覆盖、回滚晚到编辑丢失、最终漂移误报成功、恢复提交后查询失败误报未写入；补齐别名及无效 Unicode 校验 |
| R3 | 安全、隐私、权限、部署 | 修复终端控制字符注入；复核 Host/Origin/会话、CLI 白名单、符号链接、权限、RPC 脱敏及无推理分支 |
| R4 | 测试、兼容、包、CLI、网页 | 修复 npm bin 符号链接入口静默退出及 explain 丢失漂移诊断；隔离安装和 Chrome 操作通过 |
| R5 | 最终回归、diff、文档、许可 | 修复活动内置档位别名带空白时误读新版预设；核对有效 override 的 Unicode 空白语义、公开文档及 MIT |

所有修复只用临时 home 或合成元数据。未以真实账号或生产配置作自动测试，没有强制覆盖路径。

## 验证结果

环境：macOS、Node.js 24.19.0；npm 打包/安装使用本机已安装 npm。Chrome 使用本机应用，Playwright 使用既有开发模块。要求为 Node 22+，没有声称单独验收全部 22.x。

| 检查 | 结果与证明范围 |
| --- | --- |
| `npm test` | 100 项通过，0 失败/跳过；配置、输入、并发、恢复、查询、服务及目录协议 |
| Python 保护基线 | 10 项通过；原安装器在 tests fixture，新入口调用 Node CLI |
| Chrome 集成 | setup、创建预览、保存/激活、冲突草稿、比较、解释、恢复及持续重启提醒通过 |
| 网页操作 | 键盘跳转、弹窗校验焦点、字段错误保留、375/768/1280/1440px、放大文字、零脚本错误通过；未作真实读屏实测 |
| 本地 npm 包 | 隔离 prefix/cache 安装通过，安装自身不配置；实际 bin、setup、切换、自定义、npm exec 查询/解释/切换/整表 stdin/恢复及再次 setup 通过；包内网页和真实 CLI 动作、SIGINT 停止通过 |
| 包与许可 | 运行资源、文档、MIT；无安装生命周期脚本；唯一依赖 smol-toml 1.9.1（BSD-3-Clause），未复制参考项目代码 |

原计划复选框保留专项验收粒度，不概括勾选所有宿主/付费/跨平台条件。上表是当前交付证据；以下限制明确保留。

## Codex 兼容门禁

依据 Codex CLI **0.156.1** 的版本源码和导出协议。

- **G1 规则与角色入口**：核对独立角色 TOML 必需字段、递归发现及覆盖；阻止有效 home override 遮蔽，仍报告 RULES_LOAD_UNVERIFIED。源码证明不等于 App 或真实会话加载验收。
- **G2 账号与目录**：initialize、账号读取、分页、空账号/自定义供应商、超时、上限和脱敏经过模拟协议测试。配置后检查绑定已提交的模式、组合与修订号，失败不撤销写入。真实账号权限及桌面上下文未验证。
- **G3 受限实际调用**：协议不能证明禁用全部工具、MCP、委派及外部读取；readOnly 不满足隔离条件。--verify 在创建线程/推理之前返回 PROBE_ISOLATION_UNSUPPORTED，没有实际推理或“模型可用”承诺。

版本来源：[角色 loader](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/agent-roles/src/loader.rs)、[角色配置](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/agent-roles/src/agent_role_config.rs)、[发现入口](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/agent-roles/src/discovery.rs)、[配置 schema](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/config.schema.json)。

此版本 [home 规则读取器](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/codex-home/src/instructions/mod.rs)完整读取全局规则；project_doc_max_bytes 只限制项目规则发现。因此不按项目预算错误拒绝全局追加；其他宿主的完整读取仍保留未知。

## 借鉴与剩余边界

借鉴解释理由、用户选择优先、首次恢复基线、完整交接和难度/职责分离。未引入外部分类型推理、供应商代理、任意 hook 或领域专有权限。固定提交及来源见 [参考项目比较](https://github.com/fanglinwei/subagent-delegation/blob/main/docs/research/2026-10-13-plan-review-reference-projects.md)。README 采用目的、安装、例子、边界、文档和许可的简洁组织。

未验收 Linux、Windows、其他 Codex 版本、桌面会话加载、读屏器或真实推理。逐文件原子替换与普通失败回退不保证断电/崩溃时多文件整体原子；残留锁须核对后处理。并发保护不提供对恶意本机进程的内核级比较交换。Skill 执行依赖宿主遵守指令。
