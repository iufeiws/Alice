import { test } from "node:test";
import assert from "node:assert/strict";

import { createMediaProcessPeer, defaultWebRtcVoiceConfig } from "../../../src/channels/webrtc-voice/src/index.js";
import { createMediaProcessPeerWorker } from "./webrtc-voice-media-process-peer-helpers.js";

test("media process peer proxies signaling status", async () => {
  const { peer, statuses } = await createTestPeer();

  assert.equal(await peer.createAnswer("offer"), "answer:offer");
  await peer.close();

  assert.equal(statuses.includes("fake.ready:call-media-proxy"), true);
});

test("media process peer proxies local candidates", async () => {
  const { peer, candidates } = await createTestPeer();

  assert.equal(await peer.createAnswer("offer"), "answer:offer");
  await peer.close();

  assert.deepEqual(candidates, [{ candidate: "candidate" }]);
});

test("media process peer proxies close", async () => {
  const { peer } = await createTestPeer();

  await peer.close();

  await assert.rejects(Promise.resolve().then(() => peer.createAnswer("offer")));
});

test("media process outbound track exposes playback and frame contract", async () => {
  const { peer } = await createTestPeer();

  const track = await peer.createOutboundAudioTrack({ sampleRateHz: 48000, channels: 1, frameMs: 20 });
  assert.equal(await track?.writeFrame({
    sequence: 0,
    pcm: new Int16Array(),
    sampleRateHz: 48000,
    channels: 1,
    durationMs: 20
  }), false);
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
  assert.equal(await track?.waitForPlaybackIdle?.(), true);
  await track?.stop?.();
  await peer.close();
});

test("media process peer rejects worker errors and reports process failure", async () => {
  const { peer, statuses } = await createTestPeer();

  await assert.rejects(
    () => peer.addIceCandidate?.({ candidate: "reject" }) ?? Promise.resolve(),
    /remote ice rejected/
  );

  const track = await peer.createOutboundAudioTrack({ sampleRateHz: 48000, channels: 1, frameMs: 20 });
  await assert.rejects(
    () => track?.waitUntilReady?.(999) ?? Promise.resolve(),
    /media process exited: exit code=2 signal=null/
  );
  assert.equal(statuses.includes("webrtc.media_process.failed:exit code=2 signal=null"), true);
});

async function createTestPeer() {
  const workerPath = await createMediaProcessPeerWorker();
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
  return { peer, statuses, candidates };
}
