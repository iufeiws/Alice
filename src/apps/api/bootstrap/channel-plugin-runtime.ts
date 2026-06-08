import { createFeishuPlugin } from "../../../plugins/feishu/src/index.js";
import { createWeChatPlugin } from "../../../plugins/wechat/src/index.js";

export function createChannelPluginRuntime(input: {
  config: any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  feishuPairingStore: any;
  wechatStateStore: any;
  time: any;
  asrPlugin: any;
  getMessageRuntime(): any;
}) {
  const feishu = createFeishuPlugin(input.config.plugins.feishu, {
    log: input.appendLog,
    pairingStore: input.feishuPairingStore,
    time: input.time,
    asr: input.asrPlugin,
    async onEvent(event) {
      input.getMessageRuntime().ingestEvent(event);
    },
    async onLifecycleEvent(event) {
      input.getMessageRuntime().ingestLifecycle({ plugin: "feishu", ...event });
    }
  });

  const wechat = createWeChatPlugin(input.config.plugins.wechat, {
    log: input.appendLog,
    stateStore: input.wechatStateStore,
    time: input.time,
    async onEvent(event) {
      input.getMessageRuntime().ingestEvent(event);
    }
  });

  return { feishu, wechat };
}
