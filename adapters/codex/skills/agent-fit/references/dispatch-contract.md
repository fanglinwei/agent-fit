# 派发契约模板

仅在原授权、收益、配置和能力检查完成后填写；模板不额外授予权限。引用真实材料，敏感信息不进入普通日志。作用域查询使用未固定 task_delegate，显式传入冻结组合；fork_turns="none" 时需完整交接必要上下文。

```text
目标与原职责：
允许动作 / 禁止动作：
权威材料及其版本：
独占写入目录（只读取证则写明只读）：
已有修改及必须保留的内容：
必要上下文、依赖与工具：
原验收与最小充分验证：
配置证据：configuration_revision、skill_revision、effective_scope、完整 task_profile
请求组合：mode_id、level、task、model、effort
接续次数：attempts_used_before、additional_dispatches、attempts_used_after
停止条件与未知项：
返回：职责、产出位置、核验结果、未覆盖与阻塞；未知/异常/部分结果标 PARTIAL
```

次数均为主代理发起的原任务累计次数；additional_dispatches 是本次拟新增的0或1次，attempts_used_after = attempts_used_before + additional_dispatches，且不超过3。拆分困难部分仍沿用原任务计数。宿主内部重试未知时不追加，旧写入者停止未知时不接管同范围。该模板是交接材料，不是自动计数或宿主执行证明。

子代理不是唯一参与者：先读适用规则和实际材料，不撤销他人改动；共享产出只有一个负责人。不能递归派发、修改生产/共享环境/第三方系统/代理配置或自行换模型。主代理保留最终设计、共享裁决、集成、关键验证与完成声明。
