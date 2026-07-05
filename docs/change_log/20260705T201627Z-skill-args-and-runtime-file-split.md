# Skill args 隐藏追加移除与运行时文件拆分

日期：2026-07-06

## 背景

本次调整来自 `docs/todoNote.md` 中记录的两个待办项：

- `Skill` 工具传入 `args` 但 skill 内容没有占位符时，不应在末尾自动追加隐藏 `ARGUMENTS` 文本。
- `chat-agent.ts` 和 `admin-plugin-runtime.ts` 超过单文件行数上限，需要按既有运行时边界拆分。

其中 skill args 处理不是 API 行为变更；旧测试断言隐藏追加 `unused args` 本身违反测试原则，应删除该断言而不是固化这个实现细节。

## 变更内容

- `renderSkillInstructions` 只替换 `$ARGUMENTS`、`$ARGUMENTS[n]` 和 `$n` 占位符。
- 删除 `Skill tool appends unused args` 测试，不再断言未使用参数会被自动拼到输出末尾。
- 拆出 ChatAgent 辅助逻辑到 `chat-agent-helpers.ts`，保留 `chat-agent.ts` 的主体运行时流程。
- 拆出 Admin plugin 的 Photo、ASR、地理相关插件、TTS、公共类型和工具函数，降低 `admin-plugin-runtime.ts` 文件长度。
- 清空 `docs/todoNote.md` 中已完成的待办项。

## 兼容性

- 不保留无占位符时自动追加 `ARGUMENTS` 的旧逻辑。
- 不新增隐藏 prompt 拼接。
- 不改变 prompt layer 顺序。
- 不新增旧逻辑 fallback。

## 验证

已执行：

```bash
npm run typecheck
node --import tsx --test --test-concurrency=1 tests/contexts/bash-sandbox/bash-sandbox-skills.test.ts
node --import tsx --test --test-concurrency=1 tests/apps/api/routes/admin/admin-routes-plugin-config.test.ts
node --import tsx --test --test-concurrency=1 tests/apps/api/admin-ui/admin-html-plugins.test.ts
npm test
git diff --check
```

结果：

- TypeScript 类型检查通过。
- 相关 Skill 与 Admin plugin 测试通过。
- 完整测试通过。
- diff 空白检查通过。
