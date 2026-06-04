# Code Review 记录

当前代码评审留下的问题：

- 暂缓处理：`check_chat` 和后台消息搜索描述的是当前一对一会话，但实际只按 plugin 过滤。多会话场景下，输出可能包含其他会话。后续会结合 session/channel 路由调整一起处理。
