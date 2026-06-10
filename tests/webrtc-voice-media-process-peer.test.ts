import { test } from "node:test";
import assert from "node:assert/strict";

import { createMediaProcessPeer, defaultWebRtcVoiceConfig } from "../src/channels/webrtc-voice/src/index.js";

const fs = await import("node:fs/promises");
const os = await import("node:os");
const path = await import("node:path");

test("media process peer proxies signaling, playback controls, status, and close", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alice-media-worker-"));
  const workerPath = path.join(dir, "worker.mjs");
  await fs.writeFile(workerPath, `
    const calls = [];
    const current = { outputId: "output-1", chunkId: "chunk-1", playbackTextCache: "hello world", playedMs: 20, totalMs: 100, status: "playing" };
    process.on("message", async (message) => {
      if (!message || message.type !== "request") return;
      const { id, method, params } = message;
      calls.push({ method, params });
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
      if (method === "createOutboundAudioTrack" || method === "addIceCandidate" || method === "interrupt" || method === "stopTrack") {
        process.send?.({ type: "response", id, ok: true, result: true });
        return;
      }
      if (method === "waitUntilReady") {
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
      if (method === "close") {
        process.send?.({ type: "response", id, ok: true, result: calls.map((call) => call.method) });
        setTimeout(() => process.exit(0), 0);
        return;
      }
      process.send?.({ type: "response", id, ok: false, error: "unknown method" });
    });
  `, "utf8");

  const statuses: string[] = [];
  const candidates: unknown[] = [];
  const peer = createMediaProcessPeer({
    callId: "call-media-proxy",
    userId: "browser-media-proxy",
    config: defaultWebRtcVoiceConfig(),
    workerPath,
    onStatus(event) {
      statuses.push(`${event.state}:${event.detail ?? ""}`);
    },
    onLocalIceCandidate(candidate) {
      candidates.push(candidate);
    }
  });

  const track = await peer.createOutboundAudioTrack({ sampleRateHz: 48000, channels: 1, frameMs: 20 });
  assert.equal(await peer.createAnswer("offer"), "answer:offer");
  await peer.addIceCandidate?.({ candidate: "remote" });
  assert.equal(await track?.waitUntilReady?.(100), true);
  const enqueued = await track?.enqueueAudioFile?.({
    itemId: "item-1",
    outputId: "output-1",
    chunkId: "chunk-1",
    filePath: "/tmp/audio.opus",
    assetId: "asset-1",
    text: "hello world",
    createdAt: "2026-06-11T00:00:00.000Z"
  });
  assert.deepEqual(enqueued, { itemId: "item-1" });
  assert.deepEqual(await track?.getCurrentPlayback?.(), {
    outputId: "output-1",
    chunkId: "chunk-1",
    playbackTextCache: "hello world",
    playedMs: 20,
    totalMs: 100,
    status: "playing"
  });
  await track?.interrupt?.({ reason: "manual", targetOutputId: "output-1" });
  assert.deepEqual(await track?.waitForPlaybackItem?.("item-1"), {
    itemId: "item-1",
    status: "played",
    framesWritten: 3,
    playedMs: 60,
    totalMs: 60
  });
  await peer.close();

  assert.deepEqual(candidates, [{ candidate: "candidate" }]);
  assert.equal(statuses.includes("fake.ready:call-media-proxy"), true);
});
