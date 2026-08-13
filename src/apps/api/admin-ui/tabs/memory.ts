export function renderMemoryTab(): string {
  return `        <section id="main-memory" class="pane">
          <div>
            <h2>Memory</h2>
          <div class="memory-controls">
            <label for="memoryRunDate">Date
              <select id="memoryRunDate"></select>
            </label>
            <button type="button" id="memory-run-day">Run Selected Day</button>
            <button type="button" id="memory-clear-session" class="secondary">Clear Session</button>
            <button type="button" id="memory-undo-last" class="secondary">Undo Last Run</button>
            <button type="button" id="memory-redo-last" class="secondary">Redo Last Run</button>
            <button type="button" id="memory-delete-latest-sql" class="secondary">Delete Latest SQL</button>
          </div>
            <div class="memory-day-layout">
              <div class="memory-calendar" id="memoryCalendar"></div>
              <div class="memory-chat-panel">
                <h2>Selected Day Chat</h2>
                <div id="memoryDayMessages" class="logs memory-chat-preview">Choose a date to load chat records.</div>
              </div>
            </div>
            <p class="muted" id="memory-status"></p>
            <div id="memoryFiles">Loading...</div>
            <h2>Last Run</h2>
            <pre id="memoryRunResult">No memory run yet.</pre>
            <h2>Short Memory</h2>
            <div id="shortMemories" class="logs">Loading...</div>
          </div>
        </section>`;
}
