export function renderMemoryScript(): string {
  return `      let memorySleepDays = [];
      let memoryCalendarMonth = "";
      async function refreshMemoryPromptPreview(target) {
        if (!$("memoryPromptPreview")) return;
        if (promptSideView === "variables") {
          $("memoryPromptPreview").outerHTML = renderPromptSideContent("memory", "Save a Memorize group to refresh its preview.");
          return;
        }
        lastMemoryPromptPreviewTarget = target || lastMemoryPromptPreviewTarget;
        $("promptSideTitle").textContent = "Prompt Preview · " + memoryTargetLabel(target);
        $("memoryPromptPreview").textContent = "Loading preview...";
        const result = await fetch("/admin/api/memory/prompts/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompts: memoryPrompts, target, date: $("memoryRunDate")?.value })
        }).then(async (res) => ({ status: res.status, body: await res.json() }));
        if (!result.body.ok) {
          $("memoryPromptPreview").textContent = JSON.stringify(result.body, null, 2);
          return;
        }
        $("memoryPromptPreview").innerHTML = renderMemoryPromptPreview(result.body.preview);
      }

      function memoryTargetLabel(target) {
        if (target === "userPreferences") return "user-preferences → user-preferences";
        if (target === "yesterdaySummary") return "diary → diary";
        return "persistent-memory → persistent-memory";
      }

      function renderMemoryPromptPreview(preview) {
        const request = preview.request || {};
        return renderLLMRequestBlock("Current Memorize Prompt Preview · " + memoryTargetLabel(preview.target), {
          ...request,
          source: "preview",
          time: preview.generatedAt,
          conversationId: preview.target,
          rawRequest: request
        });
      }

      async function refreshLLMApiPresets() {
        const [payload, credentialPayload] = await Promise.all([
          fetch("/admin/api/config/llm-presets").then((res) => res.json()),
          fetch("/admin/api/credentials").then((res) => res.json())
        ]);
        llmApiPresets = payload.presets || [];
        llmCredentials = credentialPayload.credentials || [];
        currentLLMApiPreset = payload.active;
        renderCredentialControls();
        renderLLMApiPresetControls();
        if (payload.active) {
          applyLLMApiPresetToForm(payload.active);
          $("llmPresetSelect").value = payload.active.name || "";
        }
      }

      function renderLLMApiPresetControls() {
        if ($("llmPresetSelect")) $("llmPresetSelect").innerHTML = renderLLMApiPresetOptions($("llmPresetSelect").value || "");
        if ($("promptApiPresetSelect")) {
          const selected = promptEditorMode === "memory"
            ? promptApiProfile.memorizePresetName
            : promptEditorMode === "talk"
              ? promptApiProfile.talkPresetName
              : promptApiProfile.chatPresetName;
          $("promptApiPresetSelect").innerHTML = renderLLMApiPresetOptions(selected || "");
        }
      }

      function renderLLMApiPresetOptions(selected = "") {
        return ['<option value="" ' + (!selected ? "selected" : "") + '>Choose API preset</option>']
          .concat(llmApiPresets.map((preset) => \`<option value="\${escapeAttr(preset.name)}" \${selected === preset.name ? "selected" : ""}>\${escapeHtml(preset.name)}</option>\`))
          .join("");
      }

      function renderCredentialControls() {
        const select = $("credentialId");
        if (select) {
          const selected = select.value;
          select.innerHTML = ['<option value="">Choose credential</option>']
            .concat(llmCredentials.map((credential) => \`<option value="\${escapeAttr(credential.id)}">\${escapeHtml(credential.label)} · \${escapeHtml(credential.kind)} · \${escapeHtml(credential.provider)}</option>\`))
            .join("");
          if (llmCredentials.some((credential) => credential.id === selected)) select.value = selected;
        }
      }

      function selectedLLMApiPreset(selectId = "llmPresetSelect") {
        const name = $(selectId)?.value || "";
        return llmApiPresets.find((preset) => preset.name === name);
      }

      function collectLLMApiForm() {
        const body = {
          baseURL: $("baseURL").value,
          model: $("model").value,
          protocol: $("protocol").value,
          credentialId: $("credentialId").value,
          temperature: $("temperature").value,
          maxTokens: $("maxTokens").value,
          timeoutMs: $("timeoutMs").value,
          useProxy: $("useProxy").checked,
          stream: $("streamEnabled").checked,
          supportsImage: $("supportsImage").checked,
          supportsAudio: $("supportsAudio").checked,
          extraParams: $("extraParams").value,
          followupExtraParams: $("followupExtraParams").value
        };
        return body;
      }

      function bindLLMApiPresetFormDirtyTracking() {
        ["llmPresetName", "baseURL", "model", "temperature", "maxTokens", "timeoutMs", "extraParams", "followupExtraParams"].forEach((id) => {
          $(id)?.addEventListener("input", () => markLLMApiPreset("dirty"));
        });
        $("streamEnabled")?.addEventListener("change", () => markLLMApiPreset("dirty"));
        $("useProxy")?.addEventListener("change", () => markLLMApiPreset("dirty"));
        $("supportsImage")?.addEventListener("change", () => markLLMApiPreset("dirty"));
        $("supportsAudio")?.addEventListener("change", () => markLLMApiPreset("dirty"));
        $("protocol")?.addEventListener("change", () => markLLMApiPreset("dirty"));
        $("credentialId")?.addEventListener("change", () => markLLMApiPreset("dirty"));
      }

      function markLLMApiPreset(state) {
        const marker = $("llmPresetMarker");
        if (!marker) return;
        marker.textContent = state === "dirty" ? "[●]" : state === "saved" ? "[M]" : "";
      }

      function applyLLMApiPresetToForm(preset) {
        $("baseURL").value = preset.baseURL || "";
        $("model").value = preset.model || "";
        $("protocol").value = preset.protocol || "openai-chat-completions";
        $("credentialId").value = preset.credentialId || "";
        $("temperature").value = String(preset.temperature ?? "");
        $("maxTokens").value = String(preset.maxTokens ?? "");
        $("timeoutMs").value = String(preset.timeoutMs ?? "");
        $("useProxy").checked = preset.useProxy === true;
        $("streamEnabled").checked = preset.stream !== false;
        $("supportsImage").checked = preset.supportsImage === true;
        $("supportsAudio").checked = preset.supportsAudio === true;
        $("extraParams").value = JSON.stringify(preset.extraParams || {}, null, 2);
        $("followupExtraParams").value = JSON.stringify(preset.followupExtraParams || {}, null, 2);
        $("llmPresetName").value = preset.name || "";
        markLLMApiPreset("");
      }

      function clearLLMApiForm() {
        $("baseURL").value = "";
        $("model").value = "";
        $("protocol").value = "openai-chat-completions";
        $("credentialId").value = llmCredentials[0]?.id || "";
        $("temperature").value = "0.2";
        $("maxTokens").value = "";
        $("timeoutMs").value = "60000";
        $("useProxy").checked = false;
        $("streamEnabled").checked = true;
        $("supportsImage").checked = false;
        $("supportsAudio").checked = false;
        $("extraParams").value = "{}";
        $("followupExtraParams").value = "{}";
        $("llmPresetName").value = "";
        markLLMApiPreset("");
      }

      function validateLLMApiPresetForm() {
        const name = $("llmPresetName").value.trim() || $("llmPresetSelect").value;
        if (!name) return "Preset name required. API settings are saved only as named presets.";
        if (!$("model").value.trim()) return "Model is required.";
        if (!$("credentialId").value) return "Credential is required.";
        const baseURL = $("baseURL").value.trim();
        if (baseURL) {
          try {
            const url = new URL(baseURL);
            if (url.protocol !== "http:" && url.protocol !== "https:") return "Base URL must start with http:// or https://.";
          } catch {
            return "Base URL is not a valid URL.";
          }
        }
        const temperature = Number($("temperature").value);
        if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) return "Temperature must be a number between 0 and 2.";
        const maxTokensText = $("maxTokens").value.trim();
        if (maxTokensText) {
          const maxTokens = Number(maxTokensText);
          if (!Number.isInteger(maxTokens) || maxTokens <= 0) return "Max Tokens must be a positive integer.";
        }
        const timeoutMs = Number($("timeoutMs").value);
        if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) return "Timeout Ms must be at least 1000.";
        const extraParams = parseLLMApiJsonObject("Extra Params JSON", $("extraParams").value);
        if (extraParams) return extraParams;
        const followupExtraParams = parseLLMApiJsonObject("Follow-up Extra Params JSON", $("followupExtraParams").value);
        if (followupExtraParams) return followupExtraParams;
        return "";
      }

      function parseLLMApiJsonObject(label, value) {
        const text = value.trim();
        if (!text) return "";
        try {
          const parsed = JSON.parse(text);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return label + " must be a JSON object.";
          return "";
        } catch {
          return label + " is not valid JSON.";
        }
      }

      async function saveCurrentLLMApiPreset() {
        const name = $("llmPresetName").value.trim() || $("llmPresetSelect").value;
        const validationError = validateLLMApiPresetForm();
        if (validationError) {
          $("save-status").textContent = validationError;
          return;
        }
        try {
          $("save-status").textContent = "Saving preset...";
          const result = await persistLLMApiPreset(name);
          $("save-status").textContent = "Preset saved: " + name;
          llmApiPresets = result.presets || llmApiPresets;
          renderLLMApiPresetControls();
          $("llmPresetSelect").value = name;
          const saved = selectedLLMApiPreset();
          if (saved) applyLLMApiPresetToForm(saved);
          markLLMApiPreset("saved");
        } catch (error) {
          $("save-status").textContent = "Preset save failed: " + (error?.message || "unknown");
        }
      }

      async function persistLLMApiPreset(name) {
        const result = await fetch("/admin/api/config/llm-presets", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, ...collectLLMApiForm() })
        }).then((res) => res.json());
        if (!result.ok) throw new Error(result.error || "unknown");
        return result;
      }

      async function savePromptApiProfile(mode) {
        const selected = $("promptApiPresetSelect")?.value || undefined;
        const profile = {
          chatPresetName: promptApiProfile.chatPresetName || undefined,
          talkPresetName: promptApiProfile.talkPresetName || undefined,
          memorizePresetName: promptApiProfile.memorizePresetName || undefined
        };
        if (mode === "memorize") profile.memorizePresetName = selected;
        else if (mode === "talk") profile.talkPresetName = selected;
        else profile.chatPresetName = selected;
        const result = await fetch("/admin/api/prompt-api-profile", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(profile)
        }).then((res) => res.json());
        $("prompt-status").textContent = result.ok ? "API binding saved." : "API binding save failed: " + (result.error || "unknown");
        if (result.profile) promptApiProfile = result.profile;
        if (result.ok) {
          if (mode === "memorize") await refreshMemoryPromptPreview(lastMemoryPromptPreviewTarget);
          else await refreshChatPromptPreview(mode);
        }
      }

      async function renameSelectedLLMApiPreset() {
        const from = $("llmPresetSelect").value;
        const to = $("llmPresetName").value.trim();
        if (!from || !to) {
          $("save-status").textContent = "Choose a preset and enter a new name.";
          return;
        }
        const result = await fetch("/admin/api/config/llm-presets/rename", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from, to })
        }).then((res) => res.json());
        $("save-status").textContent = result.ok ? "Preset renamed." : "Preset rename failed: " + (result.error || "unknown");
        if (result.presets) {
          llmApiPresets = result.presets;
          renderLLMApiPresetControls();
          $("llmPresetSelect").value = to;
        }
      }

      async function deleteSelectedLLMApiPreset() {
        const name = $("llmPresetSelect").value;
        if (!name) {
          $("save-status").textContent = "Choose a preset to delete.";
          return;
        }
        const result = await fetch("/admin/api/config/llm-presets", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name })
        }).then((res) => res.json());
        $("save-status").textContent = result.ok ? "Preset deleted." : "Preset delete failed: " + (result.error || "unknown");
        if (result.presets) {
          llmApiPresets = result.presets;
          renderLLMApiPresetControls();
          $("llmPresetName").value = "";
        }
      }

      async function refreshMemory() {
        const payload = await fetch("/admin/api/memory").then((res) => res.json());
        const files = payload.files || [];
        renderMemorySleepDays(payload.sleepDays || []);
        await refreshMemoryDayMessages();
        // 计划 §8.3: 只读展示最新 100 条 Short Memory; API 已按 createdAtUtc DESC 返回,
        // 按数组顺序展示(不 reverse/sort); createdAt 为本地时间, 内容经 escapeHtml 防注入。
        const shortMemories = payload.shortMemories || [];
        $("shortMemories").innerHTML = shortMemories.map((entry) => \`
          <div class="log-line">[\${escapeHtml(entry.createdAt)}] \${escapeHtml(entry.content)}</div>
        \`).join("");
        $("memoryFiles").innerHTML = files.map((file) => \`
          <details class="prompt-layer" open>
            <summary>
              <span>\${escapeHtml(memoryTargetDisplayName(file.target))} · \${escapeHtml(file.tableName || file.fileName)}</span>
              <span>
                \${escapeHtml(file.lines)}/\${escapeHtml(file.maxLines)} lines · \${escapeHtml(file.bytes)}/\${escapeHtml(file.maxBytes)} bytes
                <button type="button" class="secondary" data-memory-run="\${escapeAttr(file.target)}">Run</button>
              </span>
            </summary>
            <textarea data-memory-target="\${escapeAttr(file.target)}" rows="10">\${escapeHtml(file.content || "")}</textarea>
            <button type="button" data-memory-save="\${escapeAttr(file.target)}">Save SQL Record</button>
            <button type="button" class="secondary" data-memory-delete-latest="\${escapeAttr(file.target)}">Delete Latest SQL Record</button>
          </details>
        \`).join("");
        document.querySelectorAll("[data-memory-run]").forEach((button) => button.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          await runMemoryTarget(button.dataset.memoryRun);
        }));
        document.querySelectorAll("[data-memory-save]").forEach((button) => button.addEventListener("click", async () => {
          const target = button.dataset.memorySave;
          const content = document.querySelector('[data-memory-target="' + cssEscape(target) + '"]').value;
          const result = await fetch("/admin/api/memory/file", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ target, content })
          }).then((res) => res.json());
          $("memory-status").textContent = result.ok ? "Memory SQL record saved." : "Memory SQL save failed: " + (result.error || "unknown error");
          if (result.ok && Array.isArray(result.files)) {
            const file = result.files.find((entry) => entry.target === target);
            const details = button.closest("details");
            if (file && details) {
              details.querySelector("summary span").textContent = file.lines + "/" + file.maxLines + " lines · " + file.bytes + "/" + file.maxBytes + " bytes";
            }
          }
        }));
        document.querySelectorAll("[data-memory-delete-latest]").forEach((button) => button.addEventListener("click", async () => {
          await deleteLatestMemorySqlRecord(button.dataset.memoryDeleteLatest);
        }));
      }

      function memoryTargetDisplayName(target) {
        if (target === "persistent") return "记忆";
        if (target === "userPreferences") return "用户记忆";
        if (target === "yesterdaySummary") return "日记";
        return target || "Memory";
      }

      function renderMemorySleepDays(days) {
        memorySleepDays = days;
        const select = $("memoryRunDate");
        const previous = select.value;
        if (!days.length) {
          select.innerHTML = '<option value="">No sleep windows</option>';
          renderMemoryCalendar();
          return;
        }
        select.innerHTML = days.map((day) => {
          const label = day.date + "  " + (day.startAt || "") + " -> " + (day.endAt || "");
          return \`<option value="\${escapeAttr(day.date)}">\${escapeHtml(label)}</option>\`;
        }).join("");
        select.value = days.some((day) => day.date === previous) ? previous : days[0].date;
        memoryCalendarMonth = select.value.slice(0, 7);
        renderMemoryCalendar();
      }

      function renderMemoryCalendar() {
        const root = $("memoryCalendar");
        if (!root) return;
        const selected = $("memoryRunDate").value;
        if (!memorySleepDays.length) {
          const month = memoryCalendarMonth || new Date().toISOString().slice(0, 7);
          root.innerHTML = renderMemoryCalendarShell(month, selected, new Set());
          bindMemoryCalendar();
          return;
        }
        if (!memoryCalendarMonth) memoryCalendarMonth = selected ? selected.slice(0, 7) : memorySleepDays[0].date.slice(0, 7);
        root.innerHTML = renderMemoryCalendarShell(memoryCalendarMonth, selected, new Set(memorySleepDays.map((day) => day.date)));
        bindMemoryCalendar();
      }

      function renderMemoryCalendarShell(month, selected, availableDates) {
        const first = new Date(month + "-01T00:00:00");
        const year = first.getFullYear();
        const monthIndex = first.getMonth();
        const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
        const leading = first.getDay();
        const cells = [];
        for (let i = 0; i < leading; i += 1) cells.push('<button type="button" class="memory-calendar-day empty" disabled></button>');
        for (let day = 1; day <= daysInMonth; day += 1) {
          const date = month + "-" + String(day).padStart(2, "0");
          const available = availableDates.has(date);
          const classes = ["memory-calendar-day", available ? "available" : "", selected === date ? "selected" : ""].filter(Boolean).join(" ");
          cells.push(\`<button type="button" class="\${classes}" data-memory-calendar-date="\${escapeAttr(date)}" \${available ? "" : "disabled"}>\${day}</button>\`);
        }
        const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => '<div class="memory-calendar-weekday">' + day + '</div>').join("");
        return \`
          <div class="memory-calendar-head">
            <button type="button" class="secondary" data-memory-calendar-shift="-1">&lt;</button>
            <strong>\${escapeHtml(month)}</strong>
            <button type="button" class="secondary" data-memory-calendar-shift="1">&gt;</button>
          </div>
          <div class="memory-calendar-grid">\${weekdays}\${cells.join("")}</div>
        \`;
      }

      function bindMemoryCalendar() {
        document.querySelectorAll("[data-memory-calendar-date]").forEach((button) => button.addEventListener("click", async () => {
          $("memoryRunDate").value = button.dataset.memoryCalendarDate;
          memoryCalendarMonth = $("memoryRunDate").value.slice(0, 7);
          renderMemoryCalendar();
          await refreshMemoryDayMessages();
        }));
        document.querySelectorAll("[data-memory-calendar-shift]").forEach((button) => button.addEventListener("click", () => {
          const current = new Date((memoryCalendarMonth || new Date().toISOString().slice(0, 7)) + "-01T00:00:00");
          current.setMonth(current.getMonth() + Number(button.dataset.memoryCalendarShift || 0));
          memoryCalendarMonth = current.toISOString().slice(0, 7);
          renderMemoryCalendar();
        }));
      }

      async function refreshMemoryDayMessages() {
        if (!$("memoryDayMessages")) return;
        const date = $("memoryRunDate").value;
        if (!date) {
          $("memoryDayMessages").textContent = "Choose a date to load chat records.";
          return;
        }
        $("memoryDayMessages").textContent = "Loading chat records...";
        const payload = await fetch("/admin/api/memory/messages?date=" + encodeURIComponent(date)).then((res) => res.json());
        if (!payload.ok) {
          $("memoryDayMessages").textContent = "Chat load failed: " + (payload.error || "unknown error");
          return;
        }
        const utcWindow = payload.startAtUtc || payload.endAtUtc
          ? ' utc=' + escapeHtml(payload.startAtUtc || "") + ' -> ' + escapeHtml(payload.endAtUtc || "")
          : "";
        $("memoryDayMessages").innerHTML = '<div class="log-line">Window: ' + escapeHtml(payload.startAt || "") + ' -> ' + escapeHtml(payload.endAt || "") + utcWindow + '</div>' + renderMemoryDayMessages(payload);
      }

      function renderMemoryDayMessages(payload) {
        if (typeof payload.content === "string" && payload.content.trim()) {
          return '<pre class="log-line">' + escapeHtml(payload.content) + '</pre>';
        }
        const messages = payload.messages || [];
        if (!messages.length) return '<div class="log-line">No chat records for selected date.</div>';
        return messages.map((message) => {
          const actor = message.senderRole || message.direction || "unknown";
          const status = message.status && message.status !== "sent" ? " " + message.status : "";
          const utc = message.createdAtUtc ? " utc=" + message.createdAtUtc : "";
          return \`<div class="log-line">[\${escapeHtml(message.createdAt || "")}\${escapeHtml(utc)}] \${escapeHtml(actor)}\${escapeHtml(status)}: \${escapeHtml(message.contentText || "")}</div>\`;
        }).join("");
      }

      async function runMemoryDay() {
        const runId = createMemoryRunId();
        const startedAt = Date.now();
        const stopProgress = startMemoryRunProgress(runId, "Running Memorize...", startedAt);
        let result;
        try {
          result = await fetch("/admin/api/memory/run-day", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ date: $("memoryRunDate").value, runId })
          }).then(async (res) => ({ status: res.status, body: await res.json() }));
        } finally {
          stopProgress();
        }
        const progress = await fetchMemoryRunProgress(runId);
        const rounds = memoryRunRoundsText(result.body.result, result.body.ok ? "ok" : "failed", progress);
        $("memory-status").textContent = result.body.ok ? "Memorize complete." + rounds : "Memorize failed: " + memoryRunErrorText(result.body) + rounds;
        $("memoryRunResult").textContent = JSON.stringify(result.body.result || result.body, null, 2);
        await refreshMemory();
        await refreshLogs();
      }

      async function runMemoryTarget(target) {
        const runId = createMemoryRunId();
        const startedAt = Date.now();
        const stopProgress = startMemoryRunProgress(runId, "Running Memorize for " + target + "...", startedAt);
        let result;
        try {
          result = await fetch("/admin/api/memory/run-target", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ date: $("memoryRunDate").value, target, runId })
          }).then(async (res) => ({ status: res.status, body: await res.json() }));
        } finally {
          stopProgress();
        }
        const progress = await fetchMemoryRunProgress(runId);
        const rounds = memoryRunRoundsText(result.body.result, result.body.ok ? "ok" : "failed", progress);
        $("memory-status").textContent = result.body.ok ? "Memorize " + target + " complete." + rounds : "Memorize " + target + " failed: " + memoryRunErrorText(result.body) + rounds;
        $("memoryRunResult").textContent = JSON.stringify(result.body.result || result.body, null, 2);
        await refreshMemory();
        await refreshLogs();
      }

      function memoryRunErrorText(body) {
        const error = body?.error || body?.result?.results?.find((entry) => !entry.ok)?.error;
        if (error === "memory_manual_run_requires_paused_or_sleeping") return "pause heartbeat or enter sleeping state first";
        return error || "see Last Run / System Log";
      }

      function createMemoryRunId() {
        return Date.now() + "-" + Math.random().toString(16).slice(2);
      }

      function startMemoryRunProgress(runId, prefix, startedAt) {
        let stopped = false;
        let timer = null;
        const tick = async () => {
          if (stopped) return;
          try {
            const progress = await fetchMemoryRunProgress(runId);
            if (progress) renderMemoryProgress(prefix, progress, startedAt);
          } catch {}
          if (!stopped) timer = setTimeout(tick, 800);
        };
        $("memory-status").textContent = prefix + " rounds. 0 0s";
        timer = setTimeout(tick, 150);
        return () => {
          stopped = true;
          if (timer) clearTimeout(timer);
        };
      }

      async function fetchMemoryRunProgress(runId) {
        try {
          const payload = await fetch("/admin/api/memory/run-progress?id=" + encodeURIComponent(runId)).then((res) => res.json());
          return payload.ok ? payload.progress : null;
        } catch {
          return null;
        }
      }

      function renderMemoryProgress(prefix, progress, startedAt) {
        $("memory-status").textContent = prefix + memoryProgressRoundsText(progress, startedAt);
      }

      function memoryProgressRoundsText(progress, startedAt) {
        const entries = Object.entries(progress?.rounds || {});
        if (!entries.length) return " rounds. 0 0s";
        return " rounds. " + entries.map(([target, rounds]) => {
          const seconds = elapsedSecondsText(Date.parse(progress?.roundStartedAt?.[target] || progress?.updatedAt || new Date().toISOString()));
          return [rounds, progress?.tools?.[target], seconds].filter(Boolean).join(" ");
        }).join(", ");
      }

      function memoryRunRoundsText(result, status, progress) {
        const results = Array.isArray(result?.results) ? result.results : [];
        const parts = results.filter((entry) => typeof entry.rounds === "number").map((entry) => {
          const tool = status || progress?.tools?.[entry.target];
          const seconds = elapsedSecondsText(Date.parse(progress?.roundStartedAt?.[entry.target] || progress?.updatedAt || new Date().toISOString()));
          return [entry.rounds, tool, seconds].filter(Boolean).join(" ");
        });
        return parts.length ? " rounds. " + parts.join(", ") : "";
      }

      function elapsedSecondsText(startedAtMs) {
        return Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)) + "s";
      }

      async function undoLastMemoryRun() {
        const result = await fetch("/admin/api/memory/undo-last", { method: "POST" }).then((res) => res.json());
        $("memory-status").textContent = result.ok ? "Undo memory run complete." : "Undo memory run failed: " + (result.error || "unknown");
        await refreshMemory();
      }

      async function redoLastMemoryRun() {
        const result = await fetch("/admin/api/memory/redo-last", { method: "POST" }).then((res) => res.json());
        $("memory-status").textContent = result.ok ? "Redo memory run complete." : "Redo memory run failed: " + (result.error || "unknown");
        await refreshMemory();
      }

      async function deleteLatestMemorySqlRecord(target) {
        $("memory-status").textContent = "Deleting latest " + memoryTargetDisplayName(target) + " SQL record...";
        const result = await fetch("/admin/api/memory/delete-latest-sql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target })
        }).then((res) => res.json());
        $("memory-status").textContent = result.ok ? "Deleted latest " + memoryTargetDisplayName(target) + " SQL record: " + (result.entry?.localDate || result.entry?.id || "") : "Delete latest SQL record failed: " + (result.error || "unknown error");
        await refreshMemory();
      }

      async function clearMemorySession() {
        const result = await fetch("/admin/api/memory/clear-session", { method: "POST" }).then((res) => res.json());
        $("memory-status").textContent = result.ok ? "Memorize session cleared." : "Memorize session clear failed: " + (result.error || "unknown error");
        await refreshLLMChain();
      }
`;
}
