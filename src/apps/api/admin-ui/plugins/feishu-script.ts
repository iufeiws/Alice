export function renderFeishuPluginScript(): string {
  return `      function renderFeishuAccounts(accounts) {
        const container = $("feishu-accounts");
        container.innerHTML = "";
        const list = Array.isArray(accounts)
          ? accounts
          : accounts && typeof accounts === "object"
            ? Object.entries(accounts).map(([id, account]) => ({ id, ...account }))
            : [];
        if (list.length === 0) list.push({});
        list.forEach((account) => container.appendChild(feishuAccountRow(account)));
      }

      function feishuAccountRow(account) {
        const row = document.createElement("div");
        row.className = "feishu-account-row";
        row.innerHTML =
          '<label class="feishu-account-field">Account ID<input class="feishu-account-id" aria-label="Account ID" placeholder="e.g. main" value="' + escapeAttr(account.id || "") + '" /></label>' +
          '<label class="feishu-account-field">Name (optional)<input class="feishu-account-name" aria-label="Name (optional)" placeholder="e.g. Agent" value="' + escapeAttr(account.name || "") + '" /></label>' +
          '<label class="feishu-account-field">App ID<input class="feishu-account-appid" aria-label="App ID" placeholder="cli_xxx" value="' + escapeAttr(account.appId || "") + '" /></label>' +
          '<label class="feishu-account-field">App Secret<input class="feishu-account-secret" aria-label="App Secret" type="password" placeholder="' + (account.appSecretConfigured ? "Leave blank to keep unchanged" : "App Secret") + '" autocomplete="new-password" /></label>' +
          '<button type="button" class="feishu-account-remove">Remove</button>';
        row.querySelector(".feishu-account-remove").addEventListener("click", () => {
          row.remove();
          if ($("feishu-accounts").children.length === 0) $("feishu-accounts").appendChild(feishuAccountRow({}));
        });
        return row;
      }

      function collectFeishuAccounts() {
        return Array.from($("feishu-accounts").querySelectorAll(".feishu-account-row")).map((row) => {
          const account = {
            id: row.querySelector(".feishu-account-id").value.trim(),
            name: row.querySelector(".feishu-account-name").value.trim(),
            appId: row.querySelector(".feishu-account-appid").value.trim()
          };
          const secret = row.querySelector(".feishu-account-secret").value;
          if (secret) account.appSecret = secret;
          return account;
        }).filter((account) => account.id && account.appId);
      }

      $("feishu-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const body = {
          enabled: $("feishuEnabled").checked,
          connectionMode: form.get("connectionMode"),
          requireMention: $("feishuRequireMention").checked,
          accounts: collectFeishuAccounts()
        };
        const result = await fetch("/admin/api/config/feishu", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("feishu-status").textContent = result.ok ? "Feishu config saved." : "Failed to save Feishu config: " + (result.error || "unknown error");
        await refresh();
      });
      $("feishu-add-account").addEventListener("click", () => {
        $("feishu-accounts").appendChild(feishuAccountRow({}));
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
`;
}
