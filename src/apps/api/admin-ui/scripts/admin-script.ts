import { renderFeishuPluginScript } from "../plugins/feishu-script.js";
import { renderWechatPluginScript } from "../plugins/wechat-script.js";
import { renderPromptsScript } from "../tabs/prompts-script.js";
import { renderShellsScript } from "../tabs/shells-script.js";
import { renderPluginsScript } from "../tabs/plugins-script.js";
import { renderMemoryScript } from "../tabs/memory-script.js";
import { renderLlmChainScript } from "../tabs/llm-chain-script.js";
import { renderAdminSidebarScript } from "../sidebar-script.js";
import { renderToolPreviewScript } from "../tabs/tool-preview-script.js";
import { renderTokenUsageScript } from "../tabs/token-usage-script.js";
import { renderInitiatedBehaviorsScript } from "../tabs/initiated-behaviors-script.js";
import { renderAdminTerminalScript } from "../terminal-script.js";
import { renderGenericPluginConfigScript } from "../plugins/generic-config-script.js";
import { renderPhotoPluginScript } from "../plugins/photo-script.js";
import { renderTtsPluginScript } from "../plugins/tts-script.js";
import { renderWorldWandererPluginScript } from "../plugins/world-wanderer-script.js";
import { renderDomScript } from "../shared/dom-script.js";
import { renderImageUploadScript } from "../shared/image-upload-script.js";
import { renderPromptLayerScript } from "../shared/prompt-layer-script.js";

