# Short Memory 会话清除采集开发需求

## 1. 文档状态

- 状态：待开发
- 日期：2026-08-13
- 适用范围：Chat、Talk、Memorize 会话清除链路
- 数据库：`memory-files/alice.sqlite`
- Sandbox 文件：容器内 `/home/alice/.short_memory`，即 `~/.short_memory`
- 宿主读取路径：`path.join(config.bashSandbox.hostWorkspaceDir, ".short_memory")`，默认 `.sandbox/bash/alice/.short_memory`

## 2. 背景与目标

Alice 需要允许 sandbox 内的 Agent 在当前会话存活期间，将尚未整理的短期记忆写入 `~/.short_memory`。当一个真实存在的会话即将被清除时，Alice 必须先检查该文件，将有效内容保存到 `alice.sqlite`，再把文件重置为仅包含一个换行符的状态，最后才允许会话完成清除。

本功能的触发条件是**会话清除**，不是 Agent 状态切换。Agent 进入 `idle`、`sleeping` 或其他状态本身均不得直接触发 Short Memory 采集。

目标如下：

1. Chat、Talk、Memorize 的真实会话清除统一经过一个异步协调入口。
2. Short Memory 采集成功之前，不得归档为已清除、删除 current pointer、关闭 Talk 会话或丢弃 Memorize 会话引用。
3. Short Memory 采集失败时，保留原会话和待采集内容，并阻止后续 loop 继续执行。
4. 管理后台可以只读查看最新 100 条 Short Memory。
5. Prompt 变量树提供最新醒来时间前 24 小时至当前时间的 Short Memory XML。该变量是否加入 Prompt、加入哪些 Prompt layer、参与 Chat/Talk/Memorize 中的哪些 loop，完全由用户后续在 Prompt 编辑器中的配置决定。

## 3. 术语与业务规则

### 3.1 会话类型

```ts
export type ClearableSessionKind = "chat" | "talk" | "memorize";
```

- `chat`：主 Chat LLM current session。
- `talk`：语音 Talk 对应的 Talk runtime session 及其 LLM session。
- `memorize`：Memory console/归纳使用的 Memorize session。

### 3.2 真实会话清除

只有满足以下条件时才执行采集：

- 会话当前真实存在；
- 会话尚未被标记为已清除或关闭；
- 调用方即将执行不可重复的清除提交。

当 current session 不存在、Talk session 已关闭、Memorize session 不存在或已经带有 `clearedAt` 时，清除操作返回 `cleared: false`，不得读取或修改 `~/.short_memory`。

### 3.3 有效内容

读取到的 UTF-8 文本按以下规则判断：

1. 使用 `trim()` 得到待保存内容。
2. trim 后为空，视为无有效内容。
3. trim 后必须至少包含一个 Unicode Letter 或 Number，即满足正则 `/[\p{L}\p{N}]/u`。
4. 纯空白、纯标点、纯 emoji 或其他全符号内容均不保存，也不重置文件。
5. 有效内容以 trim 后的字符串写入数据库。

### 3.4 时间规则

- 时间字段参照 `messages.created_at` 与 `messages.created_at_utc` 的现有双字段约定。
- `created_at_utc` 来自项目全局 `CurrentTimeProvider.now().date.toISOString()`，保存 UTC `Z` 时间，例如 `2026-08-13T06:30:00.000Z`。
- `created_at` 必须由同一个 UTC instant 按 `config.core.timezone` 转换得到，保存为不带 `Z`、不带 offset 的 wall-clock ISO，例如 `2026-08-13T14:30:00.000`。
- 两个字段必须描述同一个 instant；不得分别获取两次当前时间，也不得使用运行主机默认时区。
- 时间范围筛选、醒来边界比较和排序以 `created_at_utc` 为准；`created_at` 用于面向 Agent 和管理后台展示。
- 测试必须参照 `messages` 写入行为，校验 UTC、本地 wall-clock 与配置时区三者一致。

## 4. 数据设计

### 4.1 SQLite 表

在 `memory-files/alice.sqlite` 增量创建：

```sql
CREATE TABLE IF NOT EXISTS short_memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  content TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS short_memory_entries_created_at_utc_idx
  ON short_memory_entries(created_at_utc, id);
```

表只保存主键、本地写入时间、UTC 写入时间和内容，不保存来源会话、清除原因或 Agent 状态。

