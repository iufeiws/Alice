# 系统通知格式统一记录

## 背景

部分系统通知使用 `-xxx-` 作为硬编码文本，并直接写入消息历史。这样会让 Chat pull 返回的 `<chat-log>` 中混入展示包装，后续进入 LLM 上下文时不利于区分系统消息内容和展示格式。

## 变更

- 新增统一系统通知发送路径，由 `MessageRuntime` 负责系统通知入库、发送、失败状态标记和可选 message log。
- 系统通知入库保存未包裹文本，例如 `少女拍照中`。
- 系统通知发送到渠道时统一格式化为 `<-少女拍照中->`。
- Chat pull 渲染系统消息时统一输出 `< system message="..." />`。
- 兼容历史消息中的 `-xxx-` 和 `(xxx...)` 格式，拉取时会去掉旧包装再渲染。
- Photo、Wardrobe、Bookcase、Sleep Cocoon、睡眠通知、记忆失败通知改为复用统一系统通知发送路径。

## 验证

已执行：

```bash
npm run typecheck
npm test
```

结果：

- TypeScript 类型检查通过。
- 完整测试通过。
