import { createFeishuPlugin } from "../../../channels/feishu/src/index.js";
import { createGoogleStreetViewPlugin } from "../../../channels/google-streetview/src/index.js";
import { createWeChatPlugin } from "../../../channels/wechat/src/index.js";

export function createChannelPluginRuntime(input: {
  config: any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  feishuPairingStore: any;
  wechatStateStore: any;
  time: any;
  asrPlugin: any;
  getMessageRuntime(): any;
  onFeishuCardAction?(event: any): Promise<unknown>;
  onFeishuActiveAccountChanged?(accountId: string): void | Promise<void>;
  recognizeImage(filePath: string): Promise<any>;
}) {
  const feishu = createFeishuPlugin(input.config.plugins.feishu, {
    log: input.appendLog,
    pairingStore: input.feishuPairingStore,
    time: input.time,
    asr: input.asrPlugin,
    onActiveAccountChanged: input.onFeishuActiveAccountChanged,
    async onEvent(event) {
      await input.getMessageRuntime().ingestEvent(event);
    },
    async onLifecycleEvent(event) {
      input.getMessageRuntime().ingestLifecycle({ plugin: "feishu", ...event });
    },
    async onCardAction(event) {
      return await input.onFeishuCardAction?.(event);
    }
  });

  const wechat = createWeChatPlugin(input.config.plugins.wechat, {
    log: input.appendLog,
    stateStore: input.wechatStateStore,
    time: input.time,
    async onEvent(event) {
      await input.getMessageRuntime().ingestEvent(event);
    }
  });

  const googleStreetView = createGoogleStreetViewPlugin({
    configPath: "config/plugin/google-streetview/config.json",
    recognizeImage: input.recognizeImage,
    appendLog: input.appendLog
  });

  return { feishu, wechat, googleStreetView };
}
