export function renderPluginsScript(): string {
  return `      async function refreshPlugins() {
        if ($("pluginConfigPanel").classList.contains("active")) return;
        const payload = await fetch("/admin/api/plugins").then((res) => res.json());
        const query = ($("pluginSearch").value || "").toLowerCase().trim();
        const plugins = (payload.plugins || []).filter((plugin) => {
          const haystack = [plugin.id, plugin.name, plugin.kind, plugin.status, plugin.description].join(" ").toLowerCase();
          return !query || haystack.includes(query);
        });
        $("pluginGrid").innerHTML = plugins.length ? plugins.map(renderPluginCard).join("") : '<p class="muted">No plugins match this search.</p>';
      }

      function renderPluginCard(plugin) {
        const initial = String(plugin.name || plugin.id || "?").slice(0, 1).toUpperCase();
        const canConfig = Boolean(plugin.configurable);
        const canSwitch = Boolean(plugin.switchable);
        const enabled = plugin.status === "enabled" || plugin.status === "missing_config" || plugin.status === "error";
        return \`
          <div class="plugin-card" data-plugin-card="\${escapeAttr(plugin.id)}">
            <div class="plugin-card-head">
              <div class="plugin-icon">\${escapeHtml(initial)}</div>
              <div>
                <div class="plugin-title">\${escapeHtml(plugin.name || plugin.id)}</div>
                <div class="plugin-desc">\${escapeHtml(plugin.description || "")}</div>
              </div>
            </div>
            <div class="plugin-meta">
              <div>ID: \${escapeHtml(plugin.id)}</div>
              <div>Kind: \${escapeHtml(plugin.kind)}</div>
              <div class="plugin-state">\${escapeHtml(plugin.status)} · \${escapeHtml(plugin.health)}</div>
              \${plugin.configSource ? \`<div>Config: \${escapeHtml(plugin.configSource)}</div>\` : ""}
              \${plugin.lastLoadedAt ? \`<div>Loaded: \${escapeHtml(plugin.lastLoadedAt)}</div>\` : ""}
            </div>
            <div class="plugin-actions">
              <div>
                <button type="button" data-plugin-config="\${escapeAttr(plugin.id)}" \${canConfig ? "" : "disabled"}>Config</button>
                <button type="button" class="secondary" data-plugin-reload="\${escapeAttr(plugin.id)}" \${canConfig ? "" : "disabled"}>Reload</button>
              </div>
              <label class="plugin-switch">
                <input type="checkbox" data-plugin-switch="\${escapeAttr(plugin.id)}" \${enabled ? "checked" : ""} \${canSwitch ? "" : "disabled"} />
                <span class="plugin-switch-visual" aria-hidden="true"></span>
              </label>
            </div>
          </div>
        \`;
      }

      async function openPluginConfig(pluginId) {
        $("plugin-status").textContent = "Loading plugin config...";
        const payload = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/config").then((res) => res.json());
        if (payload.error) {
          $("plugin-status").textContent = "Cannot load plugin config: " + payload.error;
          return;
        }
        $("pluginListPanel").style.display = "none";
        $("pluginConfigPanel").classList.add("active");
        $("pluginConfigTitle").textContent = (payload.plugin && payload.plugin.name ? payload.plugin.name : pluginId) + " Config";
        renderPluginConfig(payload);
        $("plugin-status").textContent = "";
      }

      function setPluginFieldValue(field, value) {
        const input = document.querySelector('[data-plugin-field="' + cssEscape(field) + '"]');
        if (!input) return;
        if (input.type === "checkbox") {
          input.checked = Boolean(value);
        } else {
          input.value = value ?? "";
        }
      }
`;
}
