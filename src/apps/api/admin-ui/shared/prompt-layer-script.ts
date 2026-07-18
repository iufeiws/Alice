export function renderPromptLayerScript(): string {
  return `      const layerMessageRoles = ["system", "user", "assistant", "tool"];

      function renderLayerDocument(documentValue, options) {
        const messages = Array.isArray(documentValue?.messages) ? documentValue.messages : [];
        return messages.map((message, index) => renderLayerMessage(message, index, messages.length, options)).join("");
      }

      function renderLayerMessage(message, index, count, options) {
        const meta = message.meta || {};
        const role = layerMessageRoles.includes(message.role) ? message.role : "user";
        return \`
          <details class="prompt-layer" data-layer-editor="\${escapeAttr(options.editorId)}" data-layer-message-index="\${index}" open>
            <summary>\${escapeHtml(meta.title || "Untitled Message")}<span>[\${escapeHtml(role)}]\${meta.enabled === false ? " disabled" : ""}</span></summary>
            <div class="row">
              <div>
                <label>Title</label>
                <input data-field="title" value="\${escapeAttr(meta.title || "")}" />
              </div>
              <div>
                <label>Role</label>
                <select data-field="role">
                  \${(options.roles || layerMessageRoles).map((item) => \`<option value="\${item}" \${role === item ? "selected" : ""}>\${item}</option>\`).join("")}
                </select>
              </div>
              \${options.showName === false ? "" : '<div><label>Name</label><input data-field="name" value="' + escapeAttr(message.name || "") + '" /></div>'}
              <label><input data-field="enabled" type="checkbox" \${meta.enabled === false ? "" : "checked"} /> Enabled</label>
            </div>
            \${role === "assistant" ? \`<label>Reasoning Content</label>
            <textarea data-field="reasoningContent" rows="3">\${escapeHtml(message.reasoningContent || "")}</textarea>
            <label>Tool Calls JSON</label>
            <textarea data-field="toolCalls" rows="7">\${escapeHtml(JSON.stringify(cloneToolCalls(message.toolCalls), null, 2))}</textarea>\` : ""}
            \${role === "tool" ? \`<label>Tool Call ID</label>
            <input data-field="toolCallId" value="\${escapeAttr(message.toolCallId || "")}" />\` : ""}
            <label>Content</label>
            <textarea data-field="content" rows="7">\${escapeHtml(typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2))}</textarea>
            \${options.showActions === false ? "" : \`<div class="prompt-actions">
              <button type="button" data-action="up" \${index === 0 ? "disabled" : ""}>Up</button>
              <button type="button" data-action="down" \${index === count - 1 ? "disabled" : ""}>Down</button>
              <button type="button" data-action="delete" class="secondary">Delete</button>
            </div>\`}
          </details>
        \`;
      }

      function bindLayerDocument(documentValue, options) {
        if (!Array.isArray(documentValue.messages)) documentValue.messages = [];
        document.querySelectorAll('[data-layer-editor="' + cssEscape(options.editorId) + '"]').forEach((root) => {
          const index = Number(root.dataset.layerMessageIndex);
          const message = documentValue.messages[index];
          if (!message) return;
          if (!message.meta) message.meta = {};
          root.querySelector('[data-field="title"]').addEventListener("input", (event) => { message.meta.title = event.target.value; options.onInput?.(); });
          root.querySelector('[data-field="name"]')?.addEventListener("input", (event) => { if (event.target.value) message.name = event.target.value; else delete message.name; options.onInput?.(); });
          root.querySelector('[data-field="enabled"]').addEventListener("change", (event) => { message.meta.enabled = event.target.checked; options.onInput?.(); });
          root.querySelector('[data-field="role"]').addEventListener("change", (event) => {
            message.role = event.target.value;
            if (message.role !== "assistant") {
              delete message.reasoningContent;
              delete message.toolCalls;
            }
            if (message.role !== "tool") delete message.toolCallId;
            options.render();
          });
          root.querySelector('[data-field="reasoningContent"]')?.addEventListener("input", (event) => { message.reasoningContent = event.target.value; options.onInput?.(); });
          root.querySelector('[data-field="toolCallId"]')?.addEventListener("input", (event) => { message.toolCallId = event.target.value; options.onInput?.(); });
          root.querySelector('[data-field="toolCalls"]')?.addEventListener("input", (event) => updateToolCallsFromTextarea(message, event.target.value, options.onInput));
          root.querySelector('[data-field="content"]').addEventListener("input", (event) => { message.content = event.target.value; options.onInput?.(); });
          root.querySelector('[data-action="delete"]')?.addEventListener("click", () => { documentValue.messages.splice(index, 1); options.render(); });
          root.querySelector('[data-action="up"]')?.addEventListener("click", () => moveLayerMessage(documentValue, index, -1, options.render));
          root.querySelector('[data-action="down"]')?.addEventListener("click", () => moveLayerMessage(documentValue, index, 1, options.render));
        });
      }

      function addLayerMessage(documentValue, options = {}) {
        if (!Array.isArray(documentValue.messages)) documentValue.messages = [];
        const assistantToolCall = options.toolCall === true;
        documentValue.messages.push({
          meta: { title: options.title || "New Message", enabled: true },
          role: assistantToolCall ? "assistant" : (options.role || "user"),
          content: "",
          ...(assistantToolCall ? { reasoningContent: "", toolCalls: [newToolCall(options.toolName || "Chat")] } : {})
        });
      }

      function moveLayerMessage(documentValue, index, delta, render) {
        const nextIndex = index + delta;
        if (nextIndex < 0 || nextIndex >= documentValue.messages.length) return;
        const [message] = documentValue.messages.splice(index, 1);
        documentValue.messages.splice(nextIndex, 0, message);
        render();
      }

      function cloneLayerDocument(value) {
        if (!value || typeof value !== "object") return { meta: {}, messages: [] };
        return {
          meta: { ...(value.meta || {}) },
          messages: (value.messages || []).map((message) => {
            const cloned = { ...message, meta: { ...(message.meta || {}) } };
            if (Array.isArray(message.toolCalls)) cloned.toolCalls = cloneToolCalls(message.toolCalls);
            return cloned;
          })
        };
      }

      function newToolCall(toolName) {
        return { id: "call_" + crypto.randomUUID(), type: "function", function: { name: toolName, arguments: "{}" } };
      }

      function cloneToolCalls(toolCalls) {
        if (!Array.isArray(toolCalls)) return [];
        return toolCalls.map((call) => ({
          id: String(call?.id || ""),
          type: "function",
          function: {
            name: String(call?.function?.name || ""),
            arguments: typeof call?.function?.arguments === "string" ? call.function.arguments : "{}"
          }
        }));
      }

      function updateToolCallsFromTextarea(message, value, onValid) {
        try {
          const parsed = JSON.parse(value);
          if (!Array.isArray(parsed)) return;
          message.toolCalls = cloneToolCalls(parsed);
          onValid?.();
        } catch {
          return;
        }
      }
`;
}
