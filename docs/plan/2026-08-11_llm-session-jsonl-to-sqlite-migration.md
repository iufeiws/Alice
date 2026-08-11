# LLM 会话 JSONL 迁移至 SQLite 方案

## 1. 目标与边界

本方案只规定一次性迁移和切换，不实现运行时代码。运行时结构见 [LLM 会话 SQLite 业务方案](./2026-08-11_llm-session-sqlite-business-design.md)。

目标文件：

- `memory-files/llm-sessions.sqlite`：保存 `chat`、`talk`、`memorize`。
- `memory-files/llm-subagent-sessions.sqlite`：独立保存所有 SubAgent 会话。
- `memory-files/llm-sessions/current.json`：继续作为 chat/talk current 指针。

主库与 SubAgent 库使用相同表结构，但迁移、事务、校验和结果完全独立。SubAgent 源数据或目标库损坏不得影响主库迁移。

迁移工具不得 grep 会话内容。它只枚举目标目录并逐文件、逐行读取，不一次性载入上千个 JSONL。

## 2. 目标表

### 2.1 `llm_session_meta` 总表

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

字段映射：

| 列 | 来源 | 规则 |
|---|---|---|
| `session_id` | `meta.sessionId` | 转为字符串；在对应数据库内必须唯一 |
| `agent_type` | `meta.agent` | 原样保存，用于选择 Agent messages 分表 |
| `started_at` | `meta.startedAt` | 原样保存，必须存在 |
| `started_at_utc` | `meta.startedAtUtc` | UTC ISO 时间，必须存在；与 Alice 消息表的本地时间/UTC 双列约定一致 |
| `message_count` | 实际 message 行数 | 不信任旧 meta 中可能过期的计数 |
| `meta_json` | JSONL 首行 | 迁移时保存除换行符外的原始 JSON 文本 |

`meta_json` 是完整 meta 的唯一业务来源。读取完整会话时直接 `JSON.parse(meta_json)` 并返回，不从普通列重建、覆盖或补齐 meta。普通列只服务唯一定位、列表排序和无需解析 JSON 的基础查询。

总表明确不包含：

- `record_type`
- 内部自增 ID
- `runtime_session_id`
- current 标志
- revision/并发版本
- 任何只属于当前 meta 实现的业务字段
- legacy path 或其他迁移审计字段

上述可变内容如需保存，全部留在 `meta_json`；迁移路径只进入一次性迁移报告，不永久进入数据库。

### 2.2 Agent messages 分表

每个 `agent_type` 一张物理分表，所有分表只有三列：

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

| 列 | 来源 | 规则 |
|---|---|---|
| `session_id` | 对应 meta 的唯一 ID | 与总表建立外键 |
| `ordinal` | JSONL message 顺序 | 从 0 连续递增 |
| `message_json` | JSONL message 行 | 保存除换行符外的原始 JSON 文本 |

表名由 `agent_type` 可逆编码生成：固定前缀 `llm_messages_`；小写 ASCII 字母和数字原样保留，其他 UTF-8 字节编码为 `_xHH`。原始 Agent 名绝不直接拼入 SQL。

示例：

- `chat` → `llm_messages_chat`
- `talk` → `llm_messages_talk`
- `memorize` → `llm_messages_memorize`
- `Research_Agent` → `llm_messages__x52esearch_x5f_x41gent`

## 3. session_id 迁移规则

- 主库 JSONL 必须含 `meta.sessionId`；缺失则该会话损坏并整体跳过。
- 数字或字符串 `sessionId` 统一转为 SQLite TEXT，但内容不改写。
- 同一数据库出现重复 `session_id` 时，首个成功导入的会话保留，后续冲突会话整体跳过并记录错误；绝不生成第二个内部 ID 规避冲突。
- 旧 SubAgent JSONL 当前没有稳定 `sessionId` 时，由迁移工具为该会话生成 UUID。UUID 只作为新会话 ID，不写回原 `meta_json`。
- 新运行时创建的所有会话必须在创建时生成唯一 `session_id`，不存在 runtime ID 与 storage ID 两套身份。

## 4. current 指针迁移

current 不进入表字段，继续由独立文件指向会话：

```json
{
  "sessionId": 1786420800000,
  "agentType": "chat"
}
```

