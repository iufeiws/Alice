export function renderCredentialsPluginScript(): string {
  return `      async function openCredentialManagement() {
        $("plugin-status").textContent = "Loading credentials...";
        $("pluginListPanel").style.display = "none";
        $("pluginConfigPanel").classList.add("active");
        $("pluginConfigTitle").textContent = "Credentials";
        $("pluginConfigBody").innerHTML = \`
          <div class="plugin-config-sections">
            <section class="plugin-config-section">
              <h2>Configured Credentials</h2>
              <div id="credentialList">Loading...</div>
            </section>
            <section class="plugin-config-section">
              <h2>Add API Key</h2>
              <div class="plugin-public-grid">
                <label for="credentialApiKeyId">Credential ID
                  <input id="credentialApiKeyId" autocomplete="off" placeholder="openai-main" />
                </label>
                <label for="credentialApiKeyLabel">Label
                  <input id="credentialApiKeyLabel" autocomplete="off" placeholder="OpenAI Main" />
                </label>
                <label for="credentialApiKeyProvider">Provider
                  <input id="credentialApiKeyProvider" autocomplete="off" value="openai-compatible" />
                </label>
              </div>
              <label for="credentialApiKeySecret">API Key
                <input id="credentialApiKeySecret" type="password" autocomplete="new-password" />
              </label>
              <button type="button" id="credential-api-key-add">Save API Key</button>
            </section>
            <section class="plugin-config-section">
              <h2>Connect xAI OAuth</h2>
              <div class="plugin-public-grid">
                <label for="credentialXaiId">Credential ID
                  <input id="credentialXaiId" autocomplete="off" placeholder="xai-supergrok" />
                </label>
                <label for="credentialXaiLabel">Label
                  <input id="credentialXaiLabel" autocomplete="off" placeholder="xAI / SuperGrok" />
                </label>
              </div>
              <button type="button" id="credential-xai-connect">Start Device Login</button>
              <div id="credentialXaiDevice"></div>
            </section>
            <p class="muted" id="credential-status"></p>
          </div>
        \`;
        $("credential-api-key-add").addEventListener("click", addApiKeyCredential);
        $("credential-xai-connect").addEventListener("click", startXaiDeviceLogin);
        await refreshCredentialManagement();
        $("plugin-status").textContent = "";
      }

      async function refreshCredentialManagement() {
        const payload = await fetch("/admin/api/credentials").then((res) => res.json());
        llmCredentials = payload.credentials || [];
        renderCredentialControls();
        const root = $("credentialList");
        if (!root) return;
        root.innerHTML = llmCredentials.length ? llmCredentials.map((credential) => \`
          <div class="log-line">
            <strong>\${escapeHtml(credential.label)}</strong> · \${escapeHtml(credential.id)} · \${escapeHtml(credential.kind)} · \${escapeHtml(credential.provider)} · \${escapeHtml(credential.status)}
            \${credential.accountLabel ? " · " + escapeHtml(credential.accountLabel) : ""}
            <button type="button" class="secondary" data-credential-remove="\${escapeAttr(credential.id)}" data-credential-kind="\${escapeAttr(credential.kind)}">\${credential.kind === "oauth" ? "Disconnect" : "Delete"}</button>
          </div>
        \`).join("") : '<p class="muted">No credentials configured.</p>';
        root.querySelectorAll("[data-credential-remove]").forEach((button) => button.addEventListener("click", async () => {
          await removeCredential(button.dataset.credentialRemove, button.dataset.credentialKind);
        }));
      }

      async function addApiKeyCredential() {
        const result = await fetch("/admin/api/credentials/api-key", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: $("credentialApiKeyId").value,
            label: $("credentialApiKeyLabel").value,
            provider: $("credentialApiKeyProvider").value,
            apiKey: $("credentialApiKeySecret").value
          })
        }).then((res) => res.json());
        $("credential-status").textContent = result.ok ? "API key credential saved." : "Credential save failed: " + (result.error || "unknown");
        $("credentialApiKeySecret").value = "";
        if (result.ok) await refreshCredentialManagement();
      }

      async function startXaiDeviceLogin() {
        const result = await fetch("/admin/api/credentials/xai/device", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ credentialId: $("credentialXaiId").value, label: $("credentialXaiLabel").value })
        }).then((res) => res.json());
        if (!result.ok || !result.session) {
          $("credential-status").textContent = "xAI login failed: " + (result.error || "unknown");
          return;
        }
        renderXaiDeviceSession(result.session);
        if (xaiDevicePollTimer) clearInterval(xaiDevicePollTimer);
        xaiDevicePollTimer = setInterval(() => pollXaiDeviceLogin(result.session.id), 2000);
      }

      function renderXaiDeviceSession(session) {
        const root = $("credentialXaiDevice");
        if (!root) return;
        const href = session.verificationUriComplete || session.verificationUri;
        root.innerHTML = \`<p>Status: \${escapeHtml(session.status)} · Code: <strong>\${escapeHtml(session.userCode)}</strong></p><p><a href="\${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">Open xAI authorization</a></p>\`;
      }

      async function pollXaiDeviceLogin(sessionId) {
        const result = await fetch("/admin/api/credentials/xai/device/" + encodeURIComponent(sessionId)).then((res) => res.json());
        if (!result.session) return;
        renderXaiDeviceSession(result.session);
        if (result.session.status === "pending") return;
        clearInterval(xaiDevicePollTimer);
        xaiDevicePollTimer = null;
        const status = $("credential-status");
        if (status) status.textContent = result.session.status === "connected" ? "xAI OAuth connected." : "xAI login ended: " + (result.session.error || result.session.status);
        if (result.session.status === "connected") {
          await refreshLLMApiPresets();
          if ($("credentialList")) await refreshCredentialManagement();
        }
      }

      async function removeCredential(id, kind) {
        const suffix = kind === "oauth" ? "/disconnect" : "";
        const method = kind === "oauth" ? "POST" : "DELETE";
        const result = await fetch("/admin/api/credentials/" + encodeURIComponent(id) + suffix, { method }).then((res) => res.json());
        $("credential-status").textContent = result.ok ? "Credential removed." : "Credential removal failed: " + (result.error || "unknown") + (result.references ? " · " + result.references.join(", ") : "");
        if (result.ok) await refreshCredentialManagement();
      }
`;
}
