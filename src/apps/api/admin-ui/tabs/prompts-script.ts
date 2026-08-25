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
        if (!activeProfile.visibleTools) activeProfile.visibleTools = {};
        if (!activeProfile.layers) activeProfile.layers = { meta: {}, messages: [] };
        if (!activeProfile.appendLayers) activeProfile.appendLayers = { meta: {}, messages: [] };
        if (!isTalk && !activeProfile.consecutiveToolReminderLayer) activeProfile.consecutiveToolReminderLayer = { meta: {}, messages: [] };
        if (!isTalk && !activeProfile.silentEndingReminderLayer) activeProfile.silentEndingReminderLayer = { meta: {}, messages: [] };
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
              \${!activeProfile.interruptLayer ? "" : \`
              <h2>Interrupt Layer</h2>
              <p class="muted">Inserted after the next completed tool-result batch when a new user message arrives during a running loop.</p>
              <div id="promptInterruptLayer">\${renderLayerDocument(activeProfile.interruptLayer, { editorId: "interrupt", roles: ["system", "user", "assistant"], showActions: false })}</div>
              \`}
              \${isTalk ? "" : \`
              <h2>Consecutive Tool Reminder</h2>
              <p class="muted">Appended as a user message after six consecutive non-sending tools. It is injected at most once per turn.</p>
              <div id="promptConsecutiveToolReminder">\${renderLayerDocument(activeProfile.consecutiveToolReminderLayer, { editorId: "consecutive-tool-reminder", roles: ["user"] })}</div>
              <button type="button" id="prompt-consecutive-tool-reminder-add">Add Consecutive Tool Reminder Message</button>
              <h2>Silent Ending Reminder</h2>
              <p class="muted">Appended as a user message before a raw, empty, or Yield finish/await_chat ending. It is injected at most once per turn, independently of the consecutive-tool reminder.</p>
              <div id="promptSilentEndingReminder">\${renderLayerDocument(activeProfile.silentEndingReminderLayer, { editorId: "silent-ending-reminder", roles: ["user"] })}</div>
              <button type="button" id="prompt-silent-ending-reminder-add">Add Silent Ending Reminder Message</button>
              \`}
              <h2>Initial Layers</h2>
              <div id="promptLayers">\${renderLayerDocument(activeProfile.layers, { editorId: "prompt-layers" })}</div>
              <button type="button" id="prompt-add">Add Initial Layer</button>
              <h2>Append Layers</h2>
              <p class="muted">Append messages are rendered before each heartbeat LLM request. Assistant tool calls run immediately and include their tool result.</p>
              <div id="promptAppendLayers">\${renderLayerDocument(activeProfile.appendLayers, { editorId: "prompt-append-layers" })}</div>
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
        if (activeProfile.interruptLayer) bindLayerDocument(activeProfile.interruptLayer, { editorId: "interrupt", render: renderPromptProfile });
        if (!isTalk) bindLayerDocument(activeProfile.consecutiveToolReminderLayer, { editorId: "consecutive-tool-reminder", render: renderPromptProfile });
        if (!isTalk) bindLayerDocument(activeProfile.silentEndingReminderLayer, { editorId: "silent-ending-reminder", render: renderPromptProfile });
        bindLayerDocument(activeProfile.layers, { editorId: "prompt-layers", render: renderPromptProfile });
        bindLayerDocument(activeProfile.appendLayers, { editorId: "prompt-append-layers", render: renderPromptProfile });
        $("prompt-add").addEventListener("click", () => {
          addLayerMessage(activeProfile.layers, { title: "New Layer" });
          renderPromptProfile();
        });
        $("prompt-append-add").addEventListener("click", () => {
          addLayerMessage(activeProfile.appendLayers, { title: "New Append Layer", toolCall: true, toolName: promptTools[0]?.name || "Chat" });
          renderPromptProfile();
        });
        $("prompt-consecutive-tool-reminder-add")?.addEventListener("click", () => {
          addLayerMessage(activeProfile.consecutiveToolReminderLayer, { title: "Consecutive Tool Reminder", role: "user" });
          renderPromptProfile();
        });
        $("prompt-silent-ending-reminder-add")?.addEventListener("click", () => {
          addLayerMessage(activeProfile.silentEndingReminderLayer, { title: "Silent Ending Reminder", role: "user" });
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
        if (!memoryPrompts.meta) memoryPrompts.meta = {};
        if (!Array.isArray(memoryPrompts.messages)) memoryPrompts.messages = [];
        $("promptProfile").innerHTML = \`
          <div class="prompt-editor-grid">
            <div class="subtabs prompt-mode-cell">
              <button class="tab" id="prompt-mode-chat" type="button">Chat</button>
              <button class="tab" id="prompt-mode-talk" type="button">Talk</button>
              <button class="tab active" id="prompt-mode-memory" type="button">Memorize</button>
            </div>
            <div class="prompt-api-cell">\${renderPromptApiPresetPicker("memorize")}</div>
            <div class="prompt-edit-cell">
              <h2>Memorize Prompt</h2>
              <div id="memoryPromptMessages">\${renderLayerDocument(memoryPrompts, { editorId: "memory" })}</div>
              <button type="button" id="memory-layer-add">Add Message</button>
              <button type="button" id="memory-prompt-save">Save Memorize Prompt</button>
            </div>
            \${renderPromptSidePane("memory", "Prompt Preview", "Save the Memorize prompt to refresh its preview.")}
          </div>
        \`;
        $("prompt-mode-chat").addEventListener("click", () => { promptEditorMode = "chat"; renderPromptProfile(); });
        $("prompt-mode-talk").addEventListener("click", () => { promptEditorMode = "talk"; renderPromptProfile(); });
        $("prompt-mode-memory").addEventListener("click", () => { promptEditorMode = "memory"; renderPromptProfile(); });
        bindPromptSideToggle("memory");
        bindPromptApiPresetPicker("memorize");
        bindLayerDocument(memoryPrompts, { editorId: "memory", render: renderPromptProfile });
        $("memory-layer-add").addEventListener("click", () => {
          addLayerMessage(memoryPrompts, { title: "New Message" });
          renderPromptProfile();
        });
        $("memory-prompt-save").addEventListener("click", saveMemoryPrompt);
      }

      function renderPromptApiPresetPicker(mode) {
        const isMemorize = mode === "memorize";
        const isTalk = mode === "talk";
        const selected = isMemorize ? promptApiProfile.memorizePresetName : isTalk ? promptApiProfile.talkPresetName : promptApiProfile.chatPresetName;
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

      async function saveMemoryPrompt() {
        const result = await fetch("/admin/api/memory/prompts", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompts: memoryPrompts }) }).then((res) => res.json());
        $("prompt-status").textContent = result.ok ? "Memorize prompt saved." : "Memorize prompt save failed.";
        if (result.prompts) memoryPrompts = result.prompts;
        renderPromptProfile();
        if (result.ok) await refreshMemoryPromptPreview("persistent");
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
