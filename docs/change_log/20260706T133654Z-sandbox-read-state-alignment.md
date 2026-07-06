# Sandbox 文件工具 Read state 对齐

## 背景

`sandbox-file-tools` 在接入 Claude Code 风格 `Read` / `Edit` 时，本地 capability 层额外改写了 `readFileState` 语义：

- 默认 `Read` 把 `offset` 存成 `undefined`，和 `Edit` 成功后的状态混在一起。
- 带 `offset` / `limit` 的普通 `Read` 被标记成 `isPartialView`，导致后续 `Edit` 误报“File has not been read yet”。
- `Read` 去重没有区分状态来源，`Edit` 成功后再次 `Read` 可能错误返回 `file_unchanged` stub，指向编辑前的旧内容。

## 变更

- `Read` 成功后保存实际 `offset`，默认完整读取保存为 `offset: 1`。
- 普通 `Read` 不再写入 `isPartialView`；该标记只保留给自动注入且内容不等于磁盘的视图类状态。
- `Read` 去重只命中由 `Read` 产生的状态，即 `offset !== undefined` 的状态；`Edit` 成功后写入的 `offset: undefined` 状态不参与去重。
- 保留空文件读取修正：空文件继续返回 `totalLines: 0`，展示为空文件提示。
- 保留图片读取识别逻辑，本次不改动。

## 验证

```bash
node --import tsx --test tests/capabilities/tools/sandbox-file-tools/sandbox-file-tools.test.ts
npm run typecheck
```

