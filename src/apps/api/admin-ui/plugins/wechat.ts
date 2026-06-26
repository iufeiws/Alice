export function renderWechatPluginPanel(): string {
  return `            <div id="channel-wechat" class="pane">
              <h2>WeChat</h2>
              <form id="wechat-form">
                <label><input id="wechatEnabled" name="enabled" type="checkbox" /> Enabled</label>
                <label for="wechatBaseURL">iLink Base URL</label>
                <input id="wechatBaseURL" name="baseURL" autocomplete="off" />
                <label for="wechatPollTimeoutMs">Poll Timeout Ms</label>
                <input id="wechatPollTimeoutMs" name="pollTimeoutMs" inputmode="numeric" />
                <button type="submit">Save</button>
                <button type="button" id="wechat-login">Get Login QR</button>
                <button type="button" id="wechat-start">Start</button>
                <button type="button" id="wechat-stop" class="secondary">Stop</button>
                <p class="muted" id="wechat-status"></p>
              </form>
              <div id="wechat-qr" class="qr-box"><span class="muted">No QR code</span></div>
              <p class="muted" id="wechat-login-status"></p>
              <pre id="wechat-contacts">[]</pre>
            </div>`;
}