Alice 主库 schema version 必须递增；迁移必须为幂等的 additive migration，不删除或重写旧表数据。

### 4.2 类型与存储接口

建议在 Memory context 中新增 `short-memory-store.ts`，公开以下类型：

```ts
export type ShortMemoryEntry = {
  id: number;
  createdAt: string;
  createdAtUtc: string;
  content: string;
};

export type ShortMemoryTransaction = {
  insert(input: { createdAt: string; createdAtUtc: string; content: string }): ShortMemoryEntry;
  commit(): void;
  rollback(): void;
};

export type ShortMemoryStore = {
  beginWrite(): ShortMemoryTransaction;
  listLatest(limit: number): ShortMemoryEntry[];
  listByCreatedAtUtcRange(input: {
    startAtUtc: string;
    endAtUtc: string;
  }): ShortMemoryEntry[];
};

export function createShortMemoryStore(dbPath: string): ShortMemoryStore;
```

接口行为：

- `beginWrite()` 使用同一数据库连接开启 `BEGIN IMMEDIATE`。
- `insert()` 只在当前事务中执行一次 INSERT，不得隐式提交。
- `commit()` 或 `rollback()` 只能调用一次；重复调用抛错。
- `listLatest(limit)` 校验 `limit` 为正整数，按 `created_at_utc DESC, id DESC` 返回。
- `listByCreatedAtUtcRange()` 使用闭区间 `created_at_utc >= startAtUtc AND created_at_utc <= endAtUtc`，按 `created_at_utc ASC, id ASC` 返回。
- 存储层错误必须直接抛出，不增加返回空数组的 fallback。

## 5. Short Memory 宿主文件与 Worker

### 5.1 接口

Sandbox 的 home 已通过 `BashSandboxConfig.hostWorkspaceDir` 挂载到 `workspaceDir`。Alice 主进程直接操作对应宿主文件，不通过 Docker exec，也不通过 LLM 可见的 Bash Tool。

建议在 Memory context 中新增窄文件接口：

```ts
export type ShortMemoryFile = {
  read(): Promise<{
    exists: boolean;
    content: string;
  }>;
  replace(content: string): Promise<void>;
};

export type ShortMemoryCaptureResult =
  | { captured: false; reason: "missing" | "empty" | "symbols_only" }
  | { captured: true; entry: ShortMemoryEntry };

export type ShortMemoryWorker = {
  captureBeforeSessionClear(): Promise<ShortMemoryCaptureResult>;
};

export function createShortMemoryWorker(input: {
  file: ShortMemoryFile;
  store: ShortMemoryStore;
  time: CurrentTimeProvider;
}): ShortMemoryWorker;

export function createHostShortMemoryFile(input: {
  hostWorkspaceDir: string;
}): ShortMemoryFile;
```

`createHostShortMemoryFile()` 必须使用 `path.resolve(hostWorkspaceDir, ".short_memory")`，并校验结果仍位于 `hostWorkspaceDir` 内。生产 wiring 传入 `config.bashSandbox.hostWorkspaceDir`，不得使用进程用户的 `$HOME` 或 `~` 展开结果。

### 5.2 宿主文件行为

约束：

- 容器内路径固定为 `path.posix.join(config.bashSandbox.workspaceDir, ".short_memory")`；宿主直接读取与之对应的 `path.resolve(config.bashSandbox.hostWorkspaceDir, ".short_memory")`。
- 文件不存在时返回 `{ exists: false, content: "" }`，不视为错误。
- 文件必须按 UTF-8 完整读取。
- `replace()` 必须在同一目录写临时文件并通过 rename 原子替换目标文件。
- 成功采集后的 `replace("\n")` 必须让目标文件严格只包含一个换行符。
- 数据库最终提交失败时使用 `replace(originalContent)` 补偿恢复；不得吞掉恢复错误。
- 宿主文件读取、写入、rename 或权限错误均必须抛出。

### 5.3 采集算法与一致性

`captureBeforeSessionClear()` 必须串行执行。多个会话同时请求清除时，后一个请求必须等待前一个请求完整结束。

有效内容的执行顺序固定为：

1. 从宿主映射路径完整读取文件。
2. 校验并 trim 内容。
3. `beginWrite()`。
4. 在未提交事务内执行 `insert()`。
5. `file.replace("\n")`，把文件改成 `"\n"`。
6. `commit()`。
7. 返回 `{ captured: true, entry }`。

