# Workflow 规格

本文是设计规格，尚非可执行引擎配置。角色是按需职责，不要求每个阶段启动独立 Agent。

职责划分、Meta 原则与版本演进见 [角色与流程演进](ROLES_AND_EVOLUTION.md)；工作区创建、并行、集成与清理见 [工作区生命周期](WORKSPACES.md)。

## Runtime 映射

各 workflow 计划实现为带版本的 pi-durable task，阶段状态与输入产物引用保存在同一 Harness 的 document 中。推理步骤按需创建隔离 conversation，命令验证由 Loom 工具采集结构化结果；不通过外部 coding CLI 执行这些阶段。模型连接沿用 Run 指定 profile；不静默更换模型或计费方式。

审查 conversation 只接收目标、契约、diff 与实际验证结果，不继承实现者完整聊天。Antigravity 若接入，仅作为带操作 ID 和结果引用的外部工具。

## 共同入口与出口

入口：目标仓库、任务目标、范围、现状 revision、约束、验收行为、预算。可自动发现的先发现，只问阻碍执行的信息。
出口：变更摘要、diff、被测 revision / 工作树指纹、验证命令与结果、审查问题、剩余风险、终止原因。

## feature（首版）

scout → contract → plan → implement → targeted_verify → review → regression → deliver。
明确行为与边界后先做最小垂直切片。审查发现问题回到 implement；修改后重跑受影响验证与审查。简单修改可合并 scout / contract / plan，不能省略实际验证。

## debug（首版）

symptom → reproduce → investigate → hypothesis_test → fix → reproduce_again → regression → review → deliver。
无法复现时继续收集证据或标记 blocked，不能把猜测报成根因。假设失败回到 investigate；修复必须重跑原始复现和相关回归。

## architecture

scout → constraints → alternatives → decision → spike → revised_decision → implementation_plan。
产物：现状图、约束、方案取舍、ADR、实验结果、后续任务。Spike 在隔离区域，不默认进入正式代码；若用户同时要求实现，接 feature 流程。

## fill-function

locate → contract → related_patterns → implement → targeted_verify → review → deliver。
关注真实行为、错误路径及残留占位；发现需要改变公共契约时升级到 feature / architecture。

## refactor

baseline → dependency_map → incremental_plan → change_batch → regression → review → deliver。
保持约定行为；产品行为改变另列目标。每批改动可独立验证，失败返回该批。

## delivery

collect_diff → verify_revision → final_checks → summary → authorized_publish。
交付准备与发布分开；没有外部发布授权时以可审阅本地产物结束。

## 门禁

实现前：目标与约束可定位；验证前：目标工作区确定；审查前：diff 与实际验证结果可读。
完成前：所有必需步骤通过或明确报告阻塞；不能把 skip 当 pass；代码改动后验证版本一致。
每条错误有分类和重试上限。取消需终止子进程树、释放工作区锁并保存可恢复状态。

## 内核实现进度

feature/debug 的版本固定模板、持久化状态与证据门禁已实现；feature CLI 已接入自动隔离角色派发、可信命令采集及交付；debug 自动派发与 TUI 写操作尚未接入，见 Workflow 内核（本地开发记录，不随公开源码发布）。
