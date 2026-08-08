import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { createCurrentTimeProvider } from "../../../../platform/time/src/index.js";
import type { FeishuAgentRunCardBlock, FeishuDynamicCardClient } from "../../../../channels/feishu/src/types.js";
import type { FeishuPairingStore } from "../../../../channels/feishu/src/pairing.js";
import type { AgentRunIndicator, AgentRunIndicatorOutput, AgentRunIndicatorSession, AgentRunIndicatorToolCall } from "../ports.js";

const fs = await import("node:fs");
const path = await import("node:path");
const CARD_LAYOUT_VERSION = 5;
const TYPING_STATE_LABEL = "正在输入中...";
const FAILED_STATE_LABEL = "失败";

export type FeishuAgentRunIndicatorCardRecord = {
  accountId?: string;
  messageId?: string;
  cardId?: string;
  layoutVersion?: number;
  nextSequence: number;
  updatedAt: string;
  state?: string;
  reasoning?: string;
  content?: string;
  tools?: string;
};

export type FeishuAgentRunIndicatorCardStore = {
  read(): FeishuAgentRunIndicatorCardRecord | undefined;
  write(record: FeishuAgentRunIndicatorCardRecord): void;
  delete(): void;
};

export type FeishuAgentRunIndicatorInput = {
  enabled(): boolean;
  client: FeishuDynamicCardClient;
  pairingStore: FeishuPairingStore;
  cardStore: FeishuAgentRunIndicatorCardStore;
  /** 无显式账户上下文时解析默认账户（当前账户指针）。 */
  resolveAccount?(): string | undefined;
  time?: CurrentTimeProvider;
  throttleMs?: number;
  getState?(): unknown;
  log?(level: "info" | "warn" | "error", message: string): void;
};

type ActiveCard = {
  accountId?: string;
  messageId: string;
  cardId: string;
  nextSequence: number;
  blocks: IndicatorBlocks;
  savedBlocks: IndicatorBlocks;
};

type IndicatorBlocks = {
  state: string;
  reasoning: string;
  content: string;
  tools: string;
};

export function createJsonFeishuAgentRunIndicatorCardStore(filePath: string): FeishuAgentRunIndicatorCardStore {
  return {
    read() {
      if (!fs.existsSync(filePath)) return undefined;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as FeishuAgentRunIndicatorCardRecord;
      if (!parsed.messageId && !parsed.cardId) return undefined;
      return {
        accountId: parsed.accountId,
        messageId: parsed.messageId,
        cardId: parsed.cardId,
        layoutVersion: parsed.layoutVersion,
        nextSequence: Number.isFinite(parsed.nextSequence) && parsed.nextSequence > 0 ? parsed.nextSequence : 1,
        updatedAt: parsed.updatedAt,
        state: parsed.state ?? "",
        reasoning: parsed.reasoning ?? "",
        content: parsed.content ?? "",
        tools: parsed.tools ?? ""
      };
    },
    write(record) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
    },
    delete() {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  };
}

