export function renderWechatPluginScript(): string {
  return `      $("wechat-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const body = { enabled: $("wechatEnabled").checked, baseURL: form.get("baseURL"), pollTimeoutMs: form.get("pollTimeoutMs") };
        const result = await fetch("/admin/api/config/wechat", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("wechat-status").textContent = result.ok ? "WeChat config saved." : "Failed to save WeChat config.";
        await refresh();
      });
      let wechatLoginTimer;
      $("wechat-login").addEventListener("click", async () => {
        clearInterval(wechatLoginTimer);
        $("wechat-login-status").textContent = "Requesting QR code...";
        const r = await fetch("/admin/api/plugins/wechat/login/qrcode", { method: "POST" }).then((res) => res.json());
        if (!r.ok) {
          $("wechat-login-status").textContent = "Cannot get QR: " + (r.error || "unknown error");
          return;
        }
        if (r.qrcodeSvg) {
          $("wechat-qr").innerHTML = r.qrcodeSvg;
        } else if (r.qrcodeBase64) {
          const src = r.qrcodeBase64.startsWith("data:") ? r.qrcodeBase64 : "data:image/png;base64," + r.qrcodeBase64;
          $("wechat-qr").innerHTML = \`<img alt="WeChat login QR" src="\${escapeAttr(src)}" />\`;
        } else if (r.qrcodeUrl) {
          $("wechat-qr").innerHTML = \`<img alt="WeChat login QR" src="\${escapeAttr(r.qrcodeUrl)}" />\`;
        } else if (r.qrcodeContent) {
          $("wechat-qr").innerHTML = \`<pre>\${escapeHtml(r.qrcodeContent)}</pre>\`;
        } else {
          $("wechat-qr").innerHTML = \`<pre>\${escapeHtml(r.qrcode)}</pre>\`;
        }
        $("wechat-login-status").textContent = "Scan QR in WeChat, then confirm login on phone.";
        wechatLoginTimer = setInterval(async () => {
          const status = await fetch("/admin/api/plugins/wechat/login/status?qrcode=" + encodeURIComponent(r.qrcode)).then((res) => res.json());
          if (!status.ok) {
            $("wechat-login-status").textContent = "Login poll failed: " + (status.error || "unknown error");
            return;
          }
          $("wechat-login-status").textContent = "Login status: " + status.status;
          if (status.status === "confirmed" || status.status === "expired") {
            clearInterval(wechatLoginTimer);
            if (status.status === "confirmed") {
              $("wechat-status").textContent = "WeChat logged in and started.";
              await refresh();
            }
          }
        }, 2000);
      });
      $("wechat-start").addEventListener("click", async () => { const r = await fetch("/admin/api/plugins/wechat/start", { method: "POST" }).then((res) => res.json()); $("wechat-status").textContent = r.ok ? "WeChat runtime started." : "Cannot start WeChat: " + (r.error || "unknown error"); await refresh(); });
      $("wechat-stop").addEventListener("click", async () => { const r = await fetch("/admin/api/plugins/wechat/stop", { method: "POST" }).then((res) => res.json()); $("wechat-status").textContent = r.ok ? "WeChat runtime stopped." : "Cannot stop WeChat."; await refresh(); });
`;
}
