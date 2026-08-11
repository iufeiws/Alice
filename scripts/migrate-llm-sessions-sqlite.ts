/**
 * LLM 会话 JSONL → SQLite 一次性迁移脚本。
 *
 * 主库(llm-sessions.sqlite)只读主 Agent 目录(chat/talk/memorize/core, 明确跳过 sub_agent);
 * SubAgent 库(llm-subagent-sessions.sqlite)只读 sub_agent 目录, 两者迁移、事务、校验完全独立。
 * 逐文件逐行读取, 不一次性载入大量 JSONL; 每个 JSONL 一个事务, 任一 message 损坏整体回滚。
 *
 * 切换: 主库验证成功即切换(旧目录改名为 llm-sessions-jsonl-legacy-<时间戳>,
 * 提升主库临时文件, 重建 llm-sessions 目录并写入新 pointer); SubAgent 验证成功独立提升。
 * 拒绝覆盖任何已存在的最终库/临时库/同名 legacy 目录。
 *
 * 报告独立两份(database 字段区分), 运行中任何 SubAgent 失败不抛出(记录进报告),
 * 主库关键失败才抛错。
 */

import { DatabaseSync } from "../src/platform/storage/src/sqlite-compat.js";
import { agentMessagesTableName } from "../src/contexts/llm-session/src/adapters/sqlite-llm-session-store.js";
import { writeLLMSessionPointer } from "../src/contexts/llm-session/src/adapters/llm-session-pointer.js";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const fs = await import("node:fs");
const path = await import("node:path");

