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

          const modelEditSelect = document.querySelector('[data-plugin-field="editPresetName"]');
          modelEditSelect?.addEventListener("change", () => {
            const preset = (config.presets || {})[modelEditSelect.value] || {};
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
            setPluginFieldValue("currentPreset.bailian.mode", bailian.mode || "server_commit");
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
          });

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
      };
`;
}
