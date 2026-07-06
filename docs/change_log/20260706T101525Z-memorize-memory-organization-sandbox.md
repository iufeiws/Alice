# Memorize 迁移到 sandbox memory_organization 工作区

日期：2026-07-06

## 背景

Memorize 旧流程依赖临时 workspace / 单目标串行归纳。项目正在迁移到 sandbox file tool，记忆归纳需要改为把三份记忆文件放入 sandbox 的 `/workspace/memory_organization/` 临时目录下，由同一次 LLM run 统一整理。

本次只接入 Memorize 到现有 sandbox file tool 运行路径，不修改 file tool 实现，也不新增隐藏 prompt 文案。

## 变更内容

- Memorize 每次 run 会在宿主机 `bashSandbox.hostWorkspaceDir/memory_organization/` 准备三份临时文件：
  - `persistent-memory.md`
  - `user-preferences.md`
  - `diary.md`
- Prompt context runtime 挂载 sandbox 内绝对路径：
  - `/workspace/memory_organization/persistent-memory.md`
  - `/workspace/memory_organization/user-preferences.md`
  - `/workspace/memory_organization/diary.md`
- 删除旧的单 target 串行归纳入口，改为一次 LLM run 处理三份文件。
- Memorize run 注册现有 sandbox `Read` / `Edit` 工具定义和 memory 自有 `self_talk`。
- LLM 完成后从宿主 workspace 读回三份文件；只有内容变化的目标才写入 memory store。
- run 结束后删除 `memory_organization/` 临时目录。
- Sleep induction、Admin 手动运行、Prompt 管理页预览都接入同一 sandbox 路径上下文。

## 兼容性

- 不修改 sandbox file tool 代码。
- 不新增 prompt 文案，不改变已有 prompt layer 顺序。
- Prompt preview 会显示 sandbox 绝对路径，避免 preview 与运行时路径不一致。
- memory 测试不模拟 `Read` / `Edit` 的具体行为，只验证 Memorize 自身的 workspace、prompt path 和 loop 边界。

## 验证

已执行：

```bash
node --import tsx --test tests/contexts/memory/*.test.ts
```

结果：

- memory 相关测试通过，22/22。

补充：

- `npm run typecheck` 当前被工作区中未纳入本次提交的 `src/channels/webrtc-voice/src/call-runtime.ts` 并行改动阻塞，错误与本次 Memorize 迁移无关。
