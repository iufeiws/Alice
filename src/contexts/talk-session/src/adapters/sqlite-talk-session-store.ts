import * as sqlite from "../../../../platform/storage/src/sqlite-compat.js";
import { json, normalizeBufferedOutputText, normalizeChunk, normalizeDiscard, normalizeInterrupt, normalizeOutput, normalizeSegment, normalizeSession, normalizeTranscriptEntry, payloadKind, payloadText } from "./sqlite-talk-session-normalizers.js";
import { initialize } from "./sqlite-talk-session-schema.js";
import type { TalkOutput, TalkStore } from "./sqlite-talk-session-types.js";

const fs = await import("node:fs");
const path = await import("node:path");

type DatabaseSync = any;

export type {
  TalkBufferedOutputText,
  TalkEvent,
  TalkEventKind,
  TalkOutput,
  TalkOutputChunk,
  TalkOutputDiscard,
  TalkOutputInterrupt,
  TalkSegment,
  TalkSession,
  TalkSource,
  TalkStore,
  TalkTranscriptEntry
} from "./sqlite-talk-session-types.js";

export function createTalkStore(dbPath: string): TalkStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db: DatabaseSync = new sqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  initialize(db);

  return {
    transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    openSession(input) {
      db.prepare(`
        INSERT INTO talk_sessions(session_id, plugin, account_id, channel_id, user_id, status, started_at, started_at_utc, last_sequence, last_event_at, last_event_at_utc, metadata_json)
        VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 0, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          status = 'open',
          last_event_at = excluded.last_event_at,
          last_event_at_utc = excluded.last_event_at_utc
      `).run(
        input.sessionId,
        input.source.plugin,
        input.source.accountId ?? null,
        input.source.channelId ?? null,
        input.source.userId ?? null,
        input.occurredAt,
        input.occurredAtUtc ?? null,
        input.occurredAt,
        input.occurredAtUtc ?? null,
        json(input.metadata)
      );
    },
    closeSession(input) {
      db.prepare(`
        UPDATE talk_sessions
        SET status = 'closed', ended_at = ?, ended_at_utc = ?, last_event_at = ?, last_event_at_utc = ?
        WHERE session_id = ?
      `).run(input.occurredAt, input.occurredAtUtc ?? null, input.occurredAt, input.occurredAtUtc ?? null, input.sessionId);
    },
    getSession(sessionId) {
      return normalizeSession(db.prepare(`
        SELECT id, session_id AS sessionId, plugin, account_id AS accountId, channel_id AS channelId, user_id AS userId,
               status, started_at AS startedAt, started_at_utc AS startedAtUtc,
               ended_at AS endedAt, ended_at_utc AS endedAtUtc
        FROM talk_sessions
        WHERE session_id = ?
        LIMIT 1
      `).get(sessionId));
    },
    insertEvent(event) {
      const result = db.prepare(`
        INSERT OR IGNORE INTO talk_events(session_id, sequence, kind, occurred_at, occurred_at_utc, payload_kind, payload_text, payload_json, raw_json, processed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.sessionId,
        event.sequence,
        event.kind,
        event.occurredAt,
        event.occurredAtUtc ?? null,
        payloadKind(event.payload),
        payloadText(event.payload),
        json(event.payload),
        json(event.raw),
        event.occurredAt
      );
      const row = db.prepare(`
        SELECT id FROM talk_events WHERE session_id = ? AND sequence = ? LIMIT 1
      `).get(event.sessionId, event.sequence) as { id: number };
      db.prepare(`
        UPDATE talk_sessions
        SET last_sequence = MAX(last_sequence, ?), last_event_at = ?, last_event_at_utc = ?
        WHERE session_id = ?
      `).run(event.sequence, event.occurredAt, event.occurredAtUtc ?? null, event.sessionId);
      return { id: Number(row.id), inserted: result.changes > 0 };
    },
    insertSegment(input) {
      db.prepare(`
        INSERT INTO talk_segments(session_id, event_id, segment_id, role, kind, content_text, content_json, ended_at, ended_at_utc)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, segment_id) DO UPDATE SET
          event_id = COALESCE(excluded.event_id, talk_segments.event_id),
          role = excluded.role,
          kind = excluded.kind,
          content_text = excluded.content_text,
          content_json = excluded.content_json,
          ended_at = excluded.ended_at,
          ended_at_utc = excluded.ended_at_utc
      `).run(
        input.sessionId,
        input.eventId ?? null,
        input.segmentId,
        input.role,
        input.kind,
        input.contentText,
        json(input.contentJson),
        input.endedAt,
        input.endedAtUtc ?? null
      );
      return normalizeSegment(db.prepare(`
        SELECT id, session_id AS sessionId, segment_id AS segmentId, role, kind, content_text AS contentText,
               content_json AS contentJson, ended_at AS endedAt, ended_at_utc AS endedAtUtc
        FROM talk_segments
        WHERE session_id = ? AND segment_id = ?
        LIMIT 1
      `).get(input.sessionId, input.segmentId))!;
    },
    listSegments(sessionId) {
      return db.prepare(`
        SELECT id, session_id AS sessionId, segment_id AS segmentId, role, kind, content_text AS contentText,
               content_json AS contentJson, ended_at AS endedAt, ended_at_utc AS endedAtUtc
        FROM talk_segments
        WHERE session_id = ?
        ORDER BY id ASC
      `).all(sessionId).map((row: unknown) => normalizeSegment(row)!).filter(Boolean);
    },
    upsertTranscriptEntry(input) {
      db.prepare(`
        INSERT INTO talk_transcript_entries(session_id, entry_id, role, content_text, occurred_at, occurred_at_utc, source_kind, source_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, entry_id) DO UPDATE SET
          role = excluded.role,
          content_text = excluded.content_text,
          occurred_at = excluded.occurred_at,
          occurred_at_utc = excluded.occurred_at_utc,
          source_kind = excluded.source_kind,
          source_id = excluded.source_id
      `).run(
        input.sessionId,
        input.entryId,
        input.role,
        input.contentText,
        input.occurredAt,
        input.occurredAtUtc ?? null,
        input.sourceKind ?? null,
        input.sourceId ?? null
      );
      return normalizeTranscriptEntry(db.prepare(`
        SELECT id, session_id AS sessionId, entry_id AS entryId, role, content_text AS contentText,
               occurred_at AS occurredAt, occurred_at_utc AS occurredAtUtc,
               source_kind AS sourceKind, source_id AS sourceId
        FROM talk_transcript_entries
        WHERE session_id = ? AND entry_id = ?
        LIMIT 1
      `).get(input.sessionId, input.entryId))!;
    },
    listTranscriptEntries(sessionId) {
      return db.prepare(`
        SELECT id, session_id AS sessionId, entry_id AS entryId, role, content_text AS contentText,
               occurred_at AS occurredAt, occurred_at_utc AS occurredAtUtc,
               source_kind AS sourceKind, source_id AS sourceId
        FROM talk_transcript_entries
        WHERE session_id = ?
        ORDER BY occurred_at ASC, id ASC
      `).all(sessionId).map((row: unknown) => normalizeTranscriptEntry(row)!).filter(Boolean);
    },
    getOutput(outputId) {
      return getOutput(db, outputId);
    },
    latestOutput(sessionId) {
      return normalizeOutput(db.prepare(`
        SELECT output_id AS outputId, session_id AS sessionId, segment_id AS segmentId, status,
               full_text AS fullText, visible_text AS visibleText, buffer_text AS bufferText,
               pending_chunk_text AS pendingChunkText, pending_chunk_start_char_index AS pendingChunkStartCharIndex,
               next_chunk_sequence AS nextChunkSequence
        FROM talk_outputs
        WHERE session_id = ? AND status IN ('streaming', 'finished')
        ORDER BY id DESC
        LIMIT 1
      `).get(sessionId));
    },
    ensureOutput(input) {
      db.prepare(`
        INSERT OR IGNORE INTO talk_outputs(output_id, session_id, status, full_text, visible_text, buffer_text, pending_chunk_text, pending_chunk_start_char_index, next_chunk_sequence, started_at, started_at_utc)
        VALUES (?, ?, 'streaming', '', '', '', '', 0, 0, ?, ?)
      `).run(input.outputId, input.sessionId, input.now, input.nowUtc ?? null);
      return getOutput(db, input.outputId)!;
    },
    updateOutput(input) {
      const current = getOutput(db, input.outputId);
      if (!current) throw new Error(`talk output not found: ${input.outputId}`);
      const next = { ...current, ...input };
      db.prepare(`
        UPDATE talk_outputs
        SET segment_id = ?, status = ?, full_text = ?, visible_text = ?, buffer_text = ?,
            pending_chunk_text = ?, pending_chunk_start_char_index = ?, next_chunk_sequence = ?
        WHERE output_id = ?
      `).run(
        next.segmentId ?? null,
        next.status,
        next.fullText,
        next.visibleText,
        next.bufferText,
        next.pendingChunkText,
        next.pendingChunkStartCharIndex,
        next.nextChunkSequence,
        input.outputId
      );
      return getOutput(db, input.outputId)!;
    },
    insertReadyChunk(input) {
      const chunkId = `${input.outputId}:chunk:${input.sequence}`;
      db.prepare(`
        INSERT OR IGNORE INTO talk_output_chunks(chunk_id, output_id, session_id, sequence, text, start_char_index, end_char_index, status, ready_at, ready_at_utc)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
      `).run(
        chunkId,
        input.outputId,
        input.sessionId,
        input.sequence,
        input.text,
        input.startCharIndex,
        input.endCharIndex,
        input.now,
        input.nowUtc ?? null
      );
      return normalizeChunk(db.prepare(`
        SELECT chunk_id AS chunkId, output_id AS outputId, session_id AS sessionId, sequence, text,
               start_char_index AS startCharIndex, end_char_index AS endCharIndex, status
        FROM talk_output_chunks
        WHERE chunk_id = ?
        LIMIT 1
      `).get(chunkId))!;
    },
    claimBufferedOutputText(sessionId) {
      const row = db.prepare(`
        SELECT output_id AS outputId, session_id AS sessionId, buffer_text AS text, status
        FROM talk_outputs
        WHERE session_id = ?
          AND status IN ('streaming', 'finished')
          AND buffer_text <> ''
        ORDER BY id ASC
        LIMIT 1
      `).get(sessionId);
      const output = normalizeBufferedOutputText(row);
      if (!output) return undefined;
      db.prepare(`
        UPDATE talk_outputs
        SET buffer_text = ''
        WHERE output_id = ?
      `).run(output.outputId);
      return output;
    },
    claimReadyOutputChunk(sessionId, now, nowUtc) {
      const row = db.prepare(`
        SELECT chunk_id AS chunkId, output_id AS outputId, session_id AS sessionId, sequence, text,
               start_char_index AS startCharIndex, end_char_index AS endCharIndex, status
        FROM talk_output_chunks
        WHERE session_id = ? AND status = 'ready'
        ORDER BY id ASC
        LIMIT 1
      `).get(sessionId);
      const chunk = normalizeChunk(row);
      if (!chunk) return undefined;
      db.prepare(`
        UPDATE talk_output_chunks
        SET status = 'claimed', claimed_at = ?, claimed_at_utc = ?
        WHERE chunk_id = ? AND status = 'ready'
      `).run(now, nowUtc ?? null, chunk.chunkId);
      return { ...chunk, status: "claimed" };
    },
    markChunkPlayed(input) {
      db.prepare(`
        UPDATE talk_output_chunks
        SET status = 'played', playback_finished_at = ?, playback_finished_at_utc = ?
        WHERE session_id = ? AND chunk_id = ? AND status IN ('claimed', 'ready')
      `).run(input.now, input.nowUtc ?? null, input.sessionId, input.chunkId);
    },
    listChunks(outputId) {
      return db.prepare(`
        SELECT chunk_id AS chunkId, output_id AS outputId, session_id AS sessionId, sequence, text,
               start_char_index AS startCharIndex, end_char_index AS endCharIndex, status
        FROM talk_output_chunks
        WHERE output_id = ?
        ORDER BY id ASC
      `).all(outputId).map((row: unknown) => normalizeChunk(row)!).filter(Boolean);
    },
    cancelChunks(outputId, now, nowUtc) {
      db.prepare(`
        UPDATE talk_output_chunks
        SET status = 'cancelled', cancelled_at = ?, cancelled_at_utc = ?
        WHERE output_id = ? AND status IN ('buffering', 'ready', 'claimed')
      `).run(now, nowUtc ?? null, outputId);
    },
    cancelOtherSessionOutputs(sessionId, keepOutputId, now, nowUtc) {
      db.prepare(`
        DELETE FROM talk_transcript_entries
        WHERE session_id = ?
          AND role = 'assistant'
          AND entry_id IN (
            SELECT 'assistant:' || later.output_id
            FROM talk_outputs AS later
            JOIN talk_outputs AS target ON target.output_id = ?
            WHERE later.session_id = ?
              AND later.output_id <> ?
              AND later.id > target.id
              AND later.status IN ('streaming', 'finished')
          )
      `).run(sessionId, keepOutputId, sessionId, keepOutputId);
      db.prepare(`
        UPDATE talk_output_chunks
        SET status = 'cancelled', cancelled_at = ?, cancelled_at_utc = ?
        WHERE session_id = ?
          AND output_id <> ?
          AND output_id IN (
            SELECT later.output_id
            FROM talk_outputs AS later
            JOIN talk_outputs AS target ON target.output_id = ?
            WHERE later.session_id = ?
              AND later.id > target.id
          )
          AND status IN ('buffering', 'ready', 'claimed')
      `).run(now, nowUtc ?? null, sessionId, keepOutputId, keepOutputId, sessionId);
      db.prepare(`
        UPDATE talk_outputs
        SET status = 'cancelled', buffer_text = '', pending_chunk_text = '', interrupted_at = ?, interrupted_at_utc = ?
        WHERE session_id = ?
          AND output_id <> ?
          AND id > (SELECT id FROM talk_outputs WHERE output_id = ?)
          AND status IN ('streaming', 'finished')
      `).run(now, nowUtc ?? null, sessionId, keepOutputId, keepOutputId);
    },
    isSessionOutputIdle(sessionId) {
      const activeOutput = db.prepare(`
        SELECT 1
        FROM talk_outputs
        WHERE session_id = ?
          AND (
            status = 'streaming'
            OR buffer_text <> ''
            OR pending_chunk_text <> ''
          )
        LIMIT 1
      `).get(sessionId);
      if (activeOutput) return false;
      const activeChunk = db.prepare(`
        SELECT 1
        FROM talk_output_chunks
        WHERE session_id = ? AND status IN ('buffering', 'ready', 'claimed')
        LIMIT 1
      `).get(sessionId);
      return !activeChunk;
    },
    pendingVoiceOutputCharCount(sessionId) {
      const output = db.prepare(`
        SELECT COALESCE(SUM(LENGTH(buffer_text) + LENGTH(pending_chunk_text)), 0) AS count
        FROM talk_outputs
        WHERE session_id = ? AND status = 'streaming'
      `).get(sessionId) as { count?: number } | undefined;
      const chunks = db.prepare(`
        SELECT COALESCE(SUM(LENGTH(text)), 0) AS count
        FROM talk_output_chunks
        WHERE session_id = ? AND status = 'ready'
      `).get(sessionId) as { count?: number } | undefined;
      return Number(output?.count ?? 0) + Number(chunks?.count ?? 0);
    },
    insertDiscard(input) {
      db.prepare(`
        INSERT INTO talk_output_discards(discard_id, session_id, output_id, interrupt_id, discarded_text, reason, created_at, created_at_utc, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.discardId,
        input.sessionId,
        input.outputId,
        input.interruptId,
        input.discardedText,
        input.reason,
        input.now,
        input.nowUtc ?? null,
        json(input.metadata)
      );
      return this.getDiscard(input.discardId)!;
    },
    getDiscard(discardId) {
      return normalizeDiscard(db.prepare(`
        SELECT discard_id AS discardId, session_id AS sessionId, output_id AS outputId, interrupt_id AS interruptId,
               discarded_text AS discardedText, reason
        FROM talk_output_discards
        WHERE discard_id = ?
        LIMIT 1
      `).get(discardId));
    },
    insertInterrupt(input) {
      db.prepare(`
        INSERT INTO talk_output_interrupts(interrupt_id, session_id, output_id, event_id, segment_id, reason, played_ms, total_ms, played_ratio, visible_text, discard_id, break_marker, created_at, created_at_utc, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.interruptId,
        input.sessionId,
        input.outputId,
        input.eventId ?? null,
        input.segmentId ?? null,
        input.reason,
        input.playedMs ?? null,
        input.totalMs ?? null,
        input.playedRatio ?? null,
        input.visibleText,
        input.discardId ?? null,
        input.breakMarker,
        input.now,
        input.nowUtc ?? null,
        json(input.metadata)
      );
      return normalizeInterrupt(db.prepare(`
        SELECT interrupt_id AS interruptId, session_id AS sessionId, output_id AS outputId, reason,
               played_ms AS playedMs, total_ms AS totalMs, played_ratio AS playedRatio,
               visible_text AS visibleText, discard_id AS discardId,
               break_marker AS breakMarker, final_user_segment_id AS finalUserSegmentId
        FROM talk_output_interrupts
        WHERE interrupt_id = ?
        LIMIT 1
      `).get(input.interruptId))!;
    },
    latestUnresolvedInterrupt(sessionId) {
      return normalizeInterrupt(db.prepare(`
        SELECT interrupt_id AS interruptId, session_id AS sessionId, output_id AS outputId, reason,
               played_ms AS playedMs, total_ms AS totalMs, played_ratio AS playedRatio,
               visible_text AS visibleText, discard_id AS discardId,
               break_marker AS breakMarker, final_user_segment_id AS finalUserSegmentId
        FROM talk_output_interrupts
        WHERE session_id = ? AND final_user_segment_id IS NULL
        ORDER BY id DESC
        LIMIT 1
      `).get(sessionId));
    },
    resolveLatestInterrupt(input) {
      db.prepare(`
        UPDATE talk_output_interrupts
        SET final_user_segment_id = ?, resolved_at = ?, resolved_at_utc = ?
        WHERE id = (
          SELECT id FROM talk_output_interrupts
          WHERE session_id = ? AND final_user_segment_id IS NULL
          ORDER BY id DESC
          LIMIT 1
        )
      `).run(input.finalUserSegmentId, input.now, input.nowUtc ?? null, input.sessionId);
    },
    resolveInterrupt(input) {
      db.prepare(`
        UPDATE talk_output_interrupts
        SET final_user_segment_id = ?, resolved_at = ?, resolved_at_utc = ?
        WHERE interrupt_id = ? AND final_user_segment_id IS NULL
      `).run(input.finalUserSegmentId, input.now, input.nowUtc ?? null, input.interruptId);
    }
  };
}

function getOutput(db: DatabaseSync, outputId: string): TalkOutput | undefined {
  return normalizeOutput(db.prepare(`
    SELECT output_id AS outputId, session_id AS sessionId, segment_id AS segmentId, status,
           full_text AS fullText, visible_text AS visibleText, buffer_text AS bufferText,
           pending_chunk_text AS pendingChunkText, pending_chunk_start_char_index AS pendingChunkStartCharIndex,
           next_chunk_sequence AS nextChunkSequence, started_at AS startedAt, started_at_utc AS startedAtUtc
    FROM talk_outputs
    WHERE output_id = ?
    LIMIT 1
  `).get(outputId));
}
