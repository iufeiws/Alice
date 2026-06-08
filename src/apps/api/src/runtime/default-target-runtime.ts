type AppConfigLike = {
  core: { defaultTargetPlugin?: string };
  plugins: { wechat: { enabled?: boolean } };
};

type FeishuPairingStoreLike = {
  list(): Array<{ channelId?: string; userId?: string; sessionId?: string }>;
};

type WeChatStateStoreLike = {
  getDefaultTarget(): unknown;
};

export type DefaultMessagingTarget = {
  plugin: string;
  accountId?: string;
  channelId?: string;
  userId?: string;
  sessionId: string;
};

export function createDefaultTargetResolver(input: {
  config: AppConfigLike;
  feishuPairingStore: FeishuPairingStoreLike;
  wechatStateStore: WeChatStateStoreLike;
}) {
  return {
    getDefaultMessagingTarget,
    getDefaultFeishuTarget
  };

  function getDefaultMessagingTarget(): unknown {
    const mode = input.config.core.defaultTargetPlugin ?? "auto";
    const wechatTarget = input.config.plugins.wechat.enabled ? input.wechatStateStore.getDefaultTarget() : undefined;
    const feishuTarget = getDefaultFeishuTarget();
    if (mode === "wechat") return wechatTarget;
    if (mode === "feishu") return feishuTarget;
    return wechatTarget ?? feishuTarget;
  }

  function getDefaultFeishuTarget(): DefaultMessagingTarget | undefined {
    const contact = input.feishuPairingStore.list()[0];
    if (!contact) return undefined;
    return {
      plugin: "feishu",
      accountId: "main",
      channelId: contact.channelId,
      userId: contact.channelId ? undefined : contact.userId,
      sessionId: contact.sessionId ?? contact.channelId ?? contact.userId ?? "admin-test"
    };
  }
}
