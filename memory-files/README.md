# Memory Files 说明

`memory-files` 预留给人类可读的文件化上下文与索引。

## 当前用途

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
memory-files/config/prompt-profile.json
```

每日 shell、shell 配置、prompt 模板和服装图片保存在：

```text
memory-files/shell/
```

## 当前未使用部分

Markdown 形式的长期 profile、session、topic 文件尚未实现。
