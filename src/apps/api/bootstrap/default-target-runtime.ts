type AppConfigLike = {
  core: { defaultTargetPlugin?: string };
  plugins: {
    wechat: { enabled?: boolean };
    feishu: { activeAccount?: string };
  };
};

type FeishuPairedContactLike = {
  accountId?: string;
  channelId?: string;
  userId?: string;
  sessionId?: string;
};

type FeishuPairingStoreLike = {
  list(): FeishuPairedContactLike[];
  getPaired?(accountId?: string): FeishuPairedContactLike | undefined;
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
    // 无上下文默认目标应跟随当前账户指针（FEISHU_ACTIVE_ACCOUNT，最后收到消息的账户）；
    // 指针缺失/无效或无配对联系人时才回退到配对数组第一项。
    const activeAccount = input.config.plugins.feishu.activeAccount;
    const contact = (activeAccount ? input.feishuPairingStore.getPaired?.(activeAccount) : undefined)
      ?? input.feishuPairingStore.list()[0];
    if (!contact) return undefined;
    return {
      plugin: "feishu",
      accountId: contact.accountId ?? "main",
      channelId: contact.channelId,
      userId: contact.channelId ? undefined : contact.userId,
      sessionId: contact.sessionId ?? contact.channelId ?? contact.userId ?? "admin-test"
    };
  }
}
