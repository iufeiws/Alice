# 文件工具 Profile 文案去除 Sandbox 暴露

## 背景

`Read` / `Edit` / `Glob` / `Grep` 的 tool profile 是 LLM 可见内容，不需要向模型暴露底层 sandbox 执行细节。

## 变更

- 去掉 `src/capabilities/tools/file/profile.ts` 中 description 和参数说明里的 `sandbox`、`configured sandbox`、`inside the sandbox` 等表述。
- 保持运行时路径校验、allowed roots 和 bash sandbox wrapper 执行机制不变。

## 验证

```bash
npm run typecheck
```
