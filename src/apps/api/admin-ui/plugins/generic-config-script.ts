export function renderGenericPluginConfigScript(): string {
  return `      const pluginConfigRenderers = {};
      const pluginConfigExtras = {};

      function closePluginConfig() {
        $("pluginConfigPanel").classList.remove("active");
        $("pluginListPanel").style.display = "";
        $("pluginConfigBody").textContent = "Choose a plugin to configure.";
        refreshPlugins();
      }

      function renderPluginConfig(payload) {
        const customRenderer = pluginConfigRenderers[payload.plugin?.id];
        if (customRenderer) {
          customRenderer(payload);
          return;
        }
        const config = payload.configValue || {};
        const fields = (payload.configSchema && payload.configSchema.fields) || [];
        const groups = (payload.configSchema && payload.configSchema.groups) || [];
        $("pluginConfigBody").innerHTML = \`
          \${renderPluginConfigGroupSelector(groups)}
          <form id="pluginConfigForm" class="plugin-config-grid" data-plugin-id="\${escapeAttr(payload.plugin.id)}" novalidate>
            <div>\${fields.filter((_, index) => index % 2 === 0).map((field) => renderPluginFieldContainer(field, config, payload.apiPresets || [])).join("")}</div>
            <div>\${fields.filter((_, index) => index % 2 === 1).map((field) => renderPluginFieldContainer(field, config, payload.apiPresets || [])).join("")}
              <div class="prompt-actions">
                <button type="submit">Save</button>
                <button type="button" id="pluginConfigReload" class="secondary">Reload</button>
                <button type="button" id="pluginConfigLogs" class="secondary">Load Events</button>
              </div>
            </div>
          </form>
          <h2>Route</h2>
          <pre>\${escapeHtml((payload.routePreview || []).join("\\n"))}</pre>
          <h2>Runtime Access</h2>
          <pre>\${escapeHtml((payload.runtimeAccess || []).join("\\n"))}</pre>
          \${renderPluginConfigExtra(payload)}
          \${payload.testSchema ? renderPluginTestBox(payload) : ""}
          <h2>Recent Events</h2>
          <div id="pluginEvents" class="logs plugin-events">No events loaded.</div>
        \`;
        bindPluginConfigForm();
        afterRenderPluginConfig(payload);
      }

      function renderPluginConfigExtra(payload) {
        if (payload.plugin?.id === "pi_worker") {
          return '<h2>Final Pi System Prompt</h2><p class="muted">This is read-only and comes from the created Pi session. Prompt customization remains a future TODO.</p><button type="button" id="piPromptPreview" class="secondary">Refresh Prompt Preview</button><pre id="piPromptPreviewValue">Loading...</pre>';
        }
        const extra = pluginConfigExtras[payload.plugin?.id];
        return extra?.html ? extra.html(payload) : "";
      }

      function afterRenderPluginConfig(payload) {
        if (payload.plugin?.id === "pi_worker") {
          loadPiPromptPreview();
        }
        pluginConfigExtras[payload.plugin?.id]?.afterRender?.(payload);
      }

      async function loadPiPromptPreview() {
        const output = $("piPromptPreviewValue");
        if (!output) return;
        output.textContent = "Loading...";
        const payload = await fetch("/admin/api/plugins/pi_worker/preview").then((res) => res.json());
        output.textContent = payload.ok ? (payload.systemPrompt || "") : "Preview failed: " + (payload.error || "unknown error");
        if ($("piPromptPreview")) $("piPromptPreview").onclick = loadPiPromptPreview;
      }

      function renderPluginConfigGroupSelector(groups) {
        if (!groups.length) return "";
        return \`
          <label for="pluginConfigGroup">Configure
            <select id="pluginConfigGroup">
              \${groups.map((group) => \`<option value="\${escapeAttr(group.key)}">\${escapeHtml(group.label || group.key)}</option>\`).join("")}
            </select>
          </label>
        \`;
      }

      function renderPluginFieldContainer(field, config, apiPresets) {
        return \`<div data-plugin-config-group="\${escapeAttr(field.group || "")}">\${renderPluginField(field, config, apiPresets)}</div>\`;
      }

      function applyPluginConfigGroupFilter() {
        const selector = $("pluginConfigGroup");
        const active = selector ? selector.value : "";
        document.querySelectorAll("[data-plugin-config-group]").forEach((node) => {
          const group = node.dataset.pluginConfigGroup || "";
          node.style.display = !active || !group || group === active ? "" : "none";
        });
      }

      function renderPluginTestBox(payload) {
        const schema = payload.testSchema || { input: "text", label: "Input", buttonLabel: "Run test" };
        const input = schema.input === "audio"
          ? \`<label>\${escapeHtml(schema.label || "Audio")}<input id="pluginTestAudio" value="\${escapeAttr((payload.configValue && payload.configValue.testAudioPath) || schema.defaultValue || "")}" placeholder="assets/plugin/asr/test-audio/example.wav" /></label>\`
          : schema.input === "image"
            ? \`<label>\${escapeHtml(schema.label || "Image")}<input id="pluginTestImage" value="\${escapeAttr((payload.configValue && payload.configValue.testImagePath) || schema.defaultValue || "")}" placeholder="assets/plugin/image-recognition/test-image/example.jpg" /></label>\`
          : \`<label>\${escapeHtml(schema.label || "Input")}<textarea id="pluginTestText" rows="4" spellcheck="false">\${escapeHtml(schema.defaultValue || "")}</textarea></label>\`;
        return \`
          <h2>Test</h2>
          <div class="plugin-test-box" data-plugin-test-input="\${escapeAttr(schema.input || "text")}">
            \${input}
            <button type="button" id="pluginConfigTest" class="secondary">\${escapeHtml(schema.buttonLabel || "Run test")}</button>
            <pre id="pluginTestOutput">No test run yet.</pre>
          </div>
        \`;
      }

      function renderPluginField(field, config, apiPresets) {
        const value = valueAtPath(config, field.key);
        const inputName = escapeAttr(field.key);
        const description = field.description ? \`<p class="muted">\${escapeHtml(field.description)}</p>\` : "";
        if (field.type === "switch") {
          return \`<label class="plugin-switch"><input type="checkbox" name="\${inputName}" data-plugin-field="\${inputName}" \${value ? "checked" : ""} /><span class="plugin-switch-visual" aria-hidden="true"></span> \${escapeHtml(field.label)}</label>\${description}\`;
        }
        if (field.type === "textarea") {
          const textValue = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2);
          return \`<label>\${escapeHtml(field.label)}<textarea rows="7" spellcheck="false" name="\${inputName}" data-plugin-field="\${inputName}">\${escapeHtml(textValue)}</textarea></label>\${description}\`;
        }
        if (field.type === "readonlyTextarea") {
          const textValue = typeof value === "string" ? value : value === undefined ? field.description || "" : JSON.stringify(value, null, 2);
          return \`<label>\${escapeHtml(field.label)}<textarea rows="12" spellcheck="false" readonly>\${escapeHtml(textValue)}</textarea></label>\`;
        }
        if (field.type === "number") {
          return \`<label>\${escapeHtml(field.label)}<input type="number" min="\${escapeAttr(field.min ?? "0.5")}" max="\${escapeAttr(field.max ?? "2")}" step="\${escapeAttr(field.step ?? "0.05")}" name="\${inputName}" data-plugin-field="\${inputName}" value="\${escapeAttr(value ?? "")}" /></label>\${description}\`;
        }
        if (field.type === "password") {
          const configured = Boolean(valueAtPath(config, field.key + "Set"));
          const placeholder = configured ? "Configured; leave blank to keep unchanged" : "Leave blank to keep unchanged";
          return \`<label>\${escapeHtml(field.label)}<input type="password" name="\${inputName}" data-plugin-field="\${inputName}" value="" placeholder="\${escapeAttr(placeholder)}" autocomplete="new-password" /></label>\${description}\`;
        }
        if (field.type === "select") {
          const options = field.options || [];
          return \`<label>\${escapeHtml(field.label)}<select name="\${inputName}" data-plugin-field="\${inputName}">\${options.map((option) => \`<option value="\${escapeAttr(option.value)}" \${option.value === value ? "selected" : ""}>\${escapeHtml(option.label || option.value)}</option>\`).join("")}</select></label>\${description}\`;
        }
        if (field.type === "apiPresetSelect") {
          const options = ["", ...apiPresets.map((preset) => preset.name).filter(Boolean)];
          return \`<label>\${escapeHtml(field.label)}<select name="\${inputName}" data-plugin-field="\${inputName}">\${options.map((option) => \`<option value="\${escapeAttr(option)}" \${option === value ? "selected" : ""}>\${escapeHtml(option || "(none)")}</option>\`).join("")}</select></label>\${description}\`;
        }
        if (field.type === "fileUpload" || field.type === "folderUpload") {
          const directoryAttrs = field.type === "folderUpload" ? "webkitdirectory directory multiple" : "";
          return \`<label>\${escapeHtml(field.label)}<input type="file" data-plugin-upload="\${escapeAttr(field.assetKey || field.key)}" data-plugin-field="\${inputName}" accept="\${escapeAttr(field.accept || "")}" \${directoryAttrs} /></label><p class="muted" data-plugin-current-field="\${inputName}">Current: \${escapeHtml(value || "(none)")}</p>\${description}\`;
        }
        if (field.type === "readonly") {
          const displayValue = typeof value === "boolean" ? (value ? "Yes" : "No") : value ?? field.description ?? "";
          return \`<label>\${escapeHtml(field.label)}<input value="\${escapeAttr(displayValue)}" readonly /></label>\`;
        }
        return \`<label>\${escapeHtml(field.label)}<input name="\${inputName}" data-plugin-field="\${inputName}" value="\${escapeAttr(value || "")}" /></label>\${description}\`;
      }

      async function savePluginConfig(event) {
        event.preventDefault();
        const form = event.currentTarget;
        if (form.dataset.pluginSaveMode === "section") {
          $("plugin-status").textContent = "Use the section save buttons for this plugin.";
          return;
        }
        const pluginId = form.dataset.pluginId;
        $("plugin-status").textContent = "Saving plugin config...";
        try {
          const body = pluginConfigBodyFrom(form);
          const result = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/config", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          }).then((res) => res.json());
          if (result.ok) {
            await openPluginConfig(pluginId);
            $("plugin-status").textContent = pluginId + (result.restartRequired ? " config saved. Restart required." : " config saved.");
            return;
          }
          $("plugin-status").textContent = "Save failed: " + (result.error || "unknown error");
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          $("plugin-status").textContent = "Save failed: " + message;
        }
      }

      async function savePluginConfigSection(event) {
        const button = event.currentTarget;
        const section = button.closest("[data-plugin-config-section]");
        const form = button.closest("form");
        const pluginId = form.dataset.pluginId;
        const sectionName = button.dataset.pluginSectionSave || "section";
        const body = pluginConfigBodyFrom(section);
        const result = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }).then((res) => res.json());
        $("plugin-status").textContent = result.ok ? sectionName + (result.restartRequired ? " saved. Restart required." : " saved.") : "Save failed: " + (result.error || "unknown error");
        if (result.ok) await openPluginConfig(pluginId);
      }

      function pluginConfigBodyFrom(root) {
        const body = {};
        root.querySelectorAll("[data-plugin-field]").forEach((input) => {
          if (input.type === "file") return;
          if (input.readOnly) return;
          if (input.type === "password" && input.value === "") return;
          const value = input.type === "checkbox" ? input.checked : input.type === "number" && input.value !== "" ? Number(input.value) : input.value;
          setValueAtPath(body, input.dataset.pluginField, value);
        });
        return body;
      }

      async function switchPluginModelConfig(event) {
        const input = event.currentTarget;
        const form = input.closest("form");
        const pluginId = form.dataset.pluginId;
        const result = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ activePresetName: input.value })
        }).then((res) => res.json());
        $("plugin-status").textContent = result.ok ? "Preset switched." : "Switch failed: " + (result.error || "unknown error");
        if (result.ok) await openPluginConfig(pluginId);
      }

      async function switchPluginTranslationPreset(event) {
        const input = event.currentTarget;
        const form = input.closest("form");
        const pluginId = form.dataset.pluginId;
        const result = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ translationPresetName: input.value })
        }).then((res) => res.json());
        $("plugin-status").textContent = result.ok ? "Translation preset switched." : "Switch failed: " + (result.error || "unknown error");
        if (result.ok) await openPluginConfig(pluginId);
      }

      async function uploadPluginAsset(event) {
        const input = event.currentTarget;
        const files = Array.from(input.files || []);
        if (!files.length) return;
        const pluginId = $("pluginConfigForm").dataset.pluginId;
        const assetKey = input.dataset.pluginUpload;
        const newPresetName = document.querySelector('[data-plugin-field="newPresetName"]')?.value.trim() || "";
        if (newPresetName) {
          $("plugin-status").textContent = "Save the new preset before uploading assets.";
          input.value = "";
          return;
        }
        const presetName = document.querySelector('[data-plugin-field="editPresetName"]')?.value || document.querySelector('[data-plugin-field="activePresetName"]')?.value || "";
        let lastResult = null;
        for (const file of files) {
          const body = await pluginAssetBodyForUpload(pluginId, assetKey, file);
          const result = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/assets/" + encodeURIComponent(assetKey), {
            method: "POST",
            headers: {
              "content-type": body.type || file.type || "application/octet-stream",
              "x-file-name": encodeURIComponent(file.name || "asset"),
              "x-relative-dir": encodeURIComponent(file.webkitRelativePath ? file.webkitRelativePath.split("/").slice(0, -1).join("/") : ""),
              "x-preset-name": encodeURIComponent(presetName)
            },
            body
          }).then((res) => res.json());
          if (!result.ok) {
            $("plugin-status").textContent = "Upload failed: " + (result.error || "unknown error");
            return;
          }
          lastResult = result;
        }
        const uploadedValue = valueAtPath(lastResult?.configValue || {}, input.dataset.pluginField) || lastResult?.assetPath || "";
        setPluginFieldValue(input.dataset.pluginField, uploadedValue);
        $("plugin-status").textContent = "Asset uploaded.";
      }

      async function loadPluginEvents(pluginId) {
        const payload = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/events").then((res) => res.json());
        if (!$("pluginEvents")) return;
        $("pluginEvents").innerHTML = (payload.events || []).length
          ? payload.events.map((entry) => \`<div class="log-line log-\${escapeAttr(entry.level || "info")}">[\${escapeHtml(entry.time || "")}] [\${escapeHtml(entry.level || "info")}] \${escapeHtml(entry.message || "")}</div>\`).join("")
          : "No plugin events yet.";
      }

      async function runPluginTest(pluginId) {
        $("pluginTestOutput").textContent = "Running...";
        const box = document.querySelector(".plugin-test-box");
        const body = box && box.dataset.pluginTestInput === "audio"
          ? { audioFile: $("pluginTestAudio").value }
          : box && box.dataset.pluginTestInput === "image"
            ? { imageFile: $("pluginTestImage").value }
            : { text: $("pluginTestText").value };
        const payload = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }).then((res) => res.json());
        if (!payload.ok) {
          $("pluginTestOutput").textContent = "Test failed: " + (payload.error || "unknown error");
          return;
        }
        const result = payload.result || {};
        $("pluginTestOutput").innerHTML = \`
Input:
\${escapeHtml(result.input || "")}

Output:
\${escapeHtml(result.output || "")}

\${result.provider ? "Transcription:\\nProvider: " + escapeHtml(result.provider) + (result.model ? "\\nModel: " + escapeHtml(result.model) : "") + "\\n" : ""}

Voice:
\${result.voice && result.voice.audioUrl ? \`<audio controls src="\${escapeAttr(result.voice.audioUrl)}"></audio>\` : "No audio"}
\${result.voice && result.voice.assetId ? "\\nAsset: " + escapeHtml(result.voice.assetId) : ""}

Timing:
\${escapeHtml(JSON.stringify(result.timing || {}, null, 2))}
\`;
      }

      function bindPluginConfigForm() {
        $("pluginConfigForm").addEventListener("submit", savePluginConfig);
        document.querySelectorAll("[data-plugin-upload]").forEach((input) => input.addEventListener("change", uploadPluginAsset));
        if ($("pluginConfigGroup")) $("pluginConfigGroup").addEventListener("change", applyPluginConfigGroupFilter);
        applyPluginConfigGroupFilter();
        $("pluginConfigReload").addEventListener("click", async () => {
          const pluginId = $("pluginConfigForm").dataset.pluginId;
          const result = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/reload", { method: "POST" }).then((res) => res.json());
          $("plugin-status").textContent = result.ok ? pluginId + " reloaded." : "Reload failed: " + (result.error || "unknown error");
          await openPluginConfig(pluginId);
        });
        $("pluginConfigLogs").addEventListener("click", () => loadPluginEvents($("pluginConfigForm").dataset.pluginId));
        document.querySelectorAll("[data-plugin-section-save]").forEach((button) => button.addEventListener("click", savePluginConfigSection));
        if ($("pluginConfigTest")) $("pluginConfigTest").addEventListener("click", () => runPluginTest($("pluginConfigForm").dataset.pluginId));
      }
`;
}
