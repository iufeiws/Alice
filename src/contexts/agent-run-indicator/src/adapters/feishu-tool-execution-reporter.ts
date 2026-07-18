import type { FeishuDynamicCardClient } from "../../../../channels/feishu/src/types.js";
import type { FeishuPairingStore } from "../../../../channels/feishu/src/pairing.js";
import type { ToolCall, ToolExecutionReporter, ToolExecutionReportSession, ToolResult } from "../../../agent-loop/src/contracts/agent-contracts.js";

export function createFeishuToolExecutionReporter(input: {
  client: FeishuDynamicCardClient;
  pairingStore: FeishuPairingStore;
  throttleMs?: number;
  outputLimitChars?: number;
  log?(level: "info" | "warn" | "error", message: string): void;
}): ToolExecutionReporter {
  const throttleMs = input.throttleMs ?? 500;
  const outputLimitChars = input.outputLimitChars ?? 12_000;
  const cardIdleMs = 5_000;
  let currentCard: ToolExecutionCardState | undefined;

  return {
    async begin(call) {
      if (!input.client.isStarted()) return undefined;
      const receiveId = pairedFeishuUserId();
      if (!receiveId) return undefined;
      try {
        const panel = await ensureCard(receiveId, call);
        return createSession(panel.card, panel.ids, call.toolName);
      } catch (error) {
        input.log?.("warn", `[tool-execution] Feishu card begin failed: ${errorMessage(error)}`);
        return undefined;
      }
    }
  };

  async function ensureCard(receiveId: string, call: ToolCall): Promise<{ card: ToolExecutionCardState; ids: ToolExecutionPanelIds }> {
    if (currentCard?.idleTimer) {
      clearTimeout(currentCard.idleTimer);
      currentCard.idleTimer = undefined;
    }
    const renderedCall = renderCode(call.input);
    const initialResult = renderCode("");
    if (!currentCard) {
      const ids = firstPanelIds();
      const created = await input.client.createToolExecutionCard({
        receiveIdType: "open_id",
        receiveId,
        toolName: call.toolName,
        call: renderedCall,
        result: initialResult,
        ...ids
      });
      currentCard = { cardId: created.cardId, nextPanelIndex: 2, nextSequence: 1, activeSessions: 0, queue: Promise.resolve() };
      await setStreaming(currentCard, true);
      currentCard.activeSessions += 1;
      return { card: currentCard, ids };
    }

    const card = currentCard;
    const ids = nextPanelIds(card);
    await enqueue(card, () => input.client.appendToolExecutionCardPanel({
      cardId: card.cardId,
      toolName: call.toolName,
      call: renderedCall,
      result: initialResult,
      ...ids,
      sequence: takeSequence(card)
    }));
    await setStreaming(card, true);
    card.activeSessions += 1;
    return { card, ids };
  }

  function createSession(card: ToolExecutionCardState, ids: ToolExecutionPanelIds, toolName: string): ToolExecutionReportSession {
    let progress = "";
    let flushedProgress = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let flushPromise: Promise<void> = Promise.resolve();
    let failed = false;

    const updateResult = async (content: string): Promise<void> => {
      await enqueue(card, () => input.client.updateToolExecutionCard({
        cardId: card.cardId,
        block: "result",
        elementId: ids.resultElementId,
        content,
        sequence: takeSequence(card)
      }));
    };
    const markFailed = (error: unknown): void => {
      failed = true;
      input.log?.("warn", `[tool-execution] Feishu card update failed: ${errorMessage(error)}`);
    };
    const flush = async (): Promise<void> => {
      if (!failed && progress !== flushedProgress) {
        await updateResult(renderCode(progress));
        flushedProgress = progress;
      }
    };
    const finish = async (state: "finished" | "failed", result: unknown): Promise<void> => {
      try {
        if (timer) clearTimeout(timer);
        timer = undefined;
        await flushPromise;
        if (!failed) {
          await flush();
          await updateResult(renderCode(result));
          await enqueue(card, () => input.client.updateToolExecutionCard({
            cardId: card.cardId,
            block: "title",
            elementId: ids.titleElementId,
            content: `${toolName}: ${state}`,
            sequence: takeSequence(card)
          }));
        }
      } catch (error) {
        markFailed(error);
      } finally {
        releaseCard(card);
      }
    };

    return {
      appendProgress(content) {
        if (failed || !content) return;
        progress = trimOutput(progress + content);
        if (timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          flushPromise = flushPromise.then(flush).catch(markFailed);
        }, throttleMs);
      },
      async finish(result: ToolResult) {
        await finish(result.ok ? "finished" : "failed", result.ok ? result.output : result.error);
      },
      async fail(error) {
        await finish("failed", errorMessage(error));
      }
    };
  }

  async function setStreaming(card: ToolExecutionCardState, enabled: boolean): Promise<void> {
    await enqueue(card, () => input.client.setToolExecutionCardStreaming({ cardId: card.cardId, enabled, sequence: takeSequence(card) }));
  }

  async function enqueue(card: ToolExecutionCardState, run: () => Promise<void>): Promise<void> {
    const next = card.queue.then(run);
    card.queue = next.catch(() => undefined);
    await next;
  }

  function releaseCard(card: ToolExecutionCardState): void {
    card.activeSessions -= 1;
    if (card.activeSessions > 0) return;
    card.idleTimer = setTimeout(() => {
      if (currentCard !== card || card.activeSessions !== 0) return;
      currentCard = undefined;
      void setStreaming(card, false).catch((error) => input.log?.("warn", `[tool-execution] Feishu card finalize failed: ${errorMessage(error)}`));
    }, cardIdleMs);
    card.idleTimer.unref?.();
  }

  function pairedFeishuUserId(): string | undefined {
    const contacts = input.pairingStore.list();
    return contacts.length === 1 ? contacts[0].userId || undefined : undefined;
  }

  function trimOutput(value: string): string {
    return value.length <= outputLimitChars ? value : value.slice(value.length - outputLimitChars);
  }
}

type ToolExecutionCardState = {
  cardId: string;
  nextPanelIndex: number;
  nextSequence: number;
  activeSessions: number;
  queue: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
};

type ToolExecutionPanelIds = { titleElementId: string; callElementId: string; resultElementId: string };

function firstPanelIds(): ToolExecutionPanelIds {
  return { titleElementId: "tool_1_title", callElementId: "tool_1_call", resultElementId: "tool_1_result" };
}

function nextPanelIds(card: ToolExecutionCardState): ToolExecutionPanelIds {
  const index = card.nextPanelIndex++;
  return { titleElementId: `tool_${index}_title`, callElementId: `tool_${index}_call`, resultElementId: `tool_${index}_result` };
}

function takeSequence(card: ToolExecutionCardState): number {
  return card.nextSequence++;
}

function renderCode(value: unknown): string {
  const content = formatCodeValue(value);
  const runs = content.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, runs.reduce((max, run) => Math.max(max, run.length), 0) + 1));
  return `${fence}json\n${content}\n${fence}`;
}

function formatCodeValue(value: unknown): string {
  if (typeof value !== "string") return value === undefined ? " " : JSON.stringify(value, null, 2);
  if (!value) return " ";
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
