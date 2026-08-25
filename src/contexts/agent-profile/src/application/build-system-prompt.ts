import type { LLMContentPart, LLMMessage, LLMToolCall } from "../../../../contexts/llm-gateway/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { AgentEvent, ToolCall, ToolDefinition, ToolResult } from "../../../agent-loop/src/contracts/agent-contracts.js";
import type { PromptContextRuntime } from "../../../prompt-context/src/index.js";
import {
  normalizePromptLayer,
  parsePromptToolArguments,
  promptMessageToMessage,
  type PromptLayer,
  type PromptMessage
} from "../domain/prompt-layer.js";

export type { PromptLayer, PromptMessage, PromptMessageMeta } from "../domain/prompt-layer.js";

const fs = await import("node:fs");
const path = await import("node:path");
const crypto = await import("node:crypto");

export type PromptDefinition = {
  id: string;
  name: string;
  scope: "agent" | "router" | "tool" | "renderer";
  description: string;
  content: string;
};

export type VisibleTools = {
  feishu: boolean;
  photo?: boolean;
  media?: boolean;
  shell?: boolean;
  [toolName: string]: boolean | undefined;
};

export type PromptProfile = {
  visibleTools: VisibleTools;
  layers: PromptLayer;
  appendLayers?: PromptLayer;
  interruptLayer?: PromptLayer;
  consecutiveToolReminderLayer?: PromptLayer;
  silentEndingReminderLayer?: PromptLayer;
};

export type PromptRenderContext = {
  renderer: PromptContextRuntime;
  event: AgentEvent;
  time: CurrentTimeProvider;
  preview?: boolean;
};

export type PromptContextDeps = {
  renderer: PromptContextRuntime;
  event: AgentEvent;
  time: CurrentTimeProvider;
  preview?: boolean;
};

type ToolDefinitionResolver = (toolName: string) => ToolDefinition | undefined;

export type PromptProfileStore = {
  get(): PromptProfile;
  save(profile: PromptProfile): PromptProfile;
};

export class PromptProfileValidationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "PromptProfileValidationError";
  }
}

export const defaultPromptRegistry: PromptDefinition[] = [
  {
    id: "agent.profile.default",
    name: "Default Agent Prompt Profile",
    scope: "agent",
    description: "Default editable prompt layers used by ChatAgent.",
    content: defaultPromptProfile().layers.messages
      .map((message) => `[${message.role}] ${message.meta.title}\n${contentText(message.content)}`)
      .join("\n\n")
  },
  {
    id: "router.codex.not_implemented",
    name: "Codex Command Placeholder",
    scope: "router",
    description: "Response used when a /codex command is routed before the Codex worker exists.",
    content: "Codex command accepted by router, but Codex worker is not implemented yet."
  }
];

export function createPromptProfileStore(filePath: string): PromptProfileStore {
  let current: PromptProfile = readPromptProfile(filePath) ?? defaultPromptProfile();
  return {
    get: () => cloneProfile(current),
    save(profile) {
      current = validatePromptProfile(profile);
      writePromptProfile(filePath, current);
      return cloneProfile(current);
    }
  };
}

export function defaultPromptProfile(): PromptProfile {
  return {
    visibleTools: { feishu: true, photo: true, shell: true },
    layers: { meta: {}, messages: [] },
    appendLayers: { meta: {}, messages: [] },
    interruptLayer: defaultInterruptLayer(),
    consecutiveToolReminderLayer: { meta: {}, messages: [] },
    silentEndingReminderLayer: { meta: {}, messages: [] }
  };
}

export function defaultInterruptLayer(): PromptLayer {
  return {
    meta: {},
    messages: [{
      meta: { title: "Interrupt Layer", enabled: true },
      role: "user",
      name: "Alert",
      content: "<Alert info=\"have a new message\" />"
    }]
  };
}

export function buildPromptMessages(profile: PromptProfile, context: PromptRenderContext): LLMMessage[] {
  return enabledMessages(normalizePromptProfile(profile).layers)
    .map((message) => promptMessageToMessage(message, promptRenderer(context)));
}

export function staticPromptFingerprint(profile: PromptProfile, context: PromptRenderContext): string {
  return staticPromptFingerprintForMessages(buildPromptMessages(profile, context));
}

export function staticPromptFingerprintForMessages(messages: LLMMessage[]): string {
  return staticPromptFingerprintForText(stableJson(messages));
}

export function staticPromptFingerprintForText(text: string): string {
  return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
}

export async function buildPromptMessagesWithToolResults(
  profile: PromptProfile,
  context: PromptRenderContext,
  runTool: (message: PromptMessage, call: ToolCall) => Promise<ToolResult>,
  getToolDefinition?: ToolDefinitionResolver
): Promise<LLMMessage[]> {
  return buildLayerMessagesWithToolResults(normalizePromptProfile(profile).layers, promptRenderer(context), context, runTool, getToolDefinition);
}