失败处理：

- 第 1 至第 4 步失败：回滚已开启事务，文件保持不变。
- 第 5 步失败：回滚事务；由于 `replace()` 使用同目录原子 rename，目标文件必须仍为旧内容。
- 第 6 步失败：调用 `rollback()`，再执行 `file.replace(originalContent)`，最后抛出原始提交错误；若恢复也失败，抛出包含 commit 与 restore 两个失败信息的组合错误。
- 任意失败均不得返回成功，也不得允许会话清除回调执行。
- 不允许使用不必要的 `try/catch`；只在事务回滚和文件补偿所必需的边界捕获错误。

说明：SQLite 与宿主文件仍不属于同一个原子事务，因此这里使用“SQLite 未提交事务 + 同目录原子文件替换 + 提交失败补偿恢复”。实现必须通过测试覆盖每个失败点。

## 6. 统一 Session Clear Coordinator

### 6.1 接口

建议新增 `session-clear-coordinator.ts`：

```ts
export type SessionClearReason = string;

export type SessionClearRequest = {
  kind: ClearableSessionKind;
  sessionId: string;
  reason: SessionClearReason;
  exists(): boolean;
  clear(): Promise<void> | void;
};

export type SessionClearResult = {
  cleared: boolean;
  shortMemoryCaptured: boolean;
};

export type SessionClearCoordinator = {
  clearSession(request: SessionClearRequest): Promise<SessionClearResult>;
};

export function createSessionClearCoordinator(input: {
  shortMemoryWorker: ShortMemoryWorker;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}): SessionClearCoordinator;
```

### 6.2 行为

`clearSession()` 必须：

1. 将请求放入单一串行队列。
2. 在轮到该请求执行时调用 `exists()`，而不是在入队时读取陈旧状态。
3. `exists() === false` 时返回 `{ cleared: false, shortMemoryCaptured: false }`，不得调用 Worker。
4. 调用并等待 `shortMemoryWorker.captureBeforeSessionClear()`。
5. Worker 成功后调用并等待 `request.clear()`。
6. `request.clear()` 成功后返回 `{ cleared: true, shortMemoryCaptured: capture.captured }`。
7. Worker 或 clear 回调失败时向调用方传播错误，队列仍须允许后续请求继续执行。

同一个 session 的并发重复 clear 由执行时的 `exists()` 去重。第一个请求成功后，第二个请求观察到会话已不存在并返回 `cleared: false`。

日志不得记录 Short Memory 正文，只记录 `kind`、`sessionId`、`reason`、是否捕获以及错误码。

## 7. 各会话接入要求

### 7.1 Chat

将以下接口改为异步：

```ts
// llm-session runtime
clearCurrentLLMSession(reason: LLMSessionClearReason): Promise<SessionClearResult>;

// agent-loop runtime
clearCurrentLLMSession(reason: LLMSessionClearReason): Promise<SessionClearResult>;

// ChatAgent
clearLLMSession(reason: LLMSessionClearReason): Promise<SessionClearResult>;
```

`llm-session-runtime` 中现有写 `clearedAt/clearedAtUtc/reason`、写 metadata、清 current pointer 和清内存 current session 的逻辑整体作为 coordinator 的 `clear()` 回调。

以下所有 Chat 清除原因都必须进入同一入口：

- `prompt_static_changed`
- `admin_clear`
- `admin_cancel`
- `mode_transition`
- `mode_timeout`
- `yield_end`
- `process_restart_recovery_failed`

所有调用点必须 `await`。特别是 function-call loop、Yield 结束、Prompt 静态指纹变化、取消和 session rebuild 路径，不得在 clear Promise 完成前返回或开启新 loop。

进程关闭不属于会话清除：shutdown 不采集 Short Memory，也不写会话 cleared 标记。

### 7.2 Talk

Talk 正常关闭视为真实会话清除。接口调整为：

```ts
export type TalkRuntime = {
  // 其他接口省略
  closeSession(input: {
    sessionId: number;
    occurredAt?: string;
    occurredAtUtc?: string;
  }): Promise<SessionClearResult>;
};
```

协调器成功完成后，Talk 的 `clear()` 回调按以下顺序执行：

1. 将活跃 Talk LLM transcript 从 runtime 重写到持久存储。
2. 将对应 LLM session 标记为 cleared 并清 current pointer。
3. 关闭 `logs/talk/talk.sqlite` 中的 Talk session。
4. 将关闭后的 Talk transcript 投影到 conversation hub。
5. 将 Agent 状态切换到 `waiting`。