export type LLMSessionMigrationReport = {
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

type MigrationReport = Omit<LLMSessionMigrationReport, "database" | "currentPointer">;

const META_TABLE_DDL = `
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
`;

const AGENT_MESSAGES_TABLE_DDL = (tableName: string) => `
  CREATE TABLE IF NOT EXISTS "${tableName}" (
    session_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    message_json TEXT NOT NULL CHECK (json_valid(message_json)),
    PRIMARY KEY (session_id, ordinal),
    FOREIGN KEY (session_id)
      REFERENCES llm_session_meta(session_id)
      ON DELETE CASCADE
  );
`;

export async function migrateLLMSessionsToSQLite(input: { memoryRoot: string }): Promise<{ main: LLMSessionMigrationReport; subagent: LLMSessionMigrationReport }> {
  const memoryRoot = input.memoryRoot;
  const sessionsDir = path.join(memoryRoot, "llm-sessions");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const mainDbPath = path.join(memoryRoot, "llm-sessions.sqlite");
  const subagentDbPath = path.join(memoryRoot, "llm-subagent-sessions.sqlite");
  const mainTempDbPath = path.join(memoryRoot, `llm-sessions.sqlite.tmp-${timestamp}`);
  const subagentTempDbPath = path.join(memoryRoot, `llm-subagent-sessions.sqlite.tmp-${timestamp}`);
  const legacyDirPath = path.join(memoryRoot, `llm-sessions-jsonl-legacy-${timestamp}`);

  assertNoOverwrite([mainDbPath, subagentDbPath, mainTempDbPath, subagentTempDbPath, legacyDirPath]);

  let mainReport: LLMSessionMigrationReport;
  let subagentReport: LLMSessionMigrationReport;
  let pendingPointer: { sessionId: number; agentType: string } | undefined;
  let legacyRenamed = false;
  let mainPromoted = false;
  try {
    const main = await buildTempDatabase({
      kind: "main",
      sourceRoot: sessionsDir,
      skipDir: "sub_agent",
      tempDbPath: mainTempDbPath
    });
    // SubAgent 迁移硬失败(临时库无法创建/打开等)只记录进 SubAgent 报告,
    // 不抛出、不影响主库迁移与切换(§5.7-5.8: 主库验证成功即可切换, 不等 SubAgent)。
    const subagent = await buildTempDatabase({
      kind: "subagent",
      sourceRoot: path.join(sessionsDir, "sub_agent"),
      tempDbPath: subagentTempDbPath
    }).catch((error: unknown) => ({
      report: {
        discoveredSessions: 0,
        importedSessions: 0,
        skippedSessions: 0,
        importedMessages: 0,
        warnings: [],
        errors: [{ path: "sub_agent", code: "SUBAGENT_DATABASE_FAILED", detail: error instanceof Error ? error.message : String(error) }],
        integrityCheck: "failed" as const,
        foreignKeyErrors: 0
      },
      tempDbPath: subagentTempDbPath,
      pathToSessionId: new Map<string, string>(),
      agentOfPath: new Map<string, string>()
    }));
    const mainFinalized = finalizeReport("main", main.report, main.pathToSessionId, main.agentOfPath, sessionsDir);
    mainReport = mainFinalized.report;
    pendingPointer = mainFinalized.pendingPointer;
    if (mainReport.integrityCheck !== "ok") {
      throw new Error(`main llm session database integrity check failed, migration aborted (see main report)`);
    }
    // 主库切换: 旧目录改名 → 提升主库临时文件 → 重建 llm-sessions 目录 → 写入新 pointer。
    if (fs.existsSync(sessionsDir)) {
      fs.renameSync(sessionsDir, legacyDirPath);
      legacyRenamed = true;
    }
    fs.renameSync(mainTempDbPath, mainDbPath);
    mainPromoted = true;
    fs.mkdirSync(sessionsDir, { recursive: true });
    if (pendingPointer) {
      try {
        writeLLMSessionPointer(sessionsDir, pendingPointer);
      } catch {
        mainReport = { ...mainReport, currentPointer: "invalid" };
      }
    }

    // SubAgent 独立提升: 验证成功才提升, 失败保留 legacy 目录中的源文件。
    subagentReport = finalizeReport("subagent", subagent.report, new Map(), new Map(), undefined).report;
    if (subagentReport.integrityCheck === "ok") {
      fs.renameSync(subagentTempDbPath, subagentDbPath);
    } else {
      fs.rmSync(subagentTempDbPath, { force: true });
    }
  } catch (error) {
    // 清理未提升的临时库, 避免阻塞后续重跑。
    for (const tempPath of [mainTempDbPath, subagentTempDbPath]) {
      fs.rmSync(tempPath, { force: true });
    }
    // 旧目录已改名但主库尚未提升时, 把 legacy 目录改回原位:
    // 否则重跑会以空源目录迁移出空主库, 使既有会话在主库中静默不可见。
    if (legacyRenamed && !mainPromoted) {
      try {
        fs.renameSync(legacyDirPath, sessionsDir);
      } catch {
        // 改回失败时保留原始错误, 源文件仍在 legacy 目录中, 需要人工恢复。
      }
    }
    throw error;
  }
  return { main: mainReport, subagent: subagentReport };
}

type BuildTempDatabaseInput = {
  kind: "main" | "subagent";
  sourceRoot: string;
  skipDir?: string;
  tempDbPath: string;
};

async function buildTempDatabase(input: BuildTempDatabaseInput): Promise<{
  report: MigrationReport;
  tempDbPath: string;
  pathToSessionId: Map<string, string>;
  agentOfPath: Map<string, string>;
}> {
  const report: MigrationReport = {
    discoveredSessions: 0,
    importedSessions: 0,
    skippedSessions: 0,
    importedMessages: 0,
    warnings: [],
    errors: [],
    integrityCheck: "ok",
    foreignKeyErrors: 0
  };
  const pathToSessionId = new Map<string, string>();
  const agentOfPath = new Map<string, string>();

  const db = new DatabaseSync(input.tempDbPath);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(META_TABLE_DDL);
  const insertMeta = db.prepare(`
    INSERT INTO llm_session_meta(session_id, agent_type, started_at, started_at_utc, message_count, meta_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const messageInsertCache = new Map<string, any>();
  const insertMessage = (agentType: string, sessionId: string, ordinal: number, raw: string): void => {
    const tableName = agentMessagesTableName(agentType);
    let statement = messageInsertCache.get(tableName);
    if (!statement) {
      db.exec(AGENT_MESSAGES_TABLE_DDL(tableName));
      statement = db.prepare(`INSERT INTO "${tableName}"(session_id, ordinal, message_json) VALUES (?, ?, ?)`);
      messageInsertCache.set(tableName, statement);
    }
    statement.run(sessionId, ordinal, raw);
  };

  const sessionIds = new Map<string, string>();
  const files = collectJsonlFiles(input.sourceRoot, input.skipDir);
  for (const filePath of files) {
    const relativePath = path.relative(input.sourceRoot, filePath).split(path.sep).join("/");
    report.discoveredSessions += 1;
    try {
      await importSessionFile(filePath, relativePath, input.kind, db, insertMeta, insertMessage, report, sessionIds, pathToSessionId, agentOfPath);
    } catch (error) {
      report.errors.push({ path: relativePath, code: "READ_FAILED", detail: error instanceof Error ? error.message : String(error) });
      report.skippedSessions += 1;
    }
  }

  verifyDatabase(db, report);
  db.close();
  return { report, tempDbPath: input.tempDbPath, pathToSessionId, agentOfPath };
}

async function importSessionFile(
  filePath: string,
  relativePath: string,
  kind: "main" | "subagent",
  db: DatabaseSync,
  insertMeta: any,
  insertMessage: (agentType: string, sessionId: string, ordinal: number, raw: string) => void,
  report: MigrationReport,
  sessionIds: Map<string, string>,
  pathToSessionId: Map<string, string>,
  agentOfPath: Map<string, string>
): Promise<void> {
  const recordSkip = (code: string, detail: string, line?: number): void => {
    report.errors.push({ path: relativePath, line, code, detail });
    report.skippedSessions += 1;
  };

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let phase: "meta" | "messages" = "meta";
  let lineIndex = 0;
  let ordinal = 0;
  let sawNonBlank = false;
  let session: { sessionId: string; agentType: string; startedAt: string; startedAtUtc: string; metaJson: string } | undefined;
  let inTransaction = false;
  let committed = false;
  try {
    for await (const line of rl) {
      lineIndex += 1;
      const raw = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!raw.trim()) continue;
      sawNonBlank = true;
      if (phase === "meta") {
        phase = "messages";
        const verdict = resolveSessionIdentity(raw, kind, relativePath);
        if (!verdict.ok) {
          recordSkip(verdict.code, verdict.detail, lineIndex);
          return;
        }
        if (sessionIds.has(verdict.session.sessionId)) {
          recordSkip("DUPLICATE_SESSION", `session id ${verdict.session.sessionId} already imported from ${sessionIds.get(verdict.session.sessionId)}`, lineIndex);
          return;
        }
        sessionIds.set(verdict.session.sessionId, relativePath);
        session = verdict.session;
        db.exec("BEGIN IMMEDIATE");
        inTransaction = true;
        continue;
      }
      // message 行: 任一损坏 → 回滚整个会话。
      try {
        JSON.parse(raw);
      } catch {
        if (inTransaction) {
          db.exec("ROLLBACK");
          inTransaction = false;
        }
        recordSkip("MALFORMED_LINE", "message line is not valid JSON", lineIndex);
        return;
      }
      insertMessage(session!.agentType, session!.sessionId, ordinal, raw);
      ordinal += 1;
    }
    if (!sawNonBlank) {
      recordSkip("EMPTY_SESSION", "file contains no metadata line");
      return;
    }
    // 最后写总表与 message_count(= 实际行数, 不信旧 meta.messageCount)。
    insertMeta.run(session!.sessionId, session!.agentType, session!.startedAt, session!.startedAtUtc, ordinal, session!.metaJson);
    db.exec("COMMIT");
    committed = true;
    report.importedSessions += 1;
    report.importedMessages += ordinal;
    const parsedMeta = JSON.parse(session!.metaJson) as Record<string, unknown>;
    if (typeof parsedMeta.messageCount === "number" && parsedMeta.messageCount !== ordinal) {
      report.warnings.push({
        path: relativePath,
        code: "STALE_MESSAGE_COUNT",
        detail: `meta.messageCount=${parsedMeta.messageCount} but actual message rows=${ordinal}`
      });
    }
    if (kind === "main") {
      pathToSessionId.set(relativePath, session!.sessionId);
      agentOfPath.set(relativePath, session!.agentType);
    }
  } finally {
    if (inTransaction && !committed) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 忽略回滚失败, 数据库由外层清理
      }
    }
    rl.close();
  }
}

type SessionVerdict =
  | { ok: true; session: { sessionId: string; agentType: string; startedAt: string; startedAtUtc: string; metaJson: string } }
  | { ok: false; code: string; detail: string };

function resolveSessionIdentity(raw: string, kind: "main" | "subagent", relativePath: string): SessionVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "MALFORMED_META", detail: "metadata line is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "MALFORMED_META", detail: "metadata line is not a JSON object" };
  }
  const meta = parsed as Record<string, unknown>;
  if (typeof meta.startedAt !== "string" || meta.startedAt.length === 0) {
    return { ok: false, code: "MISSING_STARTED_AT", detail: "meta.startedAt is required" };
  }
  if (typeof meta.startedAtUtc !== "string" || meta.startedAtUtc.length === 0) {
    return { ok: false, code: "MISSING_STARTED_AT_UTC", detail: "meta.startedAtUtc is required" };
  }
  // agent_type 来自 meta.agent; 缺失时(如 core 目录旧文件)回退到顶层目录名。
  const agentType = typeof meta.agent === "string" && meta.agent.length > 0
    ? meta.agent
    : relativePath.split("/")[0] ?? "";
  if (!agentType) {
    return { ok: false, code: "MISSING_AGENT", detail: "meta.agent is required and no directory fallback is available" };
  }
  let sessionId: string;
  if (kind === "main") {
    // 主库必须含 meta.sessionId(数字或字符串转 TEXT, 内容不改写)。
    if (typeof meta.sessionId !== "number" && typeof meta.sessionId !== "string") {
      return { ok: false, code: "MISSING_SESSION_ID", detail: "main meta.sessionId is required" };
    }
    sessionId = String(meta.sessionId);
  } else if (typeof meta.sessionId === "number" || typeof meta.sessionId === "string") {
    sessionId = String(meta.sessionId);
  } else {
    // SubAgent 旧数据没有稳定 sessionId 时生成 UUID; 只作新会话 ID, 不写回原 meta_json。
    sessionId = randomUUID();
  }
  return {
    ok: true,
    session: { sessionId, agentType, startedAt: meta.startedAt, startedAtUtc: meta.startedAtUtc, metaJson: raw }
  };
}

/** 校验: integrity_check / foreign_key_check / 总表分表计数 / 每会话 ordinal 连续 [0, message_count)。 */
function verifyDatabase(db: DatabaseSync, report: MigrationReport): void {
  const integrityRows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
  const integrityOk = integrityRows.length > 0 && integrityRows.every((row) => row.integrity_check === "ok");
  report.integrityCheck = integrityOk ? "ok" : "failed";

  const fkErrors = db.prepare("PRAGMA foreign_key_check").all() as unknown[];
  report.foreignKeyErrors = fkErrors.length;
  if (fkErrors.length > 0) report.integrityCheck = "failed";

  const metaCount = (db.prepare("SELECT COUNT(*) AS count FROM llm_session_meta").get() as { count: number }).count;
  if (metaCount !== report.importedSessions) report.integrityCheck = "failed";

  let messageTotal = 0;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'llm_messages_%'").all() as Array<{ name: string }>;
  for (const { name: tableName } of tables) {
    const countRow = db.prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`).get() as { count: number };
    messageTotal += countRow.count;
    // 每会话 ordinal 连续 [0, message_count), 无缺口无重复; 与总表 message_count 一致。
    const groups = db.prepare(`
      SELECT m.session_id AS sessionId, t.n AS n, t.minOrdinal AS minOrdinal, t.maxOrdinal AS maxOrdinal
      FROM llm_session_meta m
      LEFT JOIN (
        SELECT session_id, COUNT(*) AS n, MIN(ordinal) AS minOrdinal, MAX(ordinal) AS maxOrdinal
        FROM "${tableName}"
        GROUP BY session_id
      ) t ON t.session_id = m.session_id
    `).all() as Array<{ sessionId: string; n: number | null; minOrdinal: number | null; maxOrdinal: number | null }>;
    for (const group of groups) {
      if (group.n === null) continue; // 无消息的会话
      if (group.minOrdinal !== 0 || group.maxOrdinal !== group.n - 1) report.integrityCheck = "failed";
    }
  }
  if (messageTotal !== report.importedMessages) report.integrityCheck = "failed";
}

