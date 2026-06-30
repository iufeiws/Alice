export function renderTtsPluginScript(): string {
  return `      pluginConfigExtras.tts = {
        afterRender(payload) {
          const config = payload.configValue || {};
          const translationEditSelect = document.querySelector('[data-plugin-field="translationEditPresetName"]');
          translationEditSelect?.addEventListener("change", () => {
            const preset = (config.translationPresets || {})[translationEditSelect.value] || {};
            setPluginFieldValue("currentTranslation.translationEnabled", preset.translationEnabled ?? true);
            setPluginFieldValue("currentTranslation.apiPresetName", preset.apiPresetName || "");
            setPluginFieldValue("currentTranslation.prompt", preset.prompt || "");
            setPluginFieldValue("newTranslationPresetName", "");
          });

          const modelEditSelect = document.querySelector('[data-plugin-field="voice.modelEditPresetName"]');
          modelEditSelect?.addEventListener("change", () => {
            const preset = ((config.voice || {}).modelConfigs || {})[modelEditSelect.value] || {};
            setPluginFieldValue("voice.currentModel.language", preset.language || "jp");
            setPluginFieldValue("voice.currentModel.speed", preset.speed ?? "");
            setPluginFieldValue("voice.currentModel.splitText", preset.splitText ?? false);
            setPluginFieldValue("voice.currentModel.partSilenceSeconds", preset.partSilenceSeconds ?? "");
            setPluginFieldValue("voice.currentModel.referenceText", "");
            setPluginFieldValue("voice.newModelConfigName", "");
          });

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
      };
`;
}
