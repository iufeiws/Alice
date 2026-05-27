import type { LLMMessage } from "../../llm/src/index.js";
import type { CurrentTimeProvider } from "../../time/src/index.js";
import type { AgentEvent, ToolCall, ToolResult } from "../../../packages/types/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type PromptDefinition = {
  id: string;
  name: string;
  scope: "agent" | "router" | "tool" | "renderer";
  description: string;
  content: string;
};

export type PromptLayerRole = "system" | "user" | "assistant" | "tool_request";

export type PromptLayer = {
  id: string;
  title: string;
  role: PromptLayerRole;
  enabled: boolean;
  content: string;
  order: number;
  toolName?: string;
  toolCallId?: string;
  toolArguments?: string;
  thinking?: string;
};

export type PromptProfile = {
  userName: string;
  layers: PromptLayer[];
  visibleTools: {
    feishu: boolean;
  };
};

export type PromptRenderContext = {
  event: AgentEvent;
  time: CurrentTimeProvider;
  dailyShell?: string;
};

export type PromptProfileStore = {
  get(): PromptProfile;
  save(profile: PromptProfile): PromptProfile;
};

export const defaultPromptRegistry: PromptDefinition[] = [
  {
    id: "agent.profile.default",
    name: "Default Agent Prompt Profile",
    scope: "agent",
    description: "Default editable prompt layers used by AgentCore.",
    content: defaultPromptProfile().layers.map((layer) => `[${layer.role}] ${layer.title}\n${layer.content}`).join("\n\n")
  },
  {
    id: "router.codex.not_implemented",
    name: "Codex Command Placeholder",
    scope: "router",
    description: "Response used when a /codex command is routed before the Codex worker exists.",
    content:
      "Codex command accepted by router, but Codex worker is not implemented yet."
  }
];

export function createPromptProfileStore(filePath: string): PromptProfileStore {
  let current: PromptProfile = readPromptProfile(filePath) ?? defaultPromptProfile();
  if (!fs.existsSync(filePath)) writePromptProfile(filePath, current);

  return {
    get() {
      return cloneProfile(current);
    },
    save(profile) {
      current = normalizePromptProfile(profile);
      writePromptProfile(filePath, current);
      return cloneProfile(current);
    }
  };
}

export function defaultPromptProfile(): PromptProfile {
  return {
    userName: "user",
    visibleTools: {
      feishu: true
    },
    layers: [
      {
        id: "safety",
        title: "安全边际",
        role: "system",
        enabled: true,
        order: 10,
        content: [
          "Keep responses safe, bounded, and honest.",
          "Do not invent tool results or claim actions were completed unless a tool result confirms it.",
          "When uncertain, ask for clarification or use available context tools."
        ].join("\n")
      },
      {
        id: "role",
        title: "角色设定",
        role: "system",
        enabled: true,
        order: 20,
        content: [
          "You are Alice's agent runtime.",
          "Current time: {{time}}",
          "User: {{user}}"
        ].join("\n")
      },
      {
        id: "duties",
        title: "职责",
        role: "user",
        enabled: true,
        order: 30,
        content: [
          "Your duties are to understand the current conversation, use tools when helpful, and reply in the active messaging session."
        ].join("\n")
      },
      {
        id: "skills",
        title: "Skill",
        role: "user",
        enabled: true,
        order: 40,
        content: [
          "可用飞书工具：",
          "- check_feishu：查看当前一对一飞书聊天记录。默认 scope=today，本地时间 6 点前从前一天 00:00 开始，6 点后从当天 00:00 开始；scope=new 只返回上次查看后的新增飞书消息。",
          "- send_feishu：发送飞书消息到当前一对一聊天。type 默认 message；message 模式会把换行分隔的 content 拆成多条飞书消息。",
          "- 多行飞书回复要在 content 中用换行分段，流式发送会在每个换行处发送已完成的一段。"
        ].join("\n")
      },
      {
        id: "shell_deepseek_role_immersion",
        title: "壳设定 + DeepSeek Role Immersion",
        role: "user",
        enabled: true,
        order: 50,
        content: [
          "{{daily_shell}}",
          "",
          "Stay immersed in the Alice role while preserving tool accuracy.",
          "Do not mention platform-specific implementation names unless the user asks.",
          "Treat Feishu history tool output as-is."
        ].join("\n")
      }
    ]
  };
}

export function buildPromptMessages(profile: PromptProfile, context: PromptRenderContext): LLMMessage[] {
  const variables = promptVariables(profile, context);
  return normalizePromptProfile(profile).layers
    .filter((layer) => layer.enabled)
    .sort((left, right) => left.order - right.order)
    .map((layer) => layerToMessage(layer, variables));
}

