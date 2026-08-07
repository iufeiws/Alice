import type { LLMChatInput, LLMChatResult, LLMMessage } from "../../../llm-gateway/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type LLMSessionJsonl = {
  metadata: Record<string, unknown>;
  messages: LLMChatInput["messages"];
};

export function createLLMSessionFilePath(root: string, time: string, options?: { namespace?: string; type?: string; name?: string }): string {
  const utc = normalizeUtcTime(time);
  const date = utc.slice(0, 10);
  const clock = utc.slice(11, 23).replace(/[:.]/g, "-") || "00-00-00-000";
  const dir = path.join(root, options?.type ?? options?.namespace ?? "chat", date);
  fs.mkdirSync(dir, { recursive: true });
  let filePath = path.join(dir, `${clock}.jsonl`);
  let suffix = 2;
  while (fs.existsSync(filePath)) {
    filePath = path.join(dir, `${clock}-${suffix}.jsonl`);
    suffix += 1;
  }
  return filePath;
}

export function relativeLLMSessionPath(root: string, filePath: string): string {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

export function absoluteLLMSessionPath(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("llm session pointer outside root");
  return resolved;
}

export function collectLLMSessionFiles(dir: string, files: string[], options?: { skipDirs?: string[] }): void {
  for (const entry of (fs.readdirSync as any)(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (options?.skipDirs?.includes(entry.name)) continue;
      collectLLMSessionFiles(fullPath, files, options);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
}

/** metadata 行最大字节数; 超过即视为异常文件, 放弃解析。 */
const MAX_METADATA_LINE_BYTES = 256 * 1024;

/**
 * 只读取 JSONL 首行(metadata), 不解析/克隆消息体(返回空 messages)。
 * 用于管理后台列表等仅需会话元数据的场景, 避免每次轮询全量读取全部会话文件。
 */
export function readLLMSessionJsonlMetadata(filePath: string): LLMSessionJsonl | undefined {
  const fd = fs.openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let offset = 0;
    let total = 0;
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (read <= 0) break;
      const newlineIndex = buffer.subarray(0, read).indexOf(0x0a);
      if (newlineIndex >= 0) {
        chunks.push(Buffer.from(buffer.subarray(0, newlineIndex)));
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, read)));
      offset += read;
      total += read;
      if (total > MAX_METADATA_LINE_BYTES) break;
    }
    const line = Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
    if (!line.trim()) return undefined;
    return { metadata: JSON.parse(line) as Record<string, unknown>, messages: [] };
  } finally {
    fs.closeSync(fd);
  }
}

export function readLLMSessionJsonl(filePath: string): LLMSessionJsonl | undefined {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return undefined;
  return {
    metadata: JSON.parse(lines[0]) as Record<string, unknown>,
    messages: cloneLLMMessages(lines.slice(1).map((line) => JSON.parse(line)) as LLMChatInput["messages"])
  };
}

