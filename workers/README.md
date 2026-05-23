# Workers

Worker process root. No separate worker process is currently implemented.

Current runtime is a single API process. The process-local daily scheduler lives in `core/scheduler` and is started by `apps/api`.

Reserved future workers:

- `agent-worker`
- `codex-worker`
- `media-worker`
- `scheduler-worker`
