export function renderLlmChainTab(): string {
  return `        <section id="main-llm-chain" class="pane">
          <button type="button" id="llm-run-cancel" class="secondary">Cancel Current Run</button>
          <button type="button" id="llm-chain-clear" class="secondary">Clear Active Session</button>
          <div class="llm-window">
            <h2>Sessions</h2>
            <div id="llmChainSessions" class="logs">No LLM session yet.</div>
          </div>
        </section>`;
}
