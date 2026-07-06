# 文件工具目录对齐

## 背景

`Read` / `Edit` / `Glob` / `Grep` 是 tool plugin，不应该以 `sandbox-file-tools` 命名放在工具目录下。参考项目中 `BashTool`、`FileReadTool`、`FileEditTool`、`GlobTool`、`GrepTool` 都位于 `src/tools/*Tool`，sandbox 只承载运行时/隔离执行能力。

## 变更

- 将 tool plugin 从 `src/capabilities/tools/sandbox-file-tools/src/sandbox-file-tools.ts` 移到 `src/capabilities/tools/file/src/index.ts`。
- 新增 `src/capabilities/tools/file/profile.ts`，按现有 `bash/profile.ts` 模式放置 `Read` / `Edit` / `Glob` / `Grep` tool definition。
- `createSandboxFileTools` 改名为 `createFileTools`。
- tool plugin id 从 `sandbox-file-tools` 改为 `file-tools`。
- 测试目录从 `tests/capabilities/tools/sandbox-file-tools/` 移到 `tests/capabilities/tools/file/`。
- 保留 `src/contexts/bash-sandbox/wrappers/` 下的 `Read` / `Edit` / `Glob` / `Grep` wrapper；它们属于 sandbox 内执行入口，不是 tool plugin 本体。

## 验证

```bash
node --import tsx --test tests/capabilities/tools/file/file-tools.test.ts
npm run typecheck
```
