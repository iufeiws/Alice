import { test } from "node:test";
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
