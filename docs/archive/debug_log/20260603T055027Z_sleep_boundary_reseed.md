# Sleep Boundary Reseed Debug Log

UTC time: 2026-06-03T05:50:27Z

## Background

The Memory Selected Day window showed an unexpected short sleep window:

- local: `2026-06-03T03:21:49.342 -> 2026-06-03T03:21:50.068`
- UTC: `2026-06-02T19:21:49.342Z -> 2026-06-02T19:21:50.068Z`

This appeared after manually deleting the bad sleep boundary rows from `memory-files/diary/diary.sqlite`.

## Observed State

After cleanup, the latest intended persisted sleep boundary was:

- `sleep_boundaries.id=12`
- `occurred_at=2026-06-03T03:21:49.342`
- `occurred_at_utc=2026-06-02T19:21:49.342Z`
- `source=sleep`

The deleted `2026-06-03T03:21:50.068` boundary was later recreated as:

- `sleep_boundaries.id=15`
- `occurred_at=2026-06-03T03:21:50.068`
- `occurred_at_utc=2026-06-02T19:21:50.068Z`
- `created_at=2026-06-03T13:45:09.368`
- `created_at_utc=2026-06-03T05:45:09.368Z`

The message store still contained the persisted system notice:

- `messages.id=2357`
- `content_text=-少女已入眠-`
- `created_at=2026-06-03T03:21:50.068`
- `created_at_utc=2026-06-02T19:21:50.068Z`

## Root Cause

`apps/api/src/admin-routes.ts` calls `recordPersistedSleepMessageBoundaries(context)` while resolving Memory sleep windows.

That function scans persisted messages for `contentText === "-少女已入眠-"` and inserts a sleep boundary when no boundary exists with the exact same `occurred_at`.

Because the automatic state transition had already recorded:

- `2026-06-03T03:21:49.342`

and the persisted system notice had:

- `2026-06-03T03:21:50.068`

the exact-string dedupe did not match. Opening or refreshing the Memory window re-seeded the deleted `03:21:50.068` boundary from the message table.

## Complication

The current `sleep_preparation_boundaries` table is no longer a clean source for the original incident, because a later manual sleep-state edit wrote another preparation boundary using stale state.

Current observed polluted rows included:

- original preparation boundary: `id=1`, `occurred_at=2026-06-03T03:16:28.678`, `created_at=2026-06-03T03:21:49.342`
- later manual-edit pollution: `id=2`, same `occurred_at`, `created_at=2026-06-03T13:10:47.266`

The original issue must therefore be reconstructed from the session transcript and system logs, not from the current sleep preparation table alone.

## Handling Decision

Disable `recordPersistedSleepMessageBoundaries(context)`.

Reason:

- The function mutates diary sleep boundary state from read-path Memory window resolution.
- It can recreate deleted bad rows whenever a persisted `-少女已入眠-` message remains.
- Exact timestamp matching is too weak for deduping state-transition boundaries against system notice messages.
- Reconstructing historical sleep boundaries from messages should be an explicit repair/backfill action, not an implicit admin-page side effect.

Expected behavior after disabling:

- Opening Memory Selected Day should not write new `sleep_boundaries` rows.
- Deleting or repairing bad sleep boundaries should remain stable.
- If historical backfill is needed, it should be run as a dedicated migration with explicit near-neighbor dedupe.

## Verification Target

After disabling the function, repeat:

1. Delete the bad `2026-06-03T03:21:50.068` sleep boundary if present.
2. Open Memory Selected Day for `2026-06-03`.
3. Confirm `sleep_boundaries` does not regain a row sourced from `messages.id=2357`.
