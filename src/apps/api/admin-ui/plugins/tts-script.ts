export function renderTtsPluginScript(): string {
  return `      pluginConfigRenderers.tts = renderTtsPluginConfig;

      function renderTtsPluginConfig(payload) {
        const config = payload.configValue || {};
        const fields = (payload.configSchema && payload.configSchema.fields) || [];
        const apiPresets = payload.apiPresets || [];
        const field = (key) => fields.find((item) => item.key === key);
        const render = (key) => field(key) ? renderPluginFieldContainer(field(key), config, apiPresets) : "";
        $("pluginConfigBody").innerHTML = \`
          <form id="pluginConfigForm" class="plugin-config-sections" data-plugin-id="\${escapeAttr(payload.plugin.id)}" data-plugin-save-mode="section">
            <section class="plugin-config-section" data-plugin-config-section="translation">
              <div class="plugin-section-head">
                <h2>Translation</h2>
              </div>
              <div class="plugin-preset-row">
                \${render("translationEditPresetName")}
                <button type="button" class="secondary" data-plugin-preset-toggle="translation">Modify</button>
              </div>
              <div class="plugin-preset-editor" data-plugin-preset-editor="translation">
                \${render("newTranslationPresetName")}
                \${render("currentTranslation.apiPresetName")}
                \${render("currentTranslation.prompt")}
              </div>
              <div class="prompt-actions">
                <button type="button" data-plugin-section-save="translation">Save Translation Preset</button>
              </div>
            </section>
            <section class="plugin-config-section" data-plugin-config-section="model-genie" data-plugin-conversion-panel="genie">
              <div class="plugin-section-head">
                <h2>Model / Conversion / Genie</h2>
              </div>
              <div class="plugin-public-grid">
                \${render("conversion.genie.enabled")}
                \${render("conversion.genie.baseURL")}
              </div>
              <div class="plugin-preset-row">
                \${render("voice.modelEditPresetName")}
                <button type="button" class="secondary" data-plugin-preset-toggle="model">Modify</button>
              </div>
              <div class="plugin-preset-editor" data-plugin-preset-editor="model">
                \${render("voice.newModelConfigName")}
                \${render("voice.currentModel.language")}
                \${render("voice.currentModel.modelDir")}
                \${render("voice.currentModel.referenceAudio")}
                \${render("voice.currentModel.referenceText")}
                \${render("voice.currentModel.speed")}
                \${render("voice.currentModel.splitText")}
                \${render("voice.currentModel.partSilenceSeconds")}
              </div>
              <div class="prompt-actions">
                <button type="button" data-plugin-section-save="model-genie">Save Genie Settings</button>
              </div>
            </section>
            <section class="plugin-config-section" data-plugin-config-section="conversion-openai-api" data-plugin-conversion-panel="openai-api">
              <div class="plugin-section-head"><h2>Conversion / OpenAI-API</h2></div>
              <div class="plugin-public-grid">
                \${render("conversion.openaiApi.apiPresetName")}
                \${render("conversion.openaiApi.model")}
                \${render("conversion.openaiApi.voice")}
                \${render("conversion.openaiApi.timeoutMs")}
                \${render("conversion.openaiApi.sampleRate")}
                \${render("conversion.openaiApi.channels")}
                \${render("conversion.openaiApi.extraParamsJson")}
              </div>
              <div class="prompt-actions">
                <button type="button" data-plugin-section-save="conversion-openai-api">Save OpenAI-API Conversion</button>
              </div>
            </section>
            <section class="plugin-config-section" data-plugin-config-section="conversion-bailian" data-plugin-conversion-panel="bailian">
              <div class="plugin-section-head"><h2>Conversion / Bailian</h2></div>
              <div class="plugin-public-grid">
                \${render("conversion.bailian.service")}
                \${render("conversion.bailian.endpoint")}
                \${render("conversion.bailian.apiKey")}
                \${render("conversion.bailian.apiKeyEnv")}
                \${render("conversion.bailian.workspaceId")}
                \${render("conversion.bailian.userAgent")}
                \${render("conversion.bailian.model")}
                \${render("conversion.bailian.voice")}
                \${render("conversion.bailian.languageType")}
                \${render("conversion.bailian.mode")}
                \${render("conversion.bailian.responseFormat")}
                \${render("conversion.bailian.timeoutMs")}
                \${render("conversion.bailian.sampleRate")}
                \${render("conversion.bailian.channels")}
                \${render("conversion.bailian.extraParamsJson")}
              </div>
              <div class="prompt-actions">
                <button type="button" data-plugin-section-save="conversion-bailian">Save Bailian Conversion</button>
              </div>
            </section>
            <section class="plugin-config-section" data-plugin-config-section="common">
              <div class="plugin-section-head"><h2>Common</h2></div>
              <div class="plugin-public-grid">
                \${render("translationPresetName")}
                \${render("voice.modelConfigName")}
                \${render("conversion.provider")}
                \${render("currentTranslation.translationEnabled")}
                \${render("enabled")}
                \${render("targetRoute")}
                \${render("persistTranslation")}
              </div>
              <div class="prompt-actions">
                <button type="button" data-plugin-section-save="common">Save Common Settings</button>
              </div>
            </section>
            <div class="prompt-actions">
              <button type="button" id="pluginConfigReload" class="secondary">Reload</button>
              <button type="button" id="pluginConfigLogs" class="secondary">Load Events</button>
            </div>
          </form>
          <h2>Route</h2>
          <pre>\${escapeHtml((payload.routePreview || []).join("\\n"))}</pre>
          <h2>Runtime Access</h2>
          <pre>\${escapeHtml((payload.runtimeAccess || []).join("\\n"))}</pre>
          \${payload.testSchema ? renderPluginTestBox(payload) : ""}
          <h2>Recent Events</h2>
          <div id="pluginEvents" class="logs plugin-events">No events loaded.</div>
        \`;
        bindPluginConfigForm();
        document.querySelectorAll("[data-plugin-preset-toggle]").forEach((button) => {
          button.addEventListener("click", () => {
            const key = button.dataset.pluginPresetToggle;
            const editor = document.querySelector('[data-plugin-preset-editor="' + cssEscape(key) + '"]');
            editor?.classList.toggle("active");
            button.textContent = editor?.classList.contains("active") ? "Hide" : "Modify";
          });
        });
        const translationEditSelect = document.querySelector('[data-plugin-field="translationEditPresetName"]');
        if (translationEditSelect) {
          translationEditSelect.addEventListener("change", () => {
            const preset = (config.translationPresets || {})[translationEditSelect.value] || {};
            setPluginFieldValue("currentTranslation.translationEnabled", preset.translationEnabled ?? true);
            setPluginFieldValue("currentTranslation.apiPresetName", preset.apiPresetName || "");
            setPluginFieldValue("currentTranslation.prompt", preset.prompt || "");
            setPluginFieldValue("newTranslationPresetName", "");
          });
        }
        const modelEditSelect = document.querySelector('[data-plugin-field="voice.modelEditPresetName"]');
        if (modelEditSelect) {
          modelEditSelect.addEventListener("change", () => {
            const preset = ((config.voice || {}).modelConfigs || {})[modelEditSelect.value] || {};
            setPluginFieldValue("voice.currentModel.language", preset.language || "jp");
            setPluginFieldValue("voice.currentModel.speed", preset.speed ?? "");
            setPluginFieldValue("voice.currentModel.splitText", preset.splitText ?? false);
            setPluginFieldValue("voice.currentModel.partSilenceSeconds", preset.partSilenceSeconds ?? "");
            setPluginFieldValue("voice.currentModel.referenceText", "");
            setPluginFieldValue("voice.newModelConfigName", "");
          });
        }
        const conversionProviderSelect = document.querySelector('[data-plugin-field="conversion.provider"]');
        const applyConversionPanel = () => {
          const provider = conversionProviderSelect?.value || "genie";
          document.querySelectorAll("[data-plugin-conversion-panel]").forEach((node) => {
            node.style.display = node.dataset.pluginConversionPanel === provider ? "" : "none";
          });
        };
        conversionProviderSelect?.addEventListener("change", applyConversionPanel);
        applyConversionPanel();
        const bailianServiceSelect = document.querySelector('[data-plugin-field="conversion.bailian.service"]');
        const bailianEndpointInput = document.querySelector('[data-plugin-field="conversion.bailian.endpoint"]');
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
