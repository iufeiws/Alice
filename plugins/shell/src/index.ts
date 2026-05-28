import type { CurrentTimeProvider } from "../../../core/time/src/index.js";
import { createCurrentTimeProvider } from "../../../core/time/src/index.js";
import type { OutputRouter } from "../../../core/output-router/src/index.js";
import type { DailyShellStore, ShellOption } from "../../../core/agent/src/shells.js";
import type { AliceStore } from "../../../packages/storage/src/sqlite-store.js";
import type { AgentOutput, ToolCall, ToolDefinition, ToolPlugin, ToolResult } from "../../../packages/types/src/index.js";
import { createId } from "../../../packages/types/src/index.js";

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
  getDefaultTarget?(): ShellToolTarget | undefined;
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
      if (call.toolName === "wardrobe") return wardrobe(call);
      return { callId: call.id, ok: false, error: `Unknown shell tool: ${call.toolName}` };
    }
  };

  async function wardrobe(call: ToolCall): Promise<ToolResult> {
    const action = stringValue(call.input.action).trim();
    if (action === "list") return listWardrobe(call);
    if (action === "switch") return switchOutfit(call);
    return toolError(call, "unsupported action");
  }

  function listWardrobe(call: ToolCall): ToolResult {
    const config = deps.dailyShellStore.getConfig(time.now().date, time.timeZone);
    const query = stringValue(call.input.name).trim();
    const outfits = query ? filterOutfits(config.outfits, query) : config.outfits;
    return {
      callId: call.id,
      ok: true,
      output: JSON.stringify({
        current: toOutfitOutput(config.daily.outfit, true),
        query: query || undefined,
        outfits: outfits.map((outfit) => toOutfitOutput(outfit, outfit.id === config.daily.outfit.id))
      })
    };
  }

  async function switchOutfit(call: ToolCall): Promise<ToolResult> {
    const target = resolveTarget(call);
    if (!target) return toolError(call, "No current messaging session is available");
    const name = stringValue(call.input.name).trim();
    if (!name) return toolError(call, "name is required");

    const config = deps.dailyShellStore.getConfig(time.now().date, time.timeZone);
    const match = resolveOutfitByName(config.outfits, name);
    if (match.kind === "none") return toolError(call, "unknown outfit name");
    if (match.kind === "ambiguous") {
      return {
        callId: call.id,
        ok: false,
        error: `ambiguous outfit name: ${name}`,
        output: JSON.stringify({
          candidates: match.outfits.map((outfit) => toOutfitOutput(outfit, outfit.id === config.daily.outfit.id))
        })
      };
    }

    let shell;
    try {
      shell = deps.dailyShellStore.switchOutfit(time.now().date, time.timeZone, match.outfit.id);
    } catch (error) {
      if (error instanceof Error && error.message === "unknown_outfit") return toolError(call, "unknown outfit name");
      throw error;
    }

    const noticeResult = await sendChangingNotice(call.id, target);
    if (!noticeResult.ok) return noticeResult.result;

    return {
      callId: call.id,
      ok: true,
      invalidateLLMSession: true,
      output: JSON.stringify({
        current: toOutfitOutput(shell.outfit, true),
        message: `服装已切换为${shell.outfit.name}`,
        rendered: deps.dailyShellStore.render(time.now().date, time.timeZone)
      })
    };
  }

  async function sendChangingNotice(callId: string, target: ShellToolTarget): Promise<{ ok: true } | { ok: false; result: ToolResult }> {
    const text = "-少女已更衣-";
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
        createdAt: time.now().iso,
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
      createdAt: output.meta.createdAt
    });
    try {
      const sent = await deps.outputRouter.send(output);
      deps.store.markOutboundMessageSent(stored.id, extractSentMessageId(sent), time.now().iso);
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
      deps.store.markOutboundMessageFailed(stored.id, time.now().iso, reason);
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
        result: { callId, ok: false, error: reason }
      };
    }
  }

  function resolveTarget(call: ToolCall): ShellToolTarget | undefined {
    if (call.requester?.plugin && call.session?.sessionId) {
      return {
        plugin: call.requester.plugin,
        accountId: call.requester.accountId,
        channelId: call.requester.channelId,
        userId: call.requester.userId,
        sessionId: call.session.sessionId
      };
    }
    return deps.getDefaultTarget?.();
  }
}

const wardrobeTool: ToolDefinition = {
  name: "wardrobe",
  description: "查看或切换爱丽丝的服装。action=list 返回可用衣橱，可用 name 模糊过滤；action=switch 根据服装 name 切换服装。",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "switch"] },
      name: { type: "string" }
    },
    required: ["action"],
    additionalProperties: false
  }
};

function toOutfitOutput(outfit: ShellOption, current: boolean): Record<string, unknown> {
  return {
    id: outfit.id,
    name: outfit.name,
    content: outfit.content,
    group: outfit.group,
    imageUrl: outfit.imageUrl,
    current
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function filterOutfits(outfits: ShellOption[], query: string): ShellOption[] {
  const normalizedQuery = normalizeSearchText(query);
  return outfits.filter((outfit) => outfitSearchText(outfit).includes(normalizedQuery));
}

function resolveOutfitByName(outfits: ShellOption[], name: string):
  | { kind: "one"; outfit: ShellOption }
  | { kind: "ambiguous"; outfits: ShellOption[] }
  | { kind: "none" } {
  const normalizedName = normalizeSearchText(name);
  const exact = outfits.filter((outfit) => normalizeSearchText(outfit.name) === normalizedName);
  if (exact.length === 1) return { kind: "one", outfit: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", outfits: exact };

  const matches = filterOutfits(outfits, name);
  if (matches.length === 1) return { kind: "one", outfit: matches[0] };
  if (matches.length > 1) return { kind: "ambiguous", outfits: matches };
  return { kind: "none" };
}

function outfitSearchText(outfit: ShellOption): string {
  return normalizeSearchText([
    outfit.name,
    outfit.id,
    outfit.group ?? "",
    outfit.content
  ].join("\n"));
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function extractSentMessageId(value: unknown): string | undefined {
  if (value && typeof value === "object" && "messageId" in value) {
    const messageId = (value as { messageId?: unknown }).messageId;
    return typeof messageId === "string" ? messageId : undefined;
  }
  return undefined;
}

function toolError(call: ToolCall, error: string): ToolResult {
  return { callId: call.id, ok: false, error };
}
