import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import { createFeishuPairingStore } from "../../../channels/feishu/src/pairing.js";
import { createWeChatStateStore } from "../../../channels/wechat/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

export function createChannelStateRuntime(input: {
  config: { memoryFiles: { root: string }; plugins: { wechat: { botToken?: string; baseURL: string } } };
  time: CurrentTimeProvider;
}) {
  const feishuPairingStore = createFeishuPairingStore("memory-files/indexes/feishu-paired-contacts.json", {
    read(filePath) {
      return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined;
    },
    write(filePath, content) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
  }, { time: input.time });

  const wechatStateStore = createWeChatStateStore(path.join(input.config.memoryFiles.root, "indexes", "wechat-ilink-state.json"));
  const wechatCredentials = wechatStateStore.getCredentials();
  if (wechatCredentials) {
    input.config.plugins.wechat.botToken = wechatCredentials.botToken;
    input.config.plugins.wechat.baseURL = wechatCredentials.baseURL;
  } else if (input.config.plugins.wechat.botToken) {
    wechatStateStore.saveCredentials({
      botToken: input.config.plugins.wechat.botToken,
      baseURL: input.config.plugins.wechat.baseURL,
      loggedInAt: input.time.now().iso
    });
  }

  return {
    feishuPairingStore,
    wechatStateStore
  };
}
