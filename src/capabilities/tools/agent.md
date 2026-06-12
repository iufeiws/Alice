# Tool implementation rules

- If a tool is exposed in `toolNames`, execute it through the common `ToolPlugin.execute` path. Do not add runtime blocks based on channel, requester, loop kind, or tool name; hide the tool at exposure time instead.
- Tool results must return to the same function-call loop that requested them. Do not route tool follow-up through heartbeat or another external loop trigger.
- Treat `requester` as the source of the call only. Tools that send `AgentOutput` must resolve the delivery target through the shared capabilities output target resolver.
- Do not include variable parameters in tool returns, such as the current time, date, timestamps, random values, or other execution-time context.
- Do not include unrelated metadata in tool returns. Usually return only success or the direct result the caller needs.
