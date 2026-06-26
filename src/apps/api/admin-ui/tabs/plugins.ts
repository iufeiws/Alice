export function renderPluginsTab(): string {
  return `        <section id="main-plugins" class="pane">
          <div id="pluginListPanel">
            <div class="plugin-toolbar">
              <div>
                <h2>Plugin</h2>
                <p class="muted">Manage local plugins and their runtime switches.</p>
              </div>
              <label for="pluginSearch">Search plugins
                <input id="pluginSearch" autocomplete="off" placeholder="name, id, kind" />
              </label>
            </div>
            <div id="pluginGrid" class="plugin-grid">Loading...</div>
          </div>
          <section id="pluginConfigPanel" class="plugin-config pane">
            <div class="plugin-config-head">
              <button type="button" id="pluginBack" class="secondary">← Plugin</button>
              <h2 id="pluginConfigTitle">Plugin Config</h2>
            </div>
            <div id="pluginConfigBody">Choose a plugin to configure.</div>
          </section>
          <p class="muted" id="plugin-status"></p>
        </section>`;
}