/** 指针迁移: 内存中"旧相对路径 → 新 session_id"映射只用于转换, 不落库。 */
function finalizeReport(
  database: "main" | "subagent",
  report: MigrationReport,
  pathToSessionId: Map<string, string>,
  agentOfPath: Map<string, string>,
  sessionsDir: string | undefined
): { report: LLMSessionMigrationReport; pendingPointer?: { sessionId: number; agentType: string } } {
  let currentPointer: LLMSessionMigrationReport["currentPointer"] = "absent";
  let pendingPointer: { sessionId: number; agentType: string } | undefined;
  if (database === "main" && sessionsDir) {
    const pointerPath = path.join(sessionsDir, "current.json");
    if (fs.existsSync(pointerPath)) {
      const resolved = resolveLegacyPointer(pointerPath, pathToSessionId, agentOfPath);
      currentPointer = resolved.status;
      if (resolved.status === "migrated" && resolved.target) {
        // 新 pointer 只在旧目录改名、新目录重建后写入, 这里先暂存目标。
        // 运行时 sessionId 为数字时间戳, 存储为 TEXT, 这里转回 number 写 pointer。
        const sessionId = Number(resolved.target.sessionId);
        if (Number.isFinite(sessionId)) {
          pendingPointer = { sessionId, agentType: resolved.target.agentType };
        } else {
          currentPointer = "invalid";
        }
      }
    }
  }
  return {
    report: {
      database,
      discoveredSessions: report.discoveredSessions,
      importedSessions: report.importedSessions,
      skippedSessions: report.skippedSessions,
      importedMessages: report.importedMessages,
      warnings: report.warnings,
      errors: report.errors,
      integrityCheck: report.integrityCheck,
      foreignKeyErrors: report.foreignKeyErrors,
      currentPointer
    },
    pendingPointer
  };
}