export function writeLLMSessionJsonl(filePath: string, metadata: Record<string, unknown>, messages: LLMChatInput["messages"]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [
    JSON.stringify(metadata),
    ...messages.map((message) => JSON.stringify(message))
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

export function writeLLMSessionJsonlMetadata(filePath: string, metadata: Record<string, unknown>): void {
  if (!fs.existsSync(filePath)) {
    writeLLMSessionJsonl(filePath, metadata, []);
    return;
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const rest = lines.slice(1).filter((line) => line.length > 0);
  fs.writeFileSync(filePath, `${[JSON.stringify(metadata), ...rest].join("\n")}\n`);
}

export function appendLLMSessionJsonlMessages(filePath: string, messages: LLMChatInput["messages"]): void {
  if (messages.length === 0) return;
  fs.appendFileSync(filePath, messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
}

export function createLLMSessionTranscriptLogger(input: {
  root: string;
  time: string;
  timeUtc?: string;
  now?: () => { time: string; timeUtc?: string };
  namespace?: string;
  name?: string;
  metadata: (state: LLMSessionTranscriptLoggerState) => Record<string, unknown>;
}): { filePath: string; append(entry: unknown): void } {
  const filePath = createLLMSessionFilePath(input.root, input.timeUtc ?? input.time, { type: input.namespace, name: input.name });
  const state: LLMSessionTranscriptLoggerState = {
    filePath,
    messages: [],
    startedAt: input.time,
    startedAtUtc: input.timeUtc,
    updatedAt: input.time,
    updatedAtUtc: input.timeUtc,
    requestCount: 0,
    responseCount: 0
  };
  const write = () => writeLLMSessionJsonl(filePath, input.metadata(state), state.messages);
  write();
  return {
    filePath,
    append(entry) {
      const current = input.now?.() ?? { time: input.time, timeUtc: input.timeUtc };
      applyTranscriptLoggerEntry(state, entry, current.time, current.timeUtc);
      write();
    }
  };
}

function normalizeUtcTime(time: string): string {
  const date = new Date(time);
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return String(time);
}

export type LLMSessionTranscriptLoggerState = {
  filePath: string;
  messages: LLMChatInput["messages"];
  startedAt: string;
  startedAtUtc?: string;
  updatedAt: string;
  updatedAtUtc?: string;
  requestCount: number;
  responseCount: number;
  currentRound?: Record<string, unknown>;
  latestRequest?: Record<string, unknown>;
  latestResponse?: Record<string, unknown>;
};

export function cloneLLMMessages(messages: LLMChatInput["messages"]): LLMChatInput["messages"] {
  return messages.map(cloneLLMMessage);
}

export function cloneLLMMessage(message: LLMMessage): LLMMessage {
  return {
    ...message,
    toolCalls: message.toolCalls?.map((call) => ({ ...call, function: { ...call.function } }))
  };
}

function applyTranscriptLoggerEntry(state: LLMSessionTranscriptLoggerState, entry: unknown, fallbackTime: string, fallbackTimeUtc?: string): void {
  if (!entry || typeof entry !== "object") return;
  const raw = entry as Record<string, unknown>;
  const round = typeof raw.round === "number" ? raw.round : Math.max(0, state.requestCount - 1);
  if (raw.type === "request" && raw.request && typeof raw.request === "object") {
    const request = raw.request as LLMChatInput;
    state.messages = cloneLLMMessages(request.messages ?? []);
    state.requestCount = Math.max(state.requestCount, round + 1);
    state.updatedAt = fallbackTime;
    state.updatedAtUtc = fallbackTimeUtc;
    state.currentRound = {
      status: "running",
      round,
      startedAt: fallbackTime,
      startedAtUtc: fallbackTimeUtc,
      model: request.model,
      temperature: request.temperature,
      tools: request.tools,
      extraParams: request.extraParams
    };
    state.latestRequest = {
      time: fallbackTime,
      timeUtc: fallbackTimeUtc,
      round,
      model: request.model,
      temperature: request.temperature,
      tools: request.tools,
      extraParams: request.extraParams,
      messageCount: state.messages.length
    };
  } else if (raw.type === "response" && raw.response && typeof raw.response === "object") {
    const response = raw.response as LLMChatResult;
    state.responseCount = Math.max(state.responseCount, round + 1);
    state.updatedAt = fallbackTime;
    state.updatedAtUtc = fallbackTimeUtc;
    state.messages.push(cloneLLMMessage(response.message));
    state.currentRound = {
      ...(state.currentRound ?? { round, startedAt: fallbackTime }),
      status: "finished",
      round,
      finishedAt: fallbackTime,
      finishedAtUtc: fallbackTimeUtc
    };
    state.latestResponse = {
      time: fallbackTime,
      timeUtc: fallbackTimeUtc,
      round,
      finishReason: response.finishReason,
      usage: response.usage,
      toolCallCount: response.message.toolCalls?.length ?? 0
    };
  } else if (raw.type === "final_messages" && Array.isArray(raw.messages)) {
    state.messages = cloneLLMMessages(raw.messages as LLMChatInput["messages"]);
    state.updatedAt = fallbackTime;
    state.updatedAtUtc = fallbackTimeUtc;
  }
}
