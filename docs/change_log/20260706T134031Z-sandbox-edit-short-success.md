# Sandbox Edit 成功返回缩短

## 背景

`Edit` 成功后原本返回完整句子，例如 `The file ... has been updated successfully.`。这类内容对模型后续决策没有额外价值，会占用不必要的上下文。

## 变更

- `Edit` wrapper 成功写入后返回 `message: "OK"`。
- `sandbox-file-tools` capability 层成功执行 `Edit` 后固定向 tool result 返回 `OK`。
- 保持失败信息不变，仍返回具体错误原因。

## 验证

```bash
node --import tsx --test tests/capabilities/tools/sandbox-file-tools/sandbox-file-tools.test.ts
npm run typecheck
```

