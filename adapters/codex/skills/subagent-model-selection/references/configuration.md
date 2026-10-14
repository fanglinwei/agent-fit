# Codex configuration

本工具只管理四个 task_* 角色、此 Skill、当前档位及 AGENTS.md 中带 subagent-delegation 标记的区块。AGENTS 启动入口明确引用绑定 home 的 Skill；每次委派前必须按 Skill 检查。指令约束不等于宿主拦截器，原生 Skill 选择器发现与实际运行生效另行核验。

- setup 首次默认 mid；内置档位命令为 low、mid、fire；mode set 切换，mode create/configure 保存自定义档位。
- status --details 查看规则、磁盘角色及潜在覆盖；mode show 与 explain 只预览，不委派。
- models check 只查询账号与目录，目录不证明调用权限；--verify 只有宿主可强制隔离工具、委派及外部副作用时才能运行。
- restore 仅撤销可证明归属的改动，保留安装前内容和管理区块之外的用户修改；旧版缺基线时拒绝猜测恢复。
- 业务命令支持 --agent codex 与 --codex-home PATH；帮助/版本不接受目标目录。CLI 安装不自动改智能体配置。

固定角色配置可能覆盖派发参数；用户指定配置或需要继承时使用未固定 model/effort 的 task_delegate，并核对宿主默认。任务等级与权限职责互相独立。

配置写入后必须重启 Codex。已有会话不承诺动态加载；runtime verification 保持 unverified，直到获得可信宿主证据。非空 AGENTS.override.md、同名角色、管理内容漂移或无法证明的恢复记录会阻止部署。

完整用法、模式表、备用条件与故障处理见项目 docs/usage.md。
