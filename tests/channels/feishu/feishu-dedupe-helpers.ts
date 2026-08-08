import type { AgentOutput } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import type { FeishuPairingStore, FeishuPairedContact } from "../../../src/channels/feishu/src/pairing.js";
import type { FeishuAudioMessageEvent, FeishuConfig, FeishuTextMessageEvent } from "../../../src/channels/feishu/src/types.js";

export function feishuConfig(): FeishuConfig {
  return {
    enabled: true,
    connectionMode: "websocket",
    accounts: { main: { appId: "app", appSecret: "secret" } },
    dmPolicy: "pairing",
    dmAllowFrom: [],
    groupPolicy: "allowlist",
    groupAllowFrom: [],
    requireMention: true,
    codexPolicy: {
      enabled: true,
      requireAllowlist: true,
      allowedUsers: [],
      allowedChats: [],
      requireExplicitCommand: true
    }
  };
}

export function rawTextMessage(messageId: string, text: string): FeishuTextMessageEvent {
  return {
    header: {
      event_id: `evt_${messageId}`,
      create_time: "1770000000000"
    },
    event: {
      message: {
        message_id: messageId,
        chat_id: "oc_chat",
        chat_type: "p2p",
        content: JSON.stringify({ text })
      },
      sender: {
        sender_id: {
          open_id: "ou_user"
        }
      }
    }
  };
}

export function rawAudioMessage(messageId: string): FeishuAudioMessageEvent {
  return {
    header: {
      event_id: `evt_${messageId}`,
      create_time: "1770000000000"
    },
    event: {
      message: {
        message_id: messageId,
        chat_id: "oc_chat",
        chat_type: "p2p",
        message_type: "audio",
        content: JSON.stringify({ file_key: "file_v2_1", duration: 3000 })
      },
      sender: {
        sender_id: {
          open_id: "ou_user"
        }
      }
    }
  };
}

export function textOutput(sessionId: string, text: string): AgentOutput {
  return {
    id: `out_${sessionId}`,
    target: {
      plugin: "feishu",
      accountId: "main",
      channelId: "oc_chat",
      userId: "ou_user",
      sessionId
    },
    content: {
      kind: "text",
      text
    },
    meta: {
      createdAt: "2026-02-02T02:40:00.000Z",
      createdAtUtc: "2026-02-02T02:40:00.000Z",
      urgency: "normal"
    }
  };
}

export function pairedStore(): FeishuPairingStore {
  const contacts: FeishuPairedContact[] = [{
    id: "feishu:dm:ou_user",
    plugin: "feishu" as const,
    userId: "ou_user",
    channelId: "oc_chat",
    sessionId: "feishu:dm:ou_user",
    scope: "dm" as const,
    pairedAt: "2026-05-24T00:00:00.000Z",
    lastSeenAt: "2026-05-24T00:00:00.000Z",
    canInitiate: true
  }];
  return {
    list: () => contacts,
    getPaired: (accountId) => accountId ? contacts.find((contact) => contact.accountId === accountId) : contacts[0],
    isPaired: () => true,
    pairFromEvent: () => {
      throw new Error("not expected");
    }
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
