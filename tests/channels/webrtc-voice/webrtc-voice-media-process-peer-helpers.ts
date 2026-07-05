const fs = await import("node:fs/promises");
const os = await import("node:os");
const path = await import("node:path");

export async function createMediaProcessPeerWorker(): Promise<string> {
  const root = path.join(os.tmpdir(), "alice-tests");
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, "alice-media-worker-"));
  const workerPath = path.join(dir, "worker.mjs");
  await fs.writeFile(workerPath, `
    const current = { outputId: "output-1", chunkId: "chunk-1", playbackTextCache: "hello world", playedMs: 20, totalMs: 100, status: "playing" };
    process.on("message", async (message) => {
      if (!message || message.type !== "request") return;
      const { id, method, params } = message;
      if (method === "init") {
        process.send?.({ type: "status", event: { state: "fake.ready", detail: params.callId } });
        process.send?.({ type: "localIceCandidate", candidate: { candidate: "candidate" } });
        process.send?.({ type: "response", id, ok: true, result: true });
        return;
      }
      if (method === "createAnswer") {
        process.send?.({ type: "response", id, ok: true, result: "answer:" + params.offerSdp });
        return;
      }
      if (method === "addIceCandidate") {
        if (params.candidate?.candidate === "reject") {
          process.send?.({ type: "response", id, ok: false, error: "remote ice rejected" });
          return;
        }
        process.send?.({ type: "response", id, ok: true, result: true });
        return;
      }
      if (method === "createOutboundAudioTrack" || method === "interrupt" || method === "stopTrack") {
        process.send?.({ type: "response", id, ok: true, result: true });
        return;
      }
      if (method === "waitUntilReady") {
        if (params.timeoutMs === 999) {
          setTimeout(() => process.exit(2), 0);
          return;
        }
        process.send?.({ type: "response", id, ok: true, result: true });
        return;
      }
      if (method === "enqueueAudioFile") {
        process.send?.({ type: "response", id, ok: true, result: { itemId: params.itemId } });
        return;
      }
      if (method === "getCurrentPlayback") {
        process.send?.({ type: "response", id, ok: true, result: current });
        return;
      }
      if (method === "waitForPlaybackItem") {
        process.send?.({ type: "response", id, ok: true, result: { itemId: params.itemId, status: "played", framesWritten: 3, playedMs: 60, totalMs: 60 } });
        return;
      }
      if (method === "waitForPlaybackIdle") {
        process.send?.({ type: "response", id, ok: true, result: true });
        return;
      }
      if (method === "close") {
        process.send?.({ type: "response", id, ok: true, result: true });
        setTimeout(() => process.exit(0), 0);
        return;
      }
      process.send?.({ type: "response", id, ok: false, error: "unknown method" });
    });
  `, "utf8");
  return workerPath;
}