- 文件路径仍为 `memory-files/llm-sessions/current.json`。
- 迁移期间在内存中维护“旧相对路径 → 新 session_id”映射，只用于转换旧 pointer，不写入数据库。
- 旧 pointer 目标成功导入且 Agent 为 chat/talk 时，写新 pointer。
- 目标缺失、损坏或 ID 冲突时，不猜测其他 current，并在迁移报告中记录。
- pointer 使用同目录临时文件加 rename 原子替换。

## 5. 迁移和切换流程

1. 停止 Alice 服务，确认没有进程继续写 JSONL。
2. 主库临时文件只读取主 Agent 目录，明确跳过 `sub_agent`。
3. SubAgent 临时库只读取 `sub_agent`，其失败不改变主库状态。
4. 每个 JSONL 使用独立事务：
   - 解析并验证首个非空 meta 行以及 `startedAt/startedAtUtc`；
   - 决定唯一 `session_id` 和 Agent 分表；
   - 逐行解析并写入 message；
   - 任一 message 损坏则回滚整个会话；
   - 最后写总表记录和实际 `message_count`。
5. 空白行沿用当前读取语义，忽略。
6. 旧 `meta.messageCount` 与实际行数不同时继续导入，保留原 meta JSON，并把差异写入报告 warning。
7. 两个临时库分别执行 `integrity_check`、`foreign_key_check`、总表/分表计数和 ordinal 连续性检查。
8. 主库验证成功即可切换，不等待 SubAgent 成功。
9. 将旧 `memory-files/llm-sessions` 改名为 `llm-sessions-jsonl-legacy-<时间戳>`。
10. 提升主库临时文件；SubAgent 临时库验证成功时独立提升。
11. 重建 `memory-files/llm-sessions` 目录并写入新 pointer。
12. 新运行时不读取 legacy JSONL，也不提供 fallback。

迁移脚本拒绝覆盖已存在的最终数据库、临时数据库或同名 legacy 目录。

## 6. 迁移报告

分别生成主库与 SubAgent 报告。报告可以记录源路径，但报告不是长期业务数据库的一部分。

```ts
type LLMSessionMigrationReport = {
  database: "main" | "subagent";
  discoveredSessions: number;
  importedSessions: number;
  skippedSessions: number;
  importedMessages: number;
  warnings: Array<{ path: string; code: string; detail: string }>;
  errors: Array<{ path: string; line?: number; code: string; detail: string }>;
  integrityCheck: "ok" | "failed";
  foreignKeyErrors: number;
  currentPointer: "migrated" | "absent" | "invalid";
};
```

## 7. 验收标准

- `discoveredSessions = importedSessions + skippedSessions`。
- 每个成功 JSONL 恰好对应一个唯一 `session_id` 和一条总表记录。
- 每个非空 message 行恰好对应一条分表记录。
- 每个会话的 ordinal 精确为 `[0, message_count)`，无缺口、无重复。
- `meta_json` 与原首行文本除换行外完全一致；`message_json` 与原 message 行文本除换行外完全一致。
- `JSON.parse` 后的 meta/messages 与迁移前 deep-equal。
- 数据库没有 record type、runtime ID、current、revision、meta 专用展开列或 legacy path 字段。
- 重复 `session_id` 不得被静默改名或导入两次。
- SubAgent 迁移全部失败时，主库仍可完成校验和切换。
- 新 pointer 只包含 `sessionId/agentType`，并能精确恢复目标会话。
- legacy 目录保留原文件，新运行时完全不访问。

## 8. 具体测试

`tests/scripts/migrate-llm-sessions-sqlite.test.ts`：

- `migrates one raw metadata row per valid jsonl`
- `migrates one raw message row per non-empty line`
- `preserves metadata and message json text`
- `uses sessionId as the only persistent session identity`
- `rejects duplicate main session ids`
- `generates a unique subagent session id when legacy metadata has none`
- `does not add the generated id to raw subagent metadata json`
- `rolls back the whole session when one message is malformed`
- `reports stale metadata messageCount without rewriting metadata json`
- `main migration never descends into sub_agent`
- `subagent migration failure does not invalidate the main database`
- `migrates current pointer through an in-memory path mapping`
- `does not persist legacy source paths`
- `refuses to overwrite an existing database`
- `keeps original files in the renamed legacy directory`
