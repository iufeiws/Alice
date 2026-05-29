export function renderAdminHtmlV2(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Alice Admin</title>
    <style>
      :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; background: #f5f6f8; color: #17202a; }
      .shell { display: grid; grid-template-columns: 360px 1fr; min-height: 100vh; }
      .shell.collapsed { grid-template-columns: 48px 1fr; }
      aside { border-right: 1px solid #d7dce3; background: #fff; min-width: 0; overflow: auto; }
      .collapsed aside .panel-body, .collapsed aside .tabbar, .collapsed aside h1 { display: none; }
      .side-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid #e2e6eb; }
      h1 { font-size: 18px; margin: 0; }
      main { min-width: 0; padding: 18px 22px; }
      .tabbar { display: flex; gap: 8px; padding: 12px 16px 0; }
      .main-tabs { padding: 0 0 14px; }
      .tab { border: 1px solid #c8d0da; background: #fff; color: #17202a; border-radius: 6px; padding: 8px 10px; font-weight: 700; cursor: pointer; }
      .tab.active { background: #2563eb; color: #fff; border-color: #2563eb; }
      .subtabs { display: flex; gap: 8px; margin: 0 0 14px; }
      .panel-body { padding: 14px 16px 20px; }
      .pane { display: none; }
      .pane.active { display: block; }
      .qr-box { width: 220px; min-height: 220px; border: 1px solid #d7dce3; border-radius: 8px; display: grid; place-items: center; background: #f8fafc; margin-top: 10px; overflow: hidden; }
      .qr-box img { max-width: 100%; max-height: 100%; object-fit: contain; }
      section { background: #fff; border: 1px solid #d7dce3; border-radius: 8px; padding: 16px; }
      h2 { font-size: 15px; margin: 0 0 14px; }
      label { display: block; font-size: 12px; font-weight: 700; margin: 12px 0 6px; }
      input, textarea, select { box-sizing: border-box; width: 100%; border: 1px solid #c4cad2; border-radius: 6px; padding: 9px 10px; font: inherit; background: #fff; color: #17202a; }
      textarea { resize: vertical; }
      audio { width: 100%; margin-top: 10px; }
      button { border: 0; border-radius: 6px; background: #2563eb; color: #fff; padding: 9px 12px; font-weight: 700; cursor: pointer; margin: 10px 8px 0 0; }
      button.secondary { background: #475467; }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f1f3f5; border-radius: 6px; padding: 12px; font-size: 12px; }
      .muted { color: #667085; font-size: 12px; }
      .list { display: grid; gap: 10px; }
      .item { border-bottom: 1px solid #e4e7eb; padding: 10px 0; }
      .item strong { display: block; font-size: 13px; }
      .row { display: grid; grid-template-columns: 1fr 120px 90px; gap: 8px; align-items: end; }
      .prompt-layer { border-bottom: 1px solid #e4e7eb; padding: 12px 0; }
      .prompt-layer summary { cursor: pointer; font-weight: 800; padding: 6px 0; }
      .prompt-layer summary span { color: #667085; font-weight: 700; margin-left: 8px; }
      .prompt-layer[open] summary { margin-bottom: 8px; }
      .prompt-actions { display: flex; gap: 6px; flex-wrap: wrap; }
      .prompt-actions button { margin-top: 6px; }
      .shell-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; align-items: start; }
      .shell-category-outfits { grid-column: 1 / -1; }
      .shell-option { border-bottom: 1px solid #e4e7eb; padding: 10px 0; }
      .shell-option summary { display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: 800; padding: 6px 0; }
      .shell-option summary .shell-title { flex: 1; min-width: 0; overflow-wrap: anywhere; }
      .shell-option summary .shell-save { margin-left: auto; }
      .shell-marker { color: #667085; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
      .shell-option summary button { margin: 0; padding: 5px 8px; }
      .shell-option textarea { min-height: 110px; }
      .shell-image-preview { margin-top: 10px; max-width: 220px; max-height: 160px; border: 1px solid #d7dce3; border-radius: 6px; object-fit: contain; background: #f8fafc; display: block; }
      .shell-image-preview.hidden { display: none; }
      .shell-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .logs { max-height: calc(100vh - 150px); overflow: auto; background: #111827; color: #e5e7eb; border-radius: 6px; padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
      .llm-split { display: grid; grid-template-rows: minmax(280px, 1fr) minmax(280px, 1fr); gap: 12px; height: calc(100vh - 145px); }
      .llm-window { min-height: 0; display: grid; grid-template-rows: auto 1fr; gap: 8px; }
      .llm-window h2 { margin: 0; }
      .llm-window .logs { max-height: none; min-height: 0; }
      .tool-preview-grid { display: grid; grid-template-columns: minmax(220px, 320px) 1fr; gap: 14px; align-items: start; }
      .tool-preview-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .log-line { border-bottom: 1px solid #243041; padding: 5px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
      .log-info { color: #d1d5db; } .log-warn { color: #fbbf24; } .log-error { color: #fca5a5; }
      @media (max-width: 900px) { .shell { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid #d7dce3; } .tool-preview-grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <div id="shell" class="shell">
      <aside>
        <div class="side-head">
          <h1>Alice Admin</h1>
          <button id="collapse" class="secondary" type="button">≡</button>
        </div>
        <div class="tabbar">
          <button class="tab active" data-left-tab="llm" type="button">LLM Settings</button>
          <button class="tab" data-left-tab="feishu" type="button">Channel Settings</button>
          <button class="tab" data-left-tab="core" type="button">Alice Core</button>
          <button class="tab" data-left-tab="agent" type="button">Agent Settings</button>
        </div>
        <div class="panel-body">
          <div id="left-llm" class="pane active">
            <h2>LLM API</h2>
            <form id="llm-form">
              <label for="baseURL">Base URL</label>
              <input id="baseURL" name="baseURL" autocomplete="off" />
              <label for="model">Model</label>
              <input id="model" name="model" autocomplete="off" />
              <label for="apiKey">API Key</label>
              <input id="apiKey" name="apiKey" type="password" placeholder="Leave blank to keep unchanged" autocomplete="new-password" />
              <label for="temperature">Temperature</label>
              <input id="temperature" name="temperature" inputmode="decimal" />
              <label for="timeoutMs">Timeout Ms</label>
              <input id="timeoutMs" name="timeoutMs" inputmode="numeric" />
              <label><input id="streamEnabled" name="stream" type="checkbox" /> Streaming</label>
              <label for="extraParams">Extra Params JSON</label>
              <textarea id="extraParams" name="extraParams" rows="6" spellcheck="false">{}</textarea>
              <label for="followupExtraParams">Follow-up Extra Params JSON</label>
              <textarea id="followupExtraParams" name="followupExtraParams" rows="6" spellcheck="false">{}</textarea>
              <p class="muted">First-call params apply to the first LLM request in a session; follow-up params apply to later tool-result requests. Object-body fragments are also accepted. For streaming token usage, include "stream_options":{"include_usage":true}.</p>
              <button type="submit">Save</button>
              <p class="muted" id="save-status"></p>
            </form>
            <h2>Runtime</h2>
            <pre id="config">Loading...</pre>
          </div>
          <div id="left-feishu" class="pane">
            <div class="subtabs">
              <button class="tab active" data-channel-tab="feishu" type="button">Feishu</button>
              <button class="tab" data-channel-tab="wechat" type="button">WeChat</button>
            </div>
            <div id="channel-feishu" class="pane active">
              <h2>Feishu</h2>
              <form id="feishu-form">
                <label><input id="feishuEnabled" name="enabled" type="checkbox" /> Enabled</label>
                <label for="feishuConnectionMode">Connection Mode</label>
                <input id="feishuConnectionMode" name="connectionMode" autocomplete="off" />
                <label for="feishuAppId">App ID</label>
                <input id="feishuAppId" name="appId" autocomplete="off" />
                <label for="feishuAppSecret">App Secret</label>
                <input id="feishuAppSecret" name="appSecret" type="password" placeholder="Leave blank to keep unchanged" autocomplete="new-password" />
                <label><input id="feishuRequireMention" name="requireMention" type="checkbox" /> Require mention in groups</label>
                <button type="submit">Save</button>
                <button type="button" id="feishu-start">Start</button>
                <button type="button" id="feishu-stop" class="secondary">Stop</button>
                <p class="muted" id="feishu-status"></p>
              </form>
              <h2>Send Test</h2>
            <label for="testMarkdown">Markdown</label>
            <textarea id="testMarkdown" rows="5">**Alice markdown test**

- item one
- item two

\`code\`</textarea>
              <button type="button" id="send-test-markdown">Send Markdown</button>
              <label for="testImagePath">Image Local Path</label>
              <input id="testImagePath" autocomplete="off" value="/home/wyf98/Alice/assets/test.png" />
              <button type="button" id="send-test-image">Send Image</button>
              <label for="testAudioPath">Audio Local Path</label>
              <input id="testAudioPath" autocomplete="off" value="/home/wyf98/Alice/assets/test.opus" />
              <button type="button" id="send-test-audio">Send Audio</button>
              <p class="muted" id="send-test-status"></p>
            </div>
            <div id="channel-wechat" class="pane">
              <h2>WeChat</h2>
              <form id="wechat-form">
                <label><input id="wechatEnabled" name="enabled" type="checkbox" /> Enabled</label>
                <label for="wechatBaseURL">iLink Base URL</label>
                <input id="wechatBaseURL" name="baseURL" autocomplete="off" />
                <label for="wechatPollTimeoutMs">Poll Timeout Ms</label>
                <input id="wechatPollTimeoutMs" name="pollTimeoutMs" inputmode="numeric" />
                <button type="submit">Save</button>
                <button type="button" id="wechat-login">Get Login QR</button>
                <button type="button" id="wechat-start">Start</button>
                <button type="button" id="wechat-stop" class="secondary">Stop</button>
                <p class="muted" id="wechat-status"></p>
              </form>
              <div id="wechat-qr" class="qr-box"><span class="muted">No QR code</span></div>
              <p class="muted" id="wechat-login-status"></p>
              <pre id="wechat-contacts">[]</pre>
            </div>
            <h2>Messaging Tools</h2>
            <button type="button" id="tool-view">View Messages</button>
            <label for="toolSearchContent">Search Content</label>
            <input id="toolSearchContent" autocomplete="off" />
            <label for="toolSearchDirection">Search Direction</label>
            <input id="toolSearchDirection" autocomplete="off" value="backward" />
            <button type="button" id="tool-search">Search Messages</button>
            <label for="toolSendType">Send Type</label>
            <input id="toolSendType" autocomplete="off" value="message" />
            <label for="toolSendContent">Send Content</label>
            <textarea id="toolSendContent" rows="4"></textarea>
            <button type="button" id="tool-send">Send Message</button>
            <pre id="tool-result">No tool run yet.</pre>
            <h2>Unique Bound Contact</h2>
            <pre id="pairings">Loading...</pre>
          </div>
          <div id="left-core" class="pane">
            <h2>Alice Core</h2>
            <form id="core-profile-form">
              <label for="appearanceDescription">Appearance Description</label>
              <textarea id="appearanceDescription" name="appearanceDescription" rows="12" spellcheck="false"></textarea>
              <button type="submit">Save Core Profile</button>
              <p class="muted" id="core-profile-status"></p>
            </form>
            <h2>Voice Sample</h2>
            <p class="muted" id="tts-reference-status">Loading...</p>
            <label for="ttsReferenceAudio">Reference Audio</label>
            <input id="ttsReferenceAudio" type="file" accept="audio/wav,audio/mpeg,audio/mp4,.wav,.mp3,.m4a" />
            <button type="button" id="tts-upload-reference">Upload Voice Sample</button>
            <label for="ttsPreviewText">Preview Text</label>
            <textarea id="ttsPreviewText" rows="3">你好，我是 Alice。今天也想听你多说一点。</textarea>
            <button type="button" id="tts-generate-preview">Generate Preview</button>
            <audio id="ttsPreviewAudio" controls></audio>
            <p class="muted" id="tts-preview-status"></p>
            <h2>Variables</h2>
            <pre id="coreProfilePreview">Loading...</pre>
          </div>
          <div id="left-agent" class="pane">
            <h2>Agent</h2>
            <form id="agent-form">
              <label for="inboundDebounceMs">Message Wait Ms</label>
              <input id="inboundDebounceMs" name="inboundDebounceMs" inputmode="numeric" />
              <label for="timezone">Timezone</label>
              <input id="timezone" name="timezone" autocomplete="off" />
              <label for="defaultTargetPlugin">Default Target Plugin</label>
              <select id="defaultTargetPlugin" name="defaultTargetPlugin">
                <option value="auto">auto</option>
                <option value="wechat">wechat</option>
                <option value="feishu">feishu</option>
              </select>
              <button type="submit">Save</button>
              <p class="muted" id="agent-status"></p>
            </form>
            <h2>State</h2>
            <form id="agent-state-form">
              <label for="agentStateSelect">State</label>
              <select id="agentStateSelect" name="state"></select>
              <label for="agentIntimacy">Intimacy</label>
              <input id="agentIntimacy" name="intimacy" inputmode="numeric" />
              <button type="submit">Save State</button>
              <pre id="agentStateSnapshot">Loading...</pre>
            </form>
            <h2>Runtime</h2>
            <button type="button" id="heartbeat-pause" class="secondary">Pause Heartbeat</button>
            <button type="button" id="heartbeat-resume">Resume Heartbeat</button>
            <button type="button" id="process-now">Process Now</button>
            <pre id="runtimeStatus">Loading...</pre>
          </div>
        </div>
      </aside>
      <main>
        <div class="tabbar main-tabs">
          <button class="tab active" data-main-tab="prompts" type="button">Prompt</button>
          <button class="tab" data-main-tab="shells" type="button">Shell</button>
          <button class="tab" data-main-tab="llm-request" type="button">Prompt Preview</button>
          <button class="tab" data-main-tab="llm-chain" type="button">LLM Request</button>
          <button class="tab" data-main-tab="tool-preview" type="button">Tool Preview</button>
          <button class="tab" data-main-tab="messages" type="button">Message Log</button>
          <button class="tab" data-main-tab="events" type="button">Event Log</button>
          <button class="tab" data-main-tab="system" type="button">System Log</button>
        </div>
        <section id="main-prompts" class="pane active">
          <div id="promptProfile">Loading...</div>
          <p class="muted" id="prompt-status"></p>
        </section>
        <section id="main-shells" class="pane">
          <div id="shellEditor">Loading...</div>
          <p class="muted" id="shell-status"></p>
        </section>
        <section id="main-llm-request" class="pane"><div id="llmRequests" class="logs">No LLM request yet.</div></section>
        <section id="main-llm-chain" class="pane">
          <button type="button" id="llm-chain-clear" class="secondary">Clear Active Session</button>
          <div class="llm-split">
            <div class="llm-window">
              <h2>Requests</h2>
              <div id="llmChainRequests" class="logs">No LLM request yet.</div>
            </div>
            <div class="llm-window">
              <h2>Responses</h2>
              <div id="llmChainResponses" class="logs">No LLM response yet.</div>
            </div>
          </div>
        </section>
        <section id="main-tool-preview" class="pane">
          <div class="tool-preview-grid">
            <div>
              <h2>Tool Return Preview</h2>
              <label for="toolPreviewSelect">Tool</label>
              <select id="toolPreviewSelect"></select>
              <label for="toolPreviewTarget">Target</label>
              <select id="toolPreviewTarget">
                <option value="feishu">Feishu</option>
                <option value="wechat">WeChat</option>
              </select>
              <label for="toolPreviewInput">Arguments JSON</label>
              <textarea id="toolPreviewInput" rows="12" spellcheck="false">{}</textarea>
              <div class="tool-preview-actions">
                <button type="button" id="tool-preview-run">Preview Return</button>
                <button type="button" id="tool-preview-reset" class="secondary">Reset Args</button>
              </div>
              <p class="muted" id="tool-preview-status"></p>
            </div>
            <div>
              <h2>Result</h2>
              <div id="toolPreviewResult" class="logs">Choose a tool and preview its return.</div>
            </div>
          </div>
        </section>
        <section id="main-messages" class="pane"><div id="messageLogs" class="logs">Loading...</div></section>
        <section id="main-events" class="pane"><div id="eventLogs" class="logs">Loading...</div></section>
        <section id="main-system" class="pane"><div id="logs" class="logs">Loading...</div></section>
      </main>
    </div>
    <script>
      const $ = (id) => document.getElementById(id);
      function setTabs(kind, name) {
        document.querySelectorAll("[data-" + kind + "-tab]").forEach((button) => button.classList.toggle("active", button.dataset[kind + "Tab"] === name));
        document.querySelectorAll(kind === "left" ? "#left-llm,#left-feishu,#left-core,#left-agent" : "#main-prompts,#main-shells,#main-llm-request,#main-llm-chain,#main-tool-preview,#main-messages,#main-events,#main-system").forEach((pane) => pane.classList.remove("active"));
        $(kind === "left" ? "left-" + name : "main-" + name).classList.add("active");
      }
      document.querySelectorAll("[data-left-tab]").forEach((button) => button.addEventListener("click", () => setTabs("left", button.dataset.leftTab)));
      document.querySelectorAll("[data-channel-tab]").forEach((button) => button.addEventListener("click", () => {
        document.querySelectorAll("[data-channel-tab]").forEach((tab) => tab.classList.toggle("active", tab === button));
        document.querySelectorAll("#channel-feishu,#channel-wechat").forEach((pane) => pane.classList.remove("active"));
        $("channel-" + button.dataset.channelTab).classList.add("active");
      }));
      document.querySelectorAll("[data-main-tab]").forEach((button) => button.addEventListener("click", async () => {
        setTabs("main", button.dataset.mainTab);
        if (button.dataset.mainTab === "shells") await refreshShellEditor();
        if (button.dataset.mainTab === "llm-request") await refreshLLMRequests();
        if (button.dataset.mainTab === "llm-chain") await refreshLLMChain();
        if (button.dataset.mainTab === "tool-preview") await refreshToolPreviewTools();
      }));
      $("collapse").addEventListener("click", () => $("shell").classList.toggle("collapsed"));

      async function refresh() {
        const config = await fetch("/admin/api/config").then((res) => res.json());
        $("config").textContent = JSON.stringify(config, null, 2);
        $("baseURL").value = config.llm.baseURL || "";
        $("model").value = config.llm.model || "";
        $("temperature").value = String(config.llm.temperature ?? "");
        $("timeoutMs").value = String(config.llm.timeoutMs ?? "");
        $("streamEnabled").checked = config.llm.stream !== false;
        $("extraParams").value = JSON.stringify(config.llm.extraParams || {}, null, 2);
        $("followupExtraParams").value = JSON.stringify(config.llm.followupExtraParams || {}, null, 2);
        $("inboundDebounceMs").value = String(config.core.inboundDebounceMs ?? 1000);
        $("timezone").value = config.core.timezone || "Asia/Singapore";
        $("defaultTargetPlugin").value = config.core.defaultTargetPlugin || "auto";
        $("appearanceDescription").value = (config.coreProfile && config.coreProfile.appearanceDescription) || "";
        $("coreProfilePreview").textContent = JSON.stringify({
          appearance: (config.coreProfile && config.coreProfile.appearanceDescription) || ""
        }, null, 2);
        $("tts-reference-status").textContent = "Current reference: " + ((config.tts && config.tts.mossReferenceAudio) || "assets/tts/references/alice/reference.wav");
        await refreshAgentState();
        $("feishuEnabled").checked = Boolean(config.plugins.feishu.enabled);
        $("feishuConnectionMode").value = config.plugins.feishu.connectionMode || "websocket";
        $("feishuAppId").value = config.plugins.feishu.appId || "";
        $("feishuRequireMention").checked = Boolean(config.plugins.feishu.requireMention);
        $("feishu-status").textContent = config.plugins.feishu.runtimeStarted ? "Feishu runtime started." : "Feishu runtime stopped.";
        $("wechatEnabled").checked = Boolean(config.plugins.wechat && config.plugins.wechat.enabled);
        $("wechatBaseURL").value = (config.plugins.wechat && config.plugins.wechat.baseURL) || "https://ilinkai.weixin.qq.com";
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
        await refreshLogs();
      }

      async function refreshLLMRequests() {
        const payload = await fetch("/admin/api/llm-requests").then((res) => res.json());
        const blocks = [
          renderLLMRequestBlock("Current Prompt Profile Prebuild", payload.profilePreview),
          renderLLMRequestBlock("Latest Message Context Preview", payload.messagePreview),
          renderLLMRequestBlock("Latest Actual Request", payload.actual)
        ].filter(Boolean);
        $("llmRequests").innerHTML = blocks.length ? blocks.join("") : "No LLM request preview available.";
        $("llmRequests").scrollTop = 0;
      }

      async function refreshLLMChain() {
        const [requestPayload, responsePayload] = await Promise.all([
          fetch("/admin/api/llm-requests").then((res) => res.json()),
          fetch("/admin/api/llm-responses").then((res) => res.json())
        ]);
        $("llmChainRequests").innerHTML = renderLLMRequestGroups(requestPayload.requests || [], requestPayload.activeSession, requestPayload.clearedSessions || []);
        $("llmChainResponses").innerHTML = renderLLMResponseGroups(responsePayload.responses || [], requestPayload.activeSession, requestPayload.clearedSessions || []);
        $("llmChainRequests").scrollTop = $("llmChainRequests").scrollHeight;
        $("llmChainResponses").scrollTop = $("llmChainResponses").scrollHeight;
      }

      function renderActiveLLMSession(session) {
        return \`<div class="log-line">Active session #\${escapeHtml(session.id || "")} started=\${escapeHtml(session.startedAt || "")} updated=\${escapeHtml(session.updatedAt || "")} requests=\${escapeHtml((session.requestIds || []).join(", "))}</div>\`;
      }

      function renderLLMRequestGroups(requests, activeSession, clearedSessions) {
        const active = activeSession ? renderActiveLLMSession(activeSession) : '<div class="log-line">Active session: none</div>';
        const activeRequests = activeSession ? entriesForActiveSession(requests, activeSession, "requestIds") : [];
        const activeGroup = activeSession
          ? \`<details class="log-line" open><summary>Active Session \${escapeHtml(activeSession.id || "")} · \${escapeHtml(activeRequests.length)} request(s) · \${escapeHtml(activeSession.startedAt || "")}</summary>\${activeRequests.length ? activeRequests.map((entry, index) => renderLLMRequestItem(entry, index + 1, activeRequests[index - 1])).join("") : "No active request history yet."}</details>\`
          : "";
        const archived = (clearedSessions || []).map((session) => {
          const requests = session.requests || [];
          return \`<details class="log-line"><summary>Saved Session \${escapeHtml(session.id || "")} · \${escapeHtml(requests.length)} request(s) · \${escapeHtml(session.startedAt || "")} · reason=\${escapeHtml(session.reason || "")}</summary>\${requests.map((entry, index) => renderLLMRequestItem(entry, index + 1, requests[index - 1])).join("")}<details><summary>Archived transcript</summary><pre>\${escapeHtml(JSON.stringify(session.messages || [], null, 2))}</pre></details></details>\`;
        }).join("");
        return (archived || '<div class="log-line">Saved sessions: none</div>') + active + activeGroup;
      }

      function renderLLMResponseGroups(responses, activeSession, clearedSessions) {
        const active = activeSession ? renderActiveLLMSession(activeSession) : '<div class="log-line">Active session: none</div>';
        const activeResponses = activeSession ? entriesForActiveSession(responses, activeSession, "responseIds") : [];
        const activeGroup = activeSession
          ? \`<details class="log-line" open><summary>Active Session \${escapeHtml(activeSession.id || "")} · \${escapeHtml(activeResponses.length)} response(s) · \${escapeHtml(activeSession.startedAt || "")}</summary>\${activeResponses.length ? activeResponses.map((entry, index) => renderLLMResponseItem(entry, index + 1)).join("") : "No active response history yet."}</details>\`
          : "";
        const archived = (clearedSessions || []).map((session) => {
          const responses = session.responses || [];
          return \`<details class="log-line"><summary>Saved Session \${escapeHtml(session.id || "")} · \${escapeHtml(responses.length)} response(s) · \${escapeHtml(session.startedAt || "")} · reason=\${escapeHtml(session.reason || "")}</summary>\${responses.map((entry, index) => renderLLMResponseItem(entry, index + 1)).join("")}</details>\`;
        }).join("");
        return (archived || '<div class="log-line">Saved sessions: none</div>') + active + activeGroup;
      }

      function entriesForActiveSession(entries, activeSession, idField) {
        const ids = new Set((activeSession[idField] || []).map((id) => String(id)));
        return [...entries]
          .filter((entry) => String(entry.sessionId || "") === String(activeSession.id || "") && ids.has(String(entry.id || "")))
          .sort(compareLLMEntries);
      }

      function compareLLMEntries(left, right) {
        const bySession = Number(left.sessionId ?? 0) - Number(right.sessionId ?? 0);
        if (bySession) return bySession;
        const byTime = String(left.time || "").localeCompare(String(right.time || ""));
        if (byTime) return byTime;
        return Number(left.id || 0) - Number(right.id || 0);
      }

      function renderLLMRequestItem(entry, index, previous) {
        const summaryMessages = index === 1 ? (entry.messages || []) : newMessagesSince(previous?.messages || [], entry.messages || []);
        const summary = summaryMessages.length
          ? summaryMessages.map((message, messageIndex) => \`#\${messageIndex + 1} [\${escapeHtml(message.role)}]\${message.name ? " " + escapeHtml(message.name) : ""}\${message.toolCallId ? " tool_call_id=" + escapeHtml(message.toolCallId) : ""}\\n\${escapeHtml(message.content || "")}\${message.reasoningContent ? "\\nreasoning_content\\n" + escapeHtml(message.reasoningContent) : ""}\${message.toolCalls ? "\\ntool_calls=" + escapeHtml(JSON.stringify(message.toolCalls, null, 2)) : ""}\`).join("\\n\\n")
          : "No newly appended messages.";
        return \`<details class="log-line"><summary>[\${escapeHtml(entry.time || "")}] request #\${index} global=\${escapeHtml(entry.id || "")} model=\${escapeHtml(entry.model || "")}</summary>\${summary}\\n<details><summary>raw request/response context</summary><pre>\${escapeHtml(JSON.stringify(entry.rawRequest || entry, null, 2))}</pre></details></details>\`;
      }

      function newMessagesSince(previous, current) {
        let index = 0;
        while (index < previous.length && index < current.length && JSON.stringify(previous[index]) === JSON.stringify(current[index])) index += 1;
        return current.slice(index);
      }

      function renderLLMResponseItem(entry, index) {
        return \`<details class="log-line"><summary>[\${escapeHtml(entry.time || "")}] response #\${index} global=\${escapeHtml(entry.id || "")} request=\${escapeHtml(entry.requestId || "")} finish=\${escapeHtml(entry.finishReason || "")}</summary><div># [\${escapeHtml(entry.message?.role || "")}]\\n\${escapeHtml(entry.message?.content || "")}\${entry.message?.reasoningContent ? "\\nreasoning_content\\n" + escapeHtml(entry.message.reasoningContent) : ""}\${entry.message?.toolCalls ? "\\ntool_calls=" + escapeHtml(JSON.stringify(entry.message.toolCalls, null, 2)) : ""}\\nraw json\\n\${escapeHtml(JSON.stringify({ message: entry.message, finishReason: entry.finishReason, usage: entry.usage, raw: entry.raw }, null, 2))}</div></details>\`;
      }

      function renderLLMRequestBlock(title, current) {
        if (!current) return "";
        const raw = current.rawRequest || {
          model: current.model,
          temperature: current.temperature,
          messages: current.messages,
          tools: current.tools
        };
        return \`
          <div class="log-line">== \${escapeHtml(title)} ==</div>
          <div class="log-line">[\${escapeHtml(current.time || "")}] source=\${escapeHtml(current.source || "actual")} model=\${escapeHtml(current.model || "")} temperature=\${escapeHtml(current.temperature ?? "")}\${current.conversationId ? " conversation=" + escapeHtml(current.conversationId) : ""}</div>
          \${current.tools && current.tools.length ? \`<div class="log-line">tool: feishu\\n\${escapeHtml(current.tools.map((tool) => tool.function.name).join(", "))}</div>\` : ""}
          \${(current.messages || []).map((message, index) => \`<div class="log-line">#\${index + 1} [\${escapeHtml(message.role)}]\${message.name ? " " + escapeHtml(message.name) : ""}\${message.toolCallId ? " tool_call_id=" + escapeHtml(message.toolCallId) : ""}\\n\${escapeHtml(message.content || "")}\${message.reasoningContent ? "\\nreasoning_content\\n" + escapeHtml(message.reasoningContent) : ""}\${message.toolCalls ? "\\ntool_calls=" + escapeHtml(JSON.stringify(message.toolCalls, null, 2)) : ""}</div>\`).join("")}
          <div class="log-line">raw json\\n\${escapeHtml(JSON.stringify(raw, null, 2))}</div>
        \`;
      }

      async function refreshAgentState() {
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

      let promptProfile = null;
      let promptVariables = {};
      let promptTools = [];
      let toolPreviewTools = [];
      async function refreshPromptProfile() {
        const payload = await fetch("/admin/api/prompt-profile").then((res) => res.json());
        promptProfile = payload.profile;
        promptVariables = payload.variables || {};
        promptTools = payload.tools || [];
        renderPromptProfile();
      }

      function renderPromptProfile() {
        if (!promptProfile) return;
        const layers = [...promptProfile.layers].sort((a, b) => a.order - b.order);
        if (!Array.isArray(promptProfile.appendLayers)) promptProfile.appendLayers = [];
        const appendLayers = [...promptProfile.appendLayers].sort((a, b) => a.order - b.order);
        $("promptProfile").innerHTML = \`
          <h2>Prompt Profile</h2>
          <label for="promptUserName">User Name</label>
          <input id="promptUserName" autocomplete="off" value="\${escapeAttr(promptProfile.userName || "user")}" />
          <h2>Variables</h2>
          <pre>\${escapeHtml(JSON.stringify(promptVariables, null, 2))}</pre>
          <h2>Visible Tools</h2>
          <label><input id="toolFeishuVisible" type="checkbox" \${promptProfile.visibleTools?.feishu === false ? "" : "checked"} /> tool: feishu</label>
          <label><input id="toolMediaVisible" type="checkbox" \${promptProfile.visibleTools?.media === false ? "" : "checked"} /> tool: media</label>
          <label><input id="toolShellVisible" type="checkbox" \${promptProfile.visibleTools?.shell === false ? "" : "checked"} /> tool: shell</label>
          <p class="muted">check_chat · send_chat · wardrobe · selfie</p>
          <h2>Initial Layers</h2>
          <div id="promptLayers">\${layers.map((layer, index) => renderPromptLayer(layer, index, layers.length, "layers")).join("")}</div>
          <button type="button" id="prompt-add">Add Initial Layer</button>
          <h2>Append Layers</h2>
          <p class="muted">Append layers are rendered and appended before each heartbeat LLM request. Tool request layers run immediately and include their tool result.</p>
          <div id="promptAppendLayers">\${appendLayers.map((layer, index) => renderPromptLayer(layer, index, appendLayers.length, "appendLayers")).join("")}</div>
          <button type="button" id="prompt-append-add">Add Append Layer</button>
          <button type="button" id="prompt-save">Save Prompt Profile</button>
        \`;
        $("promptUserName").addEventListener("input", () => { promptProfile.userName = $("promptUserName").value; });
        $("toolFeishuVisible").addEventListener("change", () => { promptProfile.visibleTools.feishu = $("toolFeishuVisible").checked; });
        $("toolMediaVisible").addEventListener("change", () => { promptProfile.visibleTools.media = $("toolMediaVisible").checked; });
        $("toolShellVisible").addEventListener("change", () => { promptProfile.visibleTools.shell = $("toolShellVisible").checked; });
        layers.forEach((layer, index) => bindPromptLayer(layer, index, "layers"));
        appendLayers.forEach((layer, index) => bindPromptLayer(layer, index, "appendLayers"));
        $("prompt-add").addEventListener("click", () => {
          const order = Math.max(0, ...promptProfile.layers.map((layer) => Number(layer.order) || 0)) + 10;
          promptProfile.layers.push({ id: "layer_" + Date.now(), title: "New Layer", role: "user", enabled: true, content: "", order });
          renderPromptProfile();
        });
        $("prompt-append-add").addEventListener("click", () => {
          const order = Math.max(0, ...promptProfile.appendLayers.map((layer) => Number(layer.order) || 0)) + 10;
          promptProfile.appendLayers.push({ id: "append_layer_" + Date.now(), title: "New Append Layer", role: "tool_request", enabled: true, content: "", order, toolName: "check_chat", toolArguments: "{}" });
          renderPromptProfile();
        });
        $("prompt-save").addEventListener("click", savePromptProfile);
      }

      async function refreshToolPreviewTools() {
        const payload = await fetch("/admin/api/tools").then((res) => res.json());
        toolPreviewTools = payload.tools || [];
        const select = $("toolPreviewSelect");
        const previous = select.value;
        select.innerHTML = toolPreviewTools.map((tool) => \`<option value="\${escapeAttr(tool.pluginId + ":" + tool.name)}">\${escapeHtml(tool.pluginId)} / \${escapeHtml(tool.name)}</option>\`).join("");
        if (previous && [...select.options].some((option) => option.value === previous)) select.value = previous;
        if (!select.value && select.options.length) select.selectedIndex = 0;
        renderToolPreviewDefaultInput(false);
      }

      function currentToolPreviewTool() {
        const [pluginId, name] = $("toolPreviewSelect").value.split(":");
        return toolPreviewTools.find((tool) => tool.pluginId === pluginId && tool.name === name);
      }

      function renderToolPreviewDefaultInput(force) {
        const tool = currentToolPreviewTool();
        if (!tool) {
          $("toolPreviewInput").value = "{}";
          return;
        }
        if (!force && $("toolPreviewInput").value.trim() && $("toolPreviewInput").value.trim() !== "{}") return;
        $("toolPreviewInput").value = JSON.stringify(defaultInputFromSchema(tool.inputSchema), null, 2);
        $("tool-preview-status").textContent = "";
      }

      function defaultInputFromSchema(schema) {
        const properties = schema && typeof schema === "object" ? schema.properties || {} : {};
        const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
        const result = {};
        Object.entries(properties).forEach(([key, spec]) => {
          if (!required.has(key) && spec.default === undefined) return;
          if (spec.default !== undefined) {
            result[key] = spec.default;
          } else if (Array.isArray(spec.enum) && spec.enum.length) {
            result[key] = spec.enum[0];
          } else if (spec.type === "number" || spec.type === "integer") {
            result[key] = 0;
          } else if (spec.type === "boolean") {
            result[key] = false;
          } else if (spec.type === "array") {
            result[key] = [];
          } else if (spec.type === "object") {
            result[key] = {};
          } else {
            result[key] = "";
          }
        });
        return result;
      }

      async function runToolPreview() {
        const tool = currentToolPreviewTool();
        if (!tool) return;
        let input;
        try {
          input = JSON.parse($("toolPreviewInput").value || "{}");
          if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Arguments must be a JSON object.");
        } catch (error) {
          $("tool-preview-status").textContent = "Invalid JSON: " + (error?.message || "parse failed");
          return;
        }
        $("tool-preview-status").textContent = "Running preview...";
        const result = await fetch("/admin/api/tools/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pluginId: tool.pluginId,
            toolName: tool.name,
            targetPlugin: $("toolPreviewTarget").value,
            input
          })
        }).then(async (res) => ({ status: res.status, body: await res.json() }));
        $("tool-preview-status").textContent = result.body.ok ? "Preview complete." : "Preview failed.";
        $("toolPreviewResult").innerHTML = renderToolPreviewResult(result.body, result.status);
        $("toolPreviewResult").scrollTop = 0;
        await refreshLogs();
        await refreshLLMRequests();
      }

      function renderToolPreviewResult(payload, status) {
        return \`
          <div class="log-line">HTTP \${escapeHtml(status)} · \${escapeHtml(payload.pluginId || "")}/\${escapeHtml(payload.toolName || "")} · ok=\${escapeHtml(payload.ok)}</div>
          <div class="log-line">LLM content\\n\${escapeHtml(payload.content || payload.error || "")}</div>
          <div class="log-line">raw json\\n\${escapeHtml(JSON.stringify(payload.result || payload, null, 2))}</div>
        \`;
      }

      function renderPromptLayer(layer, index, count, collection) {
        const role = layer.role || "system";
        const isToolRequest = role === "tool_request";
        const showsThinking = role === "assistant" || isToolRequest;
        const showsContent = !isToolRequest;
        return \`
          <details class="prompt-layer" data-layer-id="\${escapeAttr(layer.id)}" data-layer-collection="\${escapeAttr(collection)}" open>
            <summary>\${escapeHtml(layer.title || "Untitled Layer")}<span>[\${escapeHtml(role)}]\${layer.enabled ? "" : " disabled"}</span></summary>
            <div class="row">
              <div>
                <label>Title</label>
                <input data-field="title" value="\${escapeAttr(layer.title)}" />
              </div>
              <div>
                <label>Role</label>
                <select data-field="role">
                  \${["system", "user", "assistant", "tool_request"].map((item) => \`<option value="\${item}" \${role === item ? "selected" : ""}>\${item}</option>\`).join("")}
                </select>
              </div>
              <label><input data-field="enabled" type="checkbox" \${layer.enabled ? "checked" : ""} /> Enabled</label>
            </div>
            \${isToolRequest ? \`<div class="row">
              <div>
                <label>Tool Name</label>
                <select data-field="toolName">
                  \${renderToolOptions(layer.toolName)}
                </select>
              </div>
              <div>
                <label>Tool Call ID</label>
                <input data-field="toolCallId" value="\${escapeAttr(layer.toolCallId || "")}" placeholder="call_1" />
              </div>
              <div></div>
            </div>
            <label>Tool Arguments</label>
            <textarea data-field="toolArguments" rows="3">\${escapeHtml(layer.toolArguments || "")}</textarea>
            <p class="muted">Tool result is generated by actually running this request when the LLM request is built. It is not editable.</p>\` : ""}
            \${showsThinking ? \`<label>\${isToolRequest ? "Thinking / Assistant Tool Call Content" : "Thinking / Assistant Content"}</label>
            <textarea data-field="thinking" rows="3">\${escapeHtml(layer.thinking || "")}</textarea>\` : ""}
            \${showsContent ? \`<label>Content</label>
            <textarea data-field="content" rows="7">\${escapeHtml(layer.content || "")}</textarea>\` : ""}
            <div class="prompt-actions">
              <button type="button" data-action="up" \${index === 0 ? "disabled" : ""}>Up</button>
              <button type="button" data-action="down" \${index === count - 1 ? "disabled" : ""}>Down</button>
              <button type="button" data-action="delete" class="secondary">Delete</button>
            </div>
          </details>
        \`;
      }

      function renderToolOptions(selected) {
        const names = promptTools.map((tool) => tool.name);
        const current = selected || names[0] || "check_chat";
        const allNames = names.includes(current) ? names : [current, ...names];
        return allNames.map((name) => \`<option value="\${escapeAttr(name)}" \${current === name ? "selected" : ""}>\${escapeHtml(name)}</option>\`).join("");
      }

      function bindPromptLayer(layer, index, collection) {
        const root = document.querySelector('[data-layer-collection="' + cssEscape(collection) + '"][data-layer-id="' + cssEscape(layer.id) + '"]');
        if (!root) return;
        root.querySelector('[data-field="title"]').addEventListener("input", (event) => { layer.title = event.target.value; });
        root.querySelector('[data-field="role"]').addEventListener("change", (event) => {
          layer.role = event.target.value;
          if (layer.role !== "tool_request") {
            delete layer.toolName;
            delete layer.toolCallId;
            delete layer.toolArguments;
          }
          if (layer.role !== "assistant" && layer.role !== "tool_request") delete layer.thinking;
          renderPromptProfile();
        });
        root.querySelector('[data-field="enabled"]').addEventListener("change", (event) => { layer.enabled = event.target.checked; });
        root.querySelector('[data-field="toolName"]')?.addEventListener("change", (event) => { layer.toolName = event.target.value; });
        root.querySelector('[data-field="toolCallId"]')?.addEventListener("input", (event) => { layer.toolCallId = event.target.value; });
        root.querySelector('[data-field="thinking"]')?.addEventListener("input", (event) => { layer.thinking = event.target.value; });
        root.querySelector('[data-field="toolArguments"]')?.addEventListener("input", (event) => { layer.toolArguments = event.target.value; });
        root.querySelector('[data-field="content"]')?.addEventListener("input", (event) => { layer.content = event.target.value; });
        root.querySelector('[data-action="delete"]').addEventListener("click", () => {
          promptProfile[collection] = promptProfile[collection].filter((item) => item.id !== layer.id);
          renderPromptProfile();
        });
        root.querySelector('[data-action="up"]').addEventListener("click", () => movePromptLayer(index, -1, collection));
        root.querySelector('[data-action="down"]').addEventListener("click", () => movePromptLayer(index, 1, collection));
      }

      function movePromptLayer(index, delta, collection) {
        const layers = [...promptProfile[collection]].sort((a, b) => a.order - b.order);
        const nextIndex = index + delta;
        if (nextIndex < 0 || nextIndex >= layers.length) return;
        const currentOrder = layers[index].order;
        layers[index].order = layers[nextIndex].order;
        layers[nextIndex].order = currentOrder;
        renderPromptProfile();
      }

      async function savePromptProfile() {
        const result = await fetch("/admin/api/prompt-profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(promptProfile) }).then((res) => res.json());
        $("prompt-status").textContent = result.ok ? "Prompt profile saved." : "Prompt profile save failed.";
        if (result.profile) {
          promptProfile = result.profile;
          promptVariables = result.variables || {};
          renderPromptProfile();
        }
        await refreshLLMRequests();
      }

      let shellData = null;
      let shellOrder = { personalities: [], relationships: [], outfits: [] };
      const shellCategories = [
        { key: "personalities", title: "性格 / 语气" },
        { key: "relationships", title: "关系 / 称呼" },
        { key: "outfits", title: "服装 / Cosplay" }
      ];

      async function refreshShellEditor() {
        const [data, orderPayload] = await Promise.all([
          fetch("/admin/api/shell").then((res) => res.json()),
          fetch("/admin/api/shell-ui/order").then((res) => res.json())
        ]);
        shellData = data;
        shellOrder = orderPayload.order || shellOrder;
        shellCategories.forEach((category) => {
          shellData[category.key] = applyShellOrder(category.key, shellData[category.key] || []);
        });
        renderShellEditor();
      }

      function renderShellEditor() {
        if (!shellData) return;
        $("shellEditor").innerHTML = \`
          <div class="shell-head">
            <h2>Daily Shell</h2>
            <button type="button" id="shell-reroll" class="secondary">Reroll Today</button>
          </div>
          <details class="prompt-layer">
            <summary>Today<span>\${escapeHtml(shellData.daily?.date || "")}</span></summary>
            <p class="muted">Created at: \${escapeHtml(shellData.daily?.createdAt || "")}</p>
            <pre>\${escapeHtml(JSON.stringify(shellData.todayVariables || {}, null, 2))}</pre>
          </details>
          <details class="prompt-layer">
            <summary>Shell Settings<span>daily refresh clock</span></summary>
            <label for="shellRolloverHour">Daily Refresh Clock (0-23)</label>
            <input id="shellRolloverHour" inputmode="numeric" value="\${escapeAttr(shellData.settings?.rolloverHour ?? 4)}" />
            <button type="button" id="shell-settings-save">Save Shell Settings</button>
          </details>
          <details class="prompt-layer" open>
            <summary>语气 / 称呼<span>top</span></summary>
            <div class="shell-grid">
              \${shellCategories.slice(0, 2).map((category) => renderShellCategory(category)).join("")}
            </div>
          </details>
          <details class="prompt-layer" open>
            <summary>服装<span>bottom</span></summary>
            \${renderShellCategory(shellCategories[2])}
          </details>
        \`;
        $("shell-reroll").addEventListener("click", rerollShell);
        $("shell-settings-save").addEventListener("click", saveShellSettings);
        shellCategories.forEach((category) => bindShellCategory(category.key));
      }

      function renderShellCategory(category) {
        const options = shellData[category.key] || [];
        return \`
          <div class="prompt-layer shell-category-\${escapeAttr(category.key)}" data-shell-category="\${escapeAttr(category.key)}">
            <div class="shell-head">
              <h2>\${escapeHtml(category.title)}</h2>
              <span class="muted">\${options.length} options</span>
            </div>
            <div class="shell-category-body">
              \${renderShellGroups(category.key, options)}
            </div>
            <button type="button" data-action="add">Add</button>
          </div>
        \`;
      }

      function renderShellGroups(category, options) {
        const groups = new Map();
        options.forEach((option, index) => {
          const group = option.group || "root";
          if (!groups.has(group)) groups.set(group, []);
          groups.get(group).push({ option, index });
        });
        return [...groups.entries()].map(([group, items]) => \`
          <div class="item">
            <strong>\${escapeHtml(group)}</strong>
            \${items.map(({ option, index }) => renderShellOption(category, option, index)).join("")}
          </div>
        \`).join("");
      }

      function applyShellOrder(category, options) {
        const order = shellOrder[category] || [];
        if (!order.length) return options;
        const byId = new Map(options.map((option) => [option.id, option]));
        const sorted = order.map((id) => byId.get(id)).filter(Boolean);
        const seen = new Set(sorted.map((option) => option.id));
        return [...sorted, ...options.filter((option) => !seen.has(option.id))];
      }

      function renderShellOption(category, option, index) {
        return \`
          <details class="shell-option" data-shell-index="\${index}">
            <summary>
              <span class="shell-title">\${escapeHtml(option.name || "New Shell")}</span>
              <span class="shell-marker" data-field="marker"></span>
              <button type="button" data-action="up" title="Move up">↑</button>
              <button type="button" data-action="down" title="Move down">↓</button>
              <button type="button" class="shell-save" data-action="save-one" title="Save">S</button>
            </summary>
            <div class="row">
              <div>
                <label>ID</label>
                <input data-field="id" value="\${escapeAttr(option.id || "")}" />
              </div>
              <div></div>
            </div>
            <label>Name</label>
            <input data-field="name" value="\${escapeAttr(option.name || "")}" />
            <label>Group</label>
            <input data-field="group" value="\${escapeAttr(option.group || "")}" placeholder="root / 原神 / ..." />
            \${category === "outfits" ? \`
              <label>Image</label>
              <img class="shell-image-preview \${option.imageUrl ? "" : "hidden"}" data-field="imagePreview" src="\${escapeAttr(shellImageSrc(option.imageUrl || ""))}" alt="" />
              <input data-field="imageUpload" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
              <button type="button" data-action="upload-image">Upload Image</button>
            \` : ""}
            <label>Content</label>
            <textarea data-field="content" rows="6">\${escapeHtml(option.content || "")}</textarea>
            <button type="button" data-action="delete" class="secondary">Delete</button>
          </details>
        \`;
      }

      function bindShellCategory(category) {
        const root = document.querySelector('[data-shell-category="' + cssEscape(category) + '"]');
        if (!root) return;
        root.querySelector('[data-action="add"]').addEventListener("click", () => {
          shellData[category].push({ id: category.slice(0, -1) + "_" + Date.now(), name: "New Shell", content: "", group: "" });
          renderShellEditor();
        });
        root.querySelectorAll(".shell-option").forEach((optionRoot) => {
          const index = Number(optionRoot.dataset.shellIndex);
          const option = shellData[category][index];
          option._previousId = option._previousId || option.id;
          optionRoot.querySelector('[data-field="id"]').addEventListener("input", (event) => { option.id = event.target.value; markShellOption(optionRoot, "dirty"); });
          optionRoot.querySelector('[data-field="name"]').addEventListener("input", (event) => { option.name = event.target.value; markShellOption(optionRoot, "dirty"); });
          optionRoot.querySelector('[data-field="group"]').addEventListener("input", (event) => { option.group = event.target.value; markShellOption(optionRoot, "dirty"); });
          optionRoot.querySelector('[data-action="upload-image"]')?.addEventListener("click", () => uploadShellOutfitImage(optionRoot, option, category, index));
          optionRoot.querySelector('[data-field="content"]').addEventListener("input", (event) => { option.content = event.target.value; markShellOption(optionRoot, "dirty"); });
          optionRoot.querySelector('[data-action="save-one"]').addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            try {
              await saveShellOption(category, currentShellIndex(optionRoot));
            } catch (error) {
              $("shell-status").textContent = "Shell save failed: " + (error?.message || "unknown error");
            }
          });
          optionRoot.querySelector('[data-action="up"]').addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            moveShellOption(category, currentShellIndex(optionRoot), -1).catch((error) => {
              $("shell-status").textContent = "Shell order save failed: " + (error?.message || "unknown error");
            });
          });
          optionRoot.querySelector('[data-action="down"]').addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            moveShellOption(category, currentShellIndex(optionRoot), 1).catch((error) => {
              $("shell-status").textContent = "Shell order save failed: " + (error?.message || "unknown error");
            });
          });
          optionRoot.querySelector('[data-action="delete"]').addEventListener("click", async () => {
            if (shellData[category].length <= 1) {
              $("shell-status").textContent = "Each shell category must keep at least one option.";
              return;
            }
            try {
              await deleteShellOption(category, currentShellIndex(optionRoot));
            } catch (error) {
              $("shell-status").textContent = "Shell delete failed: " + (error?.message || "unknown error");
            }
          });
        });
      }

      async function moveShellOption(category, index, delta) {
        const options = shellData[category];
        const nextIndex = index + delta;
        if (nextIndex < 0 || nextIndex >= options.length) return;
        const current = options[index];
        options[index] = options[nextIndex];
        options[nextIndex] = current;
        await saveShellOrder(category);
        $("shell-status").textContent = "Shell order saved.";
        moveShellOptionNode(category, index, nextIndex, delta);
      }

      async function saveShellOption(category, index) {
        const optionRoot = document.querySelector('[data-shell-category="' + cssEscape(category) + '"] [data-shell-index="' + index + '"]');
        const option = shellData[category][index];
        const result = await persistShellOption(category, index);
        $("shell-status").textContent = "Shell saved: " + (option?.name || option?.id || category);
        shellData[category][index] = { ...result.option, _previousId: result.option.id };
        optionRootLabel(category, index, result.option);
        if (optionRoot) {
          markShellOption(optionRoot, "saved");
          optionRoot.open = false;
        }
      }

      async function persistShellOption(category, index) {
        const option = shellData[category][index];
        const previousId = option?._previousId || option?.id;
        const payload = { ...option };
        delete payload._previousId;
        const result = await fetch("/admin/api/shell-option", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ category, previousId, option: payload })
        }).then((res) => res.json());
        if (!result.ok) throw new Error(result.error || "unknown error");
        shellData[category][index] = { ...result.option, _previousId: result.option.id };
        return result;
      }

      async function deleteShellOption(category, index) {
        const option = shellData[category][index];
        const id = option?._previousId || option?.id;
        const result = await fetch("/admin/api/shell-option", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ category, id })
        }).then((res) => res.json());
        if (!result.ok) throw new Error(result.error || "unknown error");
        shellData[category].splice(index, 1);
        shellOrder = result.order || shellOrder;
        $("shell-status").textContent = "Shell deleted: " + (option?.name || id || category);
        renderShellEditor();
      }

      function optionRootLabel(category, index, option) {
        const root = document.querySelector('[data-shell-category="' + cssEscape(category) + '"] [data-shell-index="' + index + '"] .shell-title');
        if (root) root.textContent = option.name || "New Shell";
      }

      function markShellOption(optionRoot, state) {
        const marker = optionRoot.querySelector('[data-field="marker"]');
        if (!marker) return;
        marker.textContent = state === "dirty" ? "[●]" : state === "saved" ? "[M]" : "";
      }

      function moveShellOptionNode(category, index, nextIndex, delta) {
        const root = document.querySelector('[data-shell-category="' + cssEscape(category) + '"]');
        const current = root?.querySelector('[data-shell-index="' + index + '"]');
        const target = root?.querySelector('[data-shell-index="' + nextIndex + '"]');
        if (!current || !target || !current.parentElement || current.parentElement !== target.parentElement) return;
        if (delta < 0) {
          target.before(current);
        } else {
          target.after(current);
        }
        current.dataset.shellIndex = String(nextIndex);
        target.dataset.shellIndex = String(index);
      }

      function currentShellIndex(optionRoot) {
        return Number(optionRoot.dataset.shellIndex);
      }

      async function saveShellOrder(category) {
        shellOrder[category] = shellData[category].map((option) => option.id);
        const result = await fetch("/admin/api/shell-ui/order", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ category, order: shellOrder[category] })
        }).then((res) => res.json());
        if (!result.ok) throw new Error(result.error || "unknown error");
        shellOrder = result.order || shellOrder;
      }

      function shellImageSrc(imageUrl) {
        const value = String(imageUrl || "");
        if (!value) return "";
        if (/^https?:\\/\\//.test(value) || value.startsWith("data:")) return value;
        const prefix = "memory-files/shell/";
        if (value.startsWith(prefix)) return "/admin/assets/shell/" + value.slice(prefix.length).split("/").map(encodeURIComponent).join("/");
        return value;
      }

      function updateShellImagePreview(optionRoot, imageUrl, bustCache) {
        const preview = optionRoot.querySelector('[data-field="imagePreview"]');
        if (!preview) return;
        const baseSrc = shellImageSrc(imageUrl);
        const src = baseSrc && bustCache ? baseSrc + (baseSrc.includes("?") ? "&" : "?") + "v=" + Date.now() : baseSrc;
        preview.src = src;
        preview.classList.toggle("hidden", !src);
      }

      async function rerollShell() {
        const result = await fetch("/admin/api/shell/reroll", { method: "POST" }).then((res) => res.json());
        $("shell-status").textContent = result.todayVariables ? "Daily shell rerolled." : "Daily shell reroll failed.";
        shellData = result;
        renderShellEditor();
        await refreshPromptProfile();
        await refreshLLMRequests();
      }

      async function saveShellSettings() {
        const result = await fetch("/admin/api/shell-settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rolloverHour: Number($("shellRolloverHour").value) })
        }).then((res) => res.json());
        $("shell-status").textContent = result.ok ? "Shell settings saved." : "Shell settings save failed: " + (result.error || "unknown error");
        if (result.ok) {
          shellData = result;
          renderShellEditor();
        }
      }

      async function uploadShellOutfitImage(optionRoot, option, category, index) {
        const file = optionRoot.querySelector('[data-field="imageUpload"]')?.files?.[0];
        if (!file) {
          $("shell-status").textContent = "Choose an outfit image first.";
          return;
        }
        const imageBlob = await convertImageToJpeg(file);
        const result = await fetch("/admin/api/shell/outfit-image", {
          method: "POST",
          headers: {
            "content-type": "image/jpeg",
            "x-shell-id": encodeURIComponent(option.id || "outfit")
          },
          body: imageBlob
        }).then((res) => res.json());
        if (!result.ok) {
          $("shell-status").textContent = "Image upload failed: " + (result.error || "unknown error");
          return;
        }
        option.imageUrl = result.imageUrl;
        updateShellImagePreview(optionRoot, result.imageUrl, true);
        const saved = await persistShellOption(category, index);
        shellData[category][index] = { ...saved.option, _previousId: saved.option.id };
        optionRootLabel(category, index, saved.option);
        markShellOption(optionRoot, "saved");
        $("shell-status").textContent = "Image uploaded and saved: " + (saved.option.name || saved.option.id || "outfit");
      }

      function convertImageToJpeg(file) {
        return new Promise((resolve, reject) => {
          const url = URL.createObjectURL(file);
          const image = new Image();
          image.onload = () => {
            try {
              const canvas = document.createElement("canvas");
              canvas.width = image.naturalWidth || image.width;
              canvas.height = image.naturalHeight || image.height;
              const context = canvas.getContext("2d");
              context.fillStyle = "#fff";
              context.fillRect(0, 0, canvas.width, canvas.height);
              context.drawImage(image, 0, 0);
              canvas.toBlob((blob) => {
                URL.revokeObjectURL(url);
                blob ? resolve(blob) : reject(new Error("image_convert_failed"));
              }, "image/jpeg", 0.92);
            } catch (error) {
              URL.revokeObjectURL(url);
              reject(error);
            }
          };
          image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("image_load_failed"));
          };
          image.src = url;
        });
      }

      async function uploadTtsReferenceAudio() {
        const file = $("ttsReferenceAudio").files?.[0];
        if (!file) {
          $("tts-preview-status").textContent = "Choose a WAV, MP3, or M4A voice sample first.";
          return;
        }
        $("tts-preview-status").textContent = "Uploading voice sample...";
        const result = await fetch("/admin/api/tts/reference-audio", {
          method: "POST",
          headers: {
            "content-type": file.type || "application/octet-stream",
            "x-file-name": encodeURIComponent(file.name || "reference.wav")
          },
          body: file
        }).then((res) => res.json());
        if (!result.ok) {
          $("tts-preview-status").textContent = "Voice sample upload failed: " + (result.error || "unknown error");
          return;
        }
        $("tts-reference-status").textContent = "Current reference: " + result.referenceAudio + " (" + Math.round((result.size || 0) / 1024) + " KB)";
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

      async function refreshLogs() {
        const system = await fetch("/admin/api/logs").then((res) => res.json());
        $("logs").innerHTML = system.logs.map((entry) => \`<div class="log-line log-\${entry.level}">[\${entry.time}] [\${entry.level.toUpperCase()}] \${escapeHtml(entry.message)}</div>\`).join("");
        $("logs").scrollTop = $("logs").scrollHeight;
        const messages = await fetch("/admin/api/message-logs").then((res) => res.json());
        $("messageLogs").innerHTML = messages.logs.map((entry) => {
          const time = entry.createdAt || entry.time;
          const kind = entry.contentType || entry.kind;
          const target = entry.conversationId || entry.target || "";
          const summary = entry.contentText || entry.summary || "";
          const state = entry.status ? " " + entry.status : "";
          const flags = [entry.isRead ? "read" : "", entry.isRecalled ? "recalled" : ""].filter(Boolean).join(",");
          return \`<div class="log-line">[\${time}] [\${entry.direction}\${state}] [\${entry.plugin}/\${kind}] \${escapeHtml(target)}\${flags ? " · " + escapeHtml(flags) : ""} · \${escapeHtml(summary)}</div>\`;
        }).join("");
        $("messageLogs").scrollTop = $("messageLogs").scrollHeight;
        const events = await fetch("/admin/api/message-event-logs").then((res) => res.json());
        $("eventLogs").innerHTML = events.logs.map((entry) => {
          const status = entry.status ? " " + entry.status : "";
          const target = entry.target || entry.sessionId || entry.rawMessageId || "";
          const error = entry.error ? " · error=" + entry.error : "";
          return \`<div class="log-line">[\${entry.time}] [\${entry.direction}\${status}] [\${entry.plugin}/\${entry.kind}] \${escapeHtml(target)} · \${escapeHtml(entry.summary || "")}\${escapeHtml(error)}</div>\`;
        }).join("");
        $("eventLogs").scrollTop = $("eventLogs").scrollHeight;
      }

      function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
      }
      function escapeAttr(value) { return escapeHtml(value); }
      function cssEscape(value) { return String(value).replace(/["\\\\]/g, "\\\\$&"); }

      $("llm-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const body = { baseURL: form.get("baseURL"), model: form.get("model"), temperature: form.get("temperature"), timeoutMs: form.get("timeoutMs"), stream: $("streamEnabled").checked, extraParams: form.get("extraParams"), followupExtraParams: form.get("followupExtraParams") };
        const apiKey = form.get("apiKey");
        if (apiKey) body.apiKey = apiKey;
        const result = await fetch("/admin/api/config/llm", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("save-status").textContent = result.ok ? "Saved." : "Save failed.";
        await refresh();
      });

      $("feishu-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const body = { enabled: $("feishuEnabled").checked, connectionMode: form.get("connectionMode") || "websocket", appId: form.get("appId"), requireMention: $("feishuRequireMention").checked };
        const appSecret = form.get("appSecret");
        if (appSecret) body.appSecret = appSecret;
        const result = await fetch("/admin/api/config/feishu", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("feishu-status").textContent = result.ok ? "Feishu config saved." : "Failed to save Feishu config.";
        await refresh();
      });

      $("wechat-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const body = { enabled: $("wechatEnabled").checked, baseURL: form.get("baseURL"), pollTimeoutMs: form.get("pollTimeoutMs") };
        const result = await fetch("/admin/api/config/wechat", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("wechat-status").textContent = result.ok ? "WeChat config saved." : "Failed to save WeChat config.";
        await refresh();
      });

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
        const body = { appearanceDescription: form.get("appearanceDescription") };
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
        $("agent-status").textContent = result.ok ? "Heartbeat resumed." : "Failed to resume heartbeat.";
        await refreshRuntimeStatus();
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
        $("llmChainRequests").textContent = result.ok ? "Active session cleared." : "Failed to clear active session.";
        await refreshLLMRequests();
        await refreshLLMChain();
      });

      $("feishu-start").addEventListener("click", async () => { const r = await fetch("/admin/api/plugins/feishu/start", { method: "POST" }).then((res) => res.json()); $("feishu-status").textContent = r.ok ? "Feishu runtime started." : "Cannot start Feishu: " + (r.error || "unknown error"); await refresh(); });
      $("feishu-stop").addEventListener("click", async () => { const r = await fetch("/admin/api/plugins/feishu/stop", { method: "POST" }).then((res) => res.json()); $("feishu-status").textContent = r.ok ? "Feishu runtime stopped." : "Cannot stop Feishu."; await refresh(); });
      let wechatLoginTimer;
      $("wechat-login").addEventListener("click", async () => {
        clearInterval(wechatLoginTimer);
        $("wechat-login-status").textContent = "Requesting QR code...";
        const r = await fetch("/admin/api/plugins/wechat/login/qrcode", { method: "POST" }).then((res) => res.json());
        if (!r.ok) {
          $("wechat-login-status").textContent = "Cannot get QR: " + (r.error || "unknown error");
          return;
        }
        if (r.qrcodeSvg) {
          $("wechat-qr").innerHTML = r.qrcodeSvg;
        } else if (r.qrcodeBase64) {
          const src = r.qrcodeBase64.startsWith("data:") ? r.qrcodeBase64 : "data:image/png;base64," + r.qrcodeBase64;
          $("wechat-qr").innerHTML = \`<img alt="WeChat login QR" src="\${escapeAttr(src)}" />\`;
        } else if (r.qrcodeUrl) {
          $("wechat-qr").innerHTML = \`<img alt="WeChat login QR" src="\${escapeAttr(r.qrcodeUrl)}" />\`;
        } else if (r.qrcodeContent) {
          $("wechat-qr").innerHTML = \`<pre>\${escapeHtml(r.qrcodeContent)}</pre>\`;
        } else {
          $("wechat-qr").innerHTML = \`<pre>\${escapeHtml(r.qrcode)}</pre>\`;
        }
        $("wechat-login-status").textContent = "Scan QR in WeChat, then confirm login on phone.";
        wechatLoginTimer = setInterval(async () => {
          const status = await fetch("/admin/api/plugins/wechat/login/status?qrcode=" + encodeURIComponent(r.qrcode)).then((res) => res.json());
          if (!status.ok) {
            $("wechat-login-status").textContent = "Login poll failed: " + (status.error || "unknown error");
            return;
          }
          $("wechat-login-status").textContent = "Login status: " + status.status;
          if (status.status === "confirmed" || status.status === "expired") {
            clearInterval(wechatLoginTimer);
            if (status.status === "confirmed") {
              $("wechat-status").textContent = "WeChat logged in and started.";
              await refresh();
            }
          }
        }, 2000);
      });
      $("wechat-start").addEventListener("click", async () => { const r = await fetch("/admin/api/plugins/wechat/start", { method: "POST" }).then((res) => res.json()); $("wechat-status").textContent = r.ok ? "WeChat runtime started." : "Cannot start WeChat: " + (r.error || "unknown error"); await refresh(); });
      $("wechat-stop").addEventListener("click", async () => { const r = await fetch("/admin/api/plugins/wechat/stop", { method: "POST" }).then((res) => res.json()); $("wechat-status").textContent = r.ok ? "WeChat runtime stopped." : "Cannot stop WeChat."; await refresh(); });
      $("send-test-markdown").addEventListener("click", async () => sendTest("test-markdown", { markdown: $("testMarkdown").value }, "Markdown"));
      $("send-test-image").addEventListener("click", async () => sendTest("test-image", { assetId: $("testImagePath").value }, "Image"));
      $("send-test-audio").addEventListener("click", async () => sendTest("test-audio", { assetId: $("testAudioPath").value }, "Audio"));
      $("tts-upload-reference").addEventListener("click", uploadTtsReferenceAudio);
      $("tts-generate-preview").addEventListener("click", generateTtsPreview);
      $("toolPreviewSelect").addEventListener("change", () => renderToolPreviewDefaultInput(true));
      $("tool-preview-reset").addEventListener("click", () => renderToolPreviewDefaultInput(true));
      $("tool-preview-run").addEventListener("click", runToolPreview);
      $("tool-view").addEventListener("click", async () => runMessagingTool(activeMessagingToolPath("view"), {}));
      $("tool-search").addEventListener("click", async () => runMessagingTool(activeMessagingToolPath("search"), { content: $("toolSearchContent").value, direction: $("toolSearchDirection").value || "backward" }));
      $("tool-send").addEventListener("click", async () => runMessagingTool(activeMessagingToolPath("send"), { type: $("toolSendType").value || "message", content: $("toolSendContent").value }));
      function activeMessagingToolPath(action) {
        const active = document.querySelector("[data-channel-tab].active")?.dataset.channelTab;
        return active === "wechat" ? "wechat-" + action : action;
      }
      async function sendTest(path, body, label) {
        const result = await fetch("/admin/api/plugins/feishu/" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("send-test-status").textContent = result.ok ? label + " test sent." : label + " test failed: " + (result.error || "unknown error");
        await refreshLogs();
        await refreshLLMRequests();
      }
      async function runMessagingTool(path, body) {
        const result = await fetch("/admin/api/tools/messaging/" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("tool-result").textContent = result.content || result.error || "";
        await refreshLogs();
        await refreshLLMRequests();
      }
      refresh();
      setInterval(refreshLogs, 3000);
    </script>
  </body>
</html>`;
}
