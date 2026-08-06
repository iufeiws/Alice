export type PiVisibleMessage = { role: "user" | "assistant"; content: unknown };

export function isVisibleMessage(message: unknown): boolean;
export function projectVisibleMessages(entries: Array<{ type?: unknown; id?: unknown; message?: unknown }>): PiVisibleMessage[];
export function projectLatestAssistantMessageAfter(
  entries: Array<{ type?: unknown; id?: unknown; message?: unknown }>,
  entryId: string
): ({ role: "assistant"; content: unknown }) | undefined;
export function accessVisibleMessages(messages: PiVisibleMessage[], access: unknown): PiVisibleMessage[];
export function parseMessageAccess(
  access: unknown
): { kind: "index"; index: number } | { kind: "slice"; start: number | undefined; end: number | undefined };