export function createFeishuDynamicCardAgentRunIndicator(input: FeishuAgentRunIndicatorInput): AgentRunIndicator {
  const time = input.time ?? createCurrentTimeProvider("UTC");
  const throttleMs = input.throttleMs ?? 500;

  return {
    async ensureReady() {
      if (!input.enabled() || !input.client.isStarted()) return;
      const contact = pairedFeishuContact(input.resolveAccount?.());
      if (!contact?.userId) return;
      await ensureCard(contact.userId, contact.accountId, { ...blocksFromRecord(input.cardStore.read() ?? {}), state: stateLabel(input.getState?.()) });
    },
    async createFreshCard() {
      if (!input.enabled() || !input.client.isStarted()) return;
      const contact = pairedFeishuContact(input.resolveAccount?.());
      if (!contact?.userId) return;
      await createCard(contact.userId, contact.accountId, { ...blocksFromRecord(input.cardStore.read() ?? {}), state: stateLabel(input.getState?.()) });
    },
    async begin(beginInput) {
      if (!input.enabled() || !input.client.isStarted()) return undefined;
      const contact = pairedFeishuContact(beginInput.accountId ?? input.resolveAccount?.());
      if (!contact?.userId) return undefined;

      let card = await ensureCard(contact.userId, contact.accountId);
      try {
        await updateStreaming(card, true);
        await updateState(card, TYPING_STATE_LABEL);
      } catch (error) {
        if (!isMissingCardError(error)) throw error;
        input.log?.("warn", "[agent-run-indicator] persisted Feishu card is unavailable; creating a new indicator card");
        card = await createCard(contact.userId, contact.accountId);
        await updateStreaming(card, true);
        await updateState(card, TYPING_STATE_LABEL);
      }
      return createSession(card);
    },
    async setTyping(typingInput) {
      if (!input.enabled() || !input.client.isStarted()) return;
      const contact = pairedFeishuContact(input.resolveAccount?.());
      if (!contact?.userId) return;
      const receiveId = contact.userId;
      const state = typingInput.typing ? TYPING_STATE_LABEL : stateLabel(input.getState?.());
      let card = typingInput.typing ? await ensureCard(receiveId, contact.accountId, { ...emptyBlocks(), state }, { ...emptyBlocks(), state }) : await loadStoredCard(contact.accountId);
      if (!card) return;
      try {
        await updateState(card, state);
      } catch (error) {
        if (!isMissingCardError(error)) throw error;
        input.cardStore.delete();
        if (!typingInput.typing) return;
        card = await createCard(receiveId, contact.accountId, { ...emptyBlocks(), state }, { ...emptyBlocks(), state });
        await updateState(card, state);
      }
    },
    async fail(error) {
      if (!input.enabled() || !input.client.isStarted()) return;
      const contact = pairedFeishuContact(input.resolveAccount?.());
      if (!contact?.userId) return;
      const card = await loadStoredCard(contact.accountId);
      if (!card) return;
      input.log?.("warn", `[agent-run-indicator] Feishu indicator card marked failed: ${errorMessage(error)}`);
      try {
        await updateState(card, FAILED_STATE_LABEL);
        await updateStreaming(card, false);
      } catch (failError) {
        if (isMissingCardError(failError)) input.cardStore.delete();
        input.log?.("error", `[agent-run-indicator] Feishu indicator card fail update failed: ${errorMessage(failError)}`);
      }
    }
  };

  function createSession(card: ActiveCard): AgentRunIndicatorSession {
    let reasoning = "";
    let content = "";
    let toolCalls = new Map<number, AgentRunIndicatorToolCall>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let flushPromise: Promise<void> = Promise.resolve();
    let failed = false;

    const clearFlushTimer = (): void => {
      if (!flushTimer) return;
      clearTimeout(flushTimer);
      flushTimer = undefined;
    };

    const queueFlush = (): void => {
      if (flushTimer || failed) return;
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        flushPromise = flushPromise
          .then(() => flushContent(card, runningBlocks(reasoning, content, toolCallsText(toolCalls))))
          .catch((error) => {
            failed = true;
            input.log?.("error", `[agent-run-indicator] Feishu indicator flush failed: ${errorMessage(error)}`);
          });
      }, throttleMs);
    };

    async function finishOutput(output: AgentRunIndicatorOutput): Promise<void> {
      clearFlushTimer();
      await flushPromise;
      reasoning = output.reasoning;
      content = output.content;
      toolCalls = toolCallsFromOutput(output.toolCalls);
    }

    return {
      async appendReasoningDelta(delta) {
        if (failed || !delta) return;
        reasoning += delta;
        queueFlush();
      },
      async appendContentDelta(delta) {
        if (failed || !delta) return;
        content += delta;
        queueFlush();
      },
      async appendToolCallDelta(delta) {
        if (failed) return;
        const current = toolCalls.get(delta.index) ?? { id: delta.id, name: "", arguments: "" };
        if (delta.id) current.id = delta.id;
        if (delta.name) current.name = delta.name;
        if (delta.arguments) current.arguments += delta.arguments;
        toolCalls.set(delta.index, current);
        queueFlush();
      },
      async finish(output) {
        if (failed) return;
        await finishOutput(output);
        const finalBlocks = {
          state: stateLabel(input.getState?.()),
          reasoning,
          content,
          tools: toolCallsText(toolCalls)
        };
        await updateBlocks(card, finalBlocks, finalBlocks);
        await updateStreaming(card, false);
      },
      async fail(error) {
        failed = true;
        clearFlushTimer();
        input.log?.("error", `[agent-run-indicator] Feishu indicator session failed: ${errorMessage(error)}`);
        try {
          await updateStreaming(card, false);
        } catch (finishError) {
          input.log?.("error", `[agent-run-indicator] Feishu indicator fail cleanup failed: ${errorMessage(finishError)}`);
        }
      }
    };
  }

  function pairedFeishuContact(accountId?: string) {
    const contacts = input.pairingStore.list();
    if (contacts.length === 0) return undefined;
    return input.pairingStore.getPaired(accountId) ?? contacts[0];
  }

  async function ensureCard(receiveId: string, accountId: string | undefined, initialBlocks = runningBlocks("", ""), savedBlocks = initialBlocks): Promise<ActiveCard> {
    const stored = input.cardStore.read();
    const card = await loadStoredCard(accountId, stored);
    if (card) return card;
    const storedBlocks = stored ? blocksFromRecord(stored) : emptyBlocks();
    return await createCard(receiveId, accountId, {
      ...storedBlocks,
      state: initialBlocks.state
    }, {
      ...storedBlocks,
      state: savedBlocks.state
    });
  }

  async function loadStoredCard(accountId: string | undefined, stored = input.cardStore.read()): Promise<ActiveCard | undefined> {
    if (stored && stored.layoutVersion !== CARD_LAYOUT_VERSION) return undefined;
    if (stored?.cardId) {
      const blocks = blocksFromRecord(stored);
      return {
        accountId: stored.accountId ?? accountId,
        messageId: stored.messageId ?? "",
        cardId: stored.cardId,
        nextSequence: stored.nextSequence,
        blocks,
        savedBlocks: blocks
      };
    }

    if (stored?.messageId) {
      const converted = await input.client.resolveAgentRunCardId({ messageId: stored.messageId, accountId: stored.accountId ?? accountId });
      if (converted.cardId) {
        const blocks = blocksFromRecord(stored);
        const record = {
          accountId: stored.accountId ?? accountId,
          messageId: stored.messageId,
          cardId: converted.cardId,
          layoutVersion: CARD_LAYOUT_VERSION,
          nextSequence: stored.nextSequence,
          updatedAt: time.now().date.toISOString(),
          ...blocks
        };
        input.cardStore.write(record);
        return {
          accountId: record.accountId,
          messageId: record.messageId,
          cardId: record.cardId,
          nextSequence: record.nextSequence,
          blocks,
          savedBlocks: blocks
        };
      }
    }

    return undefined;
  }

  async function createCard(receiveId: string, accountId: string | undefined, blocks = runningBlocks("", ""), savedBlocks = blocks): Promise<ActiveCard> {
    const created = await input.client.createAgentRunCard({
      receiveIdType: "open_id",
      receiveId,
      blocks,
      accountId
    });
    const card = {
      accountId,
      messageId: created.messageId,
      cardId: created.cardId,
      nextSequence: 1,
      blocks,
      savedBlocks
    };
    persistCard(card);
    return card;
  }

  async function updateStreaming(card: ActiveCard, enabled: boolean): Promise<void> {
    await callCardOperation(card, () => input.client.setAgentRunCardStreaming({
      cardId: card.cardId,
      enabled,
      sequence: card.nextSequence,
      accountId: card.accountId
    }));
  }

  async function updateBlock(card: ActiveCard, block: FeishuAgentRunCardBlock, content: string, nextBlocks?: IndicatorBlocks, nextSavedBlocks?: IndicatorBlocks): Promise<void> {
    await callCardOperation(card, () => input.client.updateAgentRunCardBlocks({
      cardId: card.cardId,
      blocks: { [block]: content },
      sequence: card.nextSequence,
      accountId: card.accountId
    }), nextBlocks, nextSavedBlocks);
  }

  async function updateState(card: ActiveCard, state: string): Promise<void> {
    await updateBlock(card, "state", state, { ...card.blocks, state }, { ...card.savedBlocks, state });
  }

  async function updateBlocks(card: ActiveCard, blocks: IndicatorBlocks, nextSavedBlocks?: IndicatorBlocks): Promise<void> {
    await callCardOperation(card, () => input.client.updateAgentRunCardBlocks({
      cardId: card.cardId,
      blocks,
      sequence: card.nextSequence
    }), blocks, nextSavedBlocks);
  }

  async function flushContent(card: ActiveCard, blocks: IndicatorBlocks): Promise<void> {
    await updateBlocks(card, blocks);
  }

  async function callCardOperation(card: ActiveCard, operation: () => Promise<void>, nextBlocks?: IndicatorBlocks, nextSavedBlocks?: IndicatorBlocks): Promise<void> {
    try {
      await operation();
      card.nextSequence += 1;
      if (nextBlocks) card.blocks = nextBlocks;
      if (nextSavedBlocks) card.savedBlocks = nextSavedBlocks;
      persistCard(card);
    } catch (error) {
      if (isMissingCardError(error)) input.cardStore.delete();
      throw error;
    }
  }

  function persistCard(card: ActiveCard): void {
    const record: FeishuAgentRunIndicatorCardRecord = {
      messageId: card.messageId,
      cardId: card.cardId,
      layoutVersion: CARD_LAYOUT_VERSION,
      nextSequence: card.nextSequence,
      updatedAt: time.now().date.toISOString(),
      ...card.savedBlocks
    };
    if (card.accountId) record.accountId = card.accountId;
    input.cardStore.write(record);
  }
}

