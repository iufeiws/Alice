import type { FeishuDynamicCardClient, FeishuToolExecutionPanel } from "../../../../channels/feishu/src/types.js";
import type { FeishuPairingStore } from "../../../../channels/feishu/src/pairing.js";
import type { ToolCall, ToolExecutionReporter, ToolExecutionReportSession, ToolResult } from "../../../agent-loop/src/contracts/agent-contracts.js";

export function createFeishuToolExecutionReporter(input: {
  client: FeishuDynamicCardClient;
  pairingStore: FeishuPairingStore;
  /** 无显式账户上下文时解析默认账户（当前账户指针）。 */
  resolveAccount?(): string | undefined;
  findLatestBoundaryMessageId(): number | null;
  throttleMs?: number;
  outputLimitChars?: number;
  log?(level: "info" | "warn" | "error", message: string): void;
}): ToolExecutionReporter {
  const throttleMs = input.throttleMs ?? 500;
  const outputLimitChars = input.outputLimitChars ?? 12_000;
  const cardIdleMs = 5_000;
  const rootElementId = "tool_calls_root";
  let currentCard: ToolExecutionCardState | undefined;
  let boundaryMessageId: number | null = null;
  let beginQueue: Promise<void> = Promise.resolve();

  return {
    async begin(call) {
      let latestBoundaryMessageId: number | null;
      try {
        latestBoundaryMessageId = input.findLatestBoundaryMessageId();
      } catch (error) {
        input.log?.("warn", `[tool-execution] Feishu card begin failed: ${errorMessage(error)}`);
        return undefined;
      }
      const next = beginQueue.then(() => beginReport(call, latestBoundaryMessageId));
      beginQueue = next.then(() => undefined, () => undefined);
      return await next;
    },
    async endSequence() {
      const card = currentCard;
      if (!card) return;
      await closeCard(card);
    }
  };

  async function beginReport(call: ToolCall, latestBoundaryMessageId: number | null): Promise<ToolExecutionReportSession | undefined> {
    if (!input.client.isStarted()) return undefined;
    const contact = pairedFeishuContact(call.requester?.accountId ?? input.resolveAccount?.());
    if (!contact?.userId) return undefined;
    try {
      const created = await ensureCard(contact.userId, contact.accountId, call, latestBoundaryMessageId);
      boundaryMessageId = latestBoundaryMessageId;
      return createSession(created.card, created.panel);
    } catch (error) {
      input.log?.("warn", `[tool-execution] Feishu card begin failed: ${errorMessage(error)}`);
      return undefined;
    }
  }

  async function ensureCard(receiveId: string, accountId: string | undefined, call: ToolCall, latestBoundaryMessageId: number | null): Promise<{ card: ToolExecutionCardState; panel: FeishuToolExecutionPanel }> {
    if (currentCard && boundaryMessageId !== latestBoundaryMessageId) {
      await closeCard(currentCard);
    }
    if (currentCard?.idleTimer) {
      clearTimeout(currentCard.idleTimer);
      currentCard.idleTimer = undefined;
    }
    const renderedCall = renderCode(call.input);
    const initialResult = renderCode("");
    if (!currentCard) {
      const card = await createCard(receiveId, accountId, call, renderedCall, initialResult);
      card.activeSessions += 1;
      return { card, panel: card.panels[0]! };
    }

    return await appendPanel(currentCard, call, renderedCall, initialResult);
  }

  async function createCard(receiveId: string, accountId: string | undefined, call: ToolCall, renderedCall: string, initialResult: string): Promise<ToolExecutionCardState> {
    const ids = firstPanelIds();
    const firstPanel = createPanel(call.toolName, renderedCall, initialResult, ids);
    const created = await input.client.createToolExecutionCard({
      receiveIdType: "open_id",
      receiveId,
      toolName: firstPanel.toolName,
      call: firstPanel.call,
      result: firstPanel.result,
      titleElementId: rootElementId,
      callElementId: firstPanel.callElementId,
      resultElementId: firstPanel.resultElementId,
      accountId
    });
    const card: ToolExecutionCardState = {
      accountId,
      cardId: created.cardId,
      panels: [firstPanel],
      nextPanelIndex: 2,
      nextSequence: 1,
      activeSessions: 0,
      streaming: false,
      closed: false,
      queue: Promise.resolve()
    };
    currentCard = card;
    await setStreaming(card, true);
    return card;
  }

  async function appendPanel(card: ToolExecutionCardState, call: ToolCall, renderedCall: string, initialResult: string): Promise<{ card: ToolExecutionCardState; panel: FeishuToolExecutionPanel }> {
    const ids = nextPanelIds(card);
    const panel = createPanel(call.toolName, renderedCall, initialResult, ids);
    card.panels.push(panel);
    try {
      await enqueue(card, () => input.client.groupToolExecutionCard({
        cardId: card.cardId,
        rootElementId,
        panels: card.panels,
        sequence: takeSequence(card),
        accountId: card.accountId
      }));
    } catch (error) {
      card.panels.pop();
      throw error;
    }
    await setStreaming(card, true);
    card.activeSessions += 1;
    return { card, panel };
  }

  function createSession(card: ToolExecutionCardState, panel: FeishuToolExecutionPanel): ToolExecutionReportSession {
    let progress = "";
    let flushedProgress = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let flushPromise: Promise<void> = Promise.resolve();
    let failed = false;

    const updateResult = async (content: string): Promise<void> => {
      panel.result = content;
      await enqueue(card, () => input.client.updateToolExecutionCard({
        cardId: card.cardId,
        block: "result",
        elementId: panel.resultElementId,
        content,
        sequence: takeSequence(card),
        accountId: card.accountId
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
          panel.state = state;
          await enqueue(card, () => input.client.updateToolExecutionCard({
            cardId: card.cardId,
            block: "title",
            elementId: card.panels.length === 1 ? rootElementId : panel.titleElementId,
            content: `${panel.toolName}: ${state}`,
            sequence: takeSequence(card),
            accountId: card.accountId
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
    if (card.streaming === enabled) return;
    await enqueue(card, () => input.client.setToolExecutionCardStreaming({ cardId: card.cardId, enabled, sequence: takeSequence(card), accountId: card.accountId }));
    card.streaming = enabled;
  }

  async function enqueue(card: ToolExecutionCardState, run: () => Promise<void>): Promise<void> {
    const next = card.queue.then(run);
    card.queue = next.catch(() => undefined);
    await next;
  }

  function releaseCard(card: ToolExecutionCardState): void {
    card.activeSessions -= 1;
    if (card.activeSessions > 0) return;
    if (card.closed) {
      void finalizeCard(card);
      return;
    }
    card.idleTimer = setTimeout(() => {
      if (currentCard !== card || card.activeSessions !== 0 || card.closed) return;
      card.idleTimer = undefined;
      void setStreaming(card, false).catch((error) => input.log?.("warn", `[tool-execution] Feishu card finalize failed: ${errorMessage(error)}`));
    }, cardIdleMs);
    card.idleTimer.unref?.();
  }

  async function finalizeCard(card: ToolExecutionCardState): Promise<void> {
    try {
      await setStreaming(card, false);
    } catch (error) {
      input.log?.("warn", `[tool-execution] Feishu card finalize failed: ${errorMessage(error)}`);
    }
  }

  async function closeCard(card: ToolExecutionCardState): Promise<void> {
    if (currentCard === card) currentCard = undefined;
    card.closed = true;
    if (card.idleTimer) clearTimeout(card.idleTimer);
    card.idleTimer = undefined;
    if (card.activeSessions === 0) await finalizeCard(card);
  }

  function pairedFeishuContact(accountId?: string) {
    const contacts = input.pairingStore.list();
    if (contacts.length === 0) return undefined;
    return input.pairingStore.getPaired(accountId) ?? contacts[0];
  }

  function trimOutput(value: string): string {
    return value.length <= outputLimitChars ? value : value.slice(value.length - outputLimitChars);
  }
}

type ToolExecutionCardState = {
  accountId?: string;
  cardId: string;
  panels: FeishuToolExecutionPanel[];
  nextPanelIndex: number;
  nextSequence: number;
  activeSessions: number;
  streaming: boolean;
  closed: boolean;
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

function createPanel(toolName: string, call: string, result: string, ids: ToolExecutionPanelIds): FeishuToolExecutionPanel {
  return { toolName, state: "running", call, result, ...ids };
}

function renderCode(value: unknown): string {
  const content = formatCodeValue(value);
  const runs = content.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, runs.reduce((max, run) => Math.max(max, run.length), 0) + 1));
  return `${fence}text\n${content}\n${fence}`;
}

function formatCodeValue(value: unknown): string {
  if (typeof value !== "string") return formatStructuredValue(value, 0);
  if (!value) return " ";
  try {
    return formatStructuredValue(JSON.parse(value), 0);
  } catch {
    return value;
  }
}

function formatStructuredValue(value: unknown, depth: number): string {
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return indent("{}", depth);
    return entries.map(([key, child]) => {
      const header = `${"  ".repeat(depth)}[${key}]`;
      return `${header}\n${formatStructuredValue(child, typeof child === "object" && child !== null ? depth + 1 : depth)}`;
    }).join("\n\n");
  }
  if (value === undefined || value === "") return indent(" ", depth);
  if (typeof value === "string") return indent(value, depth);
  return indent(JSON.stringify(value, null, 2) ?? String(value), depth);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function indent(value: string, depth: number): string {
  const prefix = "  ".repeat(depth);
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
