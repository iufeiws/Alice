import type {
  ConfiguredVoiceSynthesizerDeps,
  FallbackVoiceSynthesizerDeps,
  MossOnnxVoiceSynthesizerDeps,
  TTSConfig,
  TtsApiPreset,
  TtsAudioTextChunk,
  TtsBailianConversionConfig,
  TtsConversionConfig,
  TtsOpenAiApiConversionConfig,
  TtsPlugin,
  TtsPluginConfig,
  TtsPluginDeps,
  TtsStreamChunk,
  TtsStreamInput,
  TtsSynthesizer,
  TtsTranslationPreset,
  TtsVoiceModelConfig,
  VoiceSynthesisInput,
  VoiceSynthesizer
} from "./types.js";

import { renderTtsPrompt, resolveEffectivePreset } from "./config.js";
import { ttsSymbolOnlyInput } from "./router.js";

export async function resolveTtsText(text: string, config: TtsPluginConfig, deps: TtsPluginDeps): Promise<string> {
  const symbolOnly = ttsSymbolOnlyInput(text);
  if (symbolOnly) {
    deps.appendLog?.("info", `tts translation skipped: symbol-only chars=${Array.from(text).length} symbols=${symbolOnly.symbols}`);
    return text;
  }
  if (!config.translationEnabled) {
    deps.appendLog?.("info", `tts translation skipped: disabled chars=${Array.from(text).length}`);
    return text;
  }
  const translated = await translateTtsText(text, config, deps);
  if (!translated) throw new Error("tts translation failed; no fallback configured");
  return translated;
}

export async function translateTtsText(text: string, config: TtsPluginConfig, deps: TtsPluginDeps): Promise<string | undefined> {
  const symbolOnly = ttsSymbolOnlyInput(text);
  if (symbolOnly) {
    deps.appendLog?.("info", `tts translation skipped: symbol-only chars=${Array.from(text).length} symbols=${symbolOnly.symbols}`);
    return text;
  }
  const preset = resolveEffectivePreset(config, deps);
  const client = deps.llm ?? (preset ? deps.createLlmClientFromPreset?.(preset, deps.env ?? process.env) : undefined);
  if (!client && !deps.llmRequestSender) {
    deps.appendLog?.("warn", "tts translation skipped: missing api preset baseURL or api key");
    return undefined;
  }

  try {
    deps.appendLog?.("info", `tts translation start: chars=${Array.from(text).length}`);
    const legacyPreset = config.api_preset ?? { baseURL: "", model: "flash", temperature: 0.2, extraParams: {} };
    const request = {
      agentId: "tts",
      ...(client ? { client } : {}),
      messages: [
        { role: "system" as const, content: renderTtsPrompt(config, deps) },
        { role: "user" as const, content: text }
      ],
      model: preset?.model ?? legacyPreset.model,
      temperature: preset?.temperature ?? legacyPreset.temperature,
      extraParams: preset?.extraParams ?? legacyPreset.extraParams,
      toolNames: [],
      round: 0,
      stream: false,
      metadata: { pluginId: "tts", route: "send_chat.voice.before_tts" }
    };
    const result = deps.llmRequestSender
      ? await deps.llmRequestSender(request)
      : await client!.chat({
        messages: request.messages,
        model: request.model,
        temperature: request.temperature,
        extraParams: request.extraParams
      });
    const translated = result.message.content.trim();
    if (!translated) {
      deps.appendLog?.("warn", "tts translation returned empty text");
      return undefined;
    }
    deps.appendLog?.("info", `tts translation complete: chars=${Array.from(translated).length}`);
    return translated;
  } catch (error) {
    deps.appendLog?.("warn", `tts translation failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
