export function renderInitiatedBehaviorsTab(): string {
  return `        <section id="main-initiated-behaviors" class="pane">
          <div id="behaviorListPanel">
            <div class="behavior-toolbar">
              <div>
                <h2>Initiated Behaviors</h2>
                <p class="muted">Runtime plans and layer-based prompt profiles from src/contexts/agent-profile/prompts.</p>
              </div>
              <div class="behavior-toolbar-actions">
                <label for="behaviorNewId">New behavior
                  <input id="behaviorNewId" placeholder="custom_id" />
                </label>
                <label for="behaviorNewKind">Type
                  <select id="behaviorNewKind">
                    <option value="event">event</option>
                    <option value="randomized">randomized</option>
                  </select>
                </label>
                <button type="button" id="behaviorAdd">Add</button>
                <label for="behaviorTypeFilter">Filter
                  <select id="behaviorTypeFilter">
                    <option value="all">all</option>
                    <option value="event">event</option>
                    <option value="randomized">randomized</option>
                  </select>
                </label>
              </div>
            </div>
            <div class="behavior-layout">
              <div class="behavior-table-wrap">
                <table class="behavior-table" aria-label="Initiated behaviors">
                  <colgroup>
                    <col style="width: 6%" />
                    <col style="width: 5%" />
                    <col style="width: 5%" />
                    <col style="width: 15%" />
                    <col style="width: 8%" />
                    <col style="width: 19%" />
                    <col style="width: 9%" />
                    <col style="width: 11%" />
                    <col style="width: 9%" />
                    <col style="width: 8%" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Enabled</th>
                      <th>Weight</th>
                      <th>Priority</th>
                      <th>Behavior</th>
                      <th>Type</th>
                      <th>Source / Schedule</th>
                      <th>15m response</th>
                      <th>Last run</th>
                      <th>Health</th>
                      <th>Config</th>
                    </tr>
                  </thead>
                  <tbody id="behaviorTableBody">
                    <tr><td colspan="10" class="muted">Loading initiated behaviors...</td></tr>
                  </tbody>
                </table>
              </div>
              <div class="behavior-recent">
                <h2>Recent Runs</h2>
                <div class="behavior-recent-scroll">
                  <table class="behavior-recent-table">
                    <thead>
                      <tr><th>Time</th><th>Behavior</th><th>Type</th><th>Trigger</th><th>Result</th><th>15m</th><th>Session</th></tr>
                    </thead>
                    <tbody id="behaviorRunsBody">
                      <tr><td colspan="7" class="muted">Loading runs...</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <div class="behavior-chart">
                <h2>Randomized Response, 30 Minute Buckets</h2>
                <div id="behaviorChartBars" class="behavior-chart-bars" aria-label="Randomized response chart"></div>
                <div class="usage-legend"><span><i class="usage-swatch behavior-chart-responded"></i>responded within 15m</span><span><i class="usage-swatch behavior-chart-missed"></i>no response within 15m</span></div>
              </div>
            </div>
          </div>
          <section id="behaviorConfigPanel" class="behavior-config pane">
            <div class="behavior-config-head">
              <button type="button" id="behaviorBack" class="secondary">← Initiated Behaviors</button>
              <div class="behavior-config-title">
                <h2 id="behaviorConfigTitle">sleep_goodnight</h2>
                <p class="muted" id="behaviorConfigSummary">Goodnight and enter sleep cocoon.</p>
              </div>
              <div class="behavior-config-actions">
                <button type="button" id="behaviorConfigSave">Save</button>
                <button type="button" id="behaviorConfigReset" class="secondary">Reset</button>
              </div>
            </div>
            <div class="behavior-config-grid">
              <div class="behavior-config-box">
                <h2>Type</h2>
                <label for="behaviorConfigType">Type</label>
                <select id="behaviorConfigType">
                  <option value="event">event</option>
                  <option value="randomized">randomized</option>
                </select>
              </div>
              <div class="behavior-config-box" id="behaviorConfigSpecific"></div>
            </div>
            <div class="behavior-steps">
              <h2>Steps</h2>
              <div id="behaviorConfigSteps" class="behavior-step-list"></div>
            </div>
            <div class="behavior-config-box">
              <h2>Prompt Layers</h2>
              <div class="prompt-actions">
                <button type="button" id="behaviorLayerAdd">Add Layer</button>
                <button type="button" id="behaviorToolLayerAdd" class="secondary">Add Tool Request</button>
              </div>
              <div id="behaviorPromptLayerList"></div>
            </div>
            <div class="behavior-config-box behavior-layer-preview">
              <h2>Assembled Prompt Preview</h2>
              <div id="behaviorPromptPreview" class="logs">No prompt layers.</div>
            </div>
            <div class="behavior-recent">
              <h2>Recent Runs For This Behavior</h2>
              <div id="behaviorConfigRuns" class="behavior-recent-scroll"></div>
            </div>
          </section>
        </section>`;
}
