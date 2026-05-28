import type { ToolCall, ToolDefinition, ToolPlugin, ToolResult } from "../../../packages/types/src/index.js";

const sqlite = await import("node:sqlite");
const path = await import("node:path");

type DatabaseSync = any;

export type BookcaseToolsDeps = {
  dbPath?: string;
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
  instructions: string[];
  name_bank: {
    people: string[];
    nonhuman: string[];
    places: string[];
  };
  source_line: string;
};

const defaultDbPath = path.resolve("plugins/bookcase/assets/booksummaries.sqlite");

const bookcaseTool: ToolDefinition = {
  name: "bookcase",
  description: [
    "书橱工具：管理本地书籍剧情母版。",
    "action=draw 从书橱抽取一本书作为讲故事母版，返回剧情母版、改写规则、可用替换名和必须保留的来源行。",
    "action=return 归还当前书籍并重开 LLM 会话，用于故事写完后释放书本内容占用的上下文。"
  ].join(""),
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["draw", "return"], default: "draw", description: "draw 抽取一本书；return 归还书本并请求重开会话。" },
      title: { type: "string", description: "可选，按书名模糊匹配。" },
      author: { type: "string", description: "可选，按作者模糊匹配。" },
      genre: { type: "string", description: "可选，按类型模糊匹配，如 Fantasy、Satire、Crime Fiction。" },
      minSummaryChars: { type: "number", default: 1200, description: "母版剧情简介的最小字符数。" },
      seed: { type: "number", description: "可选，提供后随机抽取可复现。" }
    },
    required: ["action"],
    additionalProperties: false
  }
};

export function createBookcaseTools(deps: BookcaseToolsDeps = {}): ToolPlugin {
  const dbPath = deps.dbPath ?? defaultDbPath;

  return {
    id: "bookcase",
    listTools() {
      return [bookcaseTool];
    },
    async execute(call) {
      if (call.toolName === "bookcase") return bookcase(call);
      return { callId: call.id, ok: false, error: `Unknown bookcase tool: ${call.toolName}` };
    }
  };

  async function bookcase(call: ToolCall): Promise<ToolResult> {
    const action = stringValue(call.input.action) || "draw";
    if (action === "draw") return drawBookcaseBook(call);
    if (action === "return") return returnBookcaseBook(call);
    return toolError(call, "unsupported action");
  }

  async function drawBookcaseBook(call: ToolCall): Promise<ToolResult> {
    let db: DatabaseSync | undefined;
    try {
      db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      const ids = candidateIds(db, call.input);
      if (ids.length === 0) return toolError(call, "no matching book summaries found");

      const selectedId = chooseId(ids, call.input);
      const book = fetchBook(db, selectedId);
      return {
        callId: call.id,
        ok: true,
        output: book
      };
    } catch (error) {
      return toolError(call, error instanceof Error ? error.message : String(error));
    } finally {
      db?.close();
    }
  }

  async function returnBookcaseBook(call: ToolCall): Promise<ToolResult> {
    return {
      callId: call.id,
      ok: true,
      invalidateLLMSession: true,
      output: {
        action: "return",
        message: "书已归还书橱；当前 LLM 会话将重开，以释放书本母版占用的上下文。"
      }
    };
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
  if (!row) throw new Error(`book id not found: ${id}`);
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
  const sourceLine = `来源：改写自《${source.title}》（${source.author}，${source.publication_date}），CMU Book Summary Corpus / Wikipedia plot summary，CC BY-SA。`;

  return {
    source,
    genres,
    summary_chars: numberValue(row.summary_chars, stringValue(row.summary).length),
    summary: stringValue(row.summary),
    instructions: [
      "全程第一人称叙述；从母版中选择一个核心角色作为“我”，没有明确主角时使用亲历者口吻。",
      "将主要人名和地名替换成童话风名字，并保持一致；不要输出替换表。",
      "写成完整故事，不要写成摘要；保留关键冲突、转折和结局，但不要照抄母版措辞。",
      "语言跟随用户；未指定时使用用户的语言。",
      "最后一行必须原样输出 source_line。",
      "故事完成且不再需要母版后，可调用 bookcase action=return 归还书本，释放上下文。"
    ],
    name_bank: {
      people: ["Liora", "Cedric", "Mira", "Rowan", "Elowen", "Bram", "Seraphina", "Pip", "Tilda", "Florian", "Ysabel", "Alaric", "Nella", "Corwin", "Briar", "Maribel"],
      nonhuman: ["Thistle", "Brindle", "Mosscap", "Silverpaw", "Candlewick", "Honeythorn", "Bracken", "Moonwhisker"],
      places: ["Moonlit Hollow", "Briarbridge", "Starfall Farm", "Thornwick", "Glasshill", "Emberfen", "Willowmere", "Kingfisher Gate"]
    },
    source_line: sourceLine
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