export async function buildPromptMessagesWithToolResults(
  profile: PromptProfile,
  context: PromptRenderContext,
  runTool: (layer: PromptLayer, call: ToolCall) => Promise<ToolResult>
): Promise<LLMMessage[]> {
  const variables = promptVariables(profile, context);
  const messages: LLMMessage[] = [];
  const layers = normalizePromptProfile(profile).layers
    .filter((layer) => layer.enabled)
    .sort((left, right) => left.order - right.order);

  for (const layer of layers) {
    const message = layerToMessage(layer, variables);
    messages.push(message);
    if (layer.role !== "tool_request") continue;

    const toolCall = message.toolCalls?.[0];
    if (!toolCall) continue;
    const result = await runTool(layer, {
      id: toolCall.id,
      toolName: toolCall.function.name,
      input: parseToolArguments(toolCall.function.arguments),
      requester: context.event.source,
      session: context.event.session
    });
    messages.push({
      role: "tool",
      name: toolCall.function.name,
      toolCallId: toolCall.id,
      content: formatPromptToolResult(result)
    });
  }

  return messages;
}

export function promptVariables(profile: PromptProfile, context: PromptRenderContext): Record<string, string> {
  const now = context.time.now();
  const date = formatLocalDate(now.date, context.time.timeZone);
  return {
    time: formatLocalDateTime(now.date, context.time.timeZone),
    date,
    timezone: context.time.timeZone,
    daily_shell: context.dailyShell ?? "",
    user: profile.userName,
    session: context.event.session.sessionId,
    channel: context.event.source.channelId ?? context.event.source.userId ?? context.event.session.sessionId
  };
}

export function renderTemplate(content: string, variables: Record<string, string>): string {
  return content.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key: string) => variables[key] ?? match);
}

export function normalizePromptProfile(profile: PromptProfile): PromptProfile {
  const fallback = defaultPromptProfile();
  const layers = Array.isArray(profile.layers) ? profile.layers : fallback.layers;
  return {
    userName: nonEmptyString(profile.userName) ?? fallback.userName,
    visibleTools: {
      feishu: profile.visibleTools?.feishu !== false
    },
    layers: layers.map((layer, index) => ({
      id: nonEmptyString(layer.id) ?? `layer_${index + 1}`,
      title: nonEmptyString(layer.title) ?? `Layer ${index + 1}`,
      role: normalizeLayerRole(layer.role),
      enabled: layer.enabled !== false,
      content: typeof layer.content === "string" ? layer.content : "",
      order: Number.isFinite(Number(layer.order)) ? Number(layer.order) : (index + 1) * 10,
      toolName: normalizeLayerRole(layer.role) === "tool_request" ? nonEmptyString(layer.toolName) : undefined,
      toolCallId: normalizeLayerRole(layer.role) === "tool_request" ? nonEmptyString(layer.toolCallId) : undefined,
      toolArguments: normalizeLayerRole(layer.role) === "tool_request" && typeof layer.toolArguments === "string" ? layer.toolArguments : undefined,
      thinking: (normalizeLayerRole(layer.role) === "assistant" || normalizeLayerRole(layer.role) === "tool_request") && typeof layer.thinking === "string" ? layer.thinking : undefined
    }))
  };
}

function layerToMessage(layer: PromptLayer, variables: Record<string, string>): LLMMessage {
  if (layer.role === "tool_request") {
    const toolName = layer.toolName || "check_feishu";
    const toolCallId = layer.toolCallId || `prompt_${layer.id}`;
    const thinking = renderTemplate(layer.thinking ?? layer.content, variables);
    const args = renderTemplate(layer.toolArguments || "{}", variables);
    return {
      role: "assistant",
      content: renderTemplate(layer.content || "", variables),
      reasoningContent: thinking,
      toolCalls: [{
        id: toolCallId,
        type: "function",
        function: {
          name: toolName,
          arguments: args
        }
      }]
    };
  }
  return {
    role: layer.role,
    content: renderTemplate(layer.content, variables),
    reasoningContent: layer.role === "assistant" && layer.thinking ? renderTemplate(layer.thinking, variables) : undefined
  };
}

function normalizeLayerRole(value: unknown): PromptLayerRole {
  if (value === "user" || value === "assistant" || value === "tool_request") return value;
  return "system";
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function formatPromptToolResult(result: ToolResult): string {
  if (!result.ok) return result.error ? `error: ${result.error}` : "error";
  if (typeof result.output === "string") return result.output;
  if (result.output === undefined || result.output === null) return "ok";
  if (typeof result.output === "number" || typeof result.output === "boolean") return String(result.output);
  try {
    return JSON.stringify(result.output);
  } catch {
    return String(result.output);
  }
}

export function getPromptContent(id: string): string {
  const prompt = defaultPromptRegistry.find((item) => item.id === id);
  if (!prompt) {
    throw new Error(`Prompt not found: ${id}`);
  }

  return prompt.content;
}

function readPromptProfile(filePath: string): PromptProfile | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return normalizePromptProfile(JSON.parse(fs.readFileSync(filePath, "utf8")) as PromptProfile);
  } catch {
    return undefined;
  }
}

function writePromptProfile(filePath: string, profile: PromptProfile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalizePromptProfile(profile), null, 2)}\n`);
}

function cloneProfile(profile: PromptProfile): PromptProfile {
  return JSON.parse(JSON.stringify(profile)) as PromptProfile;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function formatLocalDateTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function formatLocalDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
