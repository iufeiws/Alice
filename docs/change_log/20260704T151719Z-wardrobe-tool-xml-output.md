# 衣橱工具 XML-style 返回格式调整

日期：2026-07-05

## 变更内容

- `Wardrobe` 工具新增 `random` action：
  - `name` 为空时，从全部服装中随机切换。
  - `name` 非空时，从匹配到的服装中随机切换。
- 服装输出统一改为 XML-style 文本格式，只包含 `name`、`group`、`content`：
  - 详细格式：`<{name} group="...">...内容...</{name}>`
  - 简略格式：`<{name} group="..." />`
- 缺失 `group` 的服装在 `Wardrobe` 输出层视为 `root`。
- `list` 行为调整：
  - `name` 为空时返回 `<groups>`，内容为每行一个 group 名。
  - `name` 非空时仍按服装 `name/id/group/content` 模糊过滤。
  - 匹配结果超过 3 个时，只返回简略服装格式。
- `mirror` 返回当前服装的详细 XML-style 格式。
- `switch` 返回格式调整：
  - 成功只返回 `success`。
  - 普通错误返回 `<error>...</error>`。
  - 匹配到多个候选时返回 `<error>...</error>` 和 `<candidates>...</candidates>`。

## 验证

- `node --import tsx --test tests/capabilities/tools/shell/shell-tools-actions.test.ts`
- `node --import tsx --test tests/capabilities/tools/shell/shell-tools-store.test.ts`
- `npm run typecheck`