export function renderAdminScript(): string {
  return `      const $ = (id) => document.getElementById(id);
${renderDomScript()}
${renderPromptLayerScript()}
${renderImageUploadScript()}
${renderGenericPluginConfigScript()}
${renderWorldWandererPluginScript()}
${renderPhotoPluginScript()}
${renderTtsPluginScript()}
${renderInitiatedBehaviorsScript()}
${renderAdminTerminalScript()}
${renderTokenUsageScript()}
${renderToolPreviewScript()}
${renderPluginsScript()}
${renderLlmChainScript()}
${renderMemoryScript()}
${renderShellsScript()}
${renderAdminSidebarScript()}
${renderFeishuPluginScript()}
${renderWechatPluginScript()}
${renderPromptsScript()}
      function setTabs(kind, name) {
        document.querySelectorAll("[data-" + kind + "-tab]").forEach((button) => button.classList.toggle("active", button.dataset[kind + "Tab"] === name));
        document.querySelectorAll(kind === "left" ? "#left-llm,#left-feishu,#left-core,#left-agent" : "#main-prompts,#main-shells,#main-llm-chain,#main-token-usage,#main-memory,#main-plugins,#main-initiated-behaviors,#main-tool-preview").forEach((pane) => pane.classList.remove("active"));
        $(kind === "left" ? "left-" + name : "main-" + name).classList.add("active");
      }
      document.querySelectorAll("[data-left-tab]").forEach((button) => button.addEventListener("click", () => setTabs("left", button.dataset.leftTab)));
      document.querySelectorAll("[data-channel-tab]").forEach((button) => button.addEventListener("click", () => {
        document.querySelectorAll("[data-channel-tab]").forEach((tab) => tab.classList.toggle("active", tab === button));
        document.querySelectorAll("#channel-feishu,#channel-wechat").forEach((pane) => pane.classList.remove("active"));
        $("channel-" + button.dataset.channelTab).classList.add("active");
      }));
      document.querySelectorAll("[data-behavior-config]").forEach((button) => button.addEventListener("click", () => openInitiatedBehaviorConfig(button.dataset.behaviorConfig)));
      $("behaviorBack").addEventListener("click", closeInitiatedBehaviorConfig);
      $("behaviorAdd").addEventListener("click", createInitiatedBehavior);
      $("behaviorTypeFilter").addEventListener("change", renderInitiatedBehaviorList);
      $("behaviorConfigSave").addEventListener("click", saveBehaviorConfig);
      $("behaviorConfigReset").addEventListener("click", resetBehaviorConfig);
      $("behaviorLayerAdd").addEventListener("click", () => addBehaviorLayer(false));
      $("behaviorToolLayerAdd").addEventListener("click", () => addBehaviorLayer(true));
      bindBehaviorLayerEditorEvents();
      document.querySelectorAll("[data-main-tab]").forEach((button) => button.addEventListener("click", async () => {
        setTabs("main", button.dataset.mainTab);
        if (button.dataset.mainTab === "shells") await refreshShellEditor();
        if (button.dataset.mainTab === "llm-chain") await refreshLLMChain();
        if (button.dataset.mainTab === "token-usage") await refreshTokenUsage();
        if (button.dataset.mainTab === "memory") await refreshMemory();
        if (button.dataset.mainTab === "plugins") await refreshPlugins();
        if (button.dataset.mainTab === "initiated-behaviors") await refreshInitiatedBehaviors();
        if (button.dataset.mainTab === "tool-preview") await refreshToolPreviewTools();
      }));
      document.querySelectorAll("[data-terminal-tab]").forEach((button) => button.addEventListener("click", async () => {
        setTerminalTab(button.dataset.terminalTab);
        if (button.dataset.terminalTab === "active-session") await refreshActiveSessionTerminal();
      }));
      $("terminalRefresh").addEventListener("click", async () => {
        await refreshTerminal(true);
      });
      $("terminalCollapse").addEventListener("click", toggleTerminalAutoRefreshPaused);
      document.querySelector(".admin-terminal-head").addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        toggleTerminalCollapsed();
      });
      $("collapse").addEventListener("click", () => $("shell").classList.toggle("collapsed"));
      setInterval(() => {
        if (!terminalAutoRefreshPaused) refreshTerminal();
      }, 1000);

      async function refresh() {
        const config = await fetch("/admin/api/config").then((res) => res.json());
        $("config").textContent = JSON.stringify(config, null, 2);
        await refreshLLMApiPresets();
        if (!currentLLMApiPreset) clearLLMApiForm();
        $("projectUsername").value = (config.project && config.project.username) || "user";
        $("inboundDebounceMs").value = String(config.core.inboundDebounceMs ?? 1000);
        $("timezone").value = config.core.timezone || "Asia/Singapore";
        $("defaultTargetPlugin").value = config.core.defaultTargetPlugin || "auto";
        $("appearanceDescription").value = (config.coreProfile && config.coreProfile.appearanceDescription) || "";
        $("librarySetting").value = (config.coreProfile && config.coreProfile.librarySetting) || "";
        $("coreProfilePreview").textContent = JSON.stringify(config.coreVariables || {
          appearance: (config.coreProfile && config.coreProfile.appearanceDescription) || "",
          library: { content: (config.coreProfile && config.coreProfile.librarySetting) || "" }
        }, null, 2);
        await refreshAgentState();
        $("feishuEnabled").checked = Boolean(config.plugins.feishu.enabled);
        $("feishuConnectionMode").value = config.plugins.feishu.connectionMode || "";
        $("feishuRequireMention").checked = Boolean(config.plugins.feishu.requireMention);
        renderFeishuAccounts(config.plugins.feishu.accounts);
        $("feishu-status").textContent = config.plugins.feishu.runtimeStarted ? "Feishu runtime started." : "Feishu runtime stopped.";
        $("wechatEnabled").checked = Boolean(config.plugins.wechat && config.plugins.wechat.enabled);
        $("wechatBaseURL").value = (config.plugins.wechat && config.plugins.wechat.baseURL) || "";
        $("wechatPollTimeoutMs").value = String((config.plugins.wechat && config.plugins.wechat.pollTimeoutMs) || 35000);
        $("wechat-status").textContent = config.plugins.wechat && config.plugins.wechat.runtimeStarted
          ? "WeChat runtime started."
          : config.plugins.wechat && config.plugins.wechat.loggedIn
            ? "WeChat logged in, runtime stopped."
            : "WeChat not logged in.";
        $("wechat-contacts").textContent = JSON.stringify((config.plugins.wechat && config.plugins.wechat.contacts) || [], null, 2);

        await refreshPromptProfile();
        await refreshShellEditor();
        await refreshRuntimeStatus();
        const pairings = await fetch("/admin/api/plugins/feishu/pairings").then((res) => res.json());
        $("pairings").textContent = JSON.stringify(pairings.contacts, null, 2);
        await refreshLLMRequests();
        await refreshTokenUsage();
        await refreshTerminal();
      }

      $("toolPreviewSelect").addEventListener("change", () => renderToolPreviewDefaultInput(true));
      $("tool-preview-reset").addEventListener("click", () => renderToolPreviewDefaultInput(true));
      $("tool-preview-run").addEventListener("click", runToolPreview);
      $("tokenUsageRange").addEventListener("change", refreshTokenUsage);
      $("tokenUsageBucket").addEventListener("change", refreshTokenUsage);
      $("tokenUsageModel").addEventListener("change", refreshTokenUsage);
      $("tokenUsageAgent").addEventListener("change", refreshTokenUsage);
      $("tokenUsageRefresh").addEventListener("click", refreshTokenUsage);
      $("pluginBack").addEventListener("click", closePluginConfig);
      $("pluginSearch").addEventListener("input", refreshPlugins);
      $("pluginGrid").addEventListener("click", async (event) => {
        const configButton = event.target.closest("[data-plugin-config]");
        if (configButton && !configButton.disabled) {
          await openPluginConfig(configButton.dataset.pluginConfig);
          return;
        }
        const reloadButton = event.target.closest("[data-plugin-reload]");
        if (reloadButton && !reloadButton.disabled) {
          const pluginId = reloadButton.dataset.pluginReload;
          const result = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/reload", { method: "POST" }).then((res) => res.json());
          $("plugin-status").textContent = result.ok ? pluginId + " reloaded." : "Reload failed: " + (result.error || "unknown error");
          await refreshPlugins();
        }
      });
      $("pluginGrid").addEventListener("change", async (event) => {
        const input = event.target.closest("[data-plugin-switch]");
        if (!input || input.disabled) return;
        const pluginId = input.dataset.pluginSwitch;
        const action = input.checked ? "enable" : "disable";
        const result = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/" + action, { method: "POST" }).then((res) => res.json());
        $("plugin-status").textContent = result.ok ? pluginId + " " + action + "d." : "Switch failed: " + (result.error || "unknown error");
        await refreshPlugins();
      });
      $("tool-view").addEventListener("click", async () => runMessagingTool(activeMessagingToolPath("view"), {}));
      $("tool-search").addEventListener("click", async () => runMessagingTool(activeMessagingToolPath("search"), { content: $("toolSearchContent").value, direction: $("toolSearchDirection").value || "backward" }));
      $("tool-send").addEventListener("click", async () => runMessagingTool(activeMessagingToolPath("send"), { type: $("toolSendType").value || "message", content: $("toolSendContent").value }));
      refresh();`;
}
