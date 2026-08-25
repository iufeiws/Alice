export type PiVisibleMessage = { role: "user" | "assistant"; content: unknown };
export type PiRawMessage = Record<string, unknown>;

export function isVisibleMessage(message: unknown): boolean;
export function projectVisibleMessages(entries: Array<{ type?: unknown; id?: unknown; message?: unknown }>): PiVisibleMessage[];
export function projectRawMessages(entries: Array<{ type?: unknown; id?: unknown; message?: unknown }>): PiRawMessage[];
export function projectLatestAssistantMessageAfter(
  entries: Array<{ type?: unknown; id?: unknown; message?: unknown }>,
  entryId: string
): ({ role: "assistant"; content: unknown }) | undefined;
export function projectLatestAssistantOutcomeAfter(
  entries: Array<{ type?: unknown; id?: unknown; message?: unknown }>,
  entryId: string
): { status: "completed"; text: string } | { status: "failed"; text: string } | undefined;
export function accessMessages(messages: PiRawMessage[], access: unknown): PiRawMessage[];
export function parseMessageAccess(
  access: unknown
): { kind: "index"; index: number } | { kind: "slice"; start: number | undefined; end: number | undefined };
