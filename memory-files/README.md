# Memory Files 说明

`memory-files` 预留给人类可读的文件化上下文与索引。

## 当前用途

Memorize 使用长期记忆 git 仓库和日记 SQLite：

```text
memory-files/long-term-memory/persistent-memory.md
memory-files/long-term-memory/user-preferences.md
memory-files/diary/diary.sqlite
```

- `long-term-memory/persistent-memory.md`：长期事实、关系连续性和稳定背景，最多 100 行且不超过 10 KiB（10240 字节）。
- `long-term-memory/user-preferences.md`：用户稳定偏好、互动风格和约束，最多 80 行且不超过 8 KiB（8192 字节）。
- `diary/diary.sqlite`：agent 每日日记；最新日记会作为 `{{memory/yesterdaySummary/content}}` 注入 prompt，单条最多 20 行且不超过 2 KiB（2048 字节）。

`long-term-memory/` 是独立 git 仓库。每次 Memorize 写入持久记忆或用户偏好后，会直接提交一次 git 历史；这些修订历史不进入 SQLite。

睡眠 Memorize 与 `sleep_cocoon` 工具解耦：系统监听 Agent 状态切换，当状态进入 `sleeping` 时，先记录当前归纳时间戳，再读取上一个归纳时间戳到当前时间戳之间的聊天记录并归纳。归纳状态保存到：

```text
memory-files/state/sleep-memory-state.json
```

如果归纳失败，已经成功写入的目标保持不变，`lastInductionAt` 不前进，下一次进入睡眠时会重试同一窗口。应急回填从管理后台 Memory 标签按日期一天一天运行。

Memorize prompt 配置保存到：

```text
src/core/prompt/memorize-prompts.json
```

Core 与 Memorize 的原始 LLM 会话逐次保存为 JSONL，按会话创建时的 UTC 日期和时间命名：

```text
memory-files/llm-sessions/core/YYYY-MM-DD/HH-MM-SS-mmm.jsonl
memory-files/llm-sessions/memorize/YYYY-MM-DD/HH-MM-SS-mmm.jsonl
```

Core 的当前可恢复会话指针保存为 `memory-files/llm-sessions/current.json`。JSONL 第一行是 metadata，包含创建时间 UTC 和以该 UTC 创建时间计算的 `sessionId` 时间戳；后续每行是一条 LLM transcript message。

唯一飞书绑定保存到：

```text
memory-files/indexes/feishu-paired-contacts.json
```

这条记录用于：

- 只允许一个飞书用户/联系人；
- 路由管理后台发送测试；
- 支撑未来主动消息能力。

微信 iLink 登录状态保存到：

```text
memory-files/indexes/wechat-ilink-state.json
```

这条记录用于复用扫码登录后的 `bot_token`、账号专属 `baseurl` 和发送消息需要的上下文 token。

Core 侧会话消息保存在 SQLite：

```text
memory-files/message/messages.sqlite
```

Prompt profile 保存到：

```text
src/core/prompt/prompt-profile.json
src/core/prompt/prompt-api-profile.json
```

每日 shell、shell 配置和服装图片保存在：

```text
memory-files/shell/
```

每日 shell 的 prompt 模板保存到：

```text
src/core/prompt/shell-prompt-template.txt
```

## 当前未使用部分

Markdown 形式的 session、topic 文件尚未实现。
