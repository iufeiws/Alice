import { defaultVoiceCallConfigResponse } from "./voice-call-contract.js";
import { renderVoiceCallClientScript } from "./voice-call-html-client-script.js";
import { renderVoiceCallMarkup } from "./voice-call-html-markup.js";
import { renderVoiceCallStyle } from "./voice-call-html-style.js";

export function renderVoiceCallHtml(): string {
  const config = defaultVoiceCallConfigResponse();
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Alice Voice Call</title>
  <style>
${renderVoiceCallStyle(config)}
  </style>
</head>
<body>
${renderVoiceCallMarkup(config)}
  <script type="module">
${renderVoiceCallClientScript(config)}
  </script>
</body>
</html>`;
}
