import type { FeishuDynamicCardClient } from "../../../channels/feishu/src/types.js";
import type { FeishuPairingStore } from "../../../channels/feishu/src/pairing.js";
import type { BashRunReporter, BashRunReportSession, BashRuntimeResult } from "./bash-runtime.js";

export function createFeishuBashRunReporter(input: {
  client: FeishuDynamicCardClient;
  pairingStore: FeishuPairingStore;
  throttleMs?: number;
  outputLimitChars?: number;
  log?(level: "info" | "warn" | "error", message: string): void;
}): BashRunReporter {
  const throttleMs = input.throttleMs ?? 500;
  const outputLimitChars = input.outputLimitChars ?? 12_000;
  const cardIdleMs = 5_000;
  let currentCard: BashRunCardState | undefined;

  return {
    async begin(run) {
      if (!input.client.isStarted()) return undefined;
      const receiveId = pairedFeishuUserId();
      if (!receiveId) return undefined;
      try {
        const initialContent = renderContent("");
        const panel = await ensureCard(receiveId, run.command, initialContent);
        return createSession(panel.card, panel.ids, run.command);
      } catch (error) {
        input.log?.("warn", `[bash-sandbox] Feishu bash card begin failed: ${errorMessage(error)}`);
        return undefined;
      }
    }
  };

  async function ensureCard(receiveId: string, command: string, content: string): Promise<{ card: BashRunCardState; ids: BashRunPanelIds }> {
    if (currentCard?.idleTimer) {
      clearTimeout(currentCard.idleTimer);
      currentCard.idleTimer = undefined;
    }
    if (!currentCard) {
      const ids = firstPanelIds();
      const created = await input.client.createBashRunCard({
        receiveIdType: "open_id",
        receiveId,
        command,
        content,
        titleElementId: ids.titleElementId,
        contentElementId: ids.contentElementId
      });
      currentCard = {
        cardId: created.cardId,
        nextPanelIndex: 2,
        nextSequence: 1,
        activeSessions: 0,
        queue: Promise.resolve()
      };
      await setStreaming(currentCard, true);
      currentCard.activeSessions += 1;
      return { card: currentCard, ids };
    }

    const card = currentCard;
    const ids = nextPanelIds(card);
    await appendPanel(card, command, content, ids);
    await setStreaming(card, true);
    card.activeSessions += 1;
    return { card, ids };
  }

  function createSession(card: BashRunCardState, ids: BashRunPanelIds, command: string): BashRunReportSession {
    let output = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let flushPromise: Promise<void> = Promise.resolve();
    let failed = false;

    const append = (stream: "stdout" | "stderr", delta: string): void => {
      if (failed || !delta) return;
      output = trimOutput(`${output}${stream === "stderr" ? "[stderr] " : ""}${delta}`);
      queueFlush();
    };

    const queueFlush = (): void => {
      if (timer || failed) return;
      timer = setTimeout(() => {
        timer = undefined;
        flushPromise = flushPromise.then(() => update()).catch(markFailed);
      }, throttleMs);
    };

    const flushNow = async (): Promise<void> => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await flushPromise;
      if (!failed) await update();
    };

    const update = async (): Promise<void> => {
      await enqueue(card, () => input.client.updateBashRunCard({
        cardId: card.cardId,
        block: "content",
        elementId: ids.contentElementId,
        content: renderContent(output),
        sequence: takeSequence(card)
      }));
    };

    const markFailed = (error: unknown): void => {
      failed = true;
      input.log?.("warn", `[bash-sandbox] Feishu bash card update failed: ${errorMessage(error)}`);
    };

    return {
      appendStdout(delta) {
        append("stdout", delta);
      },
      appendStderr(delta) {
        append("stderr", delta);
      },
      async finish(result) {
        output = trimOutput(`${output}${finalLine(result)}`);
        await flushNow();
        if (!failed) {
          try {
            await updateTitle();
          } catch (error) {
            markFailed(error);
          } finally {
            releaseCard(card);
          }
        }
      },
      async fail(error) {
        output = trimOutput(`${output}\n[error] ${errorMessage(error)}`);
        await flushNow();
        if (!failed) {
          try {
            await updateTitle();
          } catch (finishError) {
            markFailed(finishError);
          } finally {
            releaseCard(card);
          }
        }
      }
    };

    async function updateTitle(): Promise<void> {
      await enqueue(card, () => input.client.updateBashRunCard({
        cardId: card.cardId,
        block: "title",
        elementId: ids.titleElementId,
        content: `finish: ${command}`,
        sequence: takeSequence(card)
      }));
    }
  }

  async function appendPanel(card: BashRunCardState, command: string, content: string, ids: BashRunPanelIds): Promise<void> {
    await enqueue(card, () => input.client.appendBashRunCardPanel({
      cardId: card.cardId,
      command,
      content,
      titleElementId: ids.titleElementId,
      contentElementId: ids.contentElementId,
      sequence: takeSequence(card)
    }));
  }

  async function setStreaming(card: BashRunCardState, enabled: boolean): Promise<void> {
    await enqueue(card, () => input.client.setBashRunCardStreaming({
      cardId: card.cardId,
      enabled,
      sequence: takeSequence(card)
    }));
  }

  async function enqueue(card: BashRunCardState, run: () => Promise<void>): Promise<void> {
    const next = card.queue.then(run);
    card.queue = next.catch(() => undefined);
    await next;
  }

  function takeSequence(card: BashRunCardState): number {
    const sequence = card.nextSequence;
    card.nextSequence += 1;
    return sequence;
  }

  function firstPanelIds(): BashRunPanelIds {
    return { titleElementId: "bash_1_title", contentElementId: "bash_1_out" };
  }

  function nextPanelIds(card: BashRunCardState): BashRunPanelIds {
    const index = card.nextPanelIndex;
    card.nextPanelIndex += 1;
    return { titleElementId: `bash_${index}_title`, contentElementId: `bash_${index}_out` };
  }

  function releaseCard(card: BashRunCardState): void {
    card.activeSessions -= 1;
    if (card.activeSessions > 0) return;
    card.idleTimer = setTimeout(() => {
      if (currentCard !== card || card.activeSessions !== 0) return;
      currentCard = undefined;
      void setStreaming(card, false).catch((error) => {
        input.log?.("warn", `[bash-sandbox] Feishu bash card finalize failed: ${errorMessage(error)}`);
      });
    }, cardIdleMs);
    card.idleTimer.unref?.();
  }

  function pairedFeishuUserId(): string | undefined {
    const contacts = input.pairingStore.list();
    if (contacts.length !== 1) return undefined;
    return contacts[0].userId || undefined;
  }

  function trimOutput(value: string): string {
    return value.length <= outputLimitChars ? value : value.slice(value.length - outputLimitChars);
  }
}

type BashRunCardState = {
  cardId: string;
  nextPanelIndex: number;
  nextSequence: number;
  activeSessions: number;
  queue: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
};

type BashRunPanelIds = {
  titleElementId: string;
  contentElementId: string;
};

function renderContent(output: string): string {
  return `\`\`\`text\n${output || " "}\n\`\`\``;
}

function finalLine(result: BashRuntimeResult): string {
  if (result.denied) return `\n[denied] ${result.denyReason ?? "denied"}`;
  if (result.timedOut) return "\n[timed out]";
  return `\n[exit ${result.exitCode ?? "unknown"}]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
