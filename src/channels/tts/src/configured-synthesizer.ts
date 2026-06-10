const fs = await import("node:fs");
const path = await import("node:path");
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

import { readTtsPluginConfig } from "./config.js";
import { createGenieTtsVoiceSynthesizer, isRemoteGenieProtocolError } from "./genie-synthesizer.js";
import { createMossOnnxVoiceSynthesizer } from "./moss-synthesizer.js";
import { normalizeBaseURL, requireAssetDirectory, requireAssetPath, requireGenieReferenceText, resolveAssetScopedPath } from "./internal.js";

export function createConfiguredVoiceSynthesizer(input?: TTSConfig, deps: ConfiguredVoiceSynthesizerDeps = {}): VoiceSynthesizer {
  const config = input ?? { backend: "genie-tts" as const };
  const disableMoss = Boolean(
    process.env.DISABLE_MOSS_TTS === "1" ||
    String(process.env.DISABLE_MOSS_TTS || "").toLowerCase() === "true" ||
    Boolean((input as any)?.disableMoss)
  );
  let moss: VoiceSynthesizer | undefined = undefined;
  if (!disableMoss) {
    moss = createMossOnnxVoiceSynthesizer({ ...config, backend: "moss-onnx" }, deps);
    if (config.backend === "moss-onnx") return moss;
  } else {
    if (config.backend === "moss-onnx") {
      throw new Error("MOSS TTS is disabled by DISABLE_MOSS_TTS");
    }
  }
  const genieReadinessError = getGenieReadinessError(config);
  if (genieReadinessError) {
    deps.appendLog?.("warn", `genie tts unavailable; falling back to moss: ${genieReadinessError}`);
    if (disableMoss) {
      throw new Error(`Genie TTS unavailable and MOSS is disabled: ${genieReadinessError}`);
    }
    if (!moss) {
      moss = createMossOnnxVoiceSynthesizer({ ...config, backend: "moss-onnx" }, deps);
    }
    return moss as VoiceSynthesizer;
  }
  const genie = createGenieTtsVoiceSynthesizer(config, deps);
  const fallbackMoss = moss;
  let genieHasSynthesized = false;
  let useMossFallback = false;
  const synthesize = (async (request) => {
    if (useMossFallback) return fallbackMoss?.(request) ?? Promise.reject(new Error("MOSS TTS is disabled"));
    try {
      const result = await genie(request);
      genieHasSynthesized = true;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!genieHasSynthesized && isGenieStartupFallbackError(message)) {
        useMossFallback = true;
        deps.appendLog?.("warn", `genie tts startup failed; falling back to moss: ${message}`);
        return fallbackMoss?.(request) ?? Promise.reject(new Error("MOSS TTS is disabled"));
      }
      throw error;
    }
  }) as VoiceSynthesizer;
  synthesize.noteActivity = () => {
    if (!useMossFallback) genie.noteActivity?.();
    fallbackMoss?.noteActivity?.();
  };
  synthesize.streamAudio = async function* (request) {
    if (useMossFallback || !genie.streamAudio) {
      throw new Error("Genie TTS stream is unavailable while using MOSS fallback");
    }
    try {
      yield* genie.streamAudio(request);
      genieHasSynthesized = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!genieHasSynthesized && isGenieStartupFallbackError(message)) {
        useMossFallback = true;
        deps.appendLog?.("warn", `genie tts stream failed; falling back to moss for non-stream synthesis: ${message}`);
      }
      throw error;
    }
  };
  synthesize.streamAudioWithText = async function* (request) {
    if (useMossFallback || !genie.streamAudioWithText) {
      throw new Error("Genie TTS text stream is unavailable while using MOSS fallback");
    }
    try {
      yield* genie.streamAudioWithText(request);
      genieHasSynthesized = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!genieHasSynthesized && isGenieStartupFallbackError(message)) {
        useMossFallback = true;
        deps.appendLog?.("warn", `genie tts text stream failed; falling back to moss for non-stream synthesis: ${message}`);
      }
      throw error;
    }
  };
  synthesize.prepare = async () => {
    if (useMossFallback) {
      await fallbackMoss?.prepare?.();
      return;
    }
    try {
      await genie.prepare?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isGenieStartupFallbackError(message)) {
        useMossFallback = true;
        deps.appendLog?.("warn", `genie tts prepare failed; falling back to moss: ${message}`);
        await fallbackMoss?.prepare?.();
        return;
      }
      throw error;
    }
  };
  synthesize.shutdown = async () => {
    await genie.shutdown?.();
    await fallbackMoss?.shutdown?.();
  };
  return synthesize;
}

