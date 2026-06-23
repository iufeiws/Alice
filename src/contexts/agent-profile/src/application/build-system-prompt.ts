import type { LLMMessage } from "../../../../contexts/llm-gateway/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { AgentEvent, ToolCall, ToolResult } from "../../../agent-loop/src/contracts/agent-contracts.js";
import { buildLLMTextVariables, formatToolResultForLLM, renderLLMText, type LLMTextVariables, type LLMTextWakeBoundary } from "../../../../contexts/agent-profile/src/application/llm-text-renderer.js";
import type { DailyShell } from "../domain/shell.js";
import type { MemorySnapshot } from "../../../memory/src/memory.js";
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
  userName: string;
  layers: PromptLayer[];
  appendLayers?: PromptLayer[];
  visibleTools: {
    feishu: boolean;
    photo?: boolean;
    media?: boolean;
    shell?: boolean;
    [toolName: string]: boolean | undefined;
  };
};

export type PromptRenderContext = {
  event: AgentEvent;
  time: CurrentTimeProvider;
  dailyShell?: string;
  dailyShellRaw?: DailyShell;
  appearanceDescription?: string;
  librarySetting?: string;
  memory?: MemorySnapshot;
  wakeBoundary?: LLMTextWakeBoundary;
  calendarContext?: string;
  preview?: boolean;
};

export type PromptContextDeps = {
  event: AgentEvent;
  time: CurrentTimeProvider;
  getDailyShell?: () => string | undefined;
  getDailyShellRaw?: () => DailyShell | undefined;
  getAppearanceDescription?: () => string | undefined;
  getLibrarySetting?: () => string | undefined;
  getMemorySnapshot?: () => MemorySnapshot | undefined;
  getWakeBoundary?: () => LLMTextWakeBoundary | undefined;
  getCalendarContext?: () => string | undefined;
  preview?: boolean;
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
      feishu: true,
      photo: true,
      shell: true
    },
    layers: [
    ],
    appendLayers: [
    ]
  };
}

export function buildPromptMessages(profile: PromptProfile, context: PromptRenderContext): LLMMessage[] {
  const variables = promptVariables(profile, context);
  return normalizePromptProfile(profile).layers
    .filter((layer) => layer.enabled)
    .sort((left, right) => left.order - right.order)
    .map((layer) => promptLayerToMessage(layer, variables));
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
  const variables = promptVariables(profile, context);
  return buildLayerMessagesWithToolResults(normalizePromptProfile(profile).layers, variables, context, runTool);
}

export async function buildAppendPromptMessagesWithToolResults(
  profile: PromptProfile,
  context: PromptRenderContext,
  runTool: (layer: PromptLayer, call: ToolCall) => Promise<ToolResult>
): Promise<LLMMessage[]> {
  const variables = promptVariables(profile, context);
  return buildLayerMessagesWithToolResults(normalizePromptProfile(profile).appendLayers ?? [], variables, context, runTool);
}

export async function buildLayerMessagesWithToolResults(
  inputLayers: PromptLayer[],
  variables: LLMTextVariables,
  context: PromptRenderContext,
  runTool: (layer: PromptLayer, call: ToolCall) => Promise<ToolResult>,
  options: { toolCallIdPrefix?: string } = {}
): Promise<LLMMessage[]> {
  const messages: LLMMessage[] = [];
  const layers = inputLayers
    .filter((layer) => layer.enabled)
    .sort((left, right) => left.order - right.order);

  for (const layer of layers) {
    const message = promptLayerToMessage(layer, variables, options);
    messages.push(message);
    if (layer.role !== "tool_request") continue;

    const toolCall = message.toolCalls?.[0];
    if (!toolCall) continue;
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
      content: formatPromptToolResult(result, variables)
    });
  }

  return messages;
}

export function promptVariables(profile: PromptProfile, context: PromptRenderContext): LLMTextVariables {
  return buildLLMTextVariables({
    userName: profile.userName,
    time: context.time,
    event: context.event,
    dailyShell: context.dailyShell ?? "",
    dailyShellRaw: context.dailyShellRaw,
    appearanceDescription: context.appearanceDescription,
    librarySetting: context.librarySetting,
    memory: context.memory,
    wakeBoundary: context.wakeBoundary,
    calendarContext: context.calendarContext
  });
}

export function makePromptContext(input: PromptContextDeps): PromptRenderContext {
  return {
    event: input.event,
    time: input.time,
    dailyShell: input.getDailyShell?.(),
    dailyShellRaw: input.getDailyShellRaw?.(),
    appearanceDescription: input.getAppearanceDescription?.(),
    librarySetting: input.getLibrarySetting?.(),
    memory: input.getMemorySnapshot?.(),
    wakeBoundary: input.getWakeBoundary?.(),
    calendarContext: input.getCalendarContext?.(),
    preview: input.preview
  };
}

export function renderTemplate(content: string, variables: LLMTextVariables): string {
  return renderLLMText(content, variables);
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
    userName: nonEmptyString(profile.userName) ?? fallback.userName,
    visibleTools,
    layers: normalizePromptLayers(layers),
    appendLayers: normalizePromptLayers(appendLayers ?? [])
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

function formatPromptToolResult(result: ToolResult, variables: LLMTextVariables): string {
  return formatToolResultForLLM(result, variables);
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