Short Memory 失败时，上述五步均不得执行，Talk session 保持未关闭。通话渠道必须收到关闭失败，不得伪装为成功关闭。

### 7.3 Memorize

将 Memorize clear 改为异步：

```ts
export type MemoryConsoleRuntime = {
  ensureSession(windowEndAt: string, windowStartAt?: string): MemoryInductionSession;
  clearSession(reason?: string): Promise<SessionClearResult>;
};
```

现有 `clearMemoryInductionSession()` 中设置 `clearedAt`、`clearReason`、清理 `activeTarget`、写 `final_messages` 以及释放内存 session 引用的逻辑必须放入 coordinator 的 `clear()` 回调。

以下场景均须使用该入口：

- 管理后台手工 Clear Session。
- Memorize 运行时显式结束并清除真实会话的路径。
- 后续新增的 Memorize clear 原因。

仅一次归纳 target 执行完毕但 session 仍需复用时，不属于 clear，不触发 Short Memory。

## 8. 管理后台 API 与页面

### 8.1 Memory 查询 API

`GET /admin/api/memory` 响应新增：

```ts
type AdminMemoryResponse = {
  // 现有字段省略
  shortMemories: Array<{
    id: number;
    createdAt: string;
    createdAtUtc: string;
    content: string;
  }>;
};
```

规则：

- 只返回最新 100 条。
- API 数据按 `createdAtUtc DESC, id DESC` 排序，同时返回 `createdAt` 供本地时间展示和 `createdAtUtc` 供校验。
- 查询失败由统一 Admin HTTP 错误处理返回 JSON 错误，不返回部分成功数据。

### 8.2 Clear API

以下管理 API 必须等待异步 clear：

- `POST /admin/api/llm-chain/clear`
- `POST /admin/api/llm-run/cancel` 中实际发生 session clear 的阶段
- `POST /admin/api/memory/clear-session`

成功响应至少包含：

```json
{
  "ok": true,
  "cleared": true,
  "shortMemoryCaptured": true
}
```

无当前会话时返回 HTTP 200：

```json
{
  "ok": true,
  "cleared": false,
  "shortMemoryCaptured": false
}
```

Short Memory 或 clear 失败时返回非 2xx JSON 错误，禁止直接把异常堆栈返回浏览器。

### 8.3 Memory 页面

Memory 页新增独立的只读 `Short Memory` 区块：

- 展示最新 100 条。
- 每条展示本地时间 `createdAt` 与完整 `content`；`createdAtUtc` 保留在 API 数据中用于时间一致性校验。
- 按时间倒序。
- 使用现有 `escapeHtml`，不得把内容作为 HTML 插入。
- 不提供保存、删除或编辑按钮。

## 9. Prompt 变量树

### 9.1 变量接口

在 `prompt-context-runtime` 的公开变量列表中新增：

```text
memory/shortMemory/content
```

`createPromptContextRuntime()` 增加依赖：

```ts
shortMemoryStore: Pick<ShortMemoryStore, "listByCreatedAtUtcRange">;
```

### 9.2 时间窗口

读取最新 `wakeBoundary`：

- 没有 wake boundary 时返回空 XML。
- 以 `latestWakeBoundary.occurredAtUtc` 为边界；新写入的 wake boundary 必须具有该 UTC 字段。
- `startAtUtc = latestWakeBoundary.occurredAtUtc - 24 小时`。
- `endAtUtc = CurrentTimeProvider.now().date.toISOString()`。
- 通过 `listByCreatedAtUtcRange({ startAtUtc, endAtUtc })` 查询闭区间。
- 时间计算必须使用项目时间提供器和配置时区解析能力，不得直接按字符串或本机时区计算。

### 9.3 XML 格式

变量值按 `createdAtUtc ASC, id ASC` 输出，但 XML 沿用已确认的本地 `created_at` 与内容结构：

```xml
<short_memories>
  <short_memory>
    <created_at>2026-08-13T14:30:00.000</created_at>
    <content>示例内容</content>
  </short_memory>
</short_memories>
```

空结果固定返回：

```xml
<short_memories></short_memories>
```

`created_at` 和 `content` 必须进行 XML 文本转义，至少覆盖 `&`、`<`、`>`。不得在运行时额外包裹任何未在变量树显示的 Prompt 文本。

