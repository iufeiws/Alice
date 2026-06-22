import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { ToolCall, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { CalendarStore, CalendarSystem } from "../../../../platform/storage/src/calendar-store.js";
import { calendarTool, calendarToolText } from "../profile.js";

export * from "./calendar-event-runtime.js";
export * from "./calendar-context.js";

export type CalendarToolsDeps = {
  calendarStore: CalendarStore;
  time: CurrentTimeProvider;
};

export function createCalendarTools(deps: CalendarToolsDeps): ToolPlugin {
  return {
    id: "calendar",
    listTools() {
      return [calendarTool];
    },
    async execute(call) {
      if (call.toolName !== "calendar") return toolError(call, calendarToolText.unknownTool(call.toolName));
      const action = stringValue(call.input.action);
      if (action === "add") return addEntry(call);
      if (action === "remove") return removeEntry(call);
      return toolError(call, calendarToolText.unsupportedAction);
    }
  };

  function addEntry(call: ToolCall): ToolResult {
    const type = stringValue(call.input.type);
    if (type !== "holiday" && type !== "reminder") return toolError(call, calendarToolText.invalidType);
    const title = stringValue(call.input.title).trim();
    if (!title) return toolError(call, calendarToolText.invalidTitle);
    const calendarSystem = calendarSystemValue(call.input.calendarSystem);
    if (!calendarSystem) return toolError(call, calendarToolText.invalidCalendarSystem);
    const month = integerInRange(call.input.month, 1, 12);
    const day = integerInRange(call.input.day, 1, 31);
    if (!month || !day) return toolError(call, calendarToolText.invalidDate);
    const time = type === "reminder" ? stringValue(call.input.time) : undefined;
    if (type === "reminder" && !isTime(time)) return toolError(call, calendarToolText.invalidTime);
    const now = deps.time.now();
    const entry = deps.calendarStore.addEntry({
      kind: type,
      title,
      note: stringValue(call.input.note),
      calendarSystem,
      year: integerInRange(call.input.year, 1, 9999),
      month,
      day,
      isLeapMonth: Boolean(call.input.isLeapMonth),
      time,
      now: now.iso,
      nowUtc: now.date.toISOString()
    });
    return { callId: call.id, ok: true, output: entry };
  }

  function removeEntry(call: ToolCall): ToolResult {
    const id = integerInRange(call.input.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return toolError(call, calendarToolText.invalidId);
    const removed = deps.calendarStore.removeEntry(id);
    if (!removed) return toolError(call, calendarToolText.notFound);
    return { callId: call.id, ok: true, output: removed };
  }
}

function calendarSystemValue(value: unknown): CalendarSystem | undefined {
  return value === "gregorian" || value === "lunar" ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integerInRange(value: unknown, min: number, max: number): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(numeric) && numeric >= min && numeric <= max ? numeric : undefined;
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
}

function toolError(call: ToolCall, error: string): ToolResult {
  return { callId: call.id, ok: false, error };
}
