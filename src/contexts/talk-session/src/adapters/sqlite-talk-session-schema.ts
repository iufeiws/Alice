type DatabaseSync = any;

export function initialize(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS talk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL UNIQUE,
      plugin TEXT NOT NULL,
      account_id TEXT,
      channel_id TEXT,
      user_id TEXT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      started_at_utc TEXT,
      ended_at TEXT,
      ended_at_utc TEXT,
      last_sequence INTEGER NOT NULL DEFAULT 0,
      last_event_at TEXT NOT NULL,
      last_event_at_utc TEXT,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS talk_sessions_plugin_channel_idx ON talk_sessions(plugin, channel_id);
    CREATE INDEX IF NOT EXISTS talk_sessions_status_idx ON talk_sessions(status, last_event_at);

    CREATE TABLE IF NOT EXISTS talk_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      occurred_at_utc TEXT,
      payload_kind TEXT NOT NULL,
      payload_text TEXT,
      payload_json TEXT,
      raw_json TEXT,
      processed_at TEXT,
      error TEXT,
      UNIQUE(session_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS talk_events_session_id_idx ON talk_events(session_id, id);
    CREATE INDEX IF NOT EXISTS talk_events_kind_idx ON talk_events(kind, occurred_at);

    CREATE TABLE IF NOT EXISTS talk_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      event_id INTEGER,
      segment_id TEXT,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      content_text TEXT NOT NULL,
      content_json TEXT,
      started_at TEXT,
      started_at_utc TEXT,
      ended_at TEXT NOT NULL,
      ended_at_utc TEXT,
      core_processed_at TEXT,
      core_batch_id TEXT,
      UNIQUE(session_id, segment_id)
    );
    CREATE INDEX IF NOT EXISTS talk_segments_session_id_idx ON talk_segments(session_id, id);
    CREATE INDEX IF NOT EXISTS talk_segments_core_pending_idx ON talk_segments(core_processed_at, session_id);

    CREATE TABLE IF NOT EXISTS talk_transcript_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      entry_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_text TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      occurred_at_utc TEXT,
      source_kind TEXT,
      source_id TEXT,
      UNIQUE(session_id, entry_id)
    );
    CREATE INDEX IF NOT EXISTS talk_transcript_entries_session_time_idx ON talk_transcript_entries(session_id, occurred_at, id);

    CREATE TABLE IF NOT EXISTS talk_outputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      output_id TEXT NOT NULL UNIQUE,
      session_id INTEGER NOT NULL,
      segment_id TEXT,
      status TEXT NOT NULL,
      full_text TEXT NOT NULL DEFAULT '',
      visible_text TEXT NOT NULL DEFAULT '',
      buffer_text TEXT NOT NULL DEFAULT '',
      pending_chunk_text TEXT NOT NULL DEFAULT '',
      pending_chunk_start_char_index INTEGER NOT NULL DEFAULT 0,
      next_chunk_sequence INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      started_at_utc TEXT,
      finished_at TEXT,
      finished_at_utc TEXT,
      interrupted_at TEXT,
      interrupted_at_utc TEXT,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS talk_outputs_session_idx ON talk_outputs(session_id, id);

    CREATE TABLE IF NOT EXISTS talk_output_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id TEXT NOT NULL UNIQUE,
      output_id TEXT NOT NULL,
      session_id INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      text TEXT NOT NULL,
      start_char_index INTEGER NOT NULL,
      end_char_index INTEGER NOT NULL,
      status TEXT NOT NULL,
      ready_at TEXT,
      ready_at_utc TEXT,
      claimed_at TEXT,
      claimed_at_utc TEXT,
      cancelled_at TEXT,
      cancelled_at_utc TEXT,
      playback_started_at TEXT,
      playback_started_at_utc TEXT,
      playback_finished_at TEXT,
      playback_finished_at_utc TEXT,
      metadata_json TEXT,
      UNIQUE(output_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS talk_output_chunks_claim_idx ON talk_output_chunks(session_id, status, id);

    CREATE TABLE IF NOT EXISTS talk_output_discards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discard_id TEXT NOT NULL UNIQUE,
      session_id INTEGER NOT NULL,
      output_id TEXT NOT NULL,
      interrupt_id TEXT NOT NULL,
      discarded_text TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_utc TEXT,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS talk_output_discards_session_idx ON talk_output_discards(session_id, id);

    CREATE TABLE IF NOT EXISTS talk_output_interrupts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      interrupt_id TEXT NOT NULL UNIQUE,
      session_id INTEGER NOT NULL,
      output_id TEXT NOT NULL,
      event_id INTEGER,
      segment_id TEXT,
      reason TEXT NOT NULL,
      played_ms INTEGER,
      total_ms INTEGER,
      played_ratio REAL,
      visible_text TEXT NOT NULL,
      discard_id TEXT,
      break_marker TEXT NOT NULL DEFAULT '...',
      created_at TEXT NOT NULL,
      created_at_utc TEXT,
      final_user_segment_id TEXT,
      resolved_at TEXT,
      resolved_at_utc TEXT,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS talk_output_interrupts_session_idx ON talk_output_interrupts(session_id, id);
  `);
}
