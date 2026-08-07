export function renderAdminTerminalScript(): string {
  return `      let terminalAutoRefreshPaused = false;
      let terminalRefreshInFlight = false;
      function setTerminalTab(name) {
        document.querySelectorAll("[data-terminal-tab]").forEach((button) => button.classList.toggle("active", button.dataset.terminalTab === name));
        document.querySelectorAll("#terminal-active-session,#terminal-system,#terminal-messages,#terminal-events").forEach((pane) => pane.classList.remove("active"));
        $("terminal-" + name).classList.add("active");
      }
      function toggleTerminalCollapsed() {
        const terminal = $("adminTerminal");
        terminal.classList.toggle("collapsed");
      }
      function updateTerminalAutoRefreshButton() {
        $("terminalCollapse").textContent = terminalAutoRefreshPaused ? "▶" : "Ⅱ";
        $("terminalCollapse").setAttribute("title", terminalAutoRefreshPaused ? "Resume terminal refresh" : "Pause terminal refresh");
        $("terminalCollapse").setAttribute("aria-label", terminalAutoRefreshPaused ? "Resume terminal refresh" : "Pause terminal refresh");
      }
      function toggleTerminalAutoRefreshPaused() {
        terminalAutoRefreshPaused = !terminalAutoRefreshPaused;
        updateTerminalAutoRefreshButton();
      }
      async function refreshTerminal(fullRefresh) {
        if (terminalRefreshInFlight) return;
        terminalRefreshInFlight = true;
        try {
          // 只刷新当前可见的面板: 终端折叠或对应 tab 未激活时不下发对应请求,
          // 避免后台每秒全量轮询(llm-requests 读取全部会话文件, 会占满事件循环)。
          const panes = fullRefresh ? ["active-session", "system", "messages", "events"] : visibleTerminalPanes();
          if (panes.includes("system")) await refreshSystemLogs();
          if (panes.includes("messages")) await refreshMessageLogs();
          if (panes.includes("events")) await refreshEventLogs();
          if (panes.includes("active-session")) await refreshActiveSessionTerminal();
        } finally {
          terminalRefreshInFlight = false;
        }
      }
      function visibleTerminalPanes() {
        if ($("adminTerminal").classList.contains("collapsed")) return [];
        return ["active-session", "system", "messages", "events"].filter((name) =>
          document.querySelector("#terminal-" + name)?.classList.contains("active")
        );
      }
      async function refreshSystemLogs() {
        const system = await fetch("/admin/api/logs").then((res) => res.json());
        $("logs").innerHTML = system.logs.map((entry) => \`<div class="log-line log-\${entry.level}">[\${entry.time}\${entry.utcTime ? " utc=" + entry.utcTime : ""}] [\${entry.level.toUpperCase()}] \${escapeHtml(entry.message)}</div>\`).join("");
        $("logs").scrollTop = $("logs").scrollHeight;
      }
      async function refreshMessageLogs() {
        const messages = await fetch("/admin/api/message-logs").then((res) => res.json());
        $("messageLogs").innerHTML = messages.logs.map((entry) => {
          const time = entry.createdAt || entry.time;
          const utc = entry.createdAtUtc || entry.timeUtc || "";
          const kind = entry.contentType || entry.kind;
          const target = entry.conversationId || entry.target || "";
          const summary = entry.contentText || entry.summary || "";
          const state = entry.status ? " " + entry.status : "";
          const flags = [entry.isRead ? "read" : "", entry.isRecalled ? "recalled" : ""].filter(Boolean).join(",");
          return \`<div class="log-line">[\${time}\${utc ? " utc=" + utc : ""}] [\${entry.direction}\${state}] [\${entry.plugin}/\${kind}] \${escapeHtml(target)}\${flags ? " · " + escapeHtml(flags) : ""} · \${escapeHtml(summary)}</div>\`;
        }).join("");
        $("messageLogs").scrollTop = $("messageLogs").scrollHeight;
      }
      async function refreshEventLogs() {
        const events = await fetch("/admin/api/message-event-logs").then((res) => res.json());
        $("eventLogs").innerHTML = events.logs.map((entry) => {
          const status = entry.status ? " " + entry.status : "";
          const target = entry.target || entry.sessionId || entry.rawMessageId || "";
          const error = entry.error ? " · error=" + entry.error : "";
          return \`<div class="log-line">[\${entry.time}] [\${entry.direction}\${status}] [\${entry.plugin}/\${entry.kind}] \${escapeHtml(target)} · \${escapeHtml(entry.summary || "")}\${escapeHtml(error)}</div>\`;
        }).join("");
        $("eventLogs").scrollTop = $("eventLogs").scrollHeight;
      }

`;
}
