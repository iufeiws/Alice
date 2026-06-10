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

import { readTtsPluginConfig, selectedTtsConversionProvider, ttsGenieOverrides } from "./config.js";
import { createTtsConversionSynthesizer } from "./conversion.js";
import { streamAudioWithSymbolSilence, streamTtsText } from "./stream.js";
import { resolveTtsText } from "./translation.js";

export function createTtsPlugin(deps: TtsPluginDeps): TtsPlugin {
  const config = readTtsPluginConfig(deps.configPath);

  return {
    id: "tts",
    config,
    voiceSynthesizer: createTtsRoutingSynthesizer(deps)
  };
}

export function createTtsTranslationSynthesizer(
  config: TtsPluginConfig,
  deps: TtsPluginDeps
): TtsSynthesizer {
  const base = deps.baseSynthesizer;
  const synthesize = (async (input) => {
    const ttsText = await resolveTtsText(input.text, config, deps);
    deps.appendLog?.("info", `tts synthesis start: chars=${Array.from(ttsText).length}`);
    const conversion = selectedTtsConversionProvider(config);
    const conversionSynthesizer = createTtsConversionSynthesizer(conversion, config, deps);
    const result = conversionSynthesizer
      ? await conversionSynthesizer({
        ...input,
        text: ttsText
      })
      : await base({
      ...input,
      text: ttsText,
      genie: ttsGenieOverrides(config)
    });
    deps.appendLog?.("info", `tts synthesis complete: asset=${result.assetId}`);
    return result;
  }) as TtsSynthesizer;

  synthesize.stream = (input) => streamTtsText(input, config, deps);
  synthesize.streamAudio = base.streamAudio?.bind(base);
  synthesize.streamAudioWithText = streamAudioWithSymbolSilence(base);
  synthesize.noteActivity = () => base.noteActivity?.();
  synthesize.prepare = async () => {
    base.noteActivity?.();
    await base.prepare?.();
  };
  synthesize.shutdown = async () => {
    await base.shutdown?.();
  };
  return synthesize;
}

function createTtsRoutingSynthesizer(deps: TtsPluginDeps): TtsSynthesizer {
  const base = deps.baseSynthesizer;
  const synthesize = (async (input) => {
    const config = readTtsPluginConfig(deps.configPath);
    if (!config.enabled) return base(input);
    const ttsText = await resolveTtsText(input.text, config, deps);
    deps.appendLog?.("info", `tts synthesis start: chars=${Array.from(ttsText).length}`);
    const conversion = selectedTtsConversionProvider(config);
    const conversionSynthesizer = createTtsConversionSynthesizer(conversion, config, deps);
    const result = conversionSynthesizer
      ? await conversionSynthesizer({
        ...input,
        text: ttsText
      })
      : await base({
      ...input,
      text: ttsText,
      genie: ttsGenieOverrides(config)
    });
    deps.appendLog?.("info", `tts synthesis complete: asset=${result.assetId}`);
    return result;
  }) as TtsSynthesizer;

  synthesize.stream = (input) => {
    const config = readTtsPluginConfig(deps.configPath);
    return streamTtsText(input, config, deps);
  };
  synthesize.streamAudio = base.streamAudio?.bind(base);
  synthesize.streamAudioWithText = streamAudioWithSymbolSilence(base);
  synthesize.noteActivity = () => base.noteActivity?.();
  synthesize.prepare = async () => {
    base.noteActivity?.();
    await base.prepare?.();
  };
  synthesize.shutdown = async () => {
    await base.shutdown?.();
  };
  return synthesize;
}
