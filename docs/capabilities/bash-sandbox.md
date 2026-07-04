# Bash Sandbox 能力

Bash sandbox 位于 `src/contexts/bash-sandbox`，LLM 工具入口位于 `src/capabilities/tools/bash`。

## 目标

在 Docker sandbox 内执行非交互 bash 命令，避免把未授权命令直接落到宿主机执行。

## 配置

主要配置来自应用配置中的 `bashSandbox`：

- enabled
- image
- workdir
- timeout
- mounts
- audit log path

## 执行

`createBashSandboxRuntime()` 负责读取配置并选择 executor。Docker executor 构造受限命令、挂载允许目录，并记录审计信息。

## 边界

被拒绝或失败的 sandbox 命令不得 fallback 到宿主机执行。需要更高权限时必须通过外层授权流程处理。
