import type { FeishuConfig } from "./types.js";
import { createFeishuClient, type FeishuClientDeps } from "./client.js";

export function createFeishuMonitor(config: FeishuConfig, deps: FeishuClientDeps) {
  const client = createFeishuClient(config, deps);

  return {
    start: () => client.start(),
    stop: () => client.stop(),
    sendText: client.sendText,
    sendMarkdown: client.sendMarkdown,
    sendImage: client.sendImage,
    sendAudio: client.sendAudio,
    sendFile: client.sendFile,
    downloadAudioResource: client.downloadAudioResource,
    addReaction: client.addReaction,
    removeReaction: client.removeReaction
  };
}
