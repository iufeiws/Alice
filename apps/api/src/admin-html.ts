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
      input, textarea { box-sizing: border-box; width: 100%; border: 1px solid #c4cad2; border-radius: 6px; padding: 9px 10px; font: inherit; background: #fff; color: #17202a; }
      textarea { resize: vertical; }
      button { border: 0; border-radius: 6px; background: #2563eb; color: #fff; padding: 9px 12px; font-weight: 700; cursor: pointer; margin: 10px 8px 0 0; }
      button.secondary { background: #475467; }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f1f3f5; border-radius: 6px; padding: 12px; font-size: 12px; }
      .muted { color: #667085; font-size: 12px; }
      .list { display: grid; gap: 10px; }
      .item { border-bottom: 1px solid #e4e7eb; padding: 10px 0; }
      .item strong { display: block; font-size: 13px; }
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
          </div>
        </div>
      </aside>
      <main>
        <div class="tabbar main-tabs">
          <button class="tab active" data-main-tab="prompts" type="button">Prompt</button>
          <button class="tab" data-main-tab="llm-request" type="button">LLM Request</button>
          <button class="tab" data-main-tab="messages" type="button">Message Log</button>
          <button class="tab" data-main-tab="events" type="button">Event Log</button>
          <button class="tab" data-main-tab="system" type="button">System Log</button>
        </div>
        <section id="main-prompts" class="pane active"><div id="prompts">Loading...</div></section>
        <section id="main-llm-request" class="pane"><div id="llmRequests" class="logs">No LLM request yet.</div></section>
        <section id="main-messages" class="pane"><div id="messageLogs" class="logs">Loading...</div></section>
        <section id="main-events" class="pane"><div id="eventLogs" class="logs">Loading...</div></section>
        <section id="main-system" class="pane"><div id="logs" class="logs">Loading...</div></section>
      </main>
    </div>
    <script>
      const $ = (id) => document.getElementById(id);
      function setTabs(kind, name) {
        document.querySelectorAll("[data-" + kind + "-tab]").forEach((button) => button.classList.toggle("active", button.dataset[kind + "Tab"] === name));
        document.querySelectorAll(kind === "left" ? "#left-llm,#left-feishu,#left-agent" : "#main-prompts,#main-llm-request,#main-messages,#main-events,#main-system").forEach((pane) => pane.classList.remove("active"));
        $(kind === "left" ? "left-" + name : "main-" + name).classList.add("active");
      }
      document.querySelectorAll("[data-left-tab]").forEach((button) => button.addEventListener("click", () => setTabs("left", button.dataset.leftTab)));
      document.querySelectorAll("[data-main-tab]").forEach((button) => button.addEventListener("click", async () => {
        setTabs("main", button.dataset.mainTab);
        if (button.dataset.mainTab === "llm-request") await refreshLLMRequests();
      }));
      $("collapse").addEventListener("click", () => $("shell").classList.toggle("collapsed"));

      async function refresh() {
        const config = await fetch("/admin/api/config").then((res) => res.json());
        $("config").textContent = JSON.stringify(config, null, 2);
        $("baseURL").value = config.llm.baseURL || "";
        $("model").value = config.llm.model || "";
        $("temperature").value = String(config.llm.temperature ?? "");
        $("timeoutMs").value = String(config.llm.timeoutMs ?? "");
        $("inboundDebounceMs").value = String(config.core.inboundDebounceMs ?? 1000);
        $("timezone").value = config.core.timezone || "Asia/Singapore";
        $("feishuEnabled").checked = Boolean(config.plugins.feishu.enabled);
        $("feishuConnectionMode").value = config.plugins.feishu.connectionMode || "websocket";
        $("feishuAppId").value = config.plugins.feishu.appId || "";
        $("feishuRequireMention").checked = Boolean(config.plugins.feishu.requireMention);
        $("feishu-status").textContent = config.plugins.feishu.runtimeStarted ? "Feishu runtime started." : "Feishu runtime stopped.";

        const prompts = await fetch("/admin/api/prompts").then((res) => res.json());
        $("prompts").innerHTML = prompts.prompts.map((prompt) => \`
          <div class="item"><strong>\${escapeHtml(prompt.name)}</strong><div class="muted">\${escapeHtml(prompt.id)} · \${escapeHtml(prompt.scope)}</div><p>\${escapeHtml(prompt.description)}</p><pre>\${escapeHtml(prompt.content)}</pre></div>
        \`).join("");
        const pairings = await fetch("/admin/api/plugins/feishu/pairings").then((res) => res.json());
        $("pairings").textContent = JSON.stringify(pairings.contacts, null, 2);
        await refreshLLMRequests();
        await refreshLogs();
      }

      async function refreshLLMRequests() {
        const payload = await fetch("/admin/api/llm-requests").then((res) => res.json());
        const current = payload.preview || payload.requests[payload.requests.length - 1];
        if (!current) {
          $("llmRequests").textContent = "No messages available to build an LLM request preview.";
          return;
        }
        $("llmRequests").innerHTML = \`
          <div class="log-line">[\${escapeHtml(current.time)}] source=\${escapeHtml(current.source || "actual")} model=\${escapeHtml(current.model || "")} temperature=\${escapeHtml(current.temperature ?? "")}\${current.conversationId ? " conversation=" + escapeHtml(current.conversationId) : ""}</div>
          \${current.messages.map((message, index) => \`<div class="log-line">#\${index + 1} [\${escapeHtml(message.role)}]\${message.name ? " " + escapeHtml(message.name) : ""}\\n\${escapeHtml(message.content)}</div>\`).join("")}
        \`;
        $("llmRequests").scrollTop = 0;
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

      $("llm-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const body = { baseURL: form.get("baseURL"), model: form.get("model"), temperature: form.get("temperature"), timeoutMs: form.get("timeoutMs") };
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

      $("feishu-start").addEventListener("click", async () => { const r = await fetch("/admin/api/plugins/feishu/start", { method: "POST" }).then((res) => res.json()); $("feishu-status").textContent = r.ok ? "Feishu runtime started." : "Cannot start Feishu: " + (r.error || "unknown error"); await refresh(); });
      $("feishu-stop").addEventListener("click", async () => { const r = await fetch("/admin/api/plugins/feishu/stop", { method: "POST" }).then((res) => res.json()); $("feishu-status").textContent = r.ok ? "Feishu runtime stopped." : "Cannot stop Feishu."; await refresh(); });
      $("send-test-markdown").addEventListener("click", async () => sendTest("test-markdown", { markdown: $("testMarkdown").value }, "Markdown"));
      $("send-test-image").addEventListener("click", async () => sendTest("test-image", { assetId: $("testImagePath").value }, "Image"));
      $("send-test-audio").addEventListener("click", async () => sendTest("test-audio", { assetId: $("testAudioPath").value }, "Audio"));
      async function sendTest(path, body, label) {
        const result = await fetch("/admin/api/plugins/feishu/" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("send-test-status").textContent = result.ok ? label + " test sent." : label + " test failed: " + (result.error || "unknown error");
        await refreshLogs();
        await refreshLLMRequests();
      }
      refresh();
      setInterval(refreshLogs, 3000);
    </script>
  </body>
</html>`;
}
