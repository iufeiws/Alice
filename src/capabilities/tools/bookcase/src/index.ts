import type { OutputRouter } from "../../../../platform/output-router/src/index.js";
import type { AliceStore } from "../../../../contexts/conversation-hub/src/ports/conversation-store.js";
import type { AgentOutput, ToolCall, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { ToolOutputTargetResolver } from "../../../../contexts/capabilities/src/tool-output-target.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import { renderLLMText } from "../../../../contexts/agent-profile/src/ports/prompt-rendering.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import * as sqlite from "../../../../platform/storage/src/sqlite-compat.js";
import { bookcaseInstructionBlockLines, bookcaseTool, bookcaseToolText } from "../profile.js";

const path = await import("node:path");

type DatabaseSync = any;

export type BookcaseToolTarget = {
  plugin: string;
  accountId?: string;
  channelId?: string;
  userId?: string;
  sessionId: string;
};

export type BookcaseToolsDeps = {
  dbPath?: string;
  getUserName?: () => string;
  time?: CurrentTimeProvider;
  store?: Pick<AliceStore, "insertOutboundMessage" | "markOutboundMessageSent" | "markOutboundMessageFailed">;
  outputRouter?: Pick<OutputRouter, "send">;
  getDefaultTarget?(): BookcaseToolTarget | undefined;
  resolveOutputTarget?: ToolOutputTargetResolver;
  appendMessageLog?(input: {
    direction: "outbound";
    plugin: string;
    kind: string;
    target?: string;
    sessionId?: string;
    status?: string;
    summary: string;
    error?: string;
  }): unknown;
};

type SelectedBook = {
  source: {
    title: string;
    author: string;
    publication_date: string;
    corpus: "CMU Book Summary Corpus";
    origin: "Wikipedia plot summary";
    license: "Creative Commons Attribution-ShareAlike";
  };
  genres: string[];
  summary_chars: number;
  summary: string;
};

const defaultDbPath = path.resolve("assets/tools/bookcase/booksummaries.sqlite");

export function createBookcaseTools(deps: BookcaseToolsDeps = {}): ToolPlugin {
  const dbPath = deps.dbPath ?? defaultDbPath;
  const getUserName = deps.getUserName ?? (() => "user");

  return {
    id: "bookcase",
    listTools() {
      return [bookcaseTool];
    },
    async execute(call) {
      if (call.toolName === bookcaseTool.name) return bookcase(call);
      return { callId: call.id, ok: false, error: bookcaseToolText.unknownTool(call.toolName) };
    }
  };

  async function bookcase(call: ToolCall): Promise<ToolResult> {
    const action = stringValue(call.input.action) || "draw";
    if (action === "draw") return drawBookcaseBook(call);
    if (action === "return") return returnBookcaseBook(call);
    return toolError(call, bookcaseToolText.unsupportedAction);
  }

  async function drawBookcaseBook(call: ToolCall): Promise<ToolResult> {
    let db: DatabaseSync | undefined;
    try {
      db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      const ids = candidateIds(db, call.input);
      if (ids.length === 0) return toolError(call, bookcaseToolText.noMatchingSummaries);

      const selectedId = chooseId(ids, call.input);
      const book = fetchBook(db, selectedId);
      const output = formatBookAsXml(book, getUserName(), localTimeText());
      const result: ToolResult = {
        callId: call.id,
        ok: true,
        resetLLMSession: true,
        fixedPrefixKind: "bookcase",
        fixedPrefixTtlMs: 2 * 60 * 60 * 1000,
        output
      };
      await sendBookcaseNotice(call, bookcaseToolText.drawNotice);
      return result;
    } catch (error) {
      return toolError(call, error instanceof Error ? error.message : String(error));
    } finally {
      db?.close();
    }
  }

  async function returnBookcaseBook(call: ToolCall): Promise<ToolResult> {
    const result: ToolResult = {
      callId: call.id,
      ok: true,
      resetLLMSession: true,
      clearFixedPrefix: true,
      output: formatReturnAsXml(bookcaseToolText.returnMessage)
    };
    await sendBookcaseNotice(call, bookcaseToolText.returnNotice);
    return result;
  }

  function localTimeText(): string {
    if (deps.time) return deps.time.now().iso.slice(0, 19).replace("T", " ");
    const now = new Date();
    const parts = new Intl.DateTimeFormat("sv-SE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
  }

  async function sendBookcaseNotice(call: ToolCall, text: string): Promise<void> {
    const target = resolveTarget(call);
    if (!target || !deps.outputRouter) return;
    const output: AgentOutput = {
      id: createId("tool_out"),
      target: {
        plugin: target.plugin,
        accountId: target.accountId,
        channelId: target.channelId,
        userId: target.userId,
        sessionId: target.sessionId
      },
      content: { kind: "text", text },
      meta: {
        createdAt: localIso(),
        createdAtUtc: utcIso(),
        urgency: "normal",
        allowStreaming: false
      }
    };
    try {
      await deps.outputRouter.send(output);
      deps.appendMessageLog?.({
        direction: "outbound",
        plugin: output.target.plugin,
        kind: output.content.kind,
        target: output.target.channelId ?? output.target.userId,
        sessionId: output.target.sessionId,
        status: "sent",
        summary: text
      });
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      deps.appendMessageLog?.({
        direction: "outbound",
        plugin: output.target.plugin,
        kind: output.content.kind,
        target: output.target.channelId ?? output.target.userId,
        sessionId: output.target.sessionId,
        status: "send_failed",
        summary: text,
        error: reason
      });
      return;
    }
  }

  function resolveTarget(call: ToolCall): BookcaseToolTarget | undefined {
    const resolved = deps.resolveOutputTarget?.(call);
    if (resolved) return resolved;
    if (call.requester?.plugin && call.externalSession?.sessionId) {
      return {
        plugin: call.requester.plugin,
        accountId: call.requester.accountId,
        channelId: call.requester.channelId,
        userId: call.requester.userId,
        sessionId: call.externalSession.sessionId
      };
    }
    return deps.getDefaultTarget?.();
  }

  function localIso(): string {
    return deps.time?.now().iso ?? new Date().toISOString();
  }

  function utcIso(): string {
    return deps.time?.now().date.toISOString() ?? new Date().toISOString();
  }
}

function candidateIds(db: DatabaseSync, input: Record<string, unknown>): number[] {
  const where = ["b.summary_chars >= ?"];
  const params: unknown[] = [numberValue(input.minSummaryChars, 1200)];

  const title = stringValue(input.title);
  if (title) {
    where.push("b.title LIKE ? COLLATE NOCASE");
    params.push(`%${title}%`);
  }

  const author = stringValue(input.author);
  if (author) {
    where.push("b.author LIKE ? COLLATE NOCASE");
    params.push(`%${author}%`);
  }

  const genre = stringValue(input.genre);
  if (genre) {
    where.push(`
      EXISTS (
        SELECT 1 FROM book_genres bg
        WHERE bg.book_id = b.id AND bg.genre LIKE ? COLLATE NOCASE
      )
    `);
    params.push(`%${genre}%`);
  }

  const sql = `SELECT b.id AS id FROM books b WHERE ${where.join(" AND ")} ORDER BY b.id`;
  return db.prepare(sql).all(...params).map((row: { id: number }) => row.id);
}

function chooseId(ids: number[], input: Record<string, unknown>): number {
  const seed = optionalNumber(input.seed);
  if (seed === undefined && (stringValue(input.title) || stringValue(input.author) || stringValue(input.genre))) {
    return ids[0];
  }
  const index = Math.floor(randomFromSeed(seed ?? Date.now()) * ids.length);
  return ids[Math.max(0, Math.min(ids.length - 1, index))];
}

function fetchBook(db: DatabaseSync, id: number): SelectedBook {
  const row = db.prepare("SELECT * FROM books WHERE id = ?").get(id);
  if (!row) throw new Error(bookcaseToolText.bookIdNotFound(id));
  const genres = db.prepare("SELECT genre FROM book_genres WHERE book_id = ? ORDER BY rowid")
    .all(id)
    .map((genreRow: { genre: string }) => genreRow.genre);
  const source = {
    title: stringValue(row.title),
    author: stringValue(row.author) || "unknown author",
    publication_date: stringValue(row.publication_date) || "unknown date",
    corpus: "CMU Book Summary Corpus" as const,
    origin: "Wikipedia plot summary" as const,
    license: "Creative Commons Attribution-ShareAlike" as const
  };
  return {
    source,
    genres,
    summary_chars: numberValue(row.summary_chars, stringValue(row.summary).length),
    summary: stringValue(row.summary)
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatBookAsXml(book: SelectedBook, userName: string, timeText: string): string {
  const template = [
    "<book>",
    "  <source>",
    `    <title>${escapeXml(book.source.title)}</title>`,
    `    <author>${escapeXml(book.source.author)}</author>`,
    `    <publication_date>${escapeXml(book.source.publication_date)}</publication_date>`,
    "  </source>",
    "  <genres>",
    ...book.genres.map((genre) => `    - ${escapeXml(genre)}`),
    "  </genres>",
    "  <summary>",
    escapeXml(book.summary),
    "  </summary>",
    ...bookcaseInstructionBlockLines,
    "</book>",
    `<time>${escapeXml(timeText)}<\\time>`
  ].join("\n");
  return renderLLMText(template, { user: escapeXml(userName.trim() || "user") });
}

function staticMessagesForCall(call: ToolCall, output: string): NonNullable<ToolResult["llmSessionStaticMessages"]> {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: call.id,
        type: "function",
        function: {
          name: call.toolName,
          arguments: JSON.stringify(call.input)
        }
      }]
    },
    {
      role: "tool",
      name: call.toolName,
      toolCallId: call.id,
      content: output
    }
  ];
}

function formatReturnAsXml(message: string): string {
  return [
    '<bookcase action="return" clear_fixed_prefix="true">',
    `  <message>${escapeXml(message)}</message>`,
    "</bookcase>"
  ].join("\n");
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&apos;"
  }[char] ?? char));
}

function randomFromSeed(seed: number): number {
  let state = Math.trunc(seed) || 1;
  state = (state ^ 0x6d2b79f5) >>> 0;
  state = Math.imul(state ^ (state >>> 15), 1 | state);
  state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
  return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
}

function toolError(call: ToolCall, error: string): ToolResult {
  return { callId: call.id, ok: false, error };
}