/** 旧 pointer {path, sessionId} → 新 pointer 目标; 目标缺失/损坏/ID 冲突或 agent 非 chat/talk 时 invalid。 */
function resolveLegacyPointer(
  pointerPath: string,
  pathToSessionId: Map<string, string>,
  agentOfPath: Map<string, string>
): { status: LLMSessionMigrationReport["currentPointer"]; target?: { sessionId: string; agentType: string } } {
  let pointer: unknown;
  try {
    pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
  } catch {
    return { status: "invalid" };
  }
  if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) return { status: "invalid" };
  const raw = pointer as Record<string, unknown>;
  if (typeof raw.path !== "string" || (typeof raw.sessionId !== "number" && typeof raw.sessionId !== "string")) return { status: "invalid" };
  const legacyPath = raw.path.replace(/\\/g, "/");
  const newSessionId = pathToSessionId.get(legacyPath);
  if (newSessionId === undefined) return { status: "invalid" };
  if (String(raw.sessionId) !== newSessionId) return { status: "invalid" };
  const agentType = agentOfPath.get(legacyPath);
  if (!agentType || (agentType !== "chat" && agentType !== "talk")) return { status: "invalid" };
  return { status: "migrated", target: { sessionId: newSessionId, agentType } };
}

function collectJsonlFiles(dir: string, skipDir: string | undefined): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skipDir && entry.name === skipDir) continue;
        walk(path.join(current, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path.join(current, entry.name));
      }
    }
  };
  walk(dir);
  return files.sort();
}

function assertNoOverwrite(paths: string[]): void {
  for (const target of paths) {
    if (fs.existsSync(target)) {
      throw new Error(`refuse to overwrite existing path: ${target} (remove it or migrate elsewhere)`);
    }
  }
}

// CLI 入口: 直接执行时跑主库+子库迁移并打印报告 JSON。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const memoryRoot = process.argv[2] ?? path.join(process.cwd(), "memory-files");
  migrateLLMSessionsToSQLite({ memoryRoot })
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
    })
    .catch((error) => {
      console.error(`llm session migration failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
