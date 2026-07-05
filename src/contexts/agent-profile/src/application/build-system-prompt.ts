import type { LLMMessage } from "../../../../contexts/llm-gateway/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { AgentEvent, ToolCall, ToolResult } from "../../../agent-loop/src/contracts/agent-contracts.js";
import type { PromptContextRuntime } from "../../../prompt-context/src/index.js";
import { normalizePromptLayers, parsePromptToolArguments, promptLayerToMessage, type PromptLayer, type PromptLayerRole } from "../domain/prompt-layer.js";

export type { PromptLayer, PromptLayerRole } from "../domain/prompt-layer.js";

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

export type PromptProfile = {
  layers: PromptLayer[];
  appendLayers?: PromptLayer[];
  interruptLayer?: PromptLayer;
  visibleTools: {
    feishu: boolean;
    photo?: boolean;
    media?: boolean;
    shell?: boolean;
    [toolName: string]: boolean | undefined;
  };
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

  return {
    get() {
      return cloneProfile(current);
    },
    save(profile) {
      current = validatePromptProfile(profile);
      writePromptProfile(filePath, current);
      return cloneProfile(current);
    }
  };
}

export function defaultPromptProfile(): PromptProfile {
  return {
    visibleTools: {
      feishu: true,
      photo: true,
      shell: true
    },
    layers: [
    ],
    appendLayers: [
    ],
    interruptLayer: defaultInterruptLayer()
  };
}

export function defaultInterruptLayer(): PromptLayer {
  return {
    id: "interrupt",
    title: "Interrupt Layer",
    role: "user",
    name: "Alert",
    enabled: true,
    content: "<Alert info=\"have a new message\" />",
    order: 0
  };
}

export function buildPromptMessages(profile: PromptProfile, context: PromptRenderContext): LLMMessage[] {
  const renderer = promptRenderer(context);
  return normalizePromptProfile(profile).layers
    .filter((layer) => layer.enabled)
    .sort((left, right) => left.order - right.order)
    .map((layer) => promptLayerToMessage(layer, renderer));
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
  runTool: (layer: PromptLayer, call: ToolCall) => Promise<ToolResult>
): Promise<LLMMessage[]> {
  const renderer = promptRenderer(context);
  return buildLayerMessagesWithToolResults(normalizePromptProfile(profile).layers, renderer, context, runTool);
}

export async function buildAppendPromptMessagesWithToolResults(
  profile: PromptProfile,
  context: PromptRenderContext,
  runTool: (layer: PromptLayer, call: ToolCall) => Promise<ToolResult>
): Promise<LLMMessage[]> {
  const renderer = promptRenderer(context);
  return buildLayerMessagesWithToolResults(normalizePromptProfile(profile).appendLayers ?? [], renderer, context, runTool);
}

export async function buildLayerMessagesWithToolResults(
  inputLayers: PromptLayer[],
  renderer: PromptContextRuntime,
  context: PromptRenderContext,
  runTool: (layer: PromptLayer, call: ToolCall) => Promise<ToolResult>,
  options: { toolCallIdPrefix?: string } = {}
): Promise<LLMMessage[]> {
  const messages: LLMMessage[] = [];
  const layers = inputLayers
    .filter((layer) => layer.enabled)
    .sort((left, right) => left.order - right.order);

  for (const layer of layers) {
    const message = promptLayerToMessage(layer, renderer, options);
    messages.push(message);
    if (layer.role !== "tool_request") continue;

    for (const toolCall of message.toolCalls ?? []) {
      const toolInput = parsePromptToolArguments(toolCall.function.arguments);
      const result = await runTool(layer, {
        id: toolCall.id,
        toolName: toolCall.function.name,
        input: context.preview ? { ...toolInput, __preview: true } : toolInput,
        requester: context.event.source,
        externalSession: context.event.externalSession
      });
      messages.push({
        role: "tool",
        name: toolCall.function.name,
        toolCallId: toolCall.id,
        content: formatPromptToolMessageContent(result, renderer)
      });
    }
  }

  return messages;
}

export function promptRenderer(context: PromptRenderContext): PromptContextRuntime {
  return context.renderer;
}

export function makePromptContext(input: PromptContextDeps): PromptRenderContext {
  return {
    renderer: input.renderer,
    event: input.event,
    time: input.time,
    preview: input.preview
  };
}

export function renderTemplate(content: string, renderer: PromptContextRuntime): string {
  return renderer.renderText(content);
}

