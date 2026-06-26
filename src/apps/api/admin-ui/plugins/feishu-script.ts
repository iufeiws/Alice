export function renderFeishuPluginScript(): string {
  return `      $("feishu-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const body = { enabled: $("feishuEnabled").checked, connectionMode: form.get("connectionMode"), appId: form.get("appId"), requireMention: $("feishuRequireMention").checked };
        const appSecret = form.get("appSecret");
        if (appSecret) body.appSecret = appSecret;
        const result = await fetch("/admin/api/config/feishu", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("feishu-status").textContent = result.ok ? "Feishu config saved." : "Failed to save Feishu config.";
        await refresh();
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
