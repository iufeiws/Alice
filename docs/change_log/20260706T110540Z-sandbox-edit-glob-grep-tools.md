# Sandbox 文件工具补齐 Edit Glob Grep

日期：2026-07-06

## 背景

此前 bash sandbox 已有 `Read` wrapper，并且 `sandbox-file-tools` 对外暴露了 `Edit`、`Glob`、`Grep` 的 tool definition，但执行路径只处理 `Read`。模型调用其它三个工具时会进入 unknown tool 分支。

本次目标是参考 Claude Code `src/tools` 中已有的文件工具行为，以函数级/文件级模块化复制核心语义，不复制 UI 层和权限层，也不通过自写 shell/python wrapper 模仿一个语义不完整的低配版本。

## 变更内容

- 新增 sandbox 内共享核心模块 `src/contexts/bash-sandbox/wrappers/file-tool-core.mjs`：
  - `Read` 继续使用 Claude Code `readFileInRange` 风格的 fast path / streaming path。
  - `Edit` 复制字符串替换核心语义，包括先读后写、mtime staleness 检查、partial read 禁写、多匹配保护、空 `old_string` 新建文件、quote normalization 和行尾保持。
  - `Glob` 使用 ripgrep `--files --glob` 语义，保留默认 hidden/no-ignore、mtime 排序和结果截断提示。
  - `Grep` 使用 ripgrep 搜索语义，支持 `files_with_matches`、`content`、`count`、context、case-insensitive、type、glob、head limit、offset、multiline 等参数。
- 将 `/sandbox/bin/Read`、`/sandbox/bin/Edit`、`/sandbox/bin/Glob`、`/sandbox/bin/Grep` 改为薄入口，只负责调用共享核心模块。
- 补齐 `createSandboxFileTools` 的执行路由：
  - `Edit`、`Glob`、`Grep` 都走统一 `BashSandboxRuntime.runFileTool`。
  - `Edit` 会接收当前文件的完整 `Read` state，并在成功写入后更新 state。
  - `Glob` / `Grep` 返回 wrapper 格式化后的 Claude Code 风格文本内容。
- 新增 `tests/capabilities/tools/sandbox-file-tools/sandbox-file-tools.test.ts` 覆盖工具暴露、Read 去重、越界路径拒绝、Edit read-state 传递和更新、Glob/Grep 输出转发。

## 兼容性

- 不新增隐藏 prompt。
- 不修改 prompt preview、prompt layer schema、LLM request 构筑或 layer 顺序。
- 不在 loop 执行期按 requester、channel 或 tool name 增加额外拦截；工具可用性仍由 LLM request 构筑阶段暴露的 toolNames 决定。
- 搜索语义依赖 ripgrep；这是 Claude Code 工具本身的核心依赖语义，不是自行模仿简化版搜索器。

## 验证

已执行：

```bash
node --check src/contexts/bash-sandbox/wrappers/file-tool-core.mjs
node --check src/contexts/bash-sandbox/wrappers/Read
node --check src/contexts/bash-sandbox/wrappers/Edit
node --check src/contexts/bash-sandbox/wrappers/Glob
node --check src/contexts/bash-sandbox/wrappers/Grep
node --import tsx --test tests/capabilities/tools/sandbox-file-tools/sandbox-file-tools.test.ts
npm run typecheck
```

结果：

- wrapper 语法检查通过。
- sandbox file tools 单元测试通过。
- TypeScript 类型检查通过。

另外在非 Codex sandbox 下执行了 Read/Edit/Glob/Grep wrapper 端到端验证，确认 Glob/Grep 可真实调用 `/usr/bin/rg` 并输出 JSON。
