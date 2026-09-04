// SubAgent 消息投影的唯一入口。
//
// status.messages / wait 共用这里的过滤与访问语义：
//   1. 先过滤出可见 user/assistant 消息；
//   2. 再对过滤结果执行 access 索引或切片。
//
// Pi 原生 entry/message 结构知识集中在此处，worker 路由、宿主 client 与
// SubAgent profile 不复制任何 Pi 消息结构判断。

/**
 * assistant 消息只在剥离 thinking 后仍携带非空自然语言文本时可见：
 * - 过滤前先剥离 content 中的 thinking block（思考不返回宿主, 也不影响可见性）；
 * - 带 tool call（content 中的 toolCall block 或 message.toolCalls）不可见；
 * - progress / tool result 等非文本 block 使消息不可见；
 * - 剥离后没有任何文本内容（空数组、空字符串）的占位消息不可见。
 */
function stripThinkingBlocks(content) {
  if (!Array.isArray(content)) return content;
  return content.filter((part) => !(part && typeof part === "object" && part.type === "thinking"));
}

export function isVisibleMessage(message) {
  if (message?.role !== "user" && message?.role !== "assistant") return false;
  if (message.role === "user") return true;
  if (Array.isArray(message.toolCalls) && message.toolCalls.length) return false;
  const content = stripThinkingBlocks(message.content);
  const parts = typeof content === "string"
    ? (content ? [{ type: "text", text: content }] : [])
    : Array.isArray(content) ? content : [];
  if (parts.some((part) => !part || typeof part !== "object" || part.type !== "text")) return false;
  const text = parts.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
  return text.trim().length > 0;
}

/** 把 Pi session entries 投影为公开可见消息数组（不执行 access）。 */
export function projectVisibleMessages(entries) {
  return entries
    .filter((entry) => entry?.type === "message" && isVisibleMessage(entry.message))
    .map((entry) => ({ role: entry.message.role, content: stripThinkingBlocks(entry.message.content) }));
}

/**
 * 保留 Pi JSONL 中的 message 结构，不做可见性、thinking 或 tool 过滤。
 * 二进制 content part 只保留元数据，不向宿主返回 data/base64 或 data URL。
 */
export function projectRawMessages(entries) {
  return entries
    .filter((entry) => entry?.type === "message")
    .map((entry) => stripBinaryPayloads(entry.message));
}

function stripBinaryPayloads(value) {
  if (Array.isArray(value)) return value.map(stripBinaryPayloads);
  if (!value || typeof value !== "object") return value;
  const binaryPart = value.type === "image" || value.type === "audio";
  const projected = {};
  for (const [key, child] of Object.entries(value)) {
    if (binaryPart && (key === "data" || key === "base64")) continue;
    if (key === "url" && typeof child === "string" && child.startsWith("data:")) continue;
    projected[key] = stripBinaryPayloads(child);
  }
  return projected;
}

/** entryId 之后（含）的最后一条可见 assistant 消息；无则 undefined。 */
export function projectLatestAssistantMessageAfter(entries, entryId) {
  const index = entries.findIndex((entry) => entry.id === entryId);
  if (index < 0) return undefined;
  return entries.slice(index)
    .filter((entry) => entry?.type === "message" && isVisibleMessage(entry.message) && entry.message.role === "assistant")
    .map((entry) => ({ role: "assistant", content: stripThinkingBlocks(entry.message.content) }))
    .at(-1);
}

/**
 * entryId 之后最后一轮 assistant 的终态。
 *
 * Pi 会把失败的请求也写进 session message。重试成功时，较早的 error
 * 不是 invocation 的终态，所以必须从 invocation 尾部向前找第一个终态。
 */
export function projectLatestAssistantOutcomeAfter(entries, entryId) {
  const index = entries.findIndex((entry) => entry.id === entryId);
  if (index < 0) return undefined;
  const nextInvocationIndex = entries.findIndex((entry, candidateIndex) => candidateIndex > index && entry?.type === "custom" && entry.customType === "alice_pi_invocation");
  const end = nextInvocationIndex < 0 ? entries.length : nextInvocationIndex;
  for (let candidateIndex = end - 1; candidateIndex > index; candidateIndex -= 1) {
    const message = entries[candidateIndex]?.message;
    if (entries[candidateIndex]?.type !== "message" || message?.role !== "assistant") continue;
    if (message.stopReason === "error") {
      return {
        status: "failed",
        text: typeof message.errorMessage === "string" && message.errorMessage
          ? message.errorMessage
          : "pi_session_failed"
      };
    }
    if (isVisibleMessage(message)) return { status: "completed", text: assistantMessageText(message) };
  }
  return undefined;
}

function assistantMessageText(message) {
  const content = stripThinkingBlocks(message.content);
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content.filter((part) => part?.type === "text").map((part) => part.text).join("")
    : "";
}

/**
 * 对消息数组执行 access：
 * - 单个整数：Python 数组索引语义，负数从末尾数，越界抛错；
 * - start:end：Python 切片语义，开放区间允许，越界自动截断。
 */
export function accessMessages(messages, access) {
  const parsed = parseMessageAccess(access);
  if (parsed.kind === "index") {
    const index = parsed.index < 0 ? messages.length + parsed.index : parsed.index;
    if (index < 0 || index >= messages.length) throw new Error("subagent_message_access_out_of_range");
    return [messages[index]];
  }
  return messages.slice(parsed.start, parsed.end);
}

/** 严格解析 access：单个整数或 start:end；其余一律非法。 */
export function parseMessageAccess(access) {
  if (typeof access !== "string") throw new Error("invalid_subagent_message_access");
  if (/^-?\d+$/.test(access)) return { kind: "index", index: Number(access) };
  const match = /^(-?\d*)?:(-?\d*)?$/.exec(access);
  if (!match) throw new Error("invalid_subagent_message_access");
  return {
    kind: "slice",
    start: match[1] === "" || match[1] === undefined ? undefined : Number(match[1]),
    end: match[2] === "" || match[2] === undefined ? undefined : Number(match[2])
  };
}
