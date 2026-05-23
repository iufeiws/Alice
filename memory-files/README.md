# Memory Files

`memory-files` is reserved for human-readable, file-based context and indexes.

## Current Use

The current implementation stores the unique Feishu binding at:

```text
memory-files/indexes/feishu-paired-contacts.json
```

This record is used to:

- allow only one Feishu user/contact;
- route admin send tests;
- support future proactive messages.

## Current Non-Use

Conversation memory currently lives in SQLite:

```text
data/alice.sqlite
```

Markdown long-term profile/session/topic files are not implemented yet.
