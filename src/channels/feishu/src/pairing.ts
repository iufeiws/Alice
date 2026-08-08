import type { AgentEvent } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { createCurrentTimeProvider } from "../../../platform/time/src/index.js";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";

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
  getPaired(accountId?: string): FeishuPairedContact | undefined;
  isPaired(event: AgentEvent): boolean;
  pairFromEvent(event: AgentEvent): { ok: true; contact: FeishuPairedContact } | { ok: false; reason: "already_bound"; contact: FeishuPairedContact };
}

export function createFeishuPairingStore(path: string, io: PairingFileIO, options: { time?: CurrentTimeProvider } = {}): FeishuPairingStore {
  const time = options.time ?? createCurrentTimeProvider("UTC");
  let contacts = readContacts(path, io);

  function save(): void {
    io.write(path, `${JSON.stringify({ contacts }, null, 2)}\n`);
  }

  // 配对按账户隔离：事件缺少 accountId 时按 "main" 处理。
  function contactsForAccount(accountId: string | undefined): FeishuPairedContact[] {
    const scopeId = accountId ?? "main";
    return contacts.filter((contact) => (contact.accountId ?? "main") === scopeId);
  }

  return {
    list() {
      return contacts;
    },
    getPaired(accountId) {
      if (accountId) return contactsForAccount(accountId)[0];
      return contacts[0];
    },
    isPaired(event) {
      return contactsForAccount(event.source.accountId).slice(0, 1).some((contact) => {
        if (event.externalSession.scope === "dm") {
          return contact.scope === "dm" && contact.userId === event.source.userId;
        }

        return contact.scope === "group" && contact.channelId === event.source.channelId;
      });
    },
    pairFromEvent(event) {
      const now = time.now().iso;
      const accountId = event.source.accountId;
      const id = event.externalSession.scope === "dm"
        ? `feishu:dm:${event.source.userId ?? event.source.channelId ?? event.externalSession.sessionId}`
        : `feishu:group:${event.source.channelId ?? event.externalSession.sessionId}`;
      const accountContacts = contactsForAccount(accountId);
      const existing = accountContacts.find((contact) => contact.id === id);
      const boundContact = accountContacts[0];

      if (boundContact && boundContact.id !== id) {
        return { ok: false, reason: "already_bound", contact: boundContact };
      }

      if (existing) {
        existing.lastSeenAt = now;
        existing.accountId = accountId;
        existing.channelId = event.source.channelId ?? existing.channelId;
        existing.userId = event.source.userId ?? existing.userId;
        existing.sessionId = event.externalSession.sessionId;
        save();
        return { ok: true, contact: existing };
      }

      const contact: FeishuPairedContact = {
        id,
        plugin: "feishu",
        accountId,
        userId: event.source.userId,
        channelId: event.source.channelId,
        sessionId: event.externalSession.sessionId,
        scope: event.externalSession.scope === "dm" ? "dm" : "group",
        pairedAt: now,
        lastSeenAt: now,
        canInitiate: true
      };
      contacts = [...contacts.filter((candidate) => (candidate.accountId ?? "main") !== (accountId ?? "main")), contact];
      save();
      return { ok: true, contact };
    }
  };
}

export function getPairingCommand(): string {
  return process.env.FEISHU_PAIRING_COMMAND ?? "/pair alice";
}

export function isPairingCommand(event: AgentEvent): boolean {
  return event.payload.kind === "text" && event.payload.text.trim() === getPairingCommand();
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
