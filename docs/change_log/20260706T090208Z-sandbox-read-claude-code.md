# Read 工具对齐 Claude Code FileReadTool

日期：2026-07-06

## 背景

当前项目的 `Read` 工具需要对齐 Claude Code `src/tools/FileReadTool` 的文本读取行为，并且直接在 bash sandbox 内执行。`file_path` 使用 sandbox 内绝对路径，通过 sandbox 权限和挂载边界判断可读范围。

同时，旧的 Memorize 临时 workspace 读取/编辑路径需要移除。该改动会暂时破坏 Memorize induction 写入行为，后续再按新的设计修复。

## 变更内容

- 新增 `Read` 工具插件，默认挂载到 tool runtime，工具名保持为 `Read`。
- 新增 sandbox 内 `/sandbox/bin/Read` Node wrapper：
  - 使用 Claude Code `readFileInRange` 风格的 10MB fast path / streaming path。
  - 支持 `offset` / `limit`。
  - 默认全量读取大小限制为 256KB。
  - 输出 token 上限按 25,000 token 粗估检查。
  - 阻止会阻塞或无限输出的设备文件。
  - 阻止文本工具读取常见二进制扩展。
  - 支持 mtime-only stat，用于重复读取 dedup。
- 重复读取 dedup 对齐上游语义：
  - 读取 `readFileState`。
  - 受 `tengu_read_dedup_killswitch` 控制。
  - 检查同 path、同 range、非 partial view。
  - 使用 sandbox 内 mtime stat，不再通过 `Read limit:1` 偷读内容。
  - 未变化时返回上游 `FILE_UNCHANGED_STUB` 文本。
- 模型可见文本输出改为 Claude Code 的 cat -n 风格行号文本。
- ENOENT 错误体验对齐上游文本路径：
  - 包含 cwd note。
  - 支持 macOS screenshot 普通空格 / narrow no-break space 备用路径。
  - 支持同目录相似文件名建议。
- 移除 Memorize 临时 workspace 路径和临时 workspace 目录初始化。
- workspace-files 旧读取路径移除 `fs.readFile` / `fsp.readFile` 直接调用。

## 兼容性

- 不新增隐藏 prompt。
- 未加入 Claude Code 的 `CYBER_RISK_MITIGATION_REMINDER`，因为它属于模型可见固定提醒，必须先进入项目可见 prompt/layer 管理。
- Memorize induction 写入路径当前会显式失败，等待后续重新设计。

## 验证

已执行：

```bash
node --import tsx --test tests/capabilities/tools/sandbox-read/sandbox-read-tools.test.ts tests/contexts/bash-sandbox/bash-sandbox.test.ts tests/contexts/bash-sandbox/bash-sandbox-docker.test.ts
node --import tsx --test tests/capabilities/tools/workspace-files/workspace-files-tools-read.test.ts tests/capabilities/tools/workspace-files/workspace-files-tools-edit.test.ts
node --import tsx --test tests/contexts/memory/sleep-memory.test.ts
npm run typecheck
```

结果：

- `Read` 工具和 bash sandbox 目标测试通过。
- workspace-files 读取/编辑测试通过。
- memory store 基础测试通过。
- TypeScript 类型检查通过。
