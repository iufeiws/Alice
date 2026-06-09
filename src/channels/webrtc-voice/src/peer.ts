const crypto = await import("node:crypto");
const nodeBuffer: any = (await import("node:buffer")).Buffer;

import type { ServerAudioFrame, ServerWebRtcPeer, WebRtcVoiceConfig, WebRtcVoiceStatusEvent } from "./types.js";

export async function createWeriftPeer(input: {
  callId: string;
  userId: string;
  iceServers: WebRtcVoiceConfig["iceServers"];
  onLocalIceCandidate?(candidate: unknown): void;
  onStatus?(event: WebRtcVoiceStatusEvent): void;
}): Promise<ServerWebRtcPeer> {
  const werift = await import("werift");
  const peer = new werift.RTCPeerConnection({
    iceServers: input.iceServers.map((server) => ({
      urls: Array.isArray(server.urls) ? server.urls[0] ?? "" : server.urls,
      username: server.username,
      credential: server.credential
    }))
  });
  let outboundReady = false;
  const waiters: Array<() => void> = [];
  const outboundSsrc = crypto.randomInt(1, 0x7fffffff);
  let outboundTrack: any;
  let outboundSender: any;
  let outboundPacketsWritten = 0;
  const markOutboundReady = (reason: string) => {
    if (outboundReady) return;
    outboundReady = true;
    input.onStatus?.({ state: "webrtc.outbound_audio.ready", detail: reason });
    for (const waiter of waiters.splice(0)) waiter();
  };
  peer.onIceCandidate.subscribe((candidate: unknown) => {
    input.onStatus?.({ state: "webrtc.ice_candidate", detail: candidate ? "candidate" : "complete" });
    input.onLocalIceCandidate?.(candidate);
  });
  peer.connectionStateChange.subscribe((state: string) => {
    input.onStatus?.({ state: "webrtc.connection", detail: state });
  });
  peer.iceConnectionStateChange.subscribe((state: string) => {
    input.onStatus?.({ state: "webrtc.ice_connection", detail: state });
  });
  return {
    async createAnswer(offerSdp) {
      await peer.setRemoteDescription({ type: "offer", sdp: offerSdp });
      if (outboundTrack && !outboundSender) {
        outboundSender = peer.addTrack(outboundTrack);
        outboundSender?.onReady?.subscribe?.(() => markOutboundReady("sender_ready"));
        outboundSender?.dtlsTransport?.onStateChange?.subscribe?.((state: string) => {
          input.onStatus?.({ state: "webrtc.sender.dtls", detail: state });
          if (state === "connected") markOutboundReady("sender_dtls_connected");
        });
        if (outboundSender?.dtlsTransport?.state === "connected") markOutboundReady("sender_already_ready");
      }
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      input.onStatus?.({ state: "webrtc.answer.audio", detail: summarizeAudioSdp(answer.sdp) });
      return answer.sdp;
    },
    async addIceCandidate(candidate) {
      if (!candidate) return;
      await peer.addIceCandidate(candidate as any);
    },
    createOutboundAudioTrack() {
      outboundTrack = new werift.MediaStreamTrack({ kind: "audio" });
      return {
        async waitUntilReady(timeoutMs: number) {
          if (!outboundReady) {
            input.onStatus?.({ state: "webrtc.outbound_audio.waiting", detail: `sender_ready:${outboundSender?.dtlsTransport?.state ?? "no_dtls"}` });
            await waitForPeerConnected(() => outboundReady, waiters, timeoutMs);
          }
          if (!outboundReady) input.onStatus?.({ state: "webrtc.outbound_audio.not_ready", detail: `sender_ready_timeout:${outboundSender?.dtlsTransport?.state ?? "no_dtls"}` });
          return outboundReady;
        },
        async writeFrame(frame: ServerAudioFrame) {
          if (!frame.rtpPayload?.byteLength) return false;
          if (!outboundReady) {
            input.onStatus?.({ state: "webrtc.outbound_audio.dropped", detail: "sender_not_ready" });
            return false;
          }
          const sequence = frame.sequence & 0xffff;
          const timestamp = (frame.rtpTimestamp ?? (frame.sequence * (frame.rtpTimestampIncrement ?? 960))) >>> 0;
          const packet = new werift.RtpPacket(new werift.RtpHeader({
            payloadType: frame.payloadType ?? 111,
            sequenceNumber: sequence,
            timestamp,
            ssrc: outboundSsrc
          }), nodeBuffer.from(frame.rtpPayload));
          outboundTrack.writeRtp(packet);
          outboundPacketsWritten += 1;
          if (outboundPacketsWritten === 1 || outboundPacketsWritten % 50 === 0) {
            input.onStatus?.({ state: "webrtc.outbound_audio.packets_written", detail: String(outboundPacketsWritten) });
          }
          return true;
        },
        stop() {
          outboundTrack?.stop();
        }
      };
    },
    async close() {
      outboundTrack?.stop();
      await peer.close();
    }
  };
}

function waitForPeerConnected(isConnected: () => boolean, waiters: Array<() => void>, timeoutMs: number): Promise<void> {
  if (isConnected()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    waiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function summarizeAudioSdp(sdp: string): string {
  const sections = sdp.split(/\r?\nm=/);
  const audioSections = sections.filter((section) => section.startsWith("audio ") || section.startsWith("m=audio "));
  const directions = audioSections.map((section) => {
    const match = section.match(/\r?\na=(sendrecv|sendonly|recvonly|inactive)(?:\r?\n|$)/);
    return match?.[1] ?? "unknown";
  });
  return `${audioSections.length}:${directions.join(",") || "none"}`;
}
