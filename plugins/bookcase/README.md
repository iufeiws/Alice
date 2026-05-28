# Bookcase Plugin

Bookcase 是 AgentCore 的书橱工具，用于从本地书籍剧情语料库抽取一本书作为讲故事母版。

当前暴露给 LLM 的工具名是 `bookcase`，参数只包括 schema 中声明的字段：

```json
{
  "action": "draw"
}
```

`action=draw` 抽取一本书并返回剧情母版、改写规则、名字池和来源行。`action=return` 归还书本，并通过 `invalidateLLMSession` 请求重开会话，避免书本母版继续占用上下文。

`title` 可用于按书名模糊取特定书，不再另设 `name` 参数。

语料库位于：

```text
plugins/bookcase/assets/booksummaries.sqlite
```
