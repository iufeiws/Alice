import { createLLMSessionTranscriptLogger } from '../../llm-session/src/adapters/jsonl-llm-session-log.js';
import { parseZonedIso } from '../../../platform/time/src/index.js';
import type { MemoryInductionSession } from './model.js';

export function createMemoryInductionSession(
  root: string | undefined,
  time: string,
  options: { name: string; windowStartAt?: string; windowEndAt: string; timezone: string; nowIso: () => string }
): MemoryInductionSession {
  const session: MemoryInductionSession = {
    messages: [],
    roundOffset: 0,
    completedTargets: []
  };
  if (!root) return session;
  const logger = createLLMSessionTranscriptLogger({
    root,
    time,
    timeUtc: parseZonedIso(time, options.timezone).toISOString(),
    now: () => {
      const current = options.nowIso();
      return { time: current, timeUtc: parseZonedIso(current, options.timezone).toISOString() };
    },
    namespace: "memorize",
    name: options.name,
    metadata: (state) => {
      const last = state.messages.at(-1);
      return {
        type: "llm_session",
        schemaVersion: 1,
        sessionId: Date.parse(state.startedAtUtc ?? time),
        sessionCreatedAtUtc: state.startedAtUtc,
        agent: "memorize",
        target: session.activeTarget,
        targets: session.completedTargets,
        windowStartAt: options.windowStartAt,
        windowEndAt: options.windowEndAt,
        startedAt: time,
        startedAtUtc: state.startedAtUtc,
        updatedAt: state.updatedAt,
        updatedAtUtc: state.updatedAtUtc,
        requestCount: state.requestCount,
        responseCount: state.responseCount,
        currentRound: state.currentRound,
        latestRequest: state.latestRequest,
        latestResponse: state.latestResponse,
        messageCount: state.messages.length,
        lastMessageRole: last?.role,
        lastMessageAt: state.updatedAt,
        mode: "memorize",
        clearedAt: session.clearedAt,
        clearedAtUtc: session.clearedAt ? parseZonedIso(session.clearedAt, options.timezone).toISOString() : undefined,
        clearReason: session.clearReason
      };
    }
  });
  session.append = logger.append;
  return session;
}

export function clearMemoryInductionSession(session: MemoryInductionSession | undefined, time: string, reason: string): void {
  if (!session || session.clearedAt) return;
  session.clearedAt = time;
  session.clearReason = reason;
  session.activeTarget = undefined;
  session.append?.({ type: "final_messages", messages: session.messages });
}
