import type { FeishuConfig } from "../../../packages/config/src/index.js";
import type { AgentEvent } from "../../../packages/types/src/index.js";

export type FeishuPairedContact = {
  id: string;
  plugin: "feishu";
  accountId?: string;
  userId?: string;
  channelId?: string;
  sessionId: string;
  scope: "dm" | "group";
  pairedAt: string;
  lastSeenAt: string;
  canInitiate: boolean;
};

export type PairingFileIO = {
  read(path: string): string | undefined;
  write(path: string, content: string): void;
};

export interface FeishuPairingStore {
  list(): FeishuPairedContact[];
  isPaired(event: AgentEvent): boolean;
  pairFromEvent(event: AgentEvent): { ok: true; contact: FeishuPairedContact } | { ok: false; reason: "already_bound"; contact: FeishuPairedContact };
}

export function createFeishuPairingStore(path: string, io: PairingFileIO): FeishuPairingStore {
  let contacts = readContacts(path, io);

  function save(): void {
    io.write(path, `${JSON.stringify({ contacts }, null, 2)}\n`);
  }

  return {
    list() {
      return contacts;
    },
    isPaired(event) {
      return contacts.slice(0, 1).some((contact) => {
        if (event.session.scope === "dm") {
          return contact.scope === "dm" && contact.userId === event.source.userId;
        }

        return contact.scope === "group" && contact.channelId === event.source.channelId;
      });
    },
    pairFromEvent(event) {
      const now = new Date().toISOString();
      const id = event.session.scope === "dm"
        ? `feishu:dm:${event.source.userId ?? event.source.channelId ?? event.session.sessionId}`
        : `feishu:group:${event.source.channelId ?? event.session.sessionId}`;
      const existing = contacts.find((contact) => contact.id === id);
      const boundContact = contacts[0];

      if (boundContact && boundContact.id !== id) {
        return { ok: false, reason: "already_bound", contact: boundContact };
      }

      if (existing) {
        existing.lastSeenAt = now;
        existing.channelId = event.source.channelId ?? existing.channelId;
        existing.userId = event.source.userId ?? existing.userId;
        existing.sessionId = event.session.sessionId;
        save();
        return { ok: true, contact: existing };
      }

      const contact: FeishuPairedContact = {
        id,
        plugin: "feishu",
        accountId: event.source.accountId,
        userId: event.source.userId,
        channelId: event.source.channelId,
        sessionId: event.session.sessionId,
        scope: event.session.scope === "dm" ? "dm" : "group",
        pairedAt: now,
        lastSeenAt: now,
        canInitiate: true
      };
      contacts = [contact];
      save();
      return { ok: true, contact };
    }
  };
}

export function getPairingCommand(config: FeishuConfig): string {
  return process.env.FEISHU_PAIRING_COMMAND ?? "/pair alice";
}

export function isPairingCommand(event: AgentEvent, config: FeishuConfig): boolean {
  return event.payload.kind === "text" && event.payload.text.trim() === getPairingCommand(config);
}

function readContacts(path: string, io: PairingFileIO): FeishuPairedContact[] {
  const content = io.read(path);
  if (!content) return [];

  try {
    const parsed = JSON.parse(content) as { contacts?: FeishuPairedContact[] };
    return Array.isArray(parsed.contacts) ? parsed.contacts : [];
  } catch {
    return [];
  }
}
