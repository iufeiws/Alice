# Workers 说明

Worker 进程根目录。当前还没有独立 worker 进程。

当前运行时是单个 API 进程。进程内每日调度器位于 `core/scheduler`，由 `apps/api` 启动。

预留的未来 worker：

- `agent-worker`
- `codex-worker`
- `media-worker`
- `scheduler-worker`
