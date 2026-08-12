# LLM 会话 SQLite 业务方案

## 1. 目标

SQLite 是 LLM 会话唯一运行时存储。方案重点是稳定的存储 interface、单一内存所有者、读写时序、内存分叉处理、current 指针和 SubAgent 故障隔离，而不是把当前可变的 meta 结构固化成大量数据库列。

本文只描述方案，不实现代码，也不修改任何 Prompt 或 LLM 请求内容。

## 2. 文件布局

```text
memory-files/
├── llm-sessions.sqlite
├── llm-subagent-sessions.sqlite
└── llm-sessions/
    └── current.json
```

- 主库保存 chat、talk、memorize。
- SubAgent 使用相同 schema 的独立库。
- chat/talk 共用 `current.json`；memorize 和 SubAgent 不使用 pointer。
- 表内没有 current 字段，数据库内的任何状态都不能替代 pointer。

## 3. 稳定 schema

### 3.1 总表 `llm_session_meta`

```sql
CREATE TABLE llm_session_meta (
  session_id TEXT PRIMARY KEY,
  agent_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  started_at_utc TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
    CHECK (message_count >= 0),
  meta_json TEXT NOT NULL
    CHECK (json_valid(meta_json))
);

CREATE INDEX llm_session_meta_agent_started_idx
  ON llm_session_meta(agent_type, started_at DESC, session_id DESC);
```

总表只有六列：

| 列 | 稳定职责 |
|---|---|
| `session_id` | 会话唯一 ID，同时是业务 ID、存储 ID、pointer 目标 |
| `agent_type` | 选择 Agent messages 分表及按 Agent 列表查询 |
| `started_at` | 配置时区下的本地 wall-clock ISO，供业务展示 |
| `started_at_utc` | 同一开始时刻的 UTC ISO，供精确排序和跨时区定位 |
| `message_count` | 列表展示及分表完整性校验 |
| `meta_json` | 完整、可变的会话 meta |

规则：

- `session_id` 在单个数据库内绝不允许重复，不存在另一套 runtime/storage ID。
- 完整读取会话时直接返回 `JSON.parse(meta_json)`；禁止从普通列重新拼出 meta。
- 更新 meta 时由会话业务模块提供完整新 meta；开始时间列创建后不再改变。消息追加只同步更新 `message_count` 列；`meta_json` 由 `updateMeta` 单独维护，`create`/`replace` 在单事务内写全。
- 未被提取的字段不丢弃、不标准化、不进入固定 schema。
- 六个固定列以外的内容全部属于可变 meta，按当时业务对象原样进入 `meta_json`。
- 存储模块不理解这些可变字段，也不为它们添加列或解析分支。
- 不保存永久迁移路径、旧文件名或迁移状态。

### 3.2 Agent messages 分表

```sql
CREATE TABLE "<agent_messages_table>" (
  session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  message_json TEXT NOT NULL CHECK (json_valid(message_json)),

  PRIMARY KEY (session_id, ordinal),

  FOREIGN KEY (session_id)
    REFERENCES llm_session_meta(session_id)
    ON DELETE CASCADE
);
```

分表只有三列：

| 列 | 稳定职责 |
|---|---|
| `session_id` | 关联总表唯一会话 |
| `ordinal` | 会话内零基消息顺序 |
| `message_json` | 完整 LLM message JSON |

message 不拆 role、content、tool calls 或附件字段。写入时保存完整 JSON，读取时完整解析返回。

表名由 `agent_type` 的可逆安全编码生成。主库至少有 chat/talk/memorize 三张分表；SubAgent 按实际 Agent 类型建表。

## 4. 为什么不需要并发协议

主 Agent 当前是单一非并发 worker，同一时刻只有一个 function-call run。正确设计不应再让 ChatAgent、observability 和存储 runtime 成为三个独立 transcript 写入者。

因此：

- schema 不包含 revision。
- 不设计 CAS、自动 merge 或并发重试。
- llm-session runtime 是主会话唯一内存所有者和唯一数据库写入口。
- observability 只产生 request/response 事件和日志，不直接读写会话表。
- Talk 或 Chat 的调用方只能向 llm-session runtime 提交明确的会话操作。
- 如果未来引入真正并发 worker，应另行设计，而不是提前污染当前 schema。

## 5. 内存所有权和分叉

### 5.1 权威内存会话

llm-session runtime 持有当前 `session_id`、完整 meta 和有序 messages。调用方不得持有可独立落库的第二份权威对象。

写操作采用”构造新值 → SQLite 同步事务 → 替换内存值”的顺序：

