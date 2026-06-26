export function renderAdminTerminal(): string {
  return `      <section id="adminTerminal" class="admin-terminal collapsed" aria-label="Terminal logs">
        <div class="admin-terminal-head">
          <strong class="admin-terminal-title">Terminal</strong>
          <button class="terminal-tab" data-terminal-tab="active-session" type="button" aria-label="Active Session">Active Session</button>
          <button class="terminal-tab active" data-terminal-tab="system" type="button" aria-label="System Log">System</button>
          <button class="terminal-tab" data-terminal-tab="messages" type="button" aria-label="Message Log">Message</button>
          <button class="terminal-tab" data-terminal-tab="events" type="button" aria-label="Event Log">Event</button>
          <div class="terminal-actions">
            <button id="terminalRefresh" class="terminal-action" type="button" title="Refresh logs" aria-label="Refresh logs">↻</button>
            <button id="terminalCollapse" class="terminal-action" type="button" title="Pause terminal refresh" aria-label="Pause terminal refresh">Ⅱ</button>
          </div>
        </div>
        <div class="admin-terminal-body">
          <div id="terminal-active-session" class="terminal-pane"><div id="activeSessionLogs" class="logs">Loading...</div></div>
          <div id="terminal-system" class="terminal-pane active"><div id="logs" class="logs">Loading...</div></div>
          <div id="terminal-messages" class="terminal-pane"><div id="messageLogs" class="logs">Loading...</div></div>
          <div id="terminal-events" class="terminal-pane"><div id="eventLogs" class="logs">Loading...</div></div>
        </div>
      </section>`;
}
