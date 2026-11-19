# 2026-11-19 路由组合试跑

这轮结果未用于调整预设。扫描题上三个组合均通过，Sol/medium 在这一次请求中较快；复杂复核题没有可验收产出，无法判断 L4 主选或备用的质量。

本次使用 [v0.9.0 发布源码](https://github.com/fanglinwei/agent-fit/tree/df242cf6d597398141ab5a5136baa2082ef26fcf) 和试跑当时所用 home 的 `official` 组合。下文档位 ID 和组合均属于冻结版本；现行命令见[使用说明](../usage.md#命令表)。先用已安装 CLI 核对作用域和配置，冻结题面、候选和验收。通过当时配置的供应商发独立、无工具的 Responses 请求，不启动子代理、不更改档位，同题各候选使用相同输入。每组合一次，按下表顺序交错执行；每次最多 42 秒、请求输出上限 2,500 tokens，不重试。耗时仅为请求到结果，不含人工核验、委派及返工；token 来自供应商响应，没有账单数据。

| 顺序 | 任务 | 请求组合 | 结果 | 耗时 | 输入 / 输出 token |
| --- | --- | --- | --- | ---: | ---: |
| 1 | 配置扫描 | gpt-6-luna/xhigh | 通过，响应报告的身份匹配 | 27.0 s | 3,047 / 1,365 |
| 2 | 路由复核 | gpt-6-astra/low | 供应商返回 HTTP 400 `model_not_found` | 0.4 s | — |
| 3 | 配置扫描 | gpt-6.2-sol/medium | 通过，响应报告的身份匹配 | 7.7 s | 3,047 / 275 |
| 4 | 路由复核 | gpt-6.2-sol/xhigh | 42 秒超时，无产出 | 42.0 s | — |
| 5 | 配置扫描 | gpt-6-luna/max | 通过，响应报告的身份匹配 | 25.7 s | 3,047 / 1,372 |
| 6 | 路由复核 | gpt-6.2-sol/high | 42 秒超时，无产出 | 42.0 s | — |
| 7 | 路由复核 | gpt-6-astra/medium | 供应商返回 HTTP 400 `model_not_found` | 0.2 s | — |

计划 7 次，3 次通过、2 次请求被拒、2 次超时，未返工。供应商报告的身份仅用于这次请求的归因，不能独立证明上游身份或 Codex 会话中的实际运行组合。拒绝和超时都不能作为答案质量分数。

## 复跑口径

- **配置扫描**：给定发布版 `adapters/codex/modes.json`，要求输出 `baselineDiff`、`identicalCandidateCounts`、`duplicatesOwnBaseline` 和影响说明。用脚本按源码逐级核对，比较主选和备用。验收需准确列出基线差异 L2–L4、L1–L4 分别相同的 6/7/6/2 个候选，以及与各自同级基线完全重复的候选。原输入 SHA-256：`119509caf8e5ddd14a53bea731dd04946e43830a254ff845be54d0270e5d5340`。
- **路由复核**：给定发布版的模式表及 `scopedSelection`、`showReport`、CLI 的 `explain` 分支、`verificationRequirement`/`explainSelection` 和 `finishCheck`。比较全局 official、项目选择 high 或 official、会话继承项目时，显式查询 high/L3 基线和 `reasoning` 的结果；提出最小修复。验收需解释旧基线结果无法区分选档和预览、作用域派发保留原只读复核职责、fire 仍需当前会话证据，以及 official/L4 `uncertain` 的 Sol/high 备用与 Sol/xhigh 基线不同，单凭映射不能判定应换挡。原输入 SHA-256：`7a1c07617bf082b43916a8c07f83cf3784e289a02e2a44136531debd65a5a822`。

复跑复杂题前先确认当前供应商支持 Astra，再冻结独立样本和预算。如果调整超时或供应商，另记一轮。扫描的速度差异可用于选择后续对照组合；在独立样本及真实委派流程中复核前，不据此改变默认路由。