export function normalizePromptProfile(profile: PromptProfile): PromptProfile {
  const fallback = defaultPromptProfile();
  const layers = Array.isArray(profile.layers) ? profile.layers : fallback.layers;
  const rawProfile = profile as PromptProfile & { fakeCheckChatReasoningContent?: unknown };
  const appendLayers = Array.isArray(profile.appendLayers)
    ? profile.appendLayers
    : typeof rawProfile.fakeCheckChatReasoningContent === "string"
      ? (fallback.appendLayers ?? []).map((layer) => ({ ...layer, thinking: rawProfile.fakeCheckChatReasoningContent as string }))
      : [];
  const visibleTools = {
    ...profile.visibleTools,
    feishu: profile.visibleTools?.feishu !== false,
    photo: profile.visibleTools?.photo !== false && profile.visibleTools?.media !== false,
    media: profile.visibleTools?.photo !== false && profile.visibleTools?.media !== false,
    shell: profile.visibleTools?.shell !== false
  };
  return {
    visibleTools,
    layers: normalizePromptLayers(layers),
    appendLayers: normalizePromptLayers(appendLayers ?? []),
    interruptLayer: normalizeInterruptLayer(profile.interruptLayer, fallback.interruptLayer)
  };
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

function formatPromptToolMessageContent(result: ToolResult, runtime: PromptContextRuntime): string {
  if (!result.ok && typeof result.output === "string") return runtime.renderText(result.output);
  if (!result.ok) return result.error ? `error: ${runtime.renderText(result.error)}` : "error";
  if (typeof result.output === "string") return runtime.renderText(result.output);
  if (result.output === undefined || result.output === null) return "ok";
  if (typeof result.output === "number" || typeof result.output === "boolean") return String(result.output);
  return JSON.stringify(result.output);
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
  const profile = value as PromptProfile;
  if ("userName" in profile) throw new PromptProfileValidationError("invalid_prompt_profile_user_name");
  if (!profile.visibleTools || typeof profile.visibleTools !== "object" || Array.isArray(profile.visibleTools)) throw new PromptProfileValidationError("invalid_prompt_profile_visible_tools");
  validatePromptLayersForStorage(profile.layers, "layers");
  if (profile.appendLayers !== undefined) validatePromptLayersForStorage(profile.appendLayers, "appendLayers");
  if (profile.interruptLayer !== undefined) validateInterruptLayerForStorage(profile.interruptLayer);
  return cloneProfile({
    visibleTools: profile.visibleTools,
    layers: profile.layers,
    appendLayers: profile.appendLayers,
    interruptLayer: profile.interruptLayer ?? defaultInterruptLayer()
  });
}

function normalizeInterruptLayer(value: unknown, fallback: PromptLayer | undefined): PromptLayer | undefined {
  if (value === undefined) return fallback;
  const layer = normalizePromptLayers([value], fallback ? [fallback] : [])[0];
  if (!layer || layer.role === "tool_request") return fallback;
  return layer;
}

function validateInterruptLayerForStorage(value: unknown): void {
  validatePromptLayerForStorage(value, "interruptLayer");
  const layer = value as PromptLayer;
  if (layer.role === "tool_request") throw new PromptProfileValidationError("invalid_prompt_interrupt_layer_role");
}

function validatePromptLayersForStorage(value: unknown, key: string): void {
  if (!Array.isArray(value)) throw new PromptProfileValidationError(`invalid_prompt_profile_${key}`);
  value.forEach((entry, index) => validatePromptLayerForStorage(entry, `${key}_${index + 1}`));
}

function validatePromptLayerForStorage(value: unknown, key: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PromptProfileValidationError(`invalid_prompt_layer_${key}`);
  const layer = value as PromptLayer;
  if (typeof layer.id !== "string" || !layer.id.trim()) throw new PromptProfileValidationError(`invalid_prompt_layer_id_${key}`);
  if (typeof layer.title !== "string") throw new PromptProfileValidationError(`invalid_prompt_layer_title_${key}`);
  if (!["system", "user", "assistant", "tool_request"].includes(String(layer.role))) throw new PromptProfileValidationError(`invalid_prompt_layer_role_${key}`);
  if (layer.name !== undefined && typeof layer.name !== "string") throw new PromptProfileValidationError(`invalid_prompt_layer_name_${key}`);
  if (typeof layer.enabled !== "boolean") throw new PromptProfileValidationError(`invalid_prompt_layer_enabled_${key}`);
  if (typeof layer.content !== "string") throw new PromptProfileValidationError(`invalid_prompt_layer_content_${key}`);
  if (typeof layer.order !== "number" || !Number.isFinite(layer.order)) throw new PromptProfileValidationError(`invalid_prompt_layer_order_${key}`);
  if (layer.thinking !== undefined && typeof layer.thinking !== "string") throw new PromptProfileValidationError(`invalid_prompt_layer_thinking_${key}`);
  if (layer.toolCalls !== undefined) validatePromptToolCallsForStorage(layer.toolCalls, key);
}

function validatePromptToolCallsForStorage(value: unknown, key: string): void {
  if (!Array.isArray(value)) throw new PromptProfileValidationError(`invalid_prompt_layer_tool_calls_${key}`);
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new PromptProfileValidationError(`invalid_prompt_layer_tool_call_${key}_${index + 1}`);
    const call = entry as { toolName?: unknown; toolCallId?: unknown; toolArguments?: unknown };
    if (typeof call.toolName !== "string") throw new PromptProfileValidationError(`invalid_prompt_layer_tool_name_${key}_${index + 1}`);
    if (call.toolCallId !== undefined && typeof call.toolCallId !== "string") throw new PromptProfileValidationError(`invalid_prompt_layer_tool_call_id_${key}_${index + 1}`);
    if (typeof call.toolArguments !== "string") throw new PromptProfileValidationError(`invalid_prompt_layer_tool_arguments_${key}_${index + 1}`);
  });
}