export async function buildAppendPromptMessagesWithToolResults(
  profile: PromptProfile,
  context: PromptRenderContext,
  runTool: (message: PromptMessage, call: ToolCall) => Promise<ToolResult>,
  getToolDefinition?: ToolDefinitionResolver
): Promise<LLMMessage[]> {
  return buildLayerMessagesWithToolResults(normalizePromptProfile(profile).appendLayers!, promptRenderer(context), context, runTool, getToolDefinition);
}

export async function buildLayerMessagesWithToolResults(
  layer: PromptLayer,
  renderer: PromptContextRuntime,
  context: PromptRenderContext,
  runTool: (message: PromptMessage, call: ToolCall) => Promise<ToolResult>,
  getToolDefinition?: ToolDefinitionResolver
): Promise<LLMMessage[]> {
  const result: LLMMessage[] = [];
  for (const storedMessage of enabledMessages(layer)) {
    const message = promptMessageToMessage(storedMessage, renderer);
    result.push(message);
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    for (const toolCall of message.toolCalls) {
      const toolInput = parsePromptToolArguments(toolCall.function.arguments);
      const toolResult = await runTool(storedMessage, {
        id: toolCall.id,
        toolName: toolCall.function.name,
        input: context.preview ? { ...toolInput, __preview: true } : toolInput,
        requester: context.event.source,
        externalSession: context.event.externalSession
      });
      result.push({
        role: "tool",
        name: toolCall.function.name,
        toolCallId: toolCall.id,
        content: formatPromptToolMessageContent(toolResult, renderer, getToolDefinition?.(toolCall.function.name)?.passRenderText === true)
      });
    }
  }
  return result;
}

export function promptRenderer(context: PromptRenderContext): PromptContextRuntime {
  return context.renderer;
}

export function makePromptContext(input: PromptContextDeps): PromptRenderContext {
  return { renderer: input.renderer, event: input.event, time: input.time, preview: input.preview };
}

export function renderTemplate(content: string, renderer: PromptContextRuntime): string {
  return renderer.renderText(content);
}

export function normalizePromptProfile(profile: PromptProfile): PromptProfile {
  const fallback = defaultPromptProfile();
  const visibleTools = profile?.visibleTools && typeof profile.visibleTools === "object"
    ? profile.visibleTools
    : fallback.visibleTools;
  return {
    visibleTools: {
      ...visibleTools,
      feishu: visibleTools.feishu !== false,
      photo: visibleTools.photo !== false && visibleTools.media !== false,
      media: visibleTools.photo !== false && visibleTools.media !== false,
      shell: visibleTools.shell !== false
    },
    layers: normalizePromptLayer(profile?.layers, fallback.layers),
    appendLayers: normalizePromptLayer(profile?.appendLayers, fallback.appendLayers),
    interruptLayer: normalizePromptLayer(profile?.interruptLayer, fallback.interruptLayer),
    consecutiveToolReminderLayer: normalizePromptLayer(
      profile?.consecutiveToolReminderLayer,
      fallback.consecutiveToolReminderLayer
    ),
    silentEndingReminderLayer: normalizePromptLayer(
      profile?.silentEndingReminderLayer,
      fallback.silentEndingReminderLayer
    )
  };
}

