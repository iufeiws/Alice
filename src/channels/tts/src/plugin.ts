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

import { readTtsPluginConfig, ttsGenieOverrides } from "./config.js";
import { streamAudioWithSymbolSilence, streamTtsText } from "./stream.js";
import { resolveTtsText } from "./translation.js";
import { synthesizeTtsRouted } from "./router.js";

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
    const result = await synthesizeTtsRouted({
      ...input,
      text: ttsText
    }, config, deps, { genie: ttsGenieOverrides(config) });
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
    const result = await synthesizeTtsRouted({
      ...input,
      text: ttsText
    }, config, deps, { genie: ttsGenieOverrides(config) });
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
