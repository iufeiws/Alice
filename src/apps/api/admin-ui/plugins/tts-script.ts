export function renderTtsPluginScript(): string {
  return `      pluginConfigRenderers.tts = renderTtsPluginConfig;

      function renderTtsPluginConfig(payload) {
        $("pluginConfigBody").innerHTML = [
          '<form id="pluginConfigForm" class="tts-config-layout" data-plugin-id="tts" novalidate>',
            renderTtsRuntimeSection(payload),
            renderTtsPresetSection(payload),
            renderTtsTranslationSection(payload),
          '</form>',
          '<h2>Route</h2>',
          '<pre>' + escapeHtml((payload.routePreview || []).join("\\n")) + '</pre>',
          '<h2>Runtime Access</h2>',
          '<pre>' + escapeHtml((payload.runtimeAccess || []).join("\\n")) + '</pre>',
          '<h2>Recent Events</h2>',
          '<div id="pluginEvents" class="logs plugin-events">No events loaded.</div>'
        ].join("");
        bindTtsPluginConfig(payload);
      }

      function renderTtsRuntimeSection(payload) {
        return [
          '<section id="ttsRuntimeForm" class="plugin-config-section">',
            '<div class="plugin-section-head">',
              '<h2>Runtime</h2>',
              '<div class="prompt-actions">',
                '<button type="button" id="ttsRuntimeSave">Save Runtime Settings</button>',
                '<button type="button" id="pluginConfigReload" class="secondary">Reload TTS Plugin</button>',
                '<button type="button" id="pluginConfigLogs" class="secondary">Show TTS Event Log</button>',
              '</div>',
            '</div>',
            '<div class="plugin-public-grid">',
              ttsPluginField(payload, "enabled"),
              ttsPluginField(payload, "activePresetName"),
            '</div>',
            renderPluginTestBox(payload),
          '</section>'
        ].join("");
      }

      function renderTtsPresetSection(payload) {
        return [
          '<section id="ttsPresetEditor" class="plugin-config-section">',
            '<div class="plugin-section-head">',
              '<h2>Preset</h2>',
              '<div class="prompt-actions">',
                '<button type="button" id="ttsPresetSave">Save TTS Preset</button>',
                '<button type="button" id="ttsPresetCopy" class="secondary">Copy Preset</button>',
              '</div>',
            '</div>',
            '<div class="plugin-public-grid">',
              ttsPluginField(payload, "editPresetName"),
              ttsPluginField(payload, "newPresetName"),
              ttsPluginField(payload, "currentPreset.provider"),
            '</div>',
            '<div class="tts-provider-panels">',
              renderTtsProviderPanel(payload, "genie", "Genie", [
                "currentPreset.genie.language",
                "currentPreset.genie.modelDir",
                "currentPreset.genie.referenceAudio",
                "currentPreset.genie.referenceText",
                "currentPreset.genie.enabled",
                "currentPreset.genie.baseURL",
                "currentPreset.genie.localFallbackEnabled",
                "currentPreset.genie.speed",
                "currentPreset.genie.splitText",
                "currentPreset.genie.partSilenceSeconds"
              ]),
              renderTtsProviderPanel(payload, "openai-api", "OpenAI-API", [
                "currentPreset.openaiApi.apiPresetName",
                "currentPreset.openaiApi.model",
                "currentPreset.openaiApi.voice",
                "currentPreset.openaiApi.timeoutMs",
                "currentPreset.openaiApi.sampleRate",
                "currentPreset.openaiApi.channels",
                "currentPreset.openaiApi.extraParamsJson"
              ]),
              renderTtsProviderPanel(payload, "bailian", "Bailian", [
                "currentPreset.bailian.service",
                "currentPreset.bailian.endpoint",
                "currentPreset.bailian.apiKey",
                "currentPreset.bailian.apiKeyEnv",
                "currentPreset.bailian.workspaceId",
                "currentPreset.bailian.userAgent",
                "currentPreset.bailian.model",
                "currentPreset.bailian.voice",
                "currentPreset.bailian.languageType",
                "currentPreset.bailian.responseFormat",
                "currentPreset.bailian.timeoutMs",
                "currentPreset.bailian.sampleRate",
                "currentPreset.bailian.channels",
                "currentPreset.bailian.extraParamsJson"
              ]),
              renderTtsMimoProviderPanel(payload),
            '</div>',
          '</section>'
        ].join("");
      }

      function renderTtsTranslationSection(payload) {
        return [
          '<details id="ttsTranslationForm" class="plugin-config-section">',
            '<summary><h2>Translation</h2></summary>',
            '<div class="plugin-public-grid">',
              ttsPluginField(payload, "translationPresetName"),
              ttsPluginField(payload, "translationEditPresetName"),
              ttsPluginField(payload, "newTranslationPresetName"),
            '</div>',
            '<div class="plugin-config-grid">',
              '<div>' + ttsPluginField(payload, "currentTranslation.translationEnabled") + '</div>',
              '<div>' + ttsPluginField(payload, "currentTranslation.apiPresetName") + '</div>',
            '</div>',
            ttsPluginField(payload, "currentTranslation.prompt"),
            '<div class="prompt-actions"><button type="button" id="ttsTranslationSave">Save Translation</button></div>',
          '</details>'
        ].join("");
      }

      function renderTtsProviderPanel(payload, provider, title, fields) {
        return [
          '<div class="tts-provider-panel" data-tts-provider-panel="' + escapeAttr(provider) + '">',
            '<h2>' + escapeHtml(title) + '</h2>',
            '<div class="plugin-config-grid">',
              '<div>' + fields.filter((_, index) => index % 2 === 0).map((key) => ttsPluginField(payload, key)).join("") + '</div>',
              '<div>' + fields.filter((_, index) => index % 2 === 1).map((key) => ttsPluginField(payload, key)).join("") + '</div>',
            '</div>',
          '</div>'
        ].join("");
      }

      function renderTtsMimoProviderPanel(payload) {
        return [
          '<div class="tts-provider-panel" data-tts-provider-panel="mimo">',
            '<h2>MiMo</h2>',
            '<div class="plugin-config-grid">',
              '<div>',
                ttsPluginField(payload, "currentPreset.mimo.mode"),
                ttsPluginField(payload, "currentPreset.mimo.baseURL"),
                ttsPluginField(payload, "currentPreset.mimo.apiKey"),
                ttsPluginField(payload, "currentPreset.mimo.apiKeyEnv"),
                ttsPluginField(payload, "currentPreset.mimo.audioFormat"),
                ttsPluginField(payload, "currentPreset.mimo.timeoutMs"),
              '</div>',
              '<div>',
                '<div data-tts-mimo-mode-field="preset">' + ttsPluginField(payload, "currentPreset.mimo.voice") + '</div>',
                '<div data-tts-mimo-mode-field="voicedesign">' + ttsPluginField(payload, "currentPreset.mimo.voiceDesignPrompt") + '</div>',
                '<div data-tts-mimo-mode-field="voiceclone">' + ttsPluginField(payload, "currentPreset.mimo.voiceCloneAudioDataUrl") + '</div>',
                ttsPluginField(payload, "currentPreset.mimo.sampleRate"),
                ttsPluginField(payload, "currentPreset.mimo.channels"),
                ttsPluginField(payload, "currentPreset.mimo.extraParamsJson"),
              '</div>',
            '</div>',
          '</div>'
        ].join("");
      }

      function ttsPluginField(payload, key) {
        const fields = (payload.configSchema && payload.configSchema.fields) || [];
        const field = fields.find((item) => item.key === key);
        return field ? renderPluginField(field, payload.configValue || {}, payload.apiPresets || []) : "";
      }

      function bindTtsPluginConfig(payload) {
        $("pluginConfigForm").addEventListener("submit", (event) => event.preventDefault());
        $("ttsRuntimeSave").addEventListener("click", saveTtsRuntime);
        $("ttsPresetSave").addEventListener("click", saveTtsPreset);
        $("ttsPresetCopy").addEventListener("click", copyTtsPreset);
        $("ttsTranslationSave").addEventListener("click", saveTtsTranslation);
        $("pluginConfigReload").addEventListener("click", async () => {
          const result = await fetch("/admin/api/plugins/tts/reload", { method: "POST" }).then((res) => res.json());
          $("plugin-status").textContent = result.ok ? "tts reloaded." : "Reload failed: " + (result.error || "unknown error");
          await openPluginConfig("tts");
        });
        $("pluginConfigLogs").addEventListener("click", () => loadPluginEvents("tts"));
        if ($("pluginConfigTest")) $("pluginConfigTest").addEventListener("click", () => runPluginTest("tts"));
        document.querySelectorAll("#pluginConfigForm [data-plugin-upload]").forEach((input) => input.addEventListener("change", uploadPluginAsset));
        document.querySelector('[data-plugin-field="editPresetName"]')?.addEventListener("change", (event) => {
          applyTtsPresetToForm(payload.configValue || {}, event.currentTarget.value);
        });
        document.querySelector('[data-plugin-field="translationEditPresetName"]')?.addEventListener("change", (event) => {
          applyTtsTranslationToForm(payload.configValue || {}, event.currentTarget.value);
        });
        document.querySelector('[data-plugin-field="currentPreset.provider"]')?.addEventListener("change", refreshTtsProviderPanels);
        document.querySelector('[data-plugin-field="currentPreset.mimo.mode"]')?.addEventListener("change", refreshTtsProviderPanels);
        bindBailianEndpointDefaults();
        refreshTtsProviderPanels();
      }

      async function saveTtsRuntime() {
        await patchTtsPluginConfig(pluginConfigBodyFrom($("ttsRuntimeForm")), "TTS runtime saved.");
      }

      async function saveTtsPreset() {
        await patchTtsPluginConfig(pluginConfigBodyFrom($("ttsPresetEditor")), "TTS preset saved.");
      }

      async function copyTtsPreset() {
        const sourceName = document.querySelector('[data-plugin-field="editPresetName"]')?.value || "";
        const targetName = document.querySelector('[data-plugin-field="newPresetName"]')?.value.trim() || "";
        if (!targetName) {
          $("plugin-status").textContent = "Enter a new preset name before copying.";
          return;
        }
        if (sourceName === targetName) {
          $("plugin-status").textContent = "Choose a different name before copying.";
          return;
        }
        await patchTtsPluginConfig({ copyPresetName: sourceName, newPresetName: targetName }, "TTS preset copied.");
      }

      async function saveTtsTranslation() {
        await patchTtsPluginConfig(pluginConfigBodyFrom($("ttsTranslationForm")), "TTS translation saved.");
      }

      async function patchTtsPluginConfig(body, successMessage) {
        $("plugin-status").textContent = "Saving TTS config...";
        const result = await fetch("/admin/api/plugins/tts/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }).then((res) => res.json());
        if (!result.ok) {
          $("plugin-status").textContent = "Save failed: " + (result.error || "unknown error");
          return;
        }
        await openPluginConfig("tts");
        $("plugin-status").textContent = successMessage;
      }

      function applyTtsPresetToForm(config, presetName) {
        const preset = (config.presets || {})[presetName] || {};
        const genie = preset.genie || {};
        const openaiApi = preset.openaiApi || {};
        const bailian = preset.bailian || {};
        const mimo = preset.mimo || {};
        setPluginFieldValue("currentPreset.provider", preset.provider || "genie");
        setPluginFieldValue("currentPreset.genie.enabled", genie.enabled ?? true);
        setPluginFieldValue("currentPreset.genie.baseURL", genie.baseURL || "");
        setPluginFieldValue("currentPreset.genie.localFallbackEnabled", genie.localFallbackEnabled ?? false);
        setPluginFieldValue("currentPreset.genie.language", genie.language || "jp");
        setPluginFieldValue("currentPreset.genie.modelDir", genie.modelDir || "");
        setPluginFieldValue("currentPreset.genie.referenceAudio", genie.referenceAudio || "");
        setPluginFieldValue("currentPreset.genie.speed", genie.speed ?? "");
        setPluginFieldValue("currentPreset.genie.splitText", genie.splitText ?? false);
        setPluginFieldValue("currentPreset.genie.partSilenceSeconds", genie.partSilenceSeconds ?? "");
        setPluginFieldValue("currentPreset.genie.referenceText", genie.referenceText || "");
        setPluginFieldValue("currentPreset.openaiApi.apiPresetName", openaiApi.apiPresetName || "");
        setPluginFieldValue("currentPreset.openaiApi.model", openaiApi.model || "");
        setPluginFieldValue("currentPreset.openaiApi.voice", openaiApi.voice || "");
        setPluginFieldValue("currentPreset.openaiApi.timeoutMs", openaiApi.timeoutMs ?? "");
        setPluginFieldValue("currentPreset.openaiApi.sampleRate", openaiApi.sampleRate ?? "");
        setPluginFieldValue("currentPreset.openaiApi.channels", openaiApi.channels ?? "");
        setPluginFieldValue("currentPreset.openaiApi.extraParamsJson", openaiApi.extraParamsJson || "{}");
        setPluginFieldValue("currentPreset.bailian.service", bailian.service || "qwen");
        setPluginFieldValue("currentPreset.bailian.endpoint", bailian.endpoint || "");
        setPluginFieldValue("currentPreset.bailian.apiKeyEnv", bailian.apiKeyEnv || "DASHSCOPE_API_KEY");
        setPluginFieldValue("currentPreset.bailian.workspaceId", bailian.workspaceId || "");
        setPluginFieldValue("currentPreset.bailian.userAgent", bailian.userAgent || "");
        setPluginFieldValue("currentPreset.bailian.model", bailian.model || "");
        setPluginFieldValue("currentPreset.bailian.voice", bailian.voice || "");
        setPluginFieldValue("currentPreset.bailian.languageType", bailian.languageType || "");
        setPluginFieldValue("currentPreset.bailian.responseFormat", bailian.responseFormat || "");
        setPluginFieldValue("currentPreset.bailian.timeoutMs", bailian.timeoutMs ?? "");
        setPluginFieldValue("currentPreset.bailian.sampleRate", bailian.sampleRate ?? "");
        setPluginFieldValue("currentPreset.bailian.channels", bailian.channels ?? "");
        setPluginFieldValue("currentPreset.bailian.extraParamsJson", bailian.extraParamsJson || "{}");
        setPluginFieldValue("currentPreset.mimo.mode", mimo.mode || "preset");
        setPluginFieldValue("currentPreset.mimo.baseURL", mimo.baseURL || "");
        setPluginFieldValue("currentPreset.mimo.apiKeyEnv", mimo.apiKeyEnv || "MIMO_API_KEY");
        setPluginFieldValue("currentPreset.mimo.voice", mimo.voice || "");
        setPluginFieldValue("currentPreset.mimo.voiceDesignPrompt", mimo.voiceDesignPrompt || "");
        setPluginFieldValue("currentPreset.mimo.audioFormat", mimo.audioFormat || "wav");
        setPluginFieldValue("currentPreset.mimo.timeoutMs", mimo.timeoutMs ?? "");
        setPluginFieldValue("currentPreset.mimo.sampleRate", mimo.sampleRate ?? "");
        setPluginFieldValue("currentPreset.mimo.channels", mimo.channels ?? "");
        setPluginFieldValue("currentPreset.mimo.extraParamsJson", mimo.extraParamsJson || "{}");
        setPluginFieldValue("newPresetName", "");
        refreshTtsProviderPanels();
      }

      function applyTtsTranslationToForm(config, presetName) {
        const preset = (config.translationPresets || {})[presetName] || {};
        setPluginFieldValue("currentTranslation.translationEnabled", preset.translationEnabled ?? true);
        setPluginFieldValue("currentTranslation.apiPresetName", preset.apiPresetName || "");
        setPluginFieldValue("currentTranslation.prompt", preset.prompt || "");
        setPluginFieldValue("newTranslationPresetName", "");
      }

      function refreshTtsProviderPanels() {
        const provider = document.querySelector('[data-plugin-field="currentPreset.provider"]')?.value || "genie";
        document.querySelectorAll("[data-tts-provider-panel]").forEach((panel) => {
          panel.style.display = panel.dataset.ttsProviderPanel === provider ? "" : "none";
        });
        const mimoMode = document.querySelector('[data-plugin-field="currentPreset.mimo.mode"]')?.value || "preset";
        document.querySelectorAll("[data-tts-mimo-mode-field]").forEach((node) => {
          node.style.display = node.dataset.ttsMimoModeField === mimoMode ? "" : "none";
        });
      }

      function bindBailianEndpointDefaults() {
        const bailianServiceSelect = document.querySelector('[data-plugin-field="currentPreset.bailian.service"]');
        const bailianEndpointInput = document.querySelector('[data-plugin-field="currentPreset.bailian.endpoint"]');
        const bailianDefaultEndpoints = {
          qwen: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
          cosy: "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer"
        };
        bailianServiceSelect?.addEventListener("change", () => {
          if (!bailianEndpointInput) return;
          const next = bailianServiceSelect.value === "cosy" ? "cosy" : "qwen";
          const current = bailianEndpointInput.value || "";
          if (!current || current === bailianDefaultEndpoints.qwen || current === bailianDefaultEndpoints.cosy) {
            bailianEndpointInput.value = bailianDefaultEndpoints[next];
          }
        });
      }
`;
}
