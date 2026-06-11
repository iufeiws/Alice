# Tool implementation rules

- Do not include variable parameters in tool returns, such as the current time, date, timestamps, random values, or other execution-time context.
- Do not include unrelated metadata in tool returns. Usually return only success or the direct result the caller needs.
