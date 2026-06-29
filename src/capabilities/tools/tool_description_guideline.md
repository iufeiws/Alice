# Tool Description Guideline

Tool `description` is part of the LLM-facing tool interface. Write it as instruction for the model, not as developer documentation.

## Rules

- Treat `inputSchema` as already visible to the LLM. Do not repeat field names, enum meanings, types, or required fields unless the schema cannot express the needed instruction.
- Add only information that changes how the LLM should fill the call, such as a default value for an optional field or a required argument ordering.
- Describe the action target in terms the LLM can resolve from the prompt. Avoid vague runtime wording such as "current chat session" when the prompt names the user directly.
- If argument order matters, state the exact order that matters. Do not say every argument must be provided first.
- Do not explain concepts already defined by the agent prompt.
- Do not expose implementation details, including plugin config, channel-specific rendering, storage, retry paths, or platform names, unless the LLM must act on them.
- Keep the description short and stable. Detailed behavior belongs in docs or tests, not in the LLM-facing tool description.
