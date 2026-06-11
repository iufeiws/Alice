const childProcess = await import("node:child_process");
const url = await import("node:url");

import type {
  EnqueuePlaybackAudioFileInput,
  PlaybackConsumerSnapshot,
  PlaybackItemSettled,
  ServerOutboundAudioTrack,
  ServerWebRtcPeer,
  WebRtcVoiceConfig,
  WebRtcVoiceStatusEvent
} from "./types.js";

type MediaProcessMessage =
  | { type: "response"; id: number; ok: true; result: unknown }
  | { type: "response"; id: number; ok: false; error: string }
  | { type: "status"; event: WebRtcVoiceStatusEvent }
  | { type: "localIceCandidate"; candidate: unknown };

export function createMediaProcessPeer(input: {
  callId: string;
  userId: string;
  config: WebRtcVoiceConfig;
  onLocalIceCandidate?(candidate: unknown): void;
  onStatus?(event: WebRtcVoiceStatusEvent): void;
  workerPath?: string;
}): ServerWebRtcPeer {
  const child = childProcess.fork(
    input.workerPath ?? url.fileURLToPath(new URL("./media-process-worker.js", import.meta.url)),
    [],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    }
  );
  let nextId = 1;
  let closed = false;
  let closing = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  const failPending = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

  child.stderr?.on("data", (chunk) => {
    input.onStatus?.({ state: "webrtc.media_process.stderr", detail: String(chunk).slice(0, 500) });
  });
  child.on("exit", (code, signal) => {
    closed = true;
    const detail = `exit code=${code ?? "null"} signal=${signal ?? "null"}`;
    input.onStatus?.({ state: closing ? "webrtc.media_process.closed" : "webrtc.media_process.failed", detail });
    if (!closing) failPending(new Error(`media process exited: ${detail}`));
  });
  child.on("message", (message: MediaProcessMessage) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "status") {
      input.onStatus?.(message.event);
      return;
    }
    if (message.type === "localIceCandidate") {
      input.onLocalIceCandidate?.(message.candidate);
      return;
    }
    if (message.type !== "response") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(message.error));
  });

  const request = <T>(method: string, params?: unknown): Promise<T> => {
    if (closed || !child.connected) return Promise.reject(new Error("media process is not connected"));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      child.send({ type: "request", id, method, params }, (error) => {
        if (!error) return;
        pending.delete(id);
        reject(error);
      });
    });
  };

  void request("init", {
    callId: input.callId,
    userId: input.userId,
    config: input.config
  }).catch((error) => {
    input.onStatus?.({ state: "webrtc.media_process.failed", detail: error instanceof Error ? error.message : String(error) });
  });

  return {
    async createAnswer(offerSdp) {
      return await request<string>("createAnswer", { offerSdp });
    },
    async addIceCandidate(candidate) {
      await request("addIceCandidate", { candidate });
    },
    async createOutboundAudioTrack(trackInput) {
      await request("createOutboundAudioTrack", trackInput);
      return createMediaProcessOutboundTrack(request);
    },
    async close() {
      closing = true;
      try {
        await request("close");
      } finally {
        closed = true;
        if (child.connected) child.disconnect();
        if (!child.killed) child.kill("SIGTERM");
      }
    }
  };
}

function createMediaProcessOutboundTrack(
  request: <T>(method: string, params?: unknown) => Promise<T>
): ServerOutboundAudioTrack {
  return {
    async writeFrame() {
      return false;
    },
    async waitUntilReady(timeoutMs) {
      return await request<boolean>("waitUntilReady", { timeoutMs });
    },
    async enqueueAudioFile(input: EnqueuePlaybackAudioFileInput) {
      return await request<{ itemId: string }>("enqueueAudioFile", input);
    },
    async waitForPlaybackItem(itemId: string) {
      return await request<PlaybackItemSettled>("waitForPlaybackItem", { itemId });
    },
    async waitForPlaybackIdle() {
      return await request<boolean>("waitForPlaybackIdle");
    },
    async interrupt(input) {
      await request("interrupt", input);
    },
    async getCurrentPlayback() {
      return await request<PlaybackConsumerSnapshot>("getCurrentPlayback");
    },
    async stop() {
      await request("stopTrack");
    }
  };
}
