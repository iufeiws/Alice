export function renderTokenUsageTab(): string {
  return `        <section id="main-token-usage" class="pane">
          <div class="usage-controls">
            <label for="tokenUsageRange">Range
              <select id="tokenUsageRange">
                <option value="24h">24h</option>
                <option value="7d">7d</option>
                <option value="30d">30d</option>
              </select>
            </label>
            <label for="tokenUsageBucket">Bucket
              <select id="tokenUsageBucket">
                <option value="hour">Hour</option>
                <option value="day">Day</option>
              </select>
            </label>
            <label for="tokenUsageModel">Model
              <select id="tokenUsageModel"><option value="all">all</option></select>
            </label>
            <label for="tokenUsageAgent">Agent
              <select id="tokenUsageAgent"><option value="all">all</option><option value="chat">chat</option><option value="talk">talk</option><option value="memorize">memorize</option><option value="pi">pi</option><option value="tts">tts</option></select>
            </label>
            <label for="tokenUsageCurrency">Currency
              <select id="tokenUsageCurrency"><option value="USD">USD</option><option value="CNY">CNY</option></select>
            </label>
            <button type="button" id="tokenUsageRefresh">Refresh</button>
          </div>
          <div id="tokenUsageMetrics" class="usage-grid"></div>
          <div id="tokenUsageChart" class="usage-chart">Loading...</div>
          <div id="tokenUsageModels"></div>
          <div id="tokenUsageLatest"></div>
        </section>`;
}
