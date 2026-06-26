export function renderAdminSidebarScript(): string {
  return `      async function refreshAgentState() {
        const payload = await fetch("/admin/api/agent-state").then((res) => res.json());
        const state = payload.state || {};
        const states = payload.states || [];
        $("agentStateSelect").innerHTML = states.map((item) => \`<option value="\${escapeAttr(item)}" \${state.state === item ? "selected" : ""}>\${escapeHtml(item)}</option>\`).join("");
        $("agentIntimacy").value = String(state.intimacy ?? 50);
        $("agentStateSnapshot").textContent = JSON.stringify(state, null, 2);
      }

      async function refreshRuntimeStatus() {
        const payload = await fetch("/admin/api/runtime/status").then((res) => res.json());
        $("runtimeStatus").textContent = JSON.stringify(payload, null, 2);
      }
      async function uploadTtsReferenceAudio() {
        const file = $("ttsReferenceAudio").files?.[0];
        if (!file) {
          $("tts-preview-status").textContent = "Choose a WAV, MP3, or M4A voice sample first.";
          return;
        }
        const referenceText = $("ttsReferenceText").value.trim();
        if (!referenceText) {
          $("tts-preview-status").textContent = "Enter the text spoken in the reference audio first.";
          return;
        }
        $("tts-preview-status").textContent = "Uploading voice sample...";
        const result = await fetch("/admin/api/tts/reference-audio", {
          method: "POST",
          headers: {
            "content-type": file.type || "application/octet-stream",
            "x-file-name": encodeURIComponent(file.name || "reference.wav"),
            "x-reference-text": encodeURIComponent(referenceText)
          },
          body: file
        }).then((res) => res.json());
        if (!result.ok) {
          $("tts-preview-status").textContent = "Voice sample upload failed: " + (result.error || "unknown error");
          return;
        }
        $("tts-reference-status").textContent = "Current reference: " + result.referenceAudio + " + " + result.referenceText + " (" + Math.round((result.size || 0) / 1024) + " KB)";
        $("tts-preview-status").textContent = "Voice sample converted to " + result.sampleRate + " Hz / " + result.channels + " ch PCM WAV, first " + result.maxDurationSeconds + "s kept.";
        await refreshLogs();
      }

      async function generateTtsPreview() {
        $("tts-preview-status").textContent = "Generating preview...";
        $("ttsPreviewAudio").removeAttribute("src");
        const result = await fetch("/admin/api/tts/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: $("ttsPreviewText").value })
        }).then((res) => res.json());
        if (!result.ok) {
          $("tts-preview-status").textContent = "Preview failed: " + (result.error || "unknown error");
          return;
        }
        $("ttsPreviewAudio").src = result.audioUrl + (result.audioUrl.includes("?") ? "&" : "?") + "v=" + Date.now();
        $("tts-preview-status").textContent = "Preview generated: " + result.assetId;
        await refreshLogs();
      }

      $("llm-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        await saveCurrentLLMApiPreset();
      });
      bindLLMApiPresetFormDirtyTracking();
      $("llmPresetSelect").addEventListener("change", () => {
        const preset = selectedLLMApiPreset();
        if (preset) {
          applyLLMApiPresetToForm(preset);
          $("save-status").textContent = "Preset loaded.";
          return;
        }
        clearLLMApiForm();
      });
      $("llm-preset-save").addEventListener("click", saveCurrentLLMApiPreset);
      $("llm-preset-rename").addEventListener("click", renameSelectedLLMApiPreset);
      $("llm-preset-delete").addEventListener("click", deleteSelectedLLMApiPreset);

      $("agent-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const body = { inboundDebounceMs: form.get("inboundDebounceMs"), timezone: form.get("timezone"), defaultTargetPlugin: form.get("defaultTargetPlugin") };
        const result = await fetch("/admin/api/config/agent", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("agent-status").textContent = result.ok ? "Agent config saved." : "Failed to save agent config.";
        await refresh();
      });
      $("core-profile-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const body = { appearanceDescription: form.get("appearanceDescription"), librarySetting: form.get("librarySetting") };
        const result = await fetch("/admin/api/core-profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("core-profile-status").textContent = result.ok ? "Core profile saved." : "Failed to save core profile.";
        await refresh();
      });
      $("agent-state-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const body = { state: $("agentStateSelect").value, intimacy: $("agentIntimacy").value };
        const result = await fetch("/admin/api/agent-state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("agent-status").textContent = result.ok ? "Agent state saved." : "Failed to save agent state.";
        await refreshAgentState();
      });
      $("heartbeat-pause").addEventListener("click", async () => {
        const result = await fetch("/admin/api/runtime/heartbeat/pause", { method: "POST" }).then((res) => res.json());
        $("agent-status").textContent = result.ok ? "Heartbeat paused." : "Failed to pause heartbeat.";
        await refreshRuntimeStatus();
      });
      $("heartbeat-resume").addEventListener("click", async () => {
        const result = await fetch("/admin/api/runtime/heartbeat/resume", { method: "POST" }).then((res) => res.json());
        $("agent-status").textContent = result.ok ? "Heartbeat started." : "Failed to start heartbeat.";
        await refreshRuntimeStatus();
      });
      $("memory-run-day").addEventListener("click", runMemoryDay);
      $("memory-clear-session").addEventListener("click", clearMemorySession);
      $("memory-undo-last").addEventListener("click", undoLastMemoryRun);
      $("memory-redo-last").addEventListener("click", redoLastMemoryRun);
      $("memory-delete-latest-sql").addEventListener("click", () => deleteLatestMemorySqlRecord("persistent"));
      $("memoryRunDate").addEventListener("change", async () => {
        memoryCalendarMonth = $("memoryRunDate").value.slice(0, 7);
        renderMemoryCalendar();
        await refreshMemoryDayMessages();
      });
      $("process-now").addEventListener("click", async () => {
        const result = await fetch("/admin/api/runtime/process-now", { method: "POST" }).then((res) => res.json());
        $("agent-status").textContent = result.ok ? "Pending messages processed." : "Failed to process pending messages.";
        await refreshRuntimeStatus();
        await refreshLogs();
        await refreshLLMRequests();
      });
      $("llm-chain-clear").addEventListener("click", async () => {
        const result = await fetch("/admin/api/llm-chain/clear", { method: "POST" }).then((res) => res.json());
        $("llmChainSessions").textContent = result.ok ? "Current session cleared." : "Failed to clear current session.";
        await refreshLLMRequests();
        await refreshLLMChain();
      });
      $("llm-run-cancel").addEventListener("click", async () => {
        const result = await fetch("/admin/api/llm-run/cancel", { method: "POST" }).then((res) => res.json());
        $("llmChainSessions").textContent = result.ok
          ? (result.hadActiveRequest ? "Current LLM run cancellation requested." : "LLM loop cancellation requested.")
          : "Failed to cancel current LLM run.";
        await refreshLLMRequests();
        await refreshLLMChain();
        await refreshLogs();
      });

      function activeMessagingToolPath(action) {
        const active = document.querySelector("[data-channel-tab].active")?.dataset.channelTab;
        return active === "wechat" ? "wechat-" + action : action;
      }
      async function runMessagingTool(path, body) {
        const result = await fetch("/admin/api/tools/messaging/" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("tool-result").textContent = result.content || result.error || "";
        await refreshLogs();
        await refreshLLMRequests();
      }

`;
}
