import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { renderGenericPluginConfigScript } from "../../../../src/apps/api/admin-ui/plugins/generic-config-script.js";
import { renderTtsPluginScript } from "../../../../src/apps/api/admin-ui/plugins/tts-script.js";
import { renderDomScript } from "../../../../src/apps/api/admin-ui/shared/dom-script.js";
import { renderPluginsScript } from "../../../../src/apps/api/admin-ui/tabs/plugins-script.js";
import { assertIncludesAll, renderAdminHtml } from "./admin-html-helpers.js";

test("pluginList_initialRender_exposesPluginManagement", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "<h2>Plugin</h2>",
    "Manage local plugins and their runtime switches.",
    "Search plugins",
    "Plugin Config",
    "Choose a plugin to configure."
  ]);
});

test("pluginConfig_schemaRender_exposesConfigActions", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "Configure",
    "Save",
    "Reload",
    "Load Events",
    "Route",
    "Runtime Access",
    "Recent Events",
    "No events loaded.",
    "No plugin events yet."
  ]);
});

test("pluginConfig_testSchema_exposesTestInputsAndResults", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "Input",
    "Audio",
    "Run test",
    "No test run yet.",
    "Test failed: ",
    "Output:",
    "Transcription:",
    "Voice:",
    "Timing:",
    "/admin/api/plugins/\" + encodeURIComponent(pluginId) + \"/test"
  ]);
});

test("pluginConfig_saveContract_usesPluginConfigEndpointsAndStatuses", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "/admin/api/plugins/\" + encodeURIComponent(pluginId) + \"/config",
    "/admin/api/plugins/\" + encodeURIComponent(pluginId) + \"/reload",
    "/admin/api/plugins/\" + encodeURIComponent(pluginId) + \"/events",
    "/admin/api/plugins/\" + encodeURIComponent(pluginId) + \"/assets/\"",
    "Saving plugin config...",
    "Save failed: ",
    " config saved.",
    "Restart required."
  ]);
});

test("pluginConfig_ttsUsesDedicatedPresetRenderer", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "pluginConfigRenderers.tts = renderTtsPluginConfig",
    "ttsRuntimeForm",
    "ttsPresetEditor",
    "tts-provider-panel",
    "Save Runtime Settings",
    "Reload TTS Plugin",
    "Show TTS Event Log",
    "Save TTS Preset",
    "Copy Preset",
    "copyPresetName",
    "Enter a new preset name before copying.",
    "Save the new preset before uploading assets."
  ]);
  assert.equal(html.includes("Set Active"), false);
  assert.equal(html.includes("Use This Preset"), false);
});

test("pluginConfig_ttsPresetSwitchUpdatesGenieFileFields", () => {
  const fields = new Map<string, FakeInput>();
  const currentLabels = new Map<string, { textContent: string }>();
  for (const name of [
    "currentPreset.provider",
    "currentPreset.genie.modelDir",
    "currentPreset.genie.referenceAudio",
    "currentPreset.genie.referenceText",
    "newPresetName"
  ]) {
    fields.set(name, fakeInput(name.endsWith(".modelDir") || name.endsWith(".referenceAudio") ? "file" : "text"));
    currentLabels.set(name, { textContent: "" });
  }
  const panels = [
    { dataset: { ttsProviderPanel: "genie" }, style: { display: "none" } },
    { dataset: { ttsProviderPanel: "mimo" }, style: { display: "" } }
  ];
  const context = {
    pluginConfigRenderers: {},
    cssEscape: (value: string) => value,
    document: {
      querySelector(selector: string) {
        const field = selector.match(/data-plugin-field="([^"]+)"/)?.[1];
        if (field) return fields.get(field) ?? null;
        const current = selector.match(/data-plugin-current-field="([^"]+)"/)?.[1];
        return current ? currentLabels.get(current) ?? null : null;
      },
      querySelectorAll(selector: string) {
        return selector === "[data-tts-provider-panel]" ? panels : [];
      }
    }
  };
  vm.runInNewContext(renderPluginsScript() + renderTtsPluginScript(), context);

  (context as unknown as { applyTtsPresetToForm: (config: unknown, presetName: string) => void }).applyTtsPresetToForm({
    presets: {
      "genie-jp": {
        provider: "genie",
        genie: {
          enabled: true,
          language: "jp",
          modelDir: "assets/tts/preset/genie-jp/model",
          referenceAudio: "assets/tts/preset/genie-jp/reference.wav",
          referenceText: "hello"
        }
      }
    }
  }, "genie-jp");

  assert.equal(fields.get("currentPreset.provider")?.value, "genie");
  assert.equal(fields.get("currentPreset.genie.referenceText")?.value, "hello");
  assert.equal(currentLabels.get("currentPreset.genie.modelDir")?.textContent, "Current: assets/tts/preset/genie-jp/model");
  assert.equal(currentLabels.get("currentPreset.genie.referenceAudio")?.textContent, "Current: assets/tts/preset/genie-jp/reference.wav");
  assert.equal(panels[0].style.display, "");
  assert.equal(panels[1].style.display, "none");
});