function runningBlocks(reasoning: string, content: string, tools = ""): IndicatorBlocks {
  return {
    state: TYPING_STATE_LABEL,
    reasoning,
    content,
    tools
  };
}

function emptyBlocks(): IndicatorBlocks {
  return {
    state: "",
    reasoning: "",
    content: "",
    tools: ""
  };
}

function blocksFromRecord(record: Pick<FeishuAgentRunIndicatorCardRecord, "state" | "reasoning" | "content" | "tools">): IndicatorBlocks {
  return {
    state: record.state ?? "",
    reasoning: record.reasoning ?? "",
    content: record.content ?? "",
    tools: record.tools ?? ""
  };
}

function toolCallsFromOutput(calls: AgentRunIndicatorToolCall[]): Map<number, AgentRunIndicatorToolCall> {
  return new Map(calls.map((call, index) => [index, { ...call }]));
}

function toolCallsText(calls: Map<number, AgentRunIndicatorToolCall>): string {
  return [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => formatToolCall(call))
    .filter(Boolean)
    .join("\n");
}

function formatToolCall(call: AgentRunIndicatorToolCall): string {
  return [call.name, call.arguments].filter(Boolean).join(" ");
}

function stateLabel(value: unknown): string {
  if (value && typeof value === "object" && "state" in value && typeof value.state === "string") return value.state;
  return "idle";
}

function isMissingCardError(error: unknown): boolean {
  const message = errorMessage(error);
  return /not\s*exist|not\s*found|does\s*not\s*exist|cannot\s*be\s*updated|deleted|invalid\s*card/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
