export type FeishuSessionBindingInput = {
  chatId: string;
  chatType: string;
  userId?: string;
  threadId?: string;
};

export interface FeishuBindingStore {
  resolveSession(input: FeishuSessionBindingInput): Promise<string>;
}

export function createInMemoryFeishuBindingStore(): FeishuBindingStore {
  const bindings = new Map<string, string>();

  return {
    async resolveSession(input) {
      const scope = input.chatType === "p2p" ? "dm" : "group";
      const key = input.threadId ?? input.chatId ?? input.userId ?? "unknown";
      const bindingKey = `feishu:${scope}:${key}`;
      const existing = bindings.get(bindingKey);
      if (existing) return existing;

      bindings.set(bindingKey, bindingKey);
      return bindingKey;
    }
  };
}
