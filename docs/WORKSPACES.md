# Git 与工作区生命周期

状态：本文为设计契约；最小生命周期 API 已实现，见 实现边界（本地开发记录，不随公开源码发布）。实时观察已接入 [TUI](TUI.md)，feature CLI 已接入从显式 commit 自动分配 worktree 与 Runtime writer，TUI 创建操作尚未接入。WorkspaceManager 位于 Workflow 与 Agent 工具之间，负责工作区分配、写入所有权、Git 基线和恢复核对。

## 创建与基线

任务开始记录 repository root/common directory、branch、HEAD、index、修改与未跟踪文件及内容指纹。默认写入 Run 使用 `loom/run-<id>` 分支和独立 worktree。

从 HEAD 创建的 worktree 不包含用户未提交修改。入口必须明确基线是指定 commit，还是继续当前工作：使用原工作区，或选择性复制修改并记录来源。不得自动 stash、reset、commit 或 clean 用户工作。

## 执行与并行

首版采用一个 Run、一个 worktree、一个 writer。Reviewer 使用隔离上下文和只读工具，验证针对同一个候选内容。独立任务需要并行时才分配更多 worktree；角色本身不决定工作区数量。

工具与 Pi ExecutionEnv 绑定 workspace ID 和 cwd；cwd 不是权限边界。Git 生命周期通过结构化操作管理，通用 shell 的绕过需要实际执行约束。Worktree 共享对象、refs 和部分配置，不构成完整隔离。

## 验证与集成

验证记录绑定 `runId + workspaceId + HEAD + content fingerprint`，包括相关未跟踪文件，以及 command、cwd、exit code 和产物。相关内容变化使原验证失效。

交付默认提供 diff、分支和证据。Commit、merge、cherry-pick、PR 按已有授权执行。集成串行进行；目标分支推进后，核对并重新验证集成后的状态，不能直接沿用分支上的通过结果。

## 重启与清理

持久化分支、路径和 revision，启动时与真实 Git 核对。不确定创建结果时先发现已有 worktree，不重复创建。取消先停止所属进程，再释放写入所有权。

保留任务的脏文件；清理前核查修改、未跟踪文件及分支保留需求。不能用超时租约直接夺取仍有命令运行的工作区。
