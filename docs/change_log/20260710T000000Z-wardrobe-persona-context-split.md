# Wardrobe / Persona context 初步拆分

日期：2026-07-10

## 变更内容

- 新增 `src/contexts/wardrobe`，承接原 `agent-profile` 中 outfit 查询、匹配、随机选择和 on-body 生成判断逻辑。
- 新增 `src/contexts/persona`，放置 persona/relationship 的基础类型边界。
- 将 `Wardrobe` tool 从 `capabilities/tools/shell` 迁到 `capabilities/tools/wardrobe`。
- 删除旧 `src/contexts/agent-profile/src/domain/outfit.ts`。
- 删除旧 `src/capabilities/tools/shell` tool 实现。
- Admin / prompt preview 工具注册字段从 `shellTools` 改为 `wardrobeTools`。
- Prompt context 保留单件服装语义变量：
  - `{{outfit/...}}` 表示当前服装。
  - `{{targetOutfit/...}}` 表示本次 on-body 生成目标服装。

## 注意

- 本次未修改 `config/plugin/photo/config.json`，该文件包含本地密钥。
- `agent-profile` 的 daily shell store 仍保留当前 outfit 的持久化字段，用于维持现有 daily shell 行为；后续完全迁出存储时再拆数据库/文件路径。

## 验证

- `npm run typecheck`
- `node --import tsx --test tests/capabilities/tools/shell/shell-tools-actions.test.ts tests/capabilities/tools/shell/shell-tools-store.test.ts tests/capabilities/tools/photo/photo-tools-selfie-core.test.ts tests/apps/api/routes/admin/admin-routes-photo.test.ts tests/contexts/agent-profile/prompt-profile-shell.test.ts`
- `npm test`
