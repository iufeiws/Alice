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

  return {
    async begin(run) {
      if (!input.client.isStarted()) return undefined;
      const receiveId = pairedFeishuUserId();
      if (!receiveId) return undefined;
      try {
        const initialContent = renderContent("");
        const card = await input.client.createBashRunCard({
          receiveIdType: "open_id",
          receiveId,
          command: run.command,
          content: initialContent
        });
        await input.client.setBashRunCardStreaming({ cardId: card.cardId, enabled: true, sequence: 1 });
        return createSession(card.cardId, run.command, 2);
      } catch (error) {
        input.log?.("warn", `[bash-sandbox] Feishu bash card begin failed: ${errorMessage(error)}`);
        return undefined;
      }
    }
  };

  function createSession(cardId: string, command: string, sequence: number): BashRunReportSession {
    let output = "";
    let nextSequence = sequence;
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
      await input.client.updateBashRunCard({
        cardId,
        block: "content",
        content: renderContent(output),
        sequence: nextSequence
      });
      nextSequence += 1;
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
            await input.client.setBashRunCardStreaming({ cardId, enabled: false, sequence: nextSequence });
          } catch (error) {
            markFailed(error);
          }
        }
      },
      async fail(error) {
        output = trimOutput(`${output}\n[error] ${errorMessage(error)}`);
        await flushNow();
        if (!failed) {
          try {
            await updateTitle();
            await input.client.setBashRunCardStreaming({ cardId, enabled: false, sequence: nextSequence });
          } catch (finishError) {
            markFailed(finishError);
          }
        }
      }
    };

    async function updateTitle(): Promise<void> {
      await input.client.updateBashRunCard({
        cardId,
        block: "title",
        content: `finish: ${command}`,
        sequence: nextSequence
      });
      nextSequence += 1;
    }
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
