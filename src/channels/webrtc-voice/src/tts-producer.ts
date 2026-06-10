import { createCurrentTimeProvider } from "../../../platform/time/src/index.js";
import type { PlaybackItem, PlaybackResult, ServerAudioFrame, ServerOutboundAudioTrack, TtsTask, WebRtcVoiceDeps, WebRtcVoiceTtsArchiveInput } from "./types.js";
import { WebRtcVoiceError } from "./errors.js";
import type { VoicePlaybackConsumer } from "./playback-consumer.js";
import { abortableAsyncIterable, copyUint8Array, hashText, raceWithAbort, sleep, splitTtsPseudoStreamParts, stripParenthesizedText } from "./utils.js";

export function createTtsProducer(ctx: {
  callId: string;
  talkSessionId: string;
  deps: WebRtcVoiceDeps;
  outboundTrack: ServerOutboundAudioTrack;
  playbackQueue: PlaybackItem[];
  activeTtsTasks: Set<TtsTask>;
  playback: VoicePlaybackConsumer;
  synthesisTime: ReturnType<typeof createCurrentTimeProvider>;
  getPlaybackGeneration(): number;
  getInterruptEpoch(): number;
  stampOutboundFrame(frame: ServerAudioFrame): ServerAudioFrame;
  advanceOutboundRtpClockForFrame(frame: ServerAudioFrame): void;
  playbackGateOpen(): boolean;
  archiveTtsOutput(deps: WebRtcVoiceDeps, input: WebRtcVoiceTtsArchiveInput): Promise<void>;
}) {
  const playbackDetail = (item: PlaybackItem, fallback?: string) => {
    const output = item.outputId ?? fallback;
    if (!output && !item.chunkId) return fallback ?? "";
    return `${output ?? ""}${item.chunkId ? ` chunk=${item.chunkId}` : ""}`;
  };
  const waitForPlaybackItemSettled = async (item: PlaybackItem) => {
    while (ctx.playbackQueue.includes(item) && item.status !== "failed" && item.status !== "interrupted" && item.status !== "cancelled") {
      ctx.playback.cleanupFinishedItems();
      if (!ctx.playbackQueue.includes(item)) break;
      await sleep(5);
    }
  };
  return {
    async playReplyText(text: string | AsyncIterable<string>, outputId?: string, options?: unknown): Promise<PlaybackResult> {
      const originalText = playbackOptionString(options, "originalText") ?? (typeof text === "string" ? text : "");
      const speakText = typeof text === "string" && ctx.deps.config.ttsTextFilter?.stripParenthesized ? stripParenthesizedText(text) : text;
      const speakTextForMeta = typeof speakText === "string" ? speakText : originalText;
      const createdAt = (ctx.deps.now?.() ?? new Date()).toISOString();
      const generation = ctx.getPlaybackGeneration();
      let frameCount = 0;
      const item: PlaybackItem = {
        outputId,
        chunkId: playbackOptionString(options, "chunkId"),
        originalText,
        speakText: speakTextForMeta,
        textHash: hashText(speakTextForMeta),
        assetId: "",
        filePath: "",
        status: "queued",
        createdAt,
        framesWritten: 0,
        playedMs: 0,
        totalMs: 0,
        interruptEpoch: ctx.getInterruptEpoch(),
        streamingTts: Boolean(ctx.deps.voiceSynthesizer.stream),
        ttsAudioTextSpans: [],
        queuedFrames: 0,
        producerDone: false,
        pendingPlaybackEvents: 0,
        beforeFirstPlayback: playbackOptionCallback(options, "beforeFirstPlayback")
      };
      ctx.playbackQueue.push(item);
      const ttsTask: TtsTask = {
        id: `tts:${ctx.callId}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
        outputId,
        controller: new AbortController()
      };
      ctx.activeTtsTasks.add(ttsTask);
      try {
      let ttsStreamSettledNotified = false;
      const notifyTtsStreamSettled = async () => {
        if (ttsStreamSettledNotified) return;
        ttsStreamSettledNotified = true;
        try {
          await playbackOptionCallback(options, "onTtsStreamSettled")?.();
        } catch (error) {
          ctx.deps.emitStatus?.({ state: "tts.stream.settled_callback_failed", detail: error instanceof Error ? error.message : String(error) });
        }
      };
      let ready: boolean | undefined;
      try {
        ready = await raceWithAbort(Promise.resolve(ctx.outboundTrack.waitUntilReady?.(ctx.deps.config.timeouts.ttsPlaybackStartMs)), ttsTask.controller.signal);
      } catch (error) {
        if (ttsTask.controller.signal.aborted) {
          item.status = "interrupted";
          return { status: "interrupted", outputId, frameCount: 0 };
        }
        throw error;
      }
      if (ready === false) {
        item.status = "failed";
        ctx.playbackQueue.shift();
        ctx.deps.emitStatus?.({ state: "tts.failed", detail: "outbound_audio_not_ready" });
        return {
          status: "interrupted",
          outputId,
          frameCount: 0,
          failureReason: "outbound_audio_not_ready"
        };
      }
      if (ctx.deps.voiceSynthesizer.stream && (ctx.deps.encodePcmL16StreamToFrames || ctx.deps.encodePcmL16ToFrames)) {
        ctx.deps.emitStatus?.({ state: "tts.stream.started", detail: outputId });
        const ttsEvents = ctx.deps.voiceSynthesizer.stream({
          text: speakText,
          time: ctx.synthesisTime,
          source: "send_chat.voice",
          streamId: outputId
        });
        const archiveAudioChunks: Uint8Array[] = [];
        let inputSampleRateHz = 32_000;
        let inputChannels = 1;
        if (ctx.deps.encodePcmL16StreamToFrames) {
          ctx.playback.start();
          let audioChunks = 0;
          let audioBytes = 0;
          let encodedFrames = 0;
          const ttsIterator = abortableAsyncIterable(ttsEvents, ttsTask.controller.signal)[Symbol.asyncIterator]();
          let firstAudioEvent: any;
          while (!ttsTask.controller.signal.aborted && generation === ctx.getPlaybackGeneration() && ctx.playbackQueue.includes(item)) {
            const next = await ttsIterator.next();
            if (next.done) break;
            const event = next.value;
            if (event.type === "translation_started") {
              ctx.deps.emitStatus?.({ state: "tts.stream.translation_started", detail: `${event.sequence}:${event.sourceChars}` });
              continue;
            }
            if (event.type === "translation_done") {
              ctx.deps.emitStatus?.({ state: "tts.stream.translation_done", detail: `${event.sequence}:${event.translatedChars}` });
              continue;
            }
            if (event.type === "part_done") {
              ctx.deps.emitStatus?.({ state: "tts.stream.part_done", detail: String(event.sequence) });
              continue;
            }
            if (event.type === "done") {
              ctx.deps.emitStatus?.({ state: "tts.stream.done", detail: outputId });
              break;
            }
            if (event.type !== "audio") continue;
            firstAudioEvent = event;
            break;
          }
          inputSampleRateHz = firstAudioEvent?.sampleRateHz ?? 32_000;
          inputChannels = firstAudioEvent?.channels ?? 1;
          const pcmChunks = async function* () {
            if (firstAudioEvent) {
              const firstSoundChunk = firstAudioEvent.soundchunk ?? firstAudioEvent.chunk;
              const firstTextChunk = firstAudioEvent.textchunk ?? firstAudioEvent.text;
              audioChunks += 1;
              audioBytes += firstSoundChunk.byteLength;
              archiveAudioChunks.push(copyUint8Array(firstSoundChunk));
              ctx.playback.recordAudioTextSpan(item, firstTextChunk, firstSoundChunk, {
                sampleRateHz: firstAudioEvent.sampleRateHz ?? inputSampleRateHz,
                channels: firstAudioEvent.channels ?? inputChannels
              });
              ctx.deps.emitStatus?.({ state: "tts.stream.audio_chunk", detail: `${audioChunks}:${audioBytes}:${inputSampleRateHz}Hz` });
              yield firstSoundChunk;
            }
            while (true) {
              const next = await ttsIterator.next();
              if (next.done) break;
              const event = next.value;
              if (ttsTask.controller.signal.aborted || generation !== ctx.getPlaybackGeneration() || !ctx.playbackQueue.includes(item)) break;
              if (event.type === "translation_started") {
                ctx.deps.emitStatus?.({ state: "tts.stream.translation_started", detail: `${event.sequence}:${event.sourceChars}` });
                continue;
              }
              if (event.type === "translation_done") {
                ctx.deps.emitStatus?.({ state: "tts.stream.translation_done", detail: `${event.sequence}:${event.translatedChars}` });
                continue;
              }
              if (event.type === "part_done") {
                ctx.deps.emitStatus?.({ state: "tts.stream.part_done", detail: String(event.sequence) });
                continue;
              }
              if (event.type === "done") {
                ctx.deps.emitStatus?.({ state: "tts.stream.done", detail: outputId });
                break;
              }
              if (event.type !== "audio") continue;
              const soundChunk = event.soundchunk ?? event.chunk;
              const textChunk = event.textchunk ?? event.text;
              audioChunks += 1;
              audioBytes += soundChunk.byteLength;
              archiveAudioChunks.push(copyUint8Array(soundChunk));
              ctx.playback.recordAudioTextSpan(item, textChunk, soundChunk, {
                sampleRateHz: event.sampleRateHz ?? inputSampleRateHz,
                channels: event.channels ?? inputChannels
              });
              if (audioChunks === 1 || audioChunks % 20 === 0) {
                ctx.deps.emitStatus?.({ state: "tts.stream.audio_chunk", detail: `${audioChunks}:${audioBytes}:${event.sampleRateHz ?? inputSampleRateHz}Hz` });
              }
              yield soundChunk;
            }
          };
          const producer = (async () => {
            try {
              let encodedMs = 0;
              for await (const frame of ctx.deps.encodePcmL16StreamToFrames!({
                chunks: pcmChunks(),
                inputSampleRateHz,
                inputChannels,
                sampleRateHz: ctx.deps.config.outboundAudio.sampleRateHz,
                channels: ctx.deps.config.outboundAudio.channels,
                frameMs: ctx.deps.config.outboundAudio.frameMs
              })) {
                encodedFrames += 1;
                ctx.playback.enqueueFrame(item, frame, encodedMs);
                encodedMs += frame.durationMs;
                item.totalMs = Math.max(item.totalMs ?? 0, encodedMs);
              }
              item.producerDone = true;
              ctx.deps.emitStatus?.({ state: "tts.queue.producer_done", detail: `${playbackDetail(item, outputId)} chunks=${audioChunks} encoded=${encodedFrames} queued=${item.queuedFrames ?? 0}`.trim() });
            } catch (error) {
              item.status = ttsTask.controller.signal.aborted ? "interrupted" : "failed";
              item.producerDone = true;
              throw error;
            } finally {
              if (encodedFrames > 0) await notifyTtsStreamSettled();
            }
          })();
          const minBufferedFrames = Math.max(20, Math.ceil(1200 / ctx.deps.config.outboundAudio.frameMs));
          ctx.deps.emitStatus?.({ state: "tts.queue.waiting", detail: `min=${minBufferedFrames} queued=${item.queuedFrames ?? 0}` });
          await producer;
          ctx.deps.emitStatus?.({ state: "tts.queue.ready", detail: `queued=${item.queuedFrames ?? 0} closed=true` });
          frameCount = item.queuedFrames ?? 0;
          const failed = item.status === "failed" || frameCount <= 0;
          const interrupted = !failed && (ttsTask.controller.signal.aborted || generation !== ctx.getPlaybackGeneration() || !ctx.playbackQueue.includes(item));
          if (failed) item.status = "failed";
          else if (interrupted) item.status = "interrupted";
          else if (item.status !== "playing") item.status = "queued";
          let finalStatus: PlaybackResult["status"];
          let archiveStatus: "interrupted" | "failed" | "played";
          if (interrupted || failed) {
            const queueIndex = ctx.playbackQueue.indexOf(item);
            if (queueIndex >= 0) ctx.playbackQueue.splice(queueIndex, 1);
            ctx.deps.emitStatus?.({ state: interrupted ? "tts.interrupted" : "tts.failed", detail: `${playbackDetail(item, outputId)}${frameCount > 0 ? "" : " no_frames_sent"}`.trim() });
            finalStatus = "interrupted";
            archiveStatus = interrupted ? "interrupted" : "failed";
          } else {
            ctx.playback.cleanupFinishedItems();
            await waitForPlaybackItemSettled(item);
            const settledStatus = item.status as PlaybackItem["status"];
            finalStatus = settledStatus === "played" ? "played" : "interrupted";
            archiveStatus = settledStatus === "played" ? "played" : settledStatus === "failed" ? "failed" : "interrupted";
          }
          if (archiveAudioChunks.length > 0) {
            await ctx.archiveTtsOutput(ctx.deps, {
              callId: ctx.callId,
              talkSessionId: ctx.talkSessionId,
              outputId,
              chunkId: item.chunkId,
              text: originalText,
              speakText: speakTextForMeta,
              createdAt,
              status: archiveStatus,
              source: "stream",
              audio: {
                chunks: archiveAudioChunks,
                sampleRateHz: inputSampleRateHz,
                channels: inputChannels,
                encoding: "pcm_s16le"
              }
            });
          }
          return {
            status: finalStatus,
            outputId,
            frameCount,
            failureReason: failed ? "no_frames_sent" : undefined
          };
        } else if (ctx.deps.encodePcmL16ToFrames) {
          if (!await ctx.playback.waitForTurn(item, ctx.playbackGateOpen)) {
            item.status = "interrupted";
            return { status: "interrupted", outputId, frameCount: 0 };
          }
          await playbackOptionCallback(options, "beforeFirstPlayback")?.();
          ctx.deps.emitStatus?.({ state: "voice_call.connected", detail: ctx.talkSessionId });
          try {
          for await (const event of abortableAsyncIterable(ttsEvents, ttsTask.controller.signal)) {
            if (ttsTask.controller.signal.aborted || generation !== ctx.getPlaybackGeneration() || !ctx.playbackQueue.includes(item)) break;
            if (event.type === "translation_started") {
              ctx.deps.emitStatus?.({ state: "tts.stream.translation_started", detail: `${event.sequence}:${event.sourceChars}` });
              continue;
            }
            if (event.type === "translation_done") {
              ctx.deps.emitStatus?.({ state: "tts.stream.translation_done", detail: `${event.sequence}:${event.translatedChars}` });
              continue;
            }
            if (event.type === "part_done") {
              ctx.deps.emitStatus?.({ state: "tts.stream.part_done", detail: String(event.sequence) });
              continue;
            }
            if (event.type === "done") {
              ctx.deps.emitStatus?.({ state: "tts.stream.done", detail: outputId });
              break;
            }
            if (event.type !== "audio") continue;
            const soundChunk = event.soundchunk ?? event.chunk;
            const textChunk = event.textchunk ?? event.text;
            inputSampleRateHz = event.sampleRateHz ?? inputSampleRateHz;
            inputChannels = event.channels ?? inputChannels;
            archiveAudioChunks.push(copyUint8Array(soundChunk));
            ctx.playback.recordAudioTextSpan(item, textChunk, soundChunk, {
              sampleRateHz: inputSampleRateHz,
              channels: inputChannels
            });
            const frames = await raceWithAbort(Promise.resolve(ctx.deps.encodePcmL16ToFrames({
              pcm: soundChunk,
              inputSampleRateHz,
              inputChannels,
              sampleRateHz: ctx.deps.config.outboundAudio.sampleRateHz,
              channels: ctx.deps.config.outboundAudio.channels,
              frameMs: ctx.deps.config.outboundAudio.frameMs
            })), ttsTask.controller.signal);
            const eventTotalMs = frames.reduce((sum, frame) => sum + frame.durationMs, 0);
            for (const frame of frames) {
              if (ttsTask.controller.signal.aborted || generation !== ctx.getPlaybackGeneration() || !ctx.playbackQueue.includes(item)) break;
              const written = await ctx.outboundTrack.writeFrame(ctx.stampOutboundFrame(frame));
              if (written) {
                ctx.advanceOutboundRtpClockForFrame(frame);
                ctx.playback.updateConsumer(item, textChunk, eventTotalMs, { emit: true });
                if (textChunk) ctx.playback.emitPlayingText(textChunk);
                else ctx.playback.reportMissingPlayingText(item, frameCount + 1);
                frameCount += 1;
              item.framesWritten = frameCount;
              item.playedMs = (item.playedMs ?? 0) + frame.durationMs;
              item.totalMs = Math.max(item.totalMs ?? 0, (item.framesWritten ?? 0) * frame.durationMs);
              ctx.playback.advanceConsumer(item, frame.durationMs);
              }
              await (ctx.deps.sleep ?? sleep)(frame.durationMs);
            }
            ctx.deps.emitStatus?.({ state: "tts.stream.frames_sent", detail: `sent=${frameCount}` });
          }
          } finally {
            if (frameCount > 0) await notifyTtsStreamSettled();
          }
        }
        const interrupted = ttsTask.controller.signal.aborted || generation !== ctx.getPlaybackGeneration() || !ctx.playbackQueue.includes(item);
        item.status = interrupted ? "interrupted" : frameCount > 0 ? "played" : "failed";
        if (archiveAudioChunks.length > 0) {
          await ctx.archiveTtsOutput(ctx.deps, {
            callId: ctx.callId,
            talkSessionId: ctx.talkSessionId,
            outputId,
            chunkId: item.chunkId,
            text: originalText,
            speakText: speakTextForMeta,
            createdAt,
            status: item.status,
            source: "stream",
            audio: {
              chunks: archiveAudioChunks,
              sampleRateHz: inputSampleRateHz,
              channels: inputChannels,
              encoding: "pcm_s16le"
            }
          });
        }
        if (ctx.playback.currentPlayingItem() === item) ctx.playback.setCurrentPlayingItem(undefined);
        ctx.playbackQueue.shift();
        ctx.deps.emitStatus?.({ state: interrupted ? "tts.interrupted" : frameCount > 0 ? "tts.played" : "tts.failed", detail: frameCount > 0 ? playbackDetail(item, outputId) : `${playbackDetail(item, outputId)} no_frames_sent`.trim() });
        return {
          status: interrupted || frameCount === 0 ? "interrupted" : "played",
          outputId,
          frameCount,
          failureReason: !interrupted && frameCount === 0 ? "no_frames_sent" : undefined
        };
      }
      if (typeof speakText !== "string") throw new Error("streaming text requires streaming TTS synthesizer");
      const parts = splitTtsPseudoStreamParts(speakText);
      const synthesizePart = async (part: string, partIndex: number) => {
        ctx.deps.emitStatus?.({ state: "tts.part.synthesizing", detail: `${partIndex + 1}/${parts.length}` });
        let voice;
        try {
          voice = await raceWithAbort(Promise.resolve(ctx.deps.voiceSynthesizer({ text: part, time: ctx.synthesisTime })), ttsTask.controller.signal);
        } catch (error) {
          if (ttsTask.controller.signal.aborted) return undefined;
          item.status = "failed";
          throw new WebRtcVoiceError("tts_failed", error instanceof Error ? error.message : String(error));
        }
        ctx.deps.emitStatus?.({ state: "tts.part.synthesized", detail: `${partIndex + 1}/${parts.length}` });
        try {
          return {
            voice,
            frames: await raceWithAbort(Promise.resolve(ctx.deps.decodeAudioFileToFrames({
              filePath: voice.filePath,
              sampleRateHz: ctx.deps.config.outboundAudio.sampleRateHz,
              channels: ctx.deps.config.outboundAudio.channels,
              frameMs: ctx.deps.config.outboundAudio.frameMs
            })), ttsTask.controller.signal)
          };
        } catch (error) {
          if (ttsTask.controller.signal.aborted) return undefined;
          item.status = "failed";
          throw error;
        }
      };
      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        if (ttsTask.controller.signal.aborted || generation !== ctx.getPlaybackGeneration() || !ctx.playbackQueue.includes(item)) break;
        const prepared = await synthesizePart(parts[partIndex]!, partIndex);
        if (!prepared) break;
        item.totalMs = prepared.frames.reduce((sum, frame) => sum + frame.durationMs, 0);
        ctx.playback.updateTextCache(item, parts[partIndex]!, item.totalMs);
        if (!await ctx.playback.waitForTurn(item, ctx.playbackGateOpen)) {
          await ctx.archiveTtsOutput(ctx.deps, {
            callId: ctx.callId,
            talkSessionId: ctx.talkSessionId,
            outputId,
            chunkId: item.chunkId,
            text: parts[partIndex]!,
            speakText: parts[partIndex]!,
            createdAt,
            status: "interrupted",
            source: "file",
            partIndex,
            partCount: parts.length,
            assetId: prepared.voice.assetId,
            filePath: prepared.voice.filePath
          });
          break;
        }
        ctx.playback.updateConsumer(item, parts[partIndex], item.totalMs);
        if (frameCount === 0) await playbackOptionCallback(options, "beforeFirstPlayback")?.();
        ctx.deps.emitStatus?.({ state: "voice_call.connected", detail: ctx.talkSessionId });
        ctx.deps.emitStatus?.({ state: "tts.part.playing", detail: `${partIndex + 1}/${parts.length}` });
        ctx.playback.emitPlayingText(parts[partIndex]);
        ctx.playback.updateConsumer(item, parts[partIndex], item.totalMs, { emit: true });
        item.assetId = prepared.voice.assetId;
        item.filePath = prepared.voice.filePath;
        for (const frame of prepared.frames) {
          if (ttsTask.controller.signal.aborted || generation !== ctx.getPlaybackGeneration() || !ctx.playbackQueue.includes(item)) break;
          const written = await ctx.outboundTrack.writeFrame(ctx.stampOutboundFrame(frame));
          if (written) {
            ctx.advanceOutboundRtpClockForFrame(frame);
            frameCount += 1;
            item.framesWritten = frameCount;
            item.playedMs = (item.playedMs ?? 0) + frame.durationMs;
            item.totalMs = Math.max(item.totalMs ?? 0, (item.framesWritten ?? 0) * frame.durationMs);
            ctx.playback.advanceConsumer(item, frame.durationMs);
          }
          await (ctx.deps.sleep ?? sleep)(frame.durationMs);
        }
        await ctx.archiveTtsOutput(ctx.deps, {
          callId: ctx.callId,
          talkSessionId: ctx.talkSessionId,
          outputId,
          chunkId: item.chunkId,
          text: parts[partIndex]!,
          speakText: parts[partIndex]!,
          createdAt,
          status: ttsTask.controller.signal.aborted || generation !== ctx.getPlaybackGeneration() || !ctx.playbackQueue.includes(item) ? "interrupted" : "played",
          source: "file",
          partIndex,
          partCount: parts.length,
          assetId: prepared.voice.assetId,
          filePath: prepared.voice.filePath
        });
        ctx.deps.emitStatus?.({ state: "tts.part.frames_sent", detail: `${partIndex + 1}/${parts.length}:${frameCount}` });
      }
      const interrupted = ttsTask.controller.signal.aborted || generation !== ctx.getPlaybackGeneration() || !ctx.playbackQueue.includes(item);
      item.status = interrupted ? "interrupted" : frameCount > 0 ? "played" : "failed";
      if (ctx.playback.currentPlayingItem() === item) ctx.playback.setCurrentPlayingItem(undefined);
      ctx.playbackQueue.shift();
      ctx.deps.emitStatus?.({ state: interrupted ? "tts.interrupted" : frameCount > 0 ? "tts.played" : "tts.failed", detail: frameCount > 0 ? playbackDetail(item, outputId) : `${playbackDetail(item, outputId)} no_frames_sent`.trim() });
      return {
        status: interrupted || frameCount === 0 ? "interrupted" : "played",
        outputId,
        frameCount,
        failureReason: !interrupted && frameCount === 0 ? "no_frames_sent" : undefined
      };
      } catch (error) {
        item.status = ttsTask.controller.signal.aborted ? "interrupted" : "failed";
        if (ctx.playback.currentPlayingItem() === item) ctx.playback.setCurrentPlayingItem(undefined);
        const queueIndex = ctx.playbackQueue.indexOf(item);
        if (queueIndex >= 0) ctx.playbackQueue.splice(queueIndex, 1);
        throw error;
      } finally {
        ctx.activeTtsTasks.delete(ttsTask);
        ttsTask.controller.abort(new Error("tts_task_finished"));
      }
    }
  };
}

function playbackOptionString(options: unknown, key: string): string | undefined {
  return options && typeof options === "object" && typeof (options as Record<string, unknown>)[key] === "string"
    ? (options as Record<string, string>)[key]
    : undefined;
}

function playbackOptionCallback(options: unknown, key: string): (() => Promise<void> | void) | undefined {
  return options && typeof options === "object" && typeof (options as Record<string, unknown>)[key] === "function"
    ? (options as Record<string, () => Promise<void> | void>)[key]
    : undefined;
}
