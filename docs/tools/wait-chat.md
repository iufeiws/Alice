# wait_chat 工具

待删除：`wait_chat` 已从 messaging/chat tool 独立出来并改名为 `finish_and_wait`。

当前实现不保留 `wait_chat` 兼容别名。等待语义由独立 control tool `finish_and_wait` 提供；heartbeat resume 仍由 chat loop 内部调用 `check_chat` 补齐结果。