1. 从当前权威内存值构造下一状态，不原地修改权威对象。
2. 提交：消息追加/替换时在一个 SQLite 事务中写 messages 与公共查询列（message_count）；meta JSON 由同一提交点内的 `updateMeta` 事务写入（`create`/`replace` 在单事务内写全 messages、meta 与公共查询列）。append 与 updateMeta 是两个独立同步事务，不在同一次调用中合并执行。
3. 全部事务成功（或仅 updateMeta）后替换内存会话。
4. 任一事务失败则抛错，旧内存会话保持不变。

### 5.2 非预期内存分叉

普通 Chat 更新只允许：

- meta 改变但 messages 不变；
- 在当前 messages 尾部追加。

调用方提交的完整 transcript 若与 runtime 当前 messages 不满足上述关系，说明出现第二份内存历史或错误覆盖。此时：

- 抛出明确错误并中止当前 run；
- 不覆盖 SQLite；
- 不自动选择较长一方；
- 不自动创建新会话；
- 不用 common-prefix 猜测用户意图。

这不是并发冲突，而是违反单一内存所有权的程序错误。

### 5.3 合法替换和业务分叉

- Talk 从 talk runtime 重建 transcript 属于显式完整替换操作，调用方必须说明替换原因；存储模块不得把普通 append 自动解释为替换。
- 如果业务确实要保留两条历史，调用方显式创建新的唯一 `session_id`，将目标 messages 和完整 meta 作为新会话写入。
- 分叉来源是否写入 meta、字段叫什么，由当时业务 meta 决定，不固化成数据库列。

## 6. 存储 interface

存储模块只暴露稳定操作：

```ts
type StoredLLMSession = {
  sessionId: string;
  agentType: string;
  startedAt: string;
  startedAtUtc: string;
  meta: Record<string, unknown>;
  messages: LLMMessage[];
};

type LLMSessionStore = {
  create(session: StoredLLMSession): void;
  read(sessionId: string): StoredLLMSession | undefined;
  append(input: {
    sessionId: string;
    messages: LLMMessage[];
  }): void;
  updateMeta(input: {
    sessionId: string;
    meta: Record<string, unknown>;
  }): void;
  replace(input: {
    sessionId: string;
    messages: LLMMessage[];
    meta: Record<string, unknown>;
    reason: string;
  }): void;
  list(input: { agentType: string; limit: number }): LLMSessionListItem[];
};
```

- `append/updateMeta/replace` 都是同步事务。`append` 只追加消息并同步 `message_count` 列，不更新 `meta_json`；meta 更新必须显式调用 `updateMeta`（同一提交点内先后执行）。meta 内不包含 message 数量，数量只由总表 `message_count` 列表达。
- `read` 先查总表，再按 `agent_type` 定位唯一分表并按 ordinal 读取。
- `list` 只查总表，不读分表、不解析 `meta_json`。
- clear 是业务 meta 更新加 pointer 删除，不要求存储表理解 clear 字段。

## 7. current 指针

`memory-files/llm-sessions/current.json`：

```json
{
  "sessionId": 1786420800000,
  "agentType": "chat"
}
```

运行时 `sessionId` 为 UTC 毫秒时间戳数字（chat/talk/memorize 会话 id 同源）；存储列与指针文件的文本形态由存储层转换。

读取：

1. pointer 不存在则无 current，不扫描表推断。
2. 按 `sessionId` 直接读取总表。
3. 校验总表 `agent_type` 与 pointer 一致且属于 chat/talk。
4. 从 `meta_json` 读取业务状态；若业务判定已 cleared，则 pointer 陈旧，删除 pointer 并返回无 current。
5. 读取对应 Agent 分表。

写入：

- 创建 current：先提交 SQLite 新会话，再原子写 pointer。
- 普通更新不重写 pointer。
- clear：先提交完整新 meta，再删除 pointer。
- chat/talk 切换：先完成旧会话 meta 更新和新会话创建，再原子改写 pointer。
- SQLite 提交后、pointer 更新前崩溃时，不扫描数据库猜测新 current；旧 pointer 无效则返回无 current。

## 8. 主 Agent 读写流程

### 启动

- 只从 pointer 恢复 current。
- 一次读取 meta 和对应分表，建立 llm-session runtime 的权威内存会话。
- 运行期间不在每个 request/response 回调中重新从 SQLite 构造另一份会话。

### 每轮写入

