import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { createCurrentTimeProvider } from "../../../../platform/time/src/index.js";
import type { OutputRouter } from "../../../../platform/output-router/src/index.js";
import type { DailyShellStore, ShellOption } from "../../../../contexts/agent-profile/src/ports/shell-store.js";
import { filterOutfits, resolveOutfitByName, shouldAttemptOnBodyGeneration } from "../../../../contexts/agent-profile/src/domain/outfit.js";
import type { AliceStore } from "../../../../contexts/conversation-hub/src/ports/conversation-store.js";
import type { AgentOutput, ToolCall, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { ToolOutputTargetResolver } from "../../../../contexts/capabilities/src/tool-output-target.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import { shellToolText, wardrobeTool } from "../profile.js";

export type ShellToolTarget = {
  plugin: string;
  accountId?: string;
  channelId?: string;
  userId?: string;
  sessionId: string;
};

export type ShellToolsDeps = {
  dailyShellStore: DailyShellStore;
  store: Pick<AliceStore, "insertOutboundMessage" | "markOutboundMessageSent" | "markOutboundMessageFailed">;
  outputRouter: Pick<OutputRouter, "send">;
  time?: CurrentTimeProvider;
  attemptOnBodyGeneration?(outfit: ShellOption): Promise<unknown> | unknown;
  getDefaultTarget?(): ShellToolTarget | undefined;
  resolveOutputTarget?: ToolOutputTargetResolver;
  appendMessageLog?(input: {
    direction: "outbound";
    plugin: string;
    kind: string;
    target?: string;
    sessionId?: string;
    status?: string;
    summary: string;
    error?: string;
  }): unknown;
};

export function createShellTools(deps: ShellToolsDeps): ToolPlugin {
  const time = deps.time ?? createCurrentTimeProvider("UTC");

  return {
    id: "shell",
    listTools() {
      return [wardrobeTool];
    },
    async execute(call) {
      if (call.toolName === wardrobeTool.name) return wardrobe(call);
      return { callId: call.id, ok: false, error: shellToolText.unknownTool(call.toolName) };
    }
  };

  async function wardrobe(call: ToolCall): Promise<ToolResult> {
    const action = stringValue(call.input.action).trim();
    if (action === "list") return listWardrobe(call);
    if (action === "mirror") return mirrorWardrobe(call);
    if (action === "switch") return switchOutfit(call);
    if (action === "random") return randomOutfit(call);
    return toolError(call, shellToolText.unsupportedAction);
  }

  function listWardrobe(call: ToolCall): ToolResult {
    const config = deps.dailyShellStore.getConfig(time.now().date, time.timeZone);
    const query = stringValue(call.input.name).trim();
    return {
      callId: call.id,
      ok: true,
      output: query ? formatOutfits(filterOutfits(config.outfits, query)) : formatGroups(config.outfits)
    };
  }

  function mirrorWardrobe(call: ToolCall): ToolResult {
    const config = deps.dailyShellStore.getConfig(time.now().date, time.timeZone);
    return {
      callId: call.id,
      ok: true,
      output: formatOutfit(config.daily.outfit, false)
    };
  }

  async function switchOutfit(call: ToolCall): Promise<ToolResult> {
    const target = resolveTarget(call);
    if (!target) return wardrobeError(call, shellToolText.noCurrentSession);
    const name = stringValue(call.input.name).trim();
    if (!name) return wardrobeError(call, shellToolText.nameRequired);

    const config = deps.dailyShellStore.getConfig(time.now().date, time.timeZone);
    const match = resolveOutfitByName(config.outfits, name);
    if (match.kind === "none") return wardrobeError(call, shellToolText.unknownOutfitName);
    if (match.kind === "ambiguous") {
      const error = xmlError(shellToolText.ambiguousOutfitName(name));
      return {
        callId: call.id,
        ok: false,
        error,
        output: `${error}\n<candidates>\n${formatOutfits(match.outfits)}\n</candidates>`
      };
    }

    return changeOutfit(call, target, match.outfit.id);
  }

  async function randomOutfit(call: ToolCall): Promise<ToolResult> {
    const target = resolveTarget(call);
    if (!target) return wardrobeError(call, shellToolText.noCurrentSession);

    const config = deps.dailyShellStore.getConfig(time.now().date, time.timeZone);
    const query = stringValue(call.input.name).trim();
    const outfits = query ? filterOutfits(config.outfits, query) : config.outfits;
    if (outfits.length === 0) return wardrobeError(call, shellToolText.unknownOutfitName);
    return changeOutfit(call, target, outfits[Math.floor(Math.random() * outfits.length)].id);
  }

  async function changeOutfit(call: ToolCall, target: ShellToolTarget, outfitId: string): Promise<ToolResult> {
    let shell;
    try {
      shell = deps.dailyShellStore.switchOutfit(time.now().date, time.timeZone, outfitId);
    } catch (error) {
      if (error instanceof Error && error.message === "unknown_outfit") return wardrobeError(call, shellToolText.unknownOutfitName);
      throw error;
    }

    const noticeResult = await sendChangingNotice(call.id, target);
    if (noticeResult.ok === false) return noticeResult.result;
    if (shouldAttemptOnBodyGeneration(shell.outfit)) {
      await deps.attemptOnBodyGeneration?.(shell.outfit);
      shell = deps.dailyShellStore.get(time.now().date, time.timeZone);
    }

    return {
      callId: call.id,
      ok: true,
      output: shellToolText.switched
    };
  }

  async function sendChangingNotice(callId: string, target: ShellToolTarget): Promise<{ ok: true } | { ok: false; result: ToolResult }> {
    const text = shellToolText.changingNotice;
    const now = time.now();
    const output: AgentOutput = {
      id: createId("tool_out"),
      target: {
        plugin: target.plugin,
        accountId: target.accountId,
        channelId: target.channelId,
        userId: target.userId,
        sessionId: target.sessionId
      },
      content: { kind: "text", text },
      meta: {
        createdAt: now.iso,
        createdAtUtc: now.date.toISOString(),
        urgency: "normal",
        allowStreaming: false
      }
    };
    const stored = deps.store.insertOutboundMessage({
      plugin: output.target.plugin,
      conversationId: output.target.sessionId,
      senderRole: "system",
      contentType: output.content.kind,
      contentText: text,
      contentJson: JSON.stringify(output.content),
      createdAt: output.meta.createdAt,
      createdAtUtc: output.meta.createdAtUtc
    });
    try {
      const sent = await deps.outputRouter.send(output);
      const sentAtUtc = time.now().date.toISOString();
      deps.store.markOutboundMessageSent(stored.id, extractSentMessageId(sent), sentAtUtc, extractSentMessageCreatedAtUtc(sent));
      deps.appendMessageLog?.({
        direction: "outbound",
        plugin: output.target.plugin,
        kind: output.content.kind,
        target: output.target.channelId ?? output.target.userId,
        sessionId: output.target.sessionId,
        status: "sent",
        summary: text
      });
      return { ok: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failedTime = time.now();
      deps.store.markOutboundMessageFailed(stored.id, failedTime.iso, reason, failedTime.date.toISOString());
      deps.appendMessageLog?.({
        direction: "outbound",
        plugin: output.target.plugin,
        kind: output.content.kind,
        target: output.target.channelId ?? output.target.userId,
        sessionId: output.target.sessionId,
        status: "send_failed",
        summary: text,
        error: reason
      });
      return {
        ok: false,
        result: { callId, ok: false, error: xmlError(reason) }
      };
    }
  }

  function resolveTarget(call: ToolCall): ShellToolTarget | undefined {
    const resolved = deps.resolveOutputTarget?.(call);
    if (resolved) return resolved;
    if (call.requester?.plugin && call.externalSession?.sessionId) {
      return {
        plugin: call.requester.plugin,
        accountId: call.requester.accountId,
        channelId: call.requester.channelId,
        userId: call.requester.userId,
        sessionId: call.externalSession.sessionId
      };
    }
    return deps.getDefaultTarget?.();
  }
}

function formatOutfit(outfit: ShellOption, compact: boolean): string {
  const group = escapeXmlAttribute(outfit.group?.trim() || "root");
  return compact
    ? `<${outfit.name} group="${group}" />`
    : `<${outfit.name} group="${group}">\n${outfit.content}\n</${outfit.name}>`;
}

function formatOutfits(outfits: ShellOption[]): string {
  return outfits.map((outfit) => formatOutfit(outfit, outfits.length > 3)).join("\n");
}

function formatGroups(outfits: ShellOption[]): string {
  const groups = [...new Set(outfits.map((outfit) => outfit.group?.trim() || "root"))];
  return `<groups>\n${groups.join("\n")}\n</groups>`;
}

function xmlError(message: string): string {
  return `<error>${escapeXmlText(message)}</error>`;
}

function wardrobeError(call: ToolCall, error: string): ToolResult {
  return { callId: call.id, ok: false, error: xmlError(error) };
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function extractSentMessageId(value: unknown): string | undefined {
  if (value && typeof value === "object" && "messageId" in value) {
    const messageId = (value as { messageId?: unknown }).messageId;
    return typeof messageId === "string" ? messageId : undefined;
  }
  return undefined;
}

function extractSentMessageCreatedAtUtc(value: unknown): string | undefined {
  if (value && typeof value === "object" && "createdAtUtc" in value) {
    const createdAtUtc = (value as { createdAtUtc?: unknown }).createdAtUtc;
    return typeof createdAtUtc === "string" ? createdAtUtc : undefined;
  }
  return undefined;
}

function toolError(call: ToolCall, error: string): ToolResult {
  return { callId: call.id, ok: false, error };
}