Prompt 编辑器显示并提供该变量。变量最终是否被引用、位于哪个 Prompt layer、进入 Chat/Talk/Memorize 中的哪些 loop，完全由用户后续编辑 Prompt 决定。本需求只实现变量数据源，不替用户决定使用范围。Prompt Preview 与实际 LLM 请求必须继续共用 `src/contexts/agent-profile/src/domain/prompt-layer.ts` 和现有 Prompt context 渲染入口。

## 10. 错误与并发语义

- Worker 和 coordinator 都必须单线程串行，不能让两个清除请求同时读取同一个文件。
- Short Memory 失败必须阻止对应会话清除。
- Chat 清除失败时，当前 loop 抛错并停止，不得继续创建下一会话。
- Talk 清除失败时，Talk session 保持打开状态，不投影关闭记录，不切换到 `waiting`。
- Memorize 清除失败时，保留内存 session 引用及未清除元数据。
- 空会话 clear 不采集、不清文件、不报错。
- 有效 Short Memory 成功采集后，即使会话自身 clear 回调随后失败，也不得再次保存同一份已被重置的文件内容；会话保留，后续重试只会看到空文件并再次尝试 clear。
- 禁止用 catch 后继续清除、返回空内容或跳过失败的兼容逻辑。

## 11. 验收标准

### 11.1 数据与文件

- [ ] 启动旧数据库时自动创建 `short_memory_entries` 和索引，旧数据不受影响。
- [ ] 有效文本以 trim 后内容写入，同时保存 `created_at` 和 `created_at_utc`。
- [ ] 两个时间字段来自同一个 `CurrentTimeProvider.now()` 结果，并与 `messages` 的双时间字段规则一致。
- [ ] `created_at_utc` 是 UTC `Z` 时间，`created_at` 是该 instant 在配置时区下的 wall-clock 时间。
- [ ] SQLite INSERT 成功且文件重置成功后，会话才被清除。
- [ ] 成功采集后 `~/.short_memory` 的字节内容严格等于 `0x0A`。
- [ ] 空白、纯符号和纯 emoji 不入库，也不修改原文件。

### 11.2 会话行为

- [ ] Chat 的所有 clear reason 均经过统一 coordinator。
- [ ] Talk 正常关闭经过统一 coordinator。
- [ ] Memorize 手动及真实 clear 路径经过统一 coordinator。
- [ ] 不存在或已清除的会话不会触发宿主 Short Memory 文件读取。
- [ ] Short Memory 失败时会话保持未清除，调用方收到错误。
- [ ] 清除 Promise 完成前，不进入后续 heartbeat、function-call loop 或新会话创建。
- [ ] 并发重复 clear 同一个会话时最多一次真实清除，后续请求返回 `cleared: false`。
- [ ] Agent 状态切换本身不触发 Short Memory。

### 11.3 后台与 Prompt

- [ ] Memory API 和页面只读显示最新 100 条，顺序为最新优先。
- [ ] Memory API 同时返回 `createdAt` 与 `createdAtUtc`，二者表示同一个 instant。
- [ ] 页面正确转义 Short Memory 内容，不产生 HTML 注入。
- [ ] Prompt 树显示 `memory/shortMemory/content`。
- [ ] Prompt 变量只包含最新醒来时间前 24 小时至当前时间的记录。
- [ ] XML 按时间升序，动态值正确转义。
- [ ] 没有 wake boundary 或没有记录时返回固定空 XML。
- [ ] 本功能没有擅自决定变量参与哪个 loop；只有用户后续编辑的 Prompt layer 可以引用它。
- [ ] Preview 与实际请求对该变量的解析结果一致。

### 11.4 工程质量

- [ ] 所有新增或变更的 API 行为都有测试。
- [ ] Admin API 对输入和错误返回 JSON。
- [ ] 单个代码文件不超过 1000 行。
- [ ] `npm run typecheck`、`npm test`、`npm run build` 全部通过。
- [ ] `project_summary.md` 已同步更新实际实现结构与行为。

## 12. 测试要求

### 12.1 Short Memory Store 单元测试

建议文件：`tests/contexts/memory/short-memory-store.test.ts`

覆盖：