export function createTtsRemoteAwareVoiceSynthesizer(
  input: TTSConfig & { ttsConfigPath?: string },
  deps: ConfiguredVoiceSynthesizerDeps = {}
): VoiceSynthesizer {
  const local = createGenieTtsVoiceSynthesizer({
    ...input,
    backend: "genie-tts",
    genieBaseURL: undefined,
    genieBaseURLExplicit: false,
    genieUseStreamForSynthesis: true
  }, deps);
  const remotes = new Map<string, VoiceSynthesizer>();

  const remoteFor = (baseURL: string): VoiceSynthesizer => {
    const normalized = normalizeBaseURL(baseURL);
    const existing = remotes.get(normalized);
    if (existing) return existing;
    const remote = createGenieTtsVoiceSynthesizer({
      ...input,
      backend: "genie-tts",
      genieBaseURL: normalized,
      genieBaseURLExplicit: true,
      genieIdleShutdownMs: 0,
      genieUseStreamForSynthesis: true
    }, deps);
    remotes.set(normalized, remote);
    return remote;
  };

  const selectedRemote = (): VoiceSynthesizer | undefined => {
    const pluginConfig = readTtsPluginConfig(input.ttsConfigPath);
    const genie = pluginConfig.conversion?.genie ?? pluginConfig.remote;
    if (!genie?.enabled) return undefined;
    const baseURL = normalizeBaseURL(genie.baseURL || "");
    return baseURL ? remoteFor(baseURL) : undefined;
  };

  const synthesize = (async (request) => {
    const remote = selectedRemote();
    if (!remote) return local(request);
    try {
      return await remote(request);
    } catch (error) {
      if (isRemoteGenieProtocolError(error)) throw error;
      deps.appendLog?.("warn", `tts remote Genie failed; falling back to local Genie: ${error instanceof Error ? error.message : String(error)}`);
      return local(request);
    }
  }) as VoiceSynthesizer;

  synthesize.streamAudio = async function* (request) {
    const remote = selectedRemote();
    if (!remote?.streamAudio) {
      deps.appendLog?.("info", "tts remote-aware stream using local Genie: remote unavailable");
      if (!local.streamAudio) throw new Error("Local Genie TTS stream is unavailable");
      yield* local.streamAudio(request);
      return;
    }
    let yielded = false;
    try {
      deps.appendLog?.("info", `tts remote-aware stream using remote Genie: chars=${Array.from(request.text).length}`);
      for await (const chunk of remote.streamAudio(request)) {
        yielded = true;
        yield chunk;
      }
      deps.appendLog?.("info", "tts remote-aware stream remote complete");
    } catch (error) {
      if (yielded) throw error;
      if (isRemoteGenieProtocolError(error)) throw error;
      deps.appendLog?.("warn", `tts remote Genie stream failed before audio; falling back to local Genie: ${error instanceof Error ? error.message : String(error)}`);
      if (!local.streamAudio) throw new Error("Local Genie TTS stream is unavailable");
      yield* local.streamAudio(request);
    }
  };
  synthesize.streamAudioWithText = async function* (request) {
    const remote = selectedRemote();
    if (!remote?.streamAudioWithText) {
      deps.appendLog?.("info", "tts remote-aware text stream using local Genie: remote unavailable");
      if (local.streamAudioWithText) {
        yield* local.streamAudioWithText(request);
        return;
      }
      if (!local.streamAudio) throw new Error("Local Genie TTS stream is unavailable");
      for await (const chunk of local.streamAudio(request)) yield { chunk };
      return;
    }
    let yielded = false;
    try {
      deps.appendLog?.("info", `tts remote-aware text stream using remote Genie: chars=${Array.from(request.text).length}`);
      for await (const chunk of remote.streamAudioWithText(request)) {
        yielded = true;
        yield chunk;
      }
      deps.appendLog?.("info", "tts remote-aware text stream remote complete");
    } catch (error) {
      if (yielded) throw error;
      if (isRemoteGenieProtocolError(error)) throw error;
      deps.appendLog?.("warn", `tts remote Genie text stream failed before audio; falling back to local Genie: ${error instanceof Error ? error.message : String(error)}`);
      if (local.streamAudioWithText) {
        yield* local.streamAudioWithText(request);
        return;
      }
      if (!local.streamAudio) throw new Error("Local Genie TTS stream is unavailable");
      for await (const chunk of local.streamAudio(request)) yield { chunk };
    }
  };
  synthesize.noteActivity = () => {
    selectedRemote()?.noteActivity?.();
    local.noteActivity?.();
  };
  synthesize.prepare = async () => {
    const remote = selectedRemote();
    if (remote) {
      try {
        await remote.prepare?.();
        return;
      } catch (error) {
        deps.appendLog?.("warn", `tts remote Genie prepare failed; falling back to local Genie: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await local.prepare?.();
  };
  synthesize.shutdown = async () => {
    await Promise.all([...remotes.values()].map((remote) => remote.shutdown?.()));
    await local.shutdown?.();
  };
  return synthesize;
}

export function createFallbackVoiceSynthesizer(
  primary: VoiceSynthesizer,
  fallback: VoiceSynthesizer,
  deps: FallbackVoiceSynthesizerDeps = {}
): VoiceSynthesizer {
  let useFallback = false;
  const synthesize = (async (request) => {
    if (useFallback) return fallback(request);
    try {
      return await primary(request);
    } catch (error) {
      useFallback = true;
      deps.appendLog?.("warn", `voice tts primary failed; falling back to local Genie: ${error instanceof Error ? error.message : String(error)}`);
      return fallback(request);
    }
  }) as VoiceSynthesizer;
  synthesize.streamAudio = async function* (request) {
    if (useFallback) {
      if (!fallback.streamAudio) throw new Error("Fallback voice TTS stream is unavailable");
      yield* fallback.streamAudio(request);
      return;
    }
    if (!primary.streamAudio) {
      useFallback = true;
      deps.appendLog?.("warn", "voice tts primary stream unavailable; falling back to local Genie");
      if (!fallback.streamAudio) throw new Error("Fallback voice TTS stream is unavailable");
      yield* fallback.streamAudio(request);
      return;
    }
    let yielded = false;
    try {
      for await (const chunk of primary.streamAudio(request)) {
        yielded = true;
        yield chunk;
      }
    } catch (error) {
      if (yielded) throw error;
      useFallback = true;
      deps.appendLog?.("warn", `voice tts primary stream failed before audio; falling back to local Genie: ${error instanceof Error ? error.message : String(error)}`);
      if (!fallback.streamAudio) throw new Error("Fallback voice TTS stream is unavailable");
      yield* fallback.streamAudio(request);
    }
  };
  synthesize.streamAudioWithText = async function* (request) {
    if (useFallback) {
      if (fallback.streamAudioWithText) {
        yield* fallback.streamAudioWithText(request);
        return;
      }
      if (!fallback.streamAudio) throw new Error("Fallback voice TTS stream is unavailable");
      for await (const chunk of fallback.streamAudio(request)) yield { chunk };
      return;
    }
    const primaryStream = primary.streamAudioWithText ?? (primary.streamAudio
      ? async function* (input: VoiceSynthesisInput) {
        for await (const chunk of primary.streamAudio!(input)) yield { chunk };
      }
      : undefined);
    if (!primaryStream) {
      useFallback = true;
      deps.appendLog?.("warn", "voice tts primary text stream unavailable; falling back to local Genie");
      if (fallback.streamAudioWithText) {
        yield* fallback.streamAudioWithText(request);
        return;
      }
      if (!fallback.streamAudio) throw new Error("Fallback voice TTS stream is unavailable");
      for await (const chunk of fallback.streamAudio(request)) yield { chunk };
      return;
    }
    let yielded = false;
    try {
      for await (const chunk of primaryStream(request)) {
        yielded = true;
        yield chunk;
      }
    } catch (error) {
      if (yielded) throw error;
      useFallback = true;
      deps.appendLog?.("warn", `voice tts primary text stream failed before audio; falling back to local Genie: ${error instanceof Error ? error.message : String(error)}`);
      if (fallback.streamAudioWithText) {
        yield* fallback.streamAudioWithText(request);
        return;
      }
      if (!fallback.streamAudio) throw new Error("Fallback voice TTS stream is unavailable");
      for await (const chunk of fallback.streamAudio(request)) yield { chunk };
    }
  };
  synthesize.noteActivity = () => {
    primary.noteActivity?.();
    fallback.noteActivity?.();
  };
  synthesize.prepare = async () => {
    if (useFallback) {
      await fallback.prepare?.();
      return;
    }
    try {
      await primary.prepare?.();
    } catch (error) {
      useFallback = true;
      deps.appendLog?.("warn", `voice tts primary prepare failed; falling back to local Genie: ${error instanceof Error ? error.message : String(error)}`);
      await fallback.prepare?.();
    }
  };
  synthesize.shutdown = async () => {
    await primary.shutdown?.();
    await fallback.shutdown?.();
  };
  return synthesize;
}

function getGenieReadinessError(input: TTSConfig): string | undefined {
  if (input.genieBaseURLExplicit) return undefined;
  const dataDir = input.genieDataDir ?? "assets/tts/genie/GenieData";
  const modelDir = input.genieModelDir ?? "assets/tts/genie/models/alice";
  const referenceAudio = input.genieReferenceAudio ?? input.mossReferenceAudio ?? "assets/tts/references/alice/reference.wav";
  const referenceText = input.genieReferenceText ?? referenceTextPath(referenceAudio);
  const modelPath = resolveAssetScopedPath(modelDir);
  try {
    requireAssetDirectory(dataDir, "Genie TTS data directory was not found");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!fs.existsSync(modelPath)) return `Genie model directory was not found: ${modelPath}`;
  if (!containsFileWithExtension(modelPath, ".onnx")) return `Genie model directory has no ONNX files: ${modelPath}`;
  try {
    requireAssetPath(referenceAudio, "Genie TTS reference audio was not found");
    requireGenieReferenceText(referenceText, "Genie TTS reference text was not found");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

function containsFileWithExtension(dir: string, extension: string): boolean {
  try {
    for (const name of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, name);
      const stat = fs.statSync(fullPath);
      if (stat.isFile() && path.extname(name).toLowerCase() === extension) return true;
      if (!stat.isFile() && containsFileWithExtension(fullPath, extension)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function referenceTextPath(referenceAudio: string): string {
  return referenceAudio.replace(/\.[^./\\]+$/, "") + ".txt";
}

function isGenieStartupFallbackError(message: string): boolean {
  return /load|reference|not healthy|did not become healthy|exited before ready|model directory|reference text|reference audio/i.test(message);
}
