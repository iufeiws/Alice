---
name: list-notes
description: 列出 sandbox 中 ~/.agents/notes 下的笔记，包含每个笔记的 name / description / path。
---

# 查看笔记列表

以下是 sandbox 中 `~/.agents/notes`（容器内 `/home/alice/.agents/notes`）下的笔记：

${{notes_list}}

## 说明

- 上面的列表在加载时动态构建，始终反映当前笔记。
- 如果列表为空，说明当前没有笔记。
