# Code Review Notes

Open issues from the workspace review:

- Deferred: `check_chat` and `search_messages` describe the current one-on-one conversation, but they filter by plugin only. In multi-session use, tool output can include other conversations. This is expected to be addressed with future session/channel routing changes.