1. 新数据库建表和索引。
2. 已有 `alice.sqlite` 的幂等迁移。
3. 事务 insert、commit、rollback。
4. rollback 后无新增记录。
5. `listLatest(100)` 的数量限制及倒序。
6. 时间相同记录使用 id 稳定排序。
7. 基于 `created_at_utc` 的闭区间时间范围查询。
8. 非法 limit 抛错。
9. `created_at`、`created_at_utc` 的写入和读取映射。

### 12.2 Worker 单元测试

建议文件：`tests/contexts/memory/short-memory-worker.test.ts`

使用临时宿主目录、fake file port 和真实临时 SQLite，覆盖：

1. 文件不存在。
2. 空字符串和仅换行。
3. 纯 ASCII/中文标点。
4. 纯 emoji。
5. 拉丁字母、中文、其他 Unicode 字母、ASCII 和非 ASCII 数字。
6. trim 后写入。
7. 写库成功后严格重置为 `"\n"`。
8. 宿主文件 read 失败。
9. INSERT 失败。
10. reset 失败并回滚。
11. commit 失败并恢复原内容。
12. commit 与 restore 同时失败时组合错误可观察。
13. 两个 capture 并发时严格串行。
14. 容器路径与宿主 `hostWorkspaceDir/.short_memory` 指向同一挂载文件。
15. 本地时间和 UTC 时间只取一次当前 instant，并按配置时区正确转换。

### 12.3 Coordinator 单元测试

建议文件：`tests/contexts/llm-session/session-clear-coordinator.test.ts`

覆盖：

1. `exists() === false` 不调用 Worker 和 clear 回调。
2. Worker 成功后才调用 clear。
3. Worker 失败时不调用 clear。
4. clear 回调失败时错误传播。
5. Chat、Talk、Memorize 三种 kind。
6. 并发请求串行。
7. 同 session 重复 clear 只执行一次。
8. 队列中的一个请求失败后，后续请求仍能执行。

### 12.4 Chat 集成测试

扩展 `tests/contexts/llm-session/`、`tests/contexts/agent-loop/` 与管理 API 测试，覆盖：

- 每个 `LLMSessionClearReason`。
- active session 与无 current session。
- Short Memory 未完成时 loop 不继续。
- `clearedAt`、metadata、pointer 和内存 current 的提交顺序。
- Admin clear 的成功、空会话和失败 JSON。
- Prompt rebuild、Yield end、cancel 与 mode timeout 路径均等待 clear。

### 12.5 Talk 集成测试

扩展 `tests/contexts/talk-session/`，覆盖：

- 正常关闭采集成功。
- Worker 阻塞期间 Talk 尚未关闭。
- Worker 失败时 Talk store 未关闭、无 conversation projection、状态不变。
- 成功后的 LLM 归档、Talk close、投影和状态切换顺序。
- 重复 close 不重复采集。

### 12.6 Memorize 集成测试

扩展 `tests/contexts/memory/` 与后台路由测试，覆盖：

- Memory console 手工 clear。
- 无 session clear 不采集。
- Worker 失败时 `clearedAt`、`activeTarget` 和内存引用不变。
- 成功后写 final messages 并释放引用。

### 12.7 Prompt 与后台测试

覆盖：

- 基于 `occurredAtUtc` 与 `createdAtUtc` 的 wake boundary 前 24 小时、边界点和 now 之后记录过滤。
- 无 wake boundary。
- XML 顺序和 `& < >` 转义。
- Prompt variable tree 可见；测试不假定该变量固定参与或不参与任何 loop，实际使用由 Prompt layer 配置决定。
- Memory API 最新 100 条响应。
- API 中 `createdAt` 与 `createdAtUtc` 的同一 instant 校验，覆盖非 UTC 配置时区和跨日情况。
- Memory 页面转义、只读和排序。

### 12.8 回归命令

```bash
npm run typecheck
npm test
npm run build
```

## 13. 建议实施顺序

1. 新增 Short Memory 表、store 和迁移测试。
2. 新增宿主映射文件读写能力和 Worker 测试。
3. 新增 Session Clear Coordinator 及单元测试。
4. 将 Chat clear 链路异步化并接入 coordinator。
5. 将 Talk close 链路异步化并接入 coordinator。
6. 将 Memorize clear 链路异步化并接入 coordinator。
7. 增加后台只读列表和 API 测试。
8. 增加 Prompt 变量、时间窗口和 XML 测试。
9. 更新项目结构文档，执行完整类型检查、测试和构建。
