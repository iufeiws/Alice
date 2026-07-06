# 不合规测试清理记录

## 背景

测试中存在一批不稳定或不应固化的断言，包括可配置项默认值、硬编码配置、固定返回文案、固定输入/输出片段、日志文本、HTML 文案和具体格式片段。

本次目标是删除这类断言，让测试只覆盖结构、状态、调用路径和持久化结果等更稳定的行为。

## 变更

- 删除或降级测试中对固定配置变量、默认值和硬编码配置内容的断言。
- 删除或降级测试中对固定返回文本、日志文本、输出文本、HTML 文案和具体输入片段的断言。
- 删除纯固定页面文案测试 `tests/apps/api/routes/voice-call/voice-call-html.test.ts`。
- 将运行时代码 `src/contexts/capabilities/src/admin-plugin-tts-test.ts` 重命名为 `src/contexts/capabilities/src/admin-plugin-tts-check.ts`，避免 `src` 下出现 `*-test.ts` 命名。
- 保留测试桩内部用于请求分流的字符串判断；这些不是对返回内容的断言。

## 验证

已执行：

```bash
npm run typecheck
npm test
rg --files src | rg '(^|/).*test\.(ts|tsx|js|mjs|cjs)$'
```

结果：

- TypeScript 类型检查通过。
- 完整测试通过。
- `src` 下没有 `*-test.ts` 测试命名文件。