function enabledMessages(layer: PromptLayer): PromptMessage[] {
  return layer.messages.filter((message) => message.meta.enabled);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function formatPromptToolMessageContent(result: ToolResult, runtime: PromptContextRuntime, passRenderText: boolean): string {
  if (!result.ok && typeof result.output === "string") return passRenderText ? runtime.renderText(result.output) : result.output;
  if (!result.ok) return result.error ? `error: ${passRenderText ? runtime.renderText(result.error) : result.error}` : "error";
  if (typeof result.output === "string") return passRenderText ? runtime.renderText(result.output) : result.output;
  if (result.output === undefined || result.output === null) return "ok";
  if (typeof result.output === "number" || typeof result.output === "boolean") return String(result.output);
  return JSON.stringify(result.output);
}

export function getPromptContent(id: string): string {
  const prompt = defaultPromptRegistry.find((item) => item.id === id);
  if (!prompt) throw new Error(`Prompt not found: ${id}`);
  return prompt.content;
}

function readPromptProfile(filePath: string): PromptProfile | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return validatePromptProfile(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

function writePromptProfile(filePath: string, profile: PromptProfile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(validatePromptProfile(profile), null, 2)}\n`);
}

function cloneProfile(profile: PromptProfile): PromptProfile {
  return JSON.parse(JSON.stringify(profile)) as PromptProfile;
}

function validatePromptProfile(value: unknown): PromptProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PromptProfileValidationError("invalid_prompt_profile");
  const profile = value as PromptProfile & { userName?: unknown };
  if (profile.userName !== undefined) throw new PromptProfileValidationError("invalid_prompt_profile_user_name");
  if (!profile.visibleTools || typeof profile.visibleTools !== "object" || Array.isArray(profile.visibleTools)) {
    throw new PromptProfileValidationError("invalid_prompt_profile_visible_tools");
  }
  validatePromptLayerForStorage(profile.layers, "layers");
  validatePromptLayerForStorage(profile.appendLayers, "appendLayers");
  validatePromptLayerForStorage(profile.interruptLayer, "interruptLayer");
  if (profile.consecutiveToolReminderLayer !== undefined) {
    validatePromptLayerForStorage(profile.consecutiveToolReminderLayer, "consecutiveToolReminderLayer");
    for (const message of profile.consecutiveToolReminderLayer.messages) {
      if (message.role !== "user") {
        throw new PromptProfileValidationError("invalid_prompt_consecutive_tool_reminder_role");
      }
    }
  }
  if (profile.silentEndingReminderLayer !== undefined) {
    validatePromptLayerForStorage(profile.silentEndingReminderLayer, "silentEndingReminderLayer");
    for (const message of profile.silentEndingReminderLayer.messages) {
      if (message.role !== "user") {
        throw new PromptProfileValidationError("invalid_prompt_silent_ending_reminder_role");
      }
    }
  }
  return cloneProfile(profile);
}

export function validatePromptLayerForStorage(value: unknown, key = "layer"): asserts value is PromptLayer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PromptProfileValidationError(`invalid_prompt_layer_${key}`);
  const layer = value as { meta?: unknown; messages?: unknown };
  if (!layer.meta || typeof layer.meta !== "object" || Array.isArray(layer.meta)) throw new PromptProfileValidationError(`invalid_prompt_layer_meta_${key}`);
  if (!Array.isArray(layer.messages)) throw new PromptProfileValidationError(`invalid_prompt_layer_messages_${key}`);
  layer.messages.forEach((message, index) => validatePromptMessageForStorage(message, `${key}_${index + 1}`));
}

function validatePromptMessageForStorage(value: unknown, key: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PromptProfileValidationError(`invalid_prompt_message_${key}`);
  const message = value as Partial<PromptMessage>;
  if (!message.meta || typeof message.meta !== "object" || Array.isArray(message.meta)) throw new PromptProfileValidationError(`invalid_prompt_message_meta_${key}`);
  if (typeof message.meta.title !== "string") throw new PromptProfileValidationError(`invalid_prompt_message_title_${key}`);
  if (typeof message.meta.enabled !== "boolean") throw new PromptProfileValidationError(`invalid_prompt_message_enabled_${key}`);
  if (!messageRole(message.role)) throw new PromptProfileValidationError(`invalid_prompt_message_role_${key}`);
  validateMessageContent(message.content, key);
  if (message.name !== undefined && typeof message.name !== "string") throw new PromptProfileValidationError(`invalid_prompt_message_name_${key}`);
  if (message.reasoningContent !== undefined && typeof message.reasoningContent !== "string") throw new PromptProfileValidationError(`invalid_prompt_message_reasoning_${key}`);
  if (message.toolCallId !== undefined && typeof message.toolCallId !== "string") throw new PromptProfileValidationError(`invalid_prompt_message_tool_call_id_${key}`);
  if (message.toolCalls !== undefined) validatePromptToolCallsForStorage(message.toolCalls, key);
}

function messageRole(role: unknown): boolean {
  return role === "system" || role === "user" || role === "assistant" || role === "tool";
}

function validateMessageContent(value: unknown, key: string): void {
  if (typeof value === "string") return;
  if (!Array.isArray(value)) throw new PromptProfileValidationError(`invalid_prompt_message_content_${key}`);
  for (const part of value) {
    if (!part || typeof part !== "object" || Array.isArray(part)) throw new PromptProfileValidationError(`invalid_prompt_message_content_part_${key}`);
    const typed = part as LLMContentPart;
    if (typed.type === "text" && typeof typed.text === "string") continue;
    if (typed.type === "image_url" && typeof typed.image_url?.url === "string") continue;
    if (typed.type === "input_audio" && typeof typed.input_audio?.data === "string" && typeof typed.input_audio?.format === "string") continue;
    throw new PromptProfileValidationError(`invalid_prompt_message_content_part_${key}`);
  }
}

function validatePromptToolCallsForStorage(value: unknown, key: string): asserts value is LLMToolCall[] {
  if (!Array.isArray(value)) throw new PromptProfileValidationError(`invalid_prompt_message_tool_calls_${key}`);
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new PromptProfileValidationError(`invalid_prompt_message_tool_call_${key}_${index + 1}`);
    const call = entry as Partial<LLMToolCall>;
    if (typeof call.id !== "string" || !call.id) throw new PromptProfileValidationError(`invalid_prompt_message_tool_call_id_${key}_${index + 1}`);
    if (call.type !== "function") throw new PromptProfileValidationError(`invalid_prompt_message_tool_call_type_${key}_${index + 1}`);
    if (!call.function || typeof call.function.name !== "string" || !call.function.name) throw new PromptProfileValidationError(`invalid_prompt_message_tool_name_${key}_${index + 1}`);
    if (typeof call.function.arguments !== "string") throw new PromptProfileValidationError(`invalid_prompt_message_tool_arguments_${key}_${index + 1}`);
  });
}

function contentText(content: LLMMessage["content"]): string {
  return typeof content === "string"
    ? content
    : content.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("\n");
}
