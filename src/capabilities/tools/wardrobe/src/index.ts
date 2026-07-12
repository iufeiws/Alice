import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { createCurrentTimeProvider } from "../../../../platform/time/src/index.js";
import type { OutputRouter } from "../../../../platform/output-router/src/index.js";
import type { AliceStore } from "../../../../contexts/conversation-hub/src/ports/conversation-store.js";
import type { ToolCall, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { ToolOutputTargetResolver } from "../../../../contexts/capabilities/src/tool-output-target.js";
import { sendSystemNoticeFromRuntime } from "../../../../contexts/conversation-hub/src/application/message-runtime.js";
import { filterOutfits, resolveOutfitByName, shouldAttemptOnBodyGeneration, type Outfit } from "../../../../contexts/wardrobe/src/index.js";
import { wardrobeTool, wardrobeToolText } from "../profile.js";

export type WardrobeToolTarget = {
  plugin: string;
  accountId?: string;
  channelId?: string;
  userId?: string;
  sessionId: string;
};

export type WardrobeRuntime = {
  getConfig(date: Date, timeZone: string): { daily: { outfit: Outfit }; outfits: Outfit[] };
  get(date: Date, timeZone: string): { outfit: Outfit };
  switchOutfit(date: Date, timeZone: string, outfitId: string): { outfit: Outfit };
};

export type WardrobeToolsDeps = {
  wardrobeRuntime: WardrobeRuntime;
  store: Pick<AliceStore, "insertOutboundMessage" | "markOutboundMessageSent" | "markOutboundMessageFailed">;
  outputRouter: Pick<OutputRouter, "send">;
  time?: CurrentTimeProvider;
  attemptOnBodyGeneration?(outfit: Outfit): Promise<unknown> | unknown;
  getDefaultTarget?(): WardrobeToolTarget | undefined;
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

export function createWardrobeTools(deps: WardrobeToolsDeps): ToolPlugin {
  const time = deps.time ?? createCurrentTimeProvider("UTC");

  return {
    id: "wardrobe",
    listTools() {
      return [wardrobeTool];
    },
    async execute(call) {
      if (call.toolName === wardrobeTool.name) return wardrobe(call);
      return { callId: call.id, ok: false, error: wardrobeToolText.unknownTool(call.toolName) };
    }
  };

  async function wardrobe(call: ToolCall): Promise<ToolResult> {
    const action = stringValue(call.input.action).trim();
    if (action === "list") return listWardrobe(call);
    if (action === "mirror") return mirrorWardrobe(call);
    if (action === "switch") return switchWardrobe(call);
    if (action === "random") return randomWardrobe(call);
    return toolError(call, wardrobeToolText.unsupportedAction);
  }

  function listWardrobe(call: ToolCall): ToolResult {
    const config = deps.wardrobeRuntime.getConfig(time.now().date, time.timeZone);
    const query = stringValue(call.input.name).trim();
    return {
      callId: call.id,
      ok: true,
      output: query ? formatOutfits(filterOutfits(config.outfits, query)) : formatGroups(config.outfits)
    };
  }

  function mirrorWardrobe(call: ToolCall): ToolResult {
    const config = deps.wardrobeRuntime.getConfig(time.now().date, time.timeZone);
    return {
      callId: call.id,
      ok: true,
      output: formatOutfit(config.daily.outfit, false)
    };
  }

  async function switchWardrobe(call: ToolCall): Promise<ToolResult> {
    const target = resolveTarget(call);
    if (!target) return wardrobeError(call, wardrobeToolText.noCurrentSession);
    const name = stringValue(call.input.name).trim();
    if (!name) return wardrobeError(call, wardrobeToolText.nameRequired);

    const config = deps.wardrobeRuntime.getConfig(time.now().date, time.timeZone);
    const match = resolveOutfitByName(config.outfits, name);
    if (match.kind === "none") return wardrobeError(call, wardrobeToolText.unknownOutfitName);
    if (match.kind === "ambiguous") {
      const error = xmlError(wardrobeToolText.ambiguousOutfitName(name));
      return {
        callId: call.id,
        ok: false,
        error,
        output: `${error}\n<candidates>\n${formatOutfits(match.outfits)}\n</candidates>`
      };
    }

    return changeWardrobe(call, target, match.outfit.id);
  }

  async function randomWardrobe(call: ToolCall): Promise<ToolResult> {
    const target = resolveTarget(call);
    if (!target) return wardrobeError(call, wardrobeToolText.noCurrentSession);

    const config = deps.wardrobeRuntime.getConfig(time.now().date, time.timeZone);
    const query = stringValue(call.input.name).trim();
    const outfits = query ? filterOutfits(config.outfits, query) : config.outfits;
    if (outfits.length === 0) return wardrobeError(call, wardrobeToolText.unknownOutfitName);
    return changeWardrobe(call, target, outfits[Math.floor(Math.random() * outfits.length)].id);
  }

  async function changeWardrobe(call: ToolCall, target: WardrobeToolTarget, outfitId: string): Promise<ToolResult> {
    let current;
    try {
      current = deps.wardrobeRuntime.switchOutfit(time.now().date, time.timeZone, outfitId);
    } catch (error) {
      if (error instanceof Error && error.message === "unknown_outfit") return wardrobeError(call, wardrobeToolText.unknownOutfitName);
      throw error;
    }

    const noticeResult = await sendChangingNotice(call.id, target);
    if (noticeResult.ok === false) return noticeResult.result;
    if (shouldAttemptOnBodyGeneration(current.outfit)) {
      await deps.attemptOnBodyGeneration?.(current.outfit);
      current = deps.wardrobeRuntime.get(time.now().date, time.timeZone);
    }

    return {
      callId: call.id,
      ok: true,
      output: wardrobeToolText.switched
    };
  }

  async function sendChangingNotice(callId: string, target: WardrobeToolTarget): Promise<{ ok: true } | { ok: false; result: ToolResult }> {
    const text = wardrobeToolText.changingNotice;
    try {
      await sendSystemNoticeFromRuntime({
        time,
        store: deps.store,
        send: (output) => deps.outputRouter.send(output),
        appendMessageLog: deps.appendMessageLog
      }, { target, text });
      return { ok: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        result: { callId, ok: false, error: xmlError(reason) }
      };
    }
  }

  function resolveTarget(call: ToolCall): WardrobeToolTarget | undefined {
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

function formatOutfit(outfit: Outfit, compact: boolean): string {
  const group = escapeXmlAttribute(outfit.group?.trim() || "root");
  return compact
    ? `<${outfit.name} group="${group}" />`
    : `<${outfit.name} group="${group}">\n${outfit.content}\n</${outfit.name}>`;
}

function formatOutfits(outfits: Outfit[]): string {
  return outfits.map((outfit) => formatOutfit(outfit, outfits.length > 3)).join("\n");
}

function formatGroups(outfits: Outfit[]): string {
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

function toolError(call: ToolCall, error: string): ToolResult {
  return { callId: call.id, ok: false, error };
}
