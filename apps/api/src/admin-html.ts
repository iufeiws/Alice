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
      .panel-body { padding: 14px 16px 20px; }
      .pane { display: none; }
      .pane.active { display: block; }
      section { background: #fff; border: 1px solid #d7dce3; border-radius: 8px; padding: 16px; }
      h2 { font-size: 15px; margin: 0 0 14px; }
      label { display: block; font-size: 12px; font-weight: 700; margin: 12px 0 6px; }
      input, textarea, select { box-sizing: border-box; width: 100%; border: 1px solid #c4cad2; border-radius: 6px; padding: 9px 10px; font: inherit; background: #fff; color: #17202a; }
      textarea { resize: vertical; }
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
      .logs { max-height: calc(100vh - 150px); overflow: auto; background: #111827; color: #e5e7eb; border-radius: 6px; padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
      .log-line { border-bottom: 1px solid #243041; padding: 5px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
      .log-info { color: #d1d5db; } .log-warn { color: #fbbf24; } .log-error { color: #fca5a5; }
      @media (max-width: 900px) { .shell { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid #d7dce3; } }
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
          <button class="tab" data-left-tab="feishu" type="button">Feishu Settings</button>
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
              <p class="muted">JSON object merged into the LLM request body. Object-body fragments are also accepted. For streaming token usage, include "stream_options":{"include_usage":true}.</p>
              <button type="submit">Save</button>
              <p class="muted" id="save-status"></p>
            </form>
            <h2>Runtime</h2>
            <pre id="config">Loading...</pre>
          </div>
          <div id="left-feishu" class="pane">
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
            <h2>Messaging Tools</h2>
            <label for="toolViewScope">View Scope</label>
            <input id="toolViewScope" autocomplete="off" value="today" />
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
          <div id="left-agent" class="pane">
            <h2>Agent</h2>
            <form id="agent-form">
              <label for="inboundDebounceMs">Message Wait Ms</label>
              <input id="inboundDebounceMs" name="inboundDebounceMs" inputmode="numeric" />
              <label for="timezone">Timezone</label>
              <input id="timezone" name="timezone" autocomplete="off" />
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
          <button class="tab" data-main-tab="llm-request" type="button">LLM Request</button>
          <button class="tab" data-main-tab="llm-responses" type="button">LLM Responses</button>
          <button class="tab" data-main-tab="llm-chain" type="button">LLM Chain</button>
          <button class="tab" data-main-tab="messages" type="button">Message Log</button>
          <button class="tab" data-main-tab="events" type="button">Event Log</button>
          <button class="tab" data-main-tab="system" type="button">System Log</button>
        </div>
        <section id="main-prompts" class="pane active">
          <div id="promptProfile">Loading...</div>
          <p class="muted" id="prompt-status"></p>
        </section>
        <section id="main-llm-request" class="pane"><div id="llmRequests" class="logs">No LLM request yet.</div></section>
        <section id="main-llm-responses" class="pane"><div id="llmResponses" class="logs">No LLM response yet.</div></section>
        <section id="main-llm-chain" class="pane">
          <button type="button" id="llm-chain-clear" class="secondary">Clear Active Session</button>
          <div id="llmChain" class="logs">No LLM chain yet.</div>
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
        document.querySelectorAll(kind === "left" ? "#left-llm,#left-feishu,#left-agent" : "#main-prompts,#main-llm-request,#main-llm-responses,#main-llm-chain,#main-messages,#main-events,#main-system").forEach((pane) => pane.classList.remove("active"));
        $(kind === "left" ? "left-" + name : "main-" + name).classList.add("active");
      }
      document.querySelectorAll("[data-left-tab]").forEach((button) => button.addEventListener("click", () => setTabs("left", button.dataset.leftTab)));
      document.querySelectorAll("[data-main-tab]").forEach((button) => button.addEventListener("click", async () => {
        setTabs("main", button.dataset.mainTab);
        if (button.dataset.mainTab === "llm-request") await refreshLLMRequests();
        if (button.dataset.mainTab === "llm-responses") await refreshLLMResponses();
        if (button.dataset.mainTab === "llm-chain") await refreshLLMChain();
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
        $("inboundDebounceMs").value = String(config.core.inboundDebounceMs ?? 1000);
        $("timezone").value = config.core.timezone || "Asia/Singapore";
        await refreshAgentState();
        $("feishuEnabled").checked = Boolean(config.plugins.feishu.enabled);
        $("feishuConnectionMode").value = config.plugins.feishu.connectionMode || "websocket";
        $("feishuAppId").value = config.plugins.feishu.appId || "";
        $("feishuRequireMention").checked = Boolean(config.plugins.feishu.requireMention);
        $("feishu-status").textContent = config.plugins.feishu.runtimeStarted ? "Feishu runtime started." : "Feishu runtime stopped.";

        await refreshPromptProfile();
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

      async function refreshLLMResponses() {
        const payload = await fetch("/admin/api/llm-responses").then((res) => res.json());
        $("llmResponses").innerHTML = renderLLMResponses(payload.responses || []) || "No LLM response yet.";
        $("llmResponses").scrollTop = 0;
      }

      async function refreshLLMChain() {
        const requestPayload = await fetch("/admin/api/llm-requests").then((res) => res.json());
        const items = (requestPayload.requests || []).sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));
        const active = requestPayload.activeSession ? renderActiveLLMSession(requestPayload.activeSession) : '<div class="log-line">Active session: none</div>';
        const history = items.length ? items.slice(-30).map(renderLLMChainItem).join("") : '<div class="log-line">No LLM request history yet.</div>';
        $("llmChain").innerHTML = active + history;
        $("llmChain").scrollTop = $("llmChain").scrollHeight;
      }

      function renderActiveLLMSession(session) {
        return \`<details class="log-line" open><summary>Active session started=\${escapeHtml(session.startedAt || "")} updated=\${escapeHtml(session.updatedAt || "")} requests=\${escapeHtml((session.requestIds || []).join(", "))}</summary>latest raw json\\n\${escapeHtml(JSON.stringify(session.latestRequest || {}, null, 2))}</details>\`;
      }

      function renderLLMChainItem(entry) {
        return \`<details class="log-line"><summary>[\${escapeHtml(entry.time || "")}] request #\${escapeHtml(entry.id || "")} model=\${escapeHtml(entry.model || "")}</summary>\${(entry.messages || []).map((message, index) => \`#\${index + 1} [\${escapeHtml(message.role)}]\\n\${escapeHtml(message.content || "")}\${message.reasoningContent ? "\\nreasoning_content\\n" + escapeHtml(message.reasoningContent) : ""}\${message.toolCalls ? "\\ntool_calls=" + escapeHtml(JSON.stringify(message.toolCalls, null, 2)) : ""}\`).join("\\n\\n")}\\nraw json\\n\${escapeHtml(JSON.stringify(entry.rawRequest || entry, null, 2))}</details>\`;
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

      function renderLLMResponses(responses) {
        if (!responses.length) return "";
        return \`
          \${responses.slice(-10).reverse().map((entry) => \`
            <details class="log-line">
              <summary>[\${escapeHtml(entry.time || "")}] response #\${escapeHtml(entry.id || "")} finish=\${escapeHtml(entry.finishReason || "")}</summary>
              <div># [\${escapeHtml(entry.message?.role || "")}]\\n\${escapeHtml(entry.message?.content || "")}\${entry.message?.reasoningContent ? "\\nreasoning_content\\n" + escapeHtml(entry.message.reasoningContent) : ""}\${entry.message?.toolCalls ? "\\ntool_calls=" + escapeHtml(JSON.stringify(entry.message.toolCalls, null, 2)) : ""}\\nraw json\\n\${escapeHtml(JSON.stringify({ message: entry.message, finishReason: entry.finishReason, usage: entry.usage, raw: entry.raw }, null, 2))}</div>
            </details>
          \`).join("")}
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
        $("promptProfile").innerHTML = \`
          <h2>Prompt Profile</h2>
          <label for="promptUserName">User Name</label>
          <input id="promptUserName" autocomplete="off" value="\${escapeAttr(promptProfile.userName || "user")}" />
          <h2>Variables</h2>
          <pre>\${escapeHtml(Object.entries(promptVariables).map(([key, value]) => "{{" + key + "}} = " + value).join("\\n"))}</pre>
          <h2>Visible Tools</h2>
          <label><input id="toolFeishuVisible" type="checkbox" \${promptProfile.visibleTools?.feishu === false ? "" : "checked"} /> tool: feishu</label>
          <p class="muted">check_feishu · send_feishu</p>
          <h2>Layers</h2>
          <div id="promptLayers">\${layers.map((layer, index) => renderPromptLayer(layer, index, layers.length)).join("")}</div>
          <button type="button" id="prompt-add">Add Layer</button>
          <button type="button" id="prompt-save">Save Prompt Profile</button>
        \`;
        $("promptUserName").addEventListener("input", () => { promptProfile.userName = $("promptUserName").value; });
        $("toolFeishuVisible").addEventListener("change", () => { promptProfile.visibleTools.feishu = $("toolFeishuVisible").checked; });
        layers.forEach((layer, index) => bindPromptLayer(layer, index));
        $("prompt-add").addEventListener("click", () => {
          const order = Math.max(0, ...promptProfile.layers.map((layer) => Number(layer.order) || 0)) + 10;
          promptProfile.layers.push({ id: "layer_" + Date.now(), title: "New Layer", role: "user", enabled: true, content: "", order });
          renderPromptProfile();
        });
        $("prompt-save").addEventListener("click", savePromptProfile);
      }

      function renderPromptLayer(layer, index, count) {
        const role = layer.role || "system";
        const isToolRequest = role === "tool_request";
        const showsThinking = role === "assistant" || isToolRequest;
        const showsContent = !isToolRequest;
        return \`
          <details class="prompt-layer" data-layer-id="\${escapeAttr(layer.id)}" open>
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
        const current = selected || names[0] || "check_feishu";
        const allNames = names.includes(current) ? names : [current, ...names];
        return allNames.map((name) => \`<option value="\${escapeAttr(name)}" \${current === name ? "selected" : ""}>\${escapeHtml(name)}</option>\`).join("");
      }

      function bindPromptLayer(layer, index) {
        const root = document.querySelector('[data-layer-id="' + cssEscape(layer.id) + '"]');
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
          promptProfile.layers = promptProfile.layers.filter((item) => item.id !== layer.id);
          renderPromptProfile();
        });
        root.querySelector('[data-action="up"]').addEventListener("click", () => movePromptLayer(index, -1));
        root.querySelector('[data-action="down"]').addEventListener("click", () => movePromptLayer(index, 1));
      }

      function movePromptLayer(index, delta) {
        const layers = [...promptProfile.layers].sort((a, b) => a.order - b.order);
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
        const body = { baseURL: form.get("baseURL"), model: form.get("model"), temperature: form.get("temperature"), timeoutMs: form.get("timeoutMs"), stream: $("streamEnabled").checked, extraParams: form.get("extraParams") };
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

      $("agent-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const body = { inboundDebounceMs: form.get("inboundDebounceMs"), timezone: form.get("timezone") };
        const result = await fetch("/admin/api/config/agent", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("agent-status").textContent = result.ok ? "Agent config saved." : "Failed to save agent config.";
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
        $("llmChain").textContent = result.ok ? "Active session cleared." : "Failed to clear active session.";
        await refreshLLMRequests();
        await refreshLLMChain();
      });

      $("feishu-start").addEventListener("click", async () => { const r = await fetch("/admin/api/plugins/feishu/start", { method: "POST" }).then((res) => res.json()); $("feishu-status").textContent = r.ok ? "Feishu runtime started." : "Cannot start Feishu: " + (r.error || "unknown error"); await refresh(); });
      $("feishu-stop").addEventListener("click", async () => { const r = await fetch("/admin/api/plugins/feishu/stop", { method: "POST" }).then((res) => res.json()); $("feishu-status").textContent = r.ok ? "Feishu runtime stopped." : "Cannot stop Feishu."; await refresh(); });
      $("send-test-markdown").addEventListener("click", async () => sendTest("test-markdown", { markdown: $("testMarkdown").value }, "Markdown"));
      $("send-test-image").addEventListener("click", async () => sendTest("test-image", { assetId: $("testImagePath").value }, "Image"));
      $("send-test-audio").addEventListener("click", async () => sendTest("test-audio", { assetId: $("testAudioPath").value }, "Audio"));
      $("tool-view").addEventListener("click", async () => runMessagingTool("view", { scope: $("toolViewScope").value || "today" }));
      $("tool-search").addEventListener("click", async () => runMessagingTool("search", { content: $("toolSearchContent").value, direction: $("toolSearchDirection").value || "backward" }));
      $("tool-send").addEventListener("click", async () => runMessagingTool("send", { type: $("toolSendType").value || "message", content: $("toolSendContent").value }));
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