test("pluginConfig_uploadKeepsCurrentEditorPreset", async () => {
  let reopenedPluginId = "";
  const currentLabel = { textContent: "" };
  const uploadInput = {
    dataset: { pluginUpload: "reference-audio", pluginField: "currentPreset.genie.referenceAudio" },
    files: [{ name: "voice.wav", type: "audio/wav" }],
    value: "",
    type: "file"
  };
  const fields = new Map<string, unknown>([
    ["newPresetName", { value: "" }],
    ["editPresetName", { value: "genie-copy" }],
    ["activePresetName", { value: "genie-jp" }],
    ["currentPreset.genie.referenceAudio", uploadInput]
  ]);
  const status = { textContent: "" };
  const form = { dataset: { pluginId: "tts" } };
  const context = {
    console,
    pluginConfigRenderers: {},
    pluginConfigExtras: {},
    $: (id: string) => id === "pluginConfigForm" ? form : id === "plugin-status" ? status : null,
    pluginAssetBodyForUpload: async (_pluginId: string, _assetKey: string, file: unknown) => file,
    fetch: async () => ({
      json: async () => ({
        ok: true,
        assetPath: "assets/tts/preset/genie-copy/reference.wav",
        configValue: {
          editPresetName: "genie-copy",
          activePresetName: "genie-jp",
          currentPreset: {
            genie: {
              referenceAudio: "assets/tts/preset/genie-copy/reference.wav"
            }
          }
        }
      })
    }),
    document: {
      querySelector(selector: string) {
        const field = selector.match(/data-plugin-field="([^"]+)"/)?.[1];
        if (field) return fields.get(field) ?? null;
        const current = selector.match(/data-plugin-current-field="([^"]+)"/)?.[1];
        return current === "currentPreset.genie.referenceAudio" ? currentLabel : null;
      },
      querySelectorAll() {
        return [];
      }
    }
  };
  vm.runInNewContext(renderDomScript() + renderGenericPluginConfigScript() + renderPluginsScript(), context);
  (context as unknown as { openPluginConfig: (pluginId: string) => Promise<void> }).openPluginConfig = async (pluginId: string) => {
    reopenedPluginId = pluginId;
  };

  await (context as unknown as { uploadPluginAsset: (event: unknown) => Promise<void> }).uploadPluginAsset({ currentTarget: uploadInput });

  assert.equal(reopenedPluginId, "");
  assert.equal(status.textContent, "Asset uploaded.");
  assert.equal(currentLabel.textContent, "Current: assets/tts/preset/genie-copy/reference.wav");
});

type FakeInput = {
  type: string;
  checked: boolean;
  value: string;
};

function fakeInput(type: string): FakeInput {
  let value = "";
  return {
    type,
    checked: false,
    get value() {
      return value;
    },
    set value(next) {
      if (type === "file" && next) throw new Error("file input value must not be set");
      value = String(next ?? "");
    }
  };
}
