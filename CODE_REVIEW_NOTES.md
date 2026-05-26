# Code Review Notes

Open issues from the workspace review:

- High: `core/agent/src/index.ts` drops plain LLM text replies. `handleEvent()` currently returns `[]` after the LLM turn, while `message-runtime` marks inbound messages processed. If the model does not call `send_feishu`, the user gets no reply and the inbound message is not retried.
- High: streaming `send_feishu` can send text before the streamed tool JSON confirms `type`. If `content` arrives before `"type":"markdown"` or another non-message type, the newline streaming path can send a plain Feishu message prematurely.
- Medium: `check_feishu` and `search_messages` describe the current one-on-one conversation, but they filter by plugin only. In multi-session use, tool output can include other conversations.
