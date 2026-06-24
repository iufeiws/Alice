# Calendar Tool LLM Interface Update

## Goal

The LLM-facing calendar API must use user-visible facts, not internal database ids.

## Exposed tool

The single tool remains `calendar`.

Actions:

- `add`
- `remove`
- `search`
- `list`

## Add

Input:

```json
{
  "action": "add",
  "title": "string",
  "datetime": "YYYY-MM-DD or YYYY-MM-DD HH:mm",
  "note": "optional string"
}
```

Rules:

- `add` only creates `schedule`.
- Only Gregorian datetime is accepted.
- `datetime` may include time or be date-only.
- Date-only schedule does not trigger timed reminder behavior.
- `title + datetime` must be unique.
- `datetime` must be greater than or equal to now.
- On success, return that day rendered as `<calendar>...</calendar>`.

## Remove

Input:

```json
{
  "action": "remove",
  "title": "string",
  "datetime": "YYYY-MM-DD or YYYY-MM-DD HH:mm"
}
```

Rules:

- Remove by visible `title` and `datetime`, not by id.
- Only future schedules can be removed.
- If both fields match one future schedule, delete it.
- If either field uniquely identifies one future schedule, delete it even when the other field is wrong.
- On success, return the deleted entry and that day rendered after deletion.
- On failure with valid future `datetime`, return future candidates:
  - datetime matches, max 5
  - title matches, max 5
  - each sorted from farther from today to nearer

## Search

Input:

```json
{
  "action": "search",
  "searchkey": "string or string[]",
  "scope": "future | past | both"
}
```

Rules:

- Accept at least one search key.
- Fuzzy match `title`, `note`, `date`, and `time`.
- Return max 10 entries.
- Sort by distance from today.
- `scope` defaults to `future`.

## List

Input:

```json
{
  "action": "list",
  "daysBefore": 5,
  "daysAfter": 5
}
```

Rules:

- `daysBefore` and `daysAfter` default to 5.
- Both are capped at 30.
- Empty days render as `-空-`.

## Rendering

Shared rendering output:

```xml
<calendar>
2026-06-19 星期五 5天前
端午节

2026-06-20 星期六 4天前
-空-
</calendar>
```
