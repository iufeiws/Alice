export function renderToolPreviewScript(): string {
  return `      let toolPreviewTools = [];
      async function refreshToolPreviewTools() {
        const payload = await fetch("/admin/api/tools").then((res) => res.json());
        toolPreviewTools = payload.tools || [];
        const select = $("toolPreviewSelect");
        const previous = select.value;
        select.innerHTML = toolPreviewTools.map((tool) => \`<option value="\${escapeAttr(tool.pluginId + ":" + tool.name)}">\${escapeHtml(tool.pluginId)} / \${escapeHtml(tool.name)}</option>\`).join("");
        if (previous && [...select.options].some((option) => option.value === previous)) select.value = previous;
        if (!select.value && select.options.length) select.selectedIndex = 0;
        renderToolPreviewDefaultInput(false);
      }

      function currentToolPreviewTool() {
        const [pluginId, name] = $("toolPreviewSelect").value.split(":");
        return toolPreviewTools.find((tool) => tool.pluginId === pluginId && tool.name === name);
      }

      function renderToolPreviewDefaultInput(force) {
        const tool = currentToolPreviewTool();
        if (!tool) {
          $("toolPreviewInput").value = "{}";
          return;
        }
        if (!force && $("toolPreviewInput").value.trim() && $("toolPreviewInput").value.trim() !== "{}") return;
        $("toolPreviewInput").value = JSON.stringify(defaultInputFromSchema(tool.inputSchema), null, 2);
        $("tool-preview-status").textContent = "";
      }

      function defaultInputFromSchema(schema) {
        const properties = schema && typeof schema === "object" ? schema.properties || {} : {};
        const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
        const result = {};
        Object.entries(properties).forEach(([key, spec]) => {
          if (!required.has(key) && spec.default === undefined) return;
          if (spec.default !== undefined) {
            result[key] = spec.default;
          } else if (Array.isArray(spec.enum) && spec.enum.length) {
            result[key] = spec.enum[0];
          } else if (spec.type === "number" || spec.type === "integer") {
            result[key] = 0;
          } else if (spec.type === "boolean") {
            result[key] = false;
          } else if (spec.type === "array") {
            result[key] = [];
          } else if (spec.type === "object") {
            result[key] = {};
          } else {
            result[key] = "";
          }
        });
        return result;
      }

      async function runToolPreview() {
        const tool = currentToolPreviewTool();
        if (!tool) return;
        let input;
        try {
          input = JSON.parse($("toolPreviewInput").value || "{}");
          if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Arguments must be a JSON object.");
        } catch (error) {
          $("tool-preview-status").textContent = "Invalid JSON: " + (error?.message || "parse failed");
          return;
        }
        $("tool-preview-status").textContent = "Running preview...";
        const result = await fetch("/admin/api/tools/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pluginId: tool.pluginId,
            toolName: tool.name,
            targetPlugin: $("toolPreviewTarget").value,
            input
          })
        }).then(async (res) => ({ status: res.status, body: await res.json() }));
        $("tool-preview-status").textContent = result.body.ok ? "Preview complete." : "Preview failed.";
        $("toolPreviewResult").innerHTML = renderToolPreviewResult(result.body, result.status);
        $("toolPreviewResult").scrollTop = 0;
        await refreshLogs();
        await refreshLLMRequests();
      }

      function renderToolPreviewResult(payload, status) {
        return \`
          <div class="log-line">HTTP \${escapeHtml(status)} · \${escapeHtml(payload.pluginId || "")}/\${escapeHtml(payload.toolName || "")} · ok=\${escapeHtml(payload.ok)}</div>
          <div class="log-line">LLM content\\n\${escapeHtml(payload.content || payload.error || "")}</div>
          <div class="log-line">raw json\\n\${escapeHtml(JSON.stringify(payload.result || payload, null, 2))}</div>
        \`;
      }
`;
}
