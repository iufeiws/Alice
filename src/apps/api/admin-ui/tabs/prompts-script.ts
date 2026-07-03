export function renderPromptsScript(): string {
  return `      let promptProfile = null;
      let talkPromptProfile = null;
      let calendarBirthday = null;
      let promptVariables = {};
      let talkPromptVariables = {};
      let promptTools = [];
      let promptEditorMode = "chat";
      let promptSideView = "preview";
      let memoryPrompts = null;
      let lastMemoryPromptPreviewTarget = "persistent";
      let llmApiPresets = [];
      let currentLLMApiPreset = null;
      let promptApiProfile = {};
      async function refreshPromptProfile() {
        const payload = await fetch("/admin/api/prompt-profile").then((res) => res.json());
        promptProfile = payload.profile;
        calendarBirthday = payload.birthday || null;
        promptVariables = payload.variables || {};
        promptTools = payload.tools || [];
        const talkPayload = await fetch("/admin/api/talk-prompt-profile").then((res) => res.json());
        talkPromptProfile = talkPayload.profile;
        talkPromptVariables = talkPayload.variables || {};
        const memoryPayload = await fetch("/admin/api/memory/prompts").then((res) => res.json());
        memoryPrompts = memoryPayload.prompts || {};
        promptApiProfile = memoryPayload.apiProfile || promptApiProfile || {};
        if (memoryPayload.apiPresets) {
          llmApiPresets = memoryPayload.apiPresets;
          renderLLMApiPresetControls();
        }
        renderPromptProfile();
      }

      function renderPromptProfile() {
        if (!promptProfile || !talkPromptProfile || !memoryPrompts) return;
        if (promptEditorMode === "memory") {
          renderMemoryPromptEditor();
          return;
        }
        const activeProfile = promptEditorMode === "talk" ? talkPromptProfile : promptProfile;
        const isTalk = promptEditorMode === "talk";
        const layers = [...activeProfile.layers].sort((a, b) => a.order - b.order);
        if (!Array.isArray(activeProfile.appendLayers)) activeProfile.appendLayers = [];
        const appendLayers = [...activeProfile.appendLayers].sort((a, b) => a.order - b.order);
        $("promptProfile").innerHTML = \`
          <div class="prompt-editor-grid">
            <div class="subtabs prompt-mode-cell">
              <button class="tab \${!isTalk ? "active" : ""}" id="prompt-mode-chat" type="button">Chat</button>
              <button class="tab \${isTalk ? "active" : ""}" id="prompt-mode-talk" type="button">Talk</button>
              <button class="tab" id="prompt-mode-memory" type="button">Memorize</button>
            </div>
            <div class="prompt-api-cell">\${renderPromptApiPresetPicker(isTalk ? "talk" : "chat")}</div>
              <div class="prompt-edit-cell">
              <h2>\${isTalk ? "Talk Prompt Profile" : "Prompt Profile"}</h2>
              \${isTalk ? "" : renderBirthdayEditor()}
              <h2>Visible Tools</h2>
              <label><input id="toolFeishuVisible" type="checkbox" \${activeProfile.visibleTools?.feishu === false ? "" : "checked"} /> tool: chat</label>
              <label><input id="toolPhotoVisible" type="checkbox" \${activeProfile.visibleTools?.photo === false || activeProfile.visibleTools?.media === false ? "" : "checked"} /> tool: photo</label>
              <label><input id="toolShellVisible" type="checkbox" \${activeProfile.visibleTools?.shell === false ? "" : "checked"} /> tool: shell</label>
              <p class="muted">Chat · wardrobe · selfie</p>
              \${isTalk || !activeProfile.interruptLayer ? "" : \`
              <h2>Interrupt Layer</h2>
              <p class="muted">Inserted after the next tool result when a new user message arrives during a running Chat loop.</p>
              <div id="promptInterruptLayer">\${renderInterruptLayer(activeProfile.interruptLayer)}</div>
              \`}
              <h2>Initial Layers</h2>
              <div id="promptLayers">\${layers.map((layer, index) => renderPromptLayer(layer, index, layers.length, "layers")).join("")}</div>
              <button type="button" id="prompt-add">Add Initial Layer</button>
              <h2>Append Layers</h2>
              <p class="muted">Append layers are rendered and appended before each heartbeat LLM request. Tool request layers run immediately and include their tool result.</p>
              <div id="promptAppendLayers">\${appendLayers.map((layer, index) => renderPromptLayer(layer, index, appendLayers.length, "appendLayers")).join("")}</div>
              <button type="button" id="prompt-append-add">Add Append Layer</button>
              <button type="button" id="prompt-save">Save Prompt Profile</button>
            </div>
            \${renderPromptSidePane(isTalk ? "talk" : "chat", isTalk ? "Talk Preview" : "Chat Preview", "Save Prompt Profile to refresh preview.")}
          </div>
        \`;
        $("prompt-mode-chat").addEventListener("click", () => { promptEditorMode = "chat"; renderPromptProfile(); });
        $("prompt-mode-talk").addEventListener("click", () => { promptEditorMode = "talk"; renderPromptProfile(); });
        $("prompt-mode-memory").addEventListener("click", () => { promptEditorMode = "memory"; renderPromptProfile(); });
        bindPromptSideToggle(isTalk ? "talk" : "chat");
        bindPromptApiPresetPicker(isTalk ? "talk" : "chat");
        if (!isTalk) bindBirthdayEditor();
        $("toolFeishuVisible").addEventListener("change", () => { activeProfile.visibleTools.feishu = $("toolFeishuVisible").checked; });
        $("toolPhotoVisible").addEventListener("change", () => { activeProfile.visibleTools.photo = $("toolPhotoVisible").checked; delete activeProfile.visibleTools.media; });
        $("toolShellVisible").addEventListener("change", () => { activeProfile.visibleTools.shell = $("toolShellVisible").checked; });
        if (!isTalk && activeProfile.interruptLayer) bindInterruptLayer(activeProfile.interruptLayer);
        layers.forEach((layer, index) => bindPromptLayer(layer, index, "layers"));
        appendLayers.forEach((layer, index) => bindPromptLayer(layer, index, "appendLayers"));
        $("prompt-add").addEventListener("click", () => {
          const order = Math.max(0, ...activeProfile.layers.map((layer) => Number(layer.order) || 0)) + 10;
          activeProfile.layers.push({ id: "layer_" + Date.now(), title: "New Layer", role: "user", enabled: true, content: "", order });
          renderPromptProfile();
        });
        $("prompt-append-add").addEventListener("click", () => {
          const order = Math.max(0, ...activeProfile.appendLayers.map((layer) => Number(layer.order) || 0)) + 10;
          activeProfile.appendLayers.push({ id: "append_layer_" + Date.now(), title: "New Append Layer", role: "tool_request", enabled: true, content: "", order, toolCalls: [{ toolName: "Chat", toolArguments: "{\\"action\\":\\"poll\\"}" }] });
          renderPromptProfile();
        });
        $("prompt-save").addEventListener("click", savePromptProfile);
      }

      function renderBirthdayEditor() {
        return \`
          <h2>Birthday</h2>
          <div class="row">
            <div>
              <label for="birthdayCalendarSystem">Calendar</label>
              <select id="birthdayCalendarSystem">
                \${["gregorian", "lunar"].map((item) => \`<option value="\${item}" \${(calendarBirthday?.calendarSystem || "gregorian") === item ? "selected" : ""}>\${item}</option>\`).join("")}
              </select>
            </div>
            <div>
              <label for="birthdayMonth">Month</label>
              <input id="birthdayMonth" type="number" min="1" max="12" value="\${escapeAttr(calendarBirthday?.month || "")}" />
            </div>
            <div>
              <label for="birthdayDay">Day</label>
              <input id="birthdayDay" type="number" min="1" max="31" value="\${escapeAttr(calendarBirthday?.day || "")}" />
            </div>
          </div>
          <div class="row">
            <div>
              <label for="birthdayYear">Year</label>
              <input id="birthdayYear" type="number" min="1" max="9999" value="\${escapeAttr(calendarBirthday?.year || "")}" />
            </div>
            <label><input id="birthdayLeapMonth" type="checkbox" \${calendarBirthday?.isLeapMonth ? "checked" : ""} /> Lunar leap month</label>
            <div>
              <button type="button" id="birthday-save">Save Birthday</button>
            </div>
          </div>
        \`;
      }

      function bindBirthdayEditor() {
        $("birthday-save")?.addEventListener("click", saveBirthday);
      }

      function renderPromptSidePane(mode, previewTitle, placeholder) {
        return \`
          <div class="prompt-preview-pane">
            <div class="prompt-preview-head">
              <h2 id="promptSideTitle">\${promptSideView === "variables" ? "变量解析树" : escapeHtml(previewTitle)}</h2>
              <button type="button" id="promptSideToggle" class="secondary">\${promptSideView === "variables" ? "预览" : "变量解析树"}</button>
            </div>
            \${renderPromptSideContent(mode, placeholder)}
          </div>
        \`;
      }

      function renderPromptSideContent(mode, placeholder) {
        const elementId = mode === "memory" ? "memoryPromptPreview" : mode === "talk" ? "talkPromptPreview" : "chatPromptPreview";
        if (promptSideView === "variables") {
          const variables = mode === "talk" ? talkPromptVariables : promptVariables;
          return \`<pre id="\${elementId}">\${escapeHtml(JSON.stringify(variables, null, 2))}</pre>\`;
        }
        return \`<div id="\${elementId}" class="logs">\${escapeHtml(placeholder)}</div>\`;
      }

      function bindPromptSideToggle(mode) {
        $("promptSideToggle")?.addEventListener("click", async () => {
          promptSideView = promptSideView === "variables" ? "preview" : "variables";
          renderPromptProfile();
          if (promptSideView !== "preview") return;
          if (mode === "memory") await refreshMemoryPromptPreview(lastMemoryPromptPreviewTarget);
          else await refreshChatPromptPreview(mode);
        });
      }

      function renderMemoryPromptEditor() {
        const groups = [
          ["commonLayers", "共同组", "persistent"]
        ];
        $("promptProfile").innerHTML = \`
          <div class="prompt-editor-grid">
            <div class="subtabs prompt-mode-cell">
              <button class="tab" id="prompt-mode-chat" type="button">Chat</button>
              <button class="tab" id="prompt-mode-talk" type="button">Talk</button>
              <button class="tab active" id="prompt-mode-memory" type="button">Memorize</button>
            </div>
            <div class="prompt-api-cell">\${renderPromptApiPresetPicker("memorize")}</div>
            <div class="prompt-edit-cell">
              \${groups.map(([key, title, target]) => \`
                <h2>\${escapeHtml(title)}</h2>
                <div id="memory-\${escapeAttr(key)}">\${[...(memoryPrompts[key] || [])].sort((a, b) => a.order - b.order).map((layer, index, list) => renderMemoryPromptLayer(layer, index, list.length, key)).join("")}</div>
                <button type="button" data-memory-layer-add="\${escapeAttr(key)}">Add Layer</button>
                <button type="button" data-memory-group-save="\${escapeAttr(key)}" data-memory-preview-target="\${escapeAttr(target)}">Save \${escapeHtml(title)}</button>
              \`).join("")}
            </div>
            \${renderPromptSidePane("memory", "Prompt Preview", "Save a Memorize group to refresh its preview.")}
          </div>
        \`;
        $("prompt-mode-chat").addEventListener("click", () => { promptEditorMode = "chat"; renderPromptProfile(); });
        $("prompt-mode-talk").addEventListener("click", () => { promptEditorMode = "talk"; renderPromptProfile(); });
        $("prompt-mode-memory").addEventListener("click", () => { promptEditorMode = "memory"; renderPromptProfile(); });
        bindPromptSideToggle("memory");
        bindPromptApiPresetPicker("memorize");
        groups.forEach(([key]) => (memoryPrompts[key] || []).forEach((layer, index) => bindMemoryPromptLayer(layer, index, key)));
        document.querySelectorAll("[data-memory-layer-add]").forEach((button) => button.addEventListener("click", () => {
          const key = button.dataset.memoryLayerAdd;
          if (!Array.isArray(memoryPrompts[key])) memoryPrompts[key] = [];
          const order = Math.max(0, ...memoryPrompts[key].map((layer) => Number(layer.order) || 0)) + 10;
          memoryPrompts[key].push({ id: key + "_" + Date.now(), title: "New Layer", role: "user", enabled: true, order, content: "" });
          renderPromptProfile();
        }));
        document.querySelectorAll("[data-memory-group-save]").forEach((button) => button.addEventListener("click", () => {
          saveMemoryPromptGroup(button.dataset.memoryGroupSave, button.dataset.memoryPreviewTarget || "persistent");
        }));
      }

      function renderPromptApiPresetPicker(mode) {
        const isMemorize = mode === "memorize";
        const isTalk = mode === "talk";
        const selected = isMemorize ? promptApiProfile.memorizePresetName : isTalk ? promptApiProfile.talkPresetName : (promptApiProfile.chatPresetName || promptApiProfile.corePresetName);
        const label = isMemorize ? "Memorize API Preset" : isTalk ? "Talk API Preset" : "Chat API Preset";
        const buttonLabel = isMemorize ? "Save Memorize API Binding" : isTalk ? "Save Talk API Binding" : "Save Chat API Binding";
        return \`
          <div class="row">
            <div>
              <label for="promptApiPresetSelect">\${escapeHtml(label)}</label>
              <select id="promptApiPresetSelect" data-prompt-api-mode="\${escapeAttr(mode)}">\${renderLLMApiPresetOptions(selected || "")}</select>
            </div>
            <div>
              <button type="button" id="prompt-api-profile-save" data-prompt-api-mode="\${escapeAttr(mode)}">\${escapeHtml(buttonLabel)}</button>
            </div>
          </div>
        \`;
      }

      function bindPromptApiPresetPicker(mode) {
        $("prompt-api-profile-save")?.addEventListener("click", () => savePromptApiProfile(mode));
      }

      function renderMemoryPromptLayer(layer, index, count, group) {
        const role = layer.role || "system";
        const isToolRequest = role === "tool_request";
        const canThink = role === "assistant" || isToolRequest;
        return \`
          <details class="prompt-layer" data-memory-layer-group="\${escapeAttr(group)}" data-memory-layer-id="\${escapeAttr(layer.id)}" open>
            <summary>\${escapeHtml(layer.title || "Untitled Layer")}<span>[\${escapeHtml(role)}]\${layer.enabled ? "" : " disabled"}</span></summary>
            <div class="row">
              <div>
                <label>Title</label>
                <input data-field="title" value="\${escapeAttr(layer.title || "")}" />
              </div>
              <div>
                <label>Role</label>
                <select data-field="role">
                  \${["system", "user", "assistant", "tool_request"].map((item) => \`<option value="\${item}" \${role === item ? "selected" : ""}>\${item}</option>\`).join("")}
                </select>
              </div>
              <div>
                <label>Name</label>
                <input data-field="name" value="\${escapeAttr(layer.name || "")}" />
              </div>
              \${isToolRequest ? \`
              <div>
                <label>Tool Calls JSON</label>
                <textarea data-field="toolCalls" rows="7">\${escapeHtml(JSON.stringify(cloneToolCalls(layer.toolCalls), null, 2))}</textarea>
              </div>
              \` : ""}
              <label><input data-field="enabled" type="checkbox" \${layer.enabled ? "checked" : ""} /> Enabled</label>
            </div>
            \${canThink ? \`
            <label>Thinking / Fake Reasoning</label>
            <textarea data-field="thinking" rows="3">\${escapeHtml(layer.thinking || "")}</textarea>
            \` : ""}
            \${isToolRequest ? \`
            <p class="muted">Use Read or self_talk tool names in the array above.</p>
            \` : ""}
            <label>Content</label>
            <textarea data-field="content" rows="7">\${escapeHtml(layer.content || "")}</textarea>
            <div class="prompt-actions">
              <button type="button" data-action="up" \${index === 0 ? "disabled" : ""}>Up</button>
              <button type="button" data-action="down" \${index === count - 1 ? "disabled" : ""}>Down</button>
              <button type="button" data-action="delete" class="secondary">Delete</button>
            </div>
          </details>
        \`;
      }

      function bindMemoryPromptLayer(layer, index, group) {
        const root = document.querySelector('[data-memory-layer-group="' + cssEscape(group) + '"][data-memory-layer-id="' + cssEscape(layer.id) + '"]');
        if (!root) return;
        root.querySelector('[data-field="title"]').addEventListener("input", (event) => { layer.title = event.target.value; });
        root.querySelector('[data-field="name"]').addEventListener("input", (event) => { layer.name = event.target.value; });
        root.querySelector('[data-field="role"]').addEventListener("change", (event) => {
          layer.role = event.target.value;
          if (layer.role === "tool_request") {
            layer.toolCalls = cloneToolCalls(layer.toolCalls);
            if (!layer.toolCalls.length) layer.toolCalls = [{ toolName: "Read", toolArguments: "{\\"file_path\\":\\"{{memorize/target/fileName}}\\"}" }];
          } else {
            delete layer.toolCalls;
          }
          if (layer.role !== "assistant" && layer.role !== "tool_request") delete layer.thinking;
          renderPromptProfile();
        });
        root.querySelector('[data-field="enabled"]').addEventListener("change", (event) => { layer.enabled = event.target.checked; });
        root.querySelector('[data-field="content"]').addEventListener("input", (event) => { layer.content = event.target.value; });
        root.querySelector('[data-field="thinking"]')?.addEventListener("input", (event) => { layer.thinking = event.target.value; });
        root.querySelector('[data-field="toolCalls"]')?.addEventListener("input", (event) => { updateToolCallsFromTextarea(layer, event.target.value); });
        root.querySelector('[data-action="delete"]').addEventListener("click", () => {
          memoryPrompts[group] = memoryPrompts[group].filter((item) => item.id !== layer.id);
          renderPromptProfile();
        });
        root.querySelector('[data-action="up"]').addEventListener("click", () => moveMemoryPromptLayer(index, -1, group));
        root.querySelector('[data-action="down"]').addEventListener("click", () => moveMemoryPromptLayer(index, 1, group));
      }

      function moveMemoryPromptLayer(index, delta, group) {
        const layers = [...memoryPrompts[group]].sort((a, b) => a.order - b.order);
        const nextIndex = index + delta;
        if (nextIndex < 0 || nextIndex >= layers.length) return;
        const currentOrder = layers[index].order;
        layers[index].order = layers[nextIndex].order;
        layers[nextIndex].order = currentOrder;
        renderPromptProfile();
      }

      async function saveMemoryPromptGroup(group, target) {
        const result = await fetch("/admin/api/memory/prompts", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompts: memoryPrompts }) }).then((res) => res.json());
        $("prompt-status").textContent = result.ok ? "Memorize " + group + " saved." : "Memorize prompt save failed.";
        if (result.prompts) memoryPrompts = result.prompts;
        renderPromptProfile();
        if (result.ok) await refreshMemoryPromptPreview(target);
      }

      function renderPromptLayer(layer, index, count, collection) {
        const role = layer.role || "system";
        return renderPromptLayerDetails({
          attributes: 'data-layer-id="' + escapeAttr(layer.id) + '" data-layer-collection="' + escapeAttr(collection) + '"',
          title: layer.title,
          role,
          name: layer.name,
          enabled: layer.enabled,
          toolCalls: layer.toolCalls,
          thinking: layer.thinking,
          content: layer.content,
          index,
          count
        });
      }

      function renderInterruptLayer(layer) {
        const role = ["system", "user", "assistant"].includes(layer.role) ? layer.role : "user";
        return renderPromptLayerDetails({
          attributes: 'data-interrupt-layer="true"',
          title: layer.title,
          role,
          roleOptions: ["system", "user", "assistant"],
          name: layer.name,
          enabled: layer.enabled,
          thinking: layer.thinking,
          content: layer.content,
          index: 0,
          count: 1,
          showActions: false
        });
      }

      function bindInterruptLayer(layer) {
        const root = document.querySelector('[data-interrupt-layer="true"]');
        if (!root) return;
        root.querySelector('[data-field="title"]').addEventListener("input", (event) => { layer.title = event.target.value; });
        root.querySelector('[data-field="name"]').addEventListener("input", (event) => { layer.name = event.target.value; });
        root.querySelector('[data-field="role"]').addEventListener("change", (event) => {
          layer.role = ["system", "user", "assistant"].includes(event.target.value) ? event.target.value : "user";
          if (layer.role !== "assistant") delete layer.thinking;
          renderPromptProfile();
        });
        root.querySelector('[data-field="enabled"]').addEventListener("change", (event) => { layer.enabled = event.target.checked; });
        root.querySelector('[data-field="thinking"]')?.addEventListener("input", (event) => { layer.thinking = event.target.value; });
        root.querySelector('[data-field="content"]')?.addEventListener("input", (event) => { layer.content = event.target.value; });
      }

      function renderToolOptions(selected) {
        const names = promptTools.map((tool) => tool.name);
        const current = selected || names[0] || "Chat";
        const allNames = names.includes(current) ? names : [current, ...names];
        return allNames.map((name) => \`<option value="\${escapeAttr(name)}" \${current === name ? "selected" : ""}>\${escapeHtml(name)}</option>\`).join("");
      }

      function bindPromptLayer(layer, index, collection) {
        const activeProfile = promptEditorMode === "talk" ? talkPromptProfile : promptProfile;
        const root = document.querySelector('[data-layer-collection="' + cssEscape(collection) + '"][data-layer-id="' + cssEscape(layer.id) + '"]');
        if (!root) return;
        root.querySelector('[data-field="title"]').addEventListener("input", (event) => { layer.title = event.target.value; });
        root.querySelector('[data-field="name"]').addEventListener("input", (event) => { layer.name = event.target.value; });
        root.querySelector('[data-field="role"]').addEventListener("change", (event) => {
          layer.role = event.target.value;
          if (layer.role !== "tool_request") {
            delete layer.toolCalls;
          } else {
            layer.toolCalls = cloneToolCalls(layer.toolCalls);
            if (!layer.toolCalls.length) layer.toolCalls = [{ toolName: promptTools[0]?.name || "Chat", toolArguments: "{\\"action\\":\\"poll\\"}" }];
          }
          if (layer.role !== "assistant" && layer.role !== "tool_request") delete layer.thinking;
          renderPromptProfile();
        });
        root.querySelector('[data-field="enabled"]').addEventListener("change", (event) => { layer.enabled = event.target.checked; });
        root.querySelector('[data-field="thinking"]')?.addEventListener("input", (event) => { layer.thinking = event.target.value; });
        root.querySelector('[data-field="toolCalls"]')?.addEventListener("input", (event) => { updateToolCallsFromTextarea(layer, event.target.value); });
        root.querySelector('[data-field="content"]')?.addEventListener("input", (event) => { layer.content = event.target.value; });
        root.querySelector('[data-action="delete"]').addEventListener("click", () => {
          activeProfile[collection] = activeProfile[collection].filter((item) => item.id !== layer.id);
          renderPromptProfile();
        });
        root.querySelector('[data-action="up"]').addEventListener("click", () => movePromptLayer(index, -1, collection));
        root.querySelector('[data-action="down"]').addEventListener("click", () => movePromptLayer(index, 1, collection));
      }

      function movePromptLayer(index, delta, collection) {
        const activeProfile = promptEditorMode === "talk" ? talkPromptProfile : promptProfile;
        const layers = [...activeProfile[collection]].sort((a, b) => a.order - b.order);
        const nextIndex = index + delta;
        if (nextIndex < 0 || nextIndex >= layers.length) return;
        const currentOrder = layers[index].order;
        layers[index].order = layers[nextIndex].order;
        layers[nextIndex].order = currentOrder;
        renderPromptProfile();
      }

      async function savePromptProfile() {
        const isTalk = promptEditorMode === "talk";
        const body = isTalk ? talkPromptProfile : promptProfile;
        const result = await fetch(isTalk ? "/admin/api/talk-prompt-profile" : "/admin/api/prompt-profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("prompt-status").textContent = result.ok ? "Prompt profile saved." : "Prompt profile save failed.";
        if (result.profile) {
          if (isTalk) talkPromptProfile = result.profile;
          else promptProfile = result.profile;
          if (isTalk) talkPromptVariables = result.variables || {};
          else promptVariables = result.variables || {};
          renderPromptProfile();
          await refreshChatPromptPreview(isTalk ? "talk" : "chat");
        }
        await refreshLLMRequests();
      }

      async function saveBirthday() {
        const result = await fetch("/admin/api/calendar/birthday", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            calendarSystem: $("birthdayCalendarSystem").value,
            month: $("birthdayMonth").value,
            day: $("birthdayDay").value,
            year: $("birthdayYear").value,
            isLeapMonth: $("birthdayLeapMonth").checked
          })
        }).then((res) => res.json());
        $("prompt-status").textContent = result.ok ? "Birthday saved." : "Birthday save failed.";
        if (result.birthday) {
          calendarBirthday = result.birthday;
          renderPromptProfile();
        }
      }

      async function refreshChatPromptPreview(mode = "chat") {
        const elementId = mode === "talk" ? "talkPromptPreview" : "chatPromptPreview";
        const element = $(elementId);
        if (!element) return;
        if (promptSideView === "variables") {
          element.outerHTML = renderPromptSideContent(mode, "Save Prompt Profile to refresh preview.");
          return;
        }
        element.textContent = "Loading preview...";
        const payload = await fetch("/admin/api/llm-requests").then((res) => res.json());
        const preview = mode === "talk" ? payload.talkProfilePreview : payload.profilePreview;
        element.innerHTML = preview ? renderLLMRequestBlock(mode === "talk" ? "Current Talk Prompt Profile Prebuild" : "Current Prompt Profile Prebuild", preview) : "No " + (mode === "talk" ? "Talk" : "Chat") + " prompt preview available.";
      }
`;
}
