import { createOpenAICompatibleClient, type LLMClient } from "../../llm-gateway/src/index.js";
import { createBailianTtsVoiceSynthesizer, createMimoTtsVoiceSynthesizer, createOpenAiApiTtsVoiceSynthesizer, createTtsRemoteAwareVoiceSynthesizer, selectedTtsPreset, translateTtsText, ttsGenieOverrides, type TtsLlmClient, type VoiceSynthesizer } from "../../../channels/tts/src/index.js";
import { ttsAudioUrl } from "../../../channels/tts/src/admin-assets.js";
import { readLLMApiPresets } from "../../llm-gateway/src/admin-presets.js";
import { requiredString } from "../../../shared/admin-input/src/index.js";
import type { AdminRuntimeContext as AdminRoutesContext } from "../../../apps/api/bootstrap/admin-route-context.js";
import { readTtsConfigForAdmin, ttsConfigPath } from "./admin-plugin-tts-config.js";

export async function testTtsPlugin(context: AdminRoutesContext, input: Record<string, unknown>): Promise<{ ok: true; result?: unknown } | { error: string }> {
  const config = readTtsConfigForAdmin(context);
  const text = requiredString(input.text);
  if (!text) return { error: "text_required" };
  if (Array.from(text).length > 240) return { error: "text_too_long" };

  const totalStartedAt = Date.now();
  let translatedText = text;
  let translationMs = 0;
  if (config.translationEnabled) {
    if (!config.apiPresetName) return { error: "missing_api_preset" };
    const preset = readLLMApiPresets(context).find((entry) => entry.name === config.apiPresetName);
    if (!preset) return { error: "invalid_api_preset" };
    if (!preset.baseURL || !preset.apiKey) return { error: "incomplete_api_preset" };
    const translationStartedAt = Date.now();
    const translated = await translateTtsText(text, config, {
      baseSynthesizer: async () => {
        throw new Error("not used");
      },
      llmRequestSender: context.llmRequestSender ? (request) => context.llmRequestSender!({ ...request, client: request.client as any } as any) as any : undefined,
      llm: createTextOnlyTtsLlmClient(createOpenAICompatibleClient({
        baseURL: preset.baseURL,
        apiKey: preset.apiKey,
        model: preset.model,
        temperature: preset.temperature,
        timeoutMs: preset.timeoutMs,
        useProxy: preset.useProxy === true,
        extraParams: preset.extraParams
      })),
      resolveApiPreset(name) {
        return readLLMApiPresets(context).find((entry) => entry.name === name);
      },
      promptRenderer: () => context.getPromptRenderer(),
      appendLog: context.appendLog
    });
    translationMs = Date.now() - translationStartedAt;
    if (!translated) return { error: "translation_failed" };
    translatedText = translated;
  } else {
    context.appendLog?.("info", `tts admin test translation skipped: disabled chars=${Array.from(text).length}`);
  }

  const ttsStartedAt = Date.now();
  const configuredSynthesizer = context.pluginConfigs?.tts?.testVoiceSynthesizer;
  const activePreset = selectedTtsPreset(config);
  const synthesizer = configuredSynthesizer ?? (
    activePreset.provider === "openai-api"
      ? createOpenAiApiTtsVoiceSynthesizer(config, {
        resolveApiPreset(name) {
          return readLLMApiPresets(context).find((entry) => entry.name === name);
        },
        appendLog: context.appendLog
      })
      : activePreset.provider === "bailian"
        ? createBailianTtsVoiceSynthesizer(config, {
          appendLog: context.appendLog
        })
      : activePreset.provider === "mimo"
        ? createMimoTtsVoiceSynthesizer(config, {
          appendLog: context.appendLog
        })
        : createTtsFallbackTtsSynthesizer(context)
  );
  let voice: Awaited<ReturnType<VoiceSynthesizer>>;
  let ttsMs = 0;
  try {
    voice = await synthesizer({
      text: translatedText,
      time: context.time,
      ...(activePreset.provider === "genie" ? { genie: ttsGenieOverrides(config) } : {})
    });
    ttsMs = Date.now() - ttsStartedAt;
  } finally {
    if (!configuredSynthesizer) await synthesizer.shutdown?.();
  }

  return {
    ok: true,
    result: {
      input: text,
      output: translatedText,
      voice: {
        assetId: voice.assetId,
        filePath: voice.filePath,
        audioUrl: ttsAudioUrl(context, voice.filePath)
      },
      timing: {
        translationMs,
        ttsMs,
        totalMs: Date.now() - totalStartedAt
      }
    }
  };
}

function createTtsFallbackTtsSynthesizer(context: AdminRoutesContext): VoiceSynthesizer {
  return createTtsRemoteAwareVoiceSynthesizer({
    ...context.config.tts,
    ttsConfigPath: ttsConfigPath(context)
  }, {
    appendLog: context.appendLog
  });
}

function createTextOnlyTtsLlmClient(client: LLMClient): TtsLlmClient {
  return {
    async chat(input) {
      const result = await client.chat(input);
      return {
        message: {
          role: result.message.role,
          content: typeof result.message.content === "string" ? result.message.content : ""
        }
      };
    }
  };
}