1. Prompt/append layers 构建完成后，发送 LLM 请求前同步提交。
2. assistant 消息**格式化确定后**（如 contentToolCall 等转换完成）、执行 tool 前同步追加最终版本——递交必须发生在消息最终确定之后，递交内容与后续提交的 transcript 完全一致，避免同一消息存在两个版本。
3. 每个 tool result 写回同一 function-call loop 后同步追加。
4. follow-up messages、yield resume 或业务 meta 改变后同步提交。
5. 下一步只使用事务成功后替换的新内存会话。

每个恢复点提交的是当时完整 meta JSON；存储模块不关心 meta 内部字段。

## 9. Memorize 和 SubAgent

### Memorize

- 保存在主库 `llm_messages_memorize`。
- 每次 induction 创建独立唯一 `session_id`。
- 不写 current pointer。
- 使用同一 store interface，但拥有自己的内存会话生命周期。

### SubAgent

- 只访问 `llm-subagent-sessions.sqlite`。
- 不使用主库事务或 pointer。
- 存储打开、建表或写入失败时记录 error 和 degraded 状态，但当前 SubAgent LLM 调用继续。
- 主库和主 Agent 不受影响。
- 错误不得加入 Prompt、tool result 或 transcript，不创建 JSONL fallback。
- 后续调用可以重新尝试存储；失败期间缺失的 transcript 不补写。

## 10. 验收标准

### Schema 与 JSON

- 总表严格只有 `session_id/agent_type/started_at/started_at_utc/message_count/meta_json` 六列。
- 分表严格只有 `session_id/ordinal/message_json` 三列。
- 不存在 record type、runtime ID、revision、current、meta 专用展开列或迁移审计字段。
- 新建、更新、读取后 `meta` deep-equal；未知 meta 字段不丢失。
- 新建、追加、读取后每条 message deep-equal，顺序不变。

### 唯一身份与 pointer

- 重复 `session_id` 创建必定失败，原会话不变。
- pointer 只使用 `sessionId/agentType`，不存在内部 ID。
- 没有 pointer 时绝不从表推断 current。
- pointer 指向不存在或 Agent 不匹配的会话时明确失败，不 fallback。

### 内存和写入

- 所有 transcript 写入只经过 llm-session runtime。
- SQLite 写入失败时权威内存对象保持原值。
- 普通 append 遇到非追加 transcript 时明确失败且不覆盖数据库。
- Talk 显式 replace 可以原子替换 messages 和 meta。
- 每个恢复点后模拟进程终止，重启读取到最后一次成功提交。

### 查询与隔离

- 列表只访问总表，不解析 meta JSON、不读取 messages 分表。
- 详情只访问目标 Agent 的一个分表。
- SubAgent 数据库损坏时，主库仍可正常读写，SubAgent LLM 调用继续且错误可见。
- SubAgent 存储正常/失败时，实际发送给 LLM 的内容完全一致。

## 11. 具体测试

### `tests/contexts/llm-session/sqlite-llm-session-store.test.ts`

- `creates the exact six-column metadata table`
- `creates exact three-column agent message tables`
- `rejects duplicate session ids`
- `round trips mutable metadata without dropping unknown fields`
- `round trips complete message json in ordinal order`
- `stores matching local and utc session start times`
- `updates raw metadata without changing session start columns`
- `appends messages and message count atomically`
- `replaces messages and metadata atomically`
- `rolls back all database changes when a write fails`
- `lists sessions without reading metadata json or message tables`
- `loads only the selected agent message table`

### `tests/contexts/llm-session/llm-session-runtime-sqlite.test.ts`

- `loads current only from the external pointer`
- `does not infer current when the pointer is absent`
- `rejects a pointer with a mismatched agent type`
- `keeps in-memory session unchanged when sqlite commit fails`
- `uses one transcript writer for request response and tool updates`
- `commits request messages before dispatch`
- `commits assistant response before tool execution`
- `commits each tool result before the next request`
- `rejects a non-append chat transcript without overwriting storage`
- `allows talk transcript replacement only through explicit replace`
- `restores the last successful recovery point after restart`
- `deletes pointer only after clear metadata is committed`
- `rewrites pointer after chat talk switch`

### `tests/contexts/llm-session/subagent-session-storage.test.ts`

- `uses a database distinct from the main session database`
- `continues subagent llm call when its database open fails`
- `continues subagent llm call when its write fails`
- `keeps the main database writable after subagent corruption`
- `reports degraded storage without changing llm input`
- `does not create jsonl fallback files`

最终实施时必须通过定向测试、`npm run typecheck`、`npm run build` 和 `npm test`。
