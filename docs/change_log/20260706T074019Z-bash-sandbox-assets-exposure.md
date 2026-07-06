# Bash sandbox 暴露 /assets

日期：2026-07-06

## 背景

bash sandbox 已有宿主机 `assets` 到容器 `/assets` 的只读挂载约定。为了让 sandbox 内的 root-scope wrapper 在处理 `find /`、`rg /`、`tree /` 等根目录扫描时也能看到资源目录，需要把 `/assets` 纳入 wrapper 展开的允许根目录。

同时，Docker executor 复用容器时必须把普通 `mounts` 纳入复用 key。否则挂载配置变化后，旧容器可能继续运行，导致新挂载未实际生效。

## 变更内容

- root-scope wrapper 的根目录展开列表加入 `/assets`。
- Docker executor 的容器复用 key 从 skill mount 扩展为完整 mount key，包含：
  - skill mounts
  - 普通 mounts
  - wrapper 目录
- bash sandbox 测试补充 `/assets` 挂载断言：
  - 默认配置包含只读 `/assets` mount。
  - Docker run 参数包含 `/assets` 只读挂载。

## 兼容性

- 不改变 tool 暴露和执行路径。
- 不新增 prompt 或隐藏 prompt。
- 不改变已有 `/workspace`、`/skills`、`/tmp`、`/cache` 根目录行为。

## 验证

已执行：

```bash
node --import tsx --test --test-concurrency=1 tests/contexts/bash-sandbox/bash-sandbox.test.ts tests/contexts/bash-sandbox/bash-sandbox-docker.test.ts
npm run typecheck
```

结果：

- bash sandbox 目标测试通过。
- TypeScript 类型检查通过。
