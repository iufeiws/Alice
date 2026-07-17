import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { LLMToolCall } from "../../../contexts/llm-gateway/src/index.js";
import type { AsrPluginConfig, AsrPluginDeps, AsrTranscribeInput, AsrTranscribeResult } from "./types.js";
import { audioDataUrl, audioFormatForMimeType, mimeTypeForFileName, readAudioInput } from "./audio.js";
import { AsrConfigError } from "./errors.js";

export const defaultMultimodalLlmAsrPrompt = `描述这段音频的内容:
- 如果是语音转写为原始语言文本，不要翻译
- 如果是声音，简短描述声音
- emotion 只填一个词，用于概括情绪、语气或声音氛围；无法判断填空字符串`;
export function defaultMultimodalLlmAsrExtraParams(): Record<string, unknown> {
  return {
    tool_choice: { type: "function", function: { name: "submit_audio_context" } },
    max_completion_tokens: 8192
  };
}
const submitAudioContextTool: ToolDefinition = {
  name: "submit_audio_context",
  description: "提交音频理解结果。必须只调用本工具，不要输出自然语言。",
  inputSchema: {
    type: "object",
    properties: {
      speakText: { type: "string", description: "音频中可识别语音的原始语言转写；没有语音时填空字符串；不要翻译。" },
      emotion: { type: "string", description: "只填一个词，用于概括说话人的情绪、语气，或非语音声音的氛围；无法判断时填空字符串。" },
      description: { type: "string", description: "简短描述非语音声音或必要补充。" }
    },
    required: ["speakText", "emotion", "description"],
    additionalProperties: false
  }
};
export function multimodalLlmAsrProtocolCall(): Record<string, unknown> {
  return {
    messages: [{
      role: "user",
      content: [
        { type: "input_audio", input_audio: { data: "data:<audio-mime>;base64,<audio-base64>" } },
        { type: "text", text: defaultMultimodalLlmAsrPrompt }
      ]
    }],
    tools: [{
      type: "function",
      function: {
        name: submitAudioContextTool.name,
        description: submitAudioContextTool.description,
        parameters: submitAudioContextTool.inputSchema
      }
    }],
    ...defaultMultimodalLlmAsrExtraParams()
  };
}

export async function transcribeMultimodalLlm(input: AsrTranscribeInput, config: AsrPluginConfig, deps: AsrPluginDeps): Promise<AsrTranscribeResult> {
  const providerConfig = config.providers.multimodalLlm;
  const preset = providerConfig?.apiPresetName ? deps.resolveApiPreset?.(providerConfig.apiPresetName) : undefined;
  const client = preset ? deps.createLlmClientFromPreset?.(preset, deps.env ?? process.env) : undefined;
  const prompt = renderAsrPrompt(providerConfig?.prompt ?? defaultMultimodalLlmAsrPrompt, deps);
  if (!providerConfig?.apiPresetName || !preset || !client || !deps.llmRequestSender || !prompt) {
    throw new AsrConfigError("missing_provider_config");
  }

  const audio = await readAudioInput(input);
  const mimeType = input.mimeType || mimeTypeForFileName(input.filename || audio.filename);
  const result = await deps.llmRequestSender({
    agentId: "asr",
    client,
    presetName: providerConfig.apiPresetName,
    messages: [{
      role: "user",
      content: [
        { type: "input_audio", input_audio: { data: audioDataUrl(audio.bytes, mimeType), format: audioFormatForMimeType(mimeType) } },
        { type: "text", text: prompt }
      ]
    }],
    model: preset.model,
    temperature: preset.temperature,
    extraParams: providerConfig.extraParams ?? defaultMultimodalLlmAsrExtraParams(),
    toolNames: [submitAudioContextTool.name],
    inlineTools: [submitAudioContextTool],
    round: 0,
    stream: false,
    metadata: {
      pluginId: "asr",
      provider: "multimodal_llm",
      filename: input.filename || audio.filename,
      mimeType
    }
  });
  const toolCall = requireSingleToolCall(result.message.toolCalls, submitAudioContextTool.name);
  const args = parseSubmitAudioContextArguments(toolCall.function.arguments);
  return {
    text: renderSubmitAudioContextText(args),
    provider: "multimodal_llm",
    model: result.model ?? preset.model,
    requestId: result.id,
    raw: result.raw
  };
}

function renderAsrPrompt(prompt: string, deps: AsrPluginDeps): string {
  if (!deps.promptRenderer) throw new Error("prompt_context_runtime_required");
  const renderer = typeof deps.promptRenderer === "function" ? deps.promptRenderer() : deps.promptRenderer;
  return renderer.renderText(prompt);
}

function requireSingleToolCall(toolCalls: LLMToolCall[] | undefined, toolName: string): LLMToolCall {
  if (!toolCalls?.length) throw new Error("multimodal_llm_asr_missing_tool_call");
  if (toolCalls.length !== 1) throw new Error("multimodal_llm_asr_unexpected_tool_call_count");
  const call = toolCalls[0];
  if (call.function.name !== toolName) throw new Error(`multimodal_llm_asr_unexpected_tool_call:${call.function.name}`);
  return call;
}

function parseSubmitAudioContextArguments(raw: string): { speakText: string; emotion: string; description: string } {
  const parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
  if (typeof parsed.speakText !== "string" || typeof parsed.emotion !== "string" || typeof parsed.description !== "string") {
    throw new Error("multimodal_llm_asr_invalid_tool_arguments");
  }
  return {
    speakText: parsed.speakText,
    emotion: parsed.emotion,
    description: parsed.description
  };
}

function renderSubmitAudioContextText(args: { speakText: string; emotion: string; description: string }): string {
  const speakText = args.speakText.trim();
  if (speakText) return `[语音][${args.emotion.trim()}]${speakText}`;
  return `[语音][${args.description.trim()}]`;
}
