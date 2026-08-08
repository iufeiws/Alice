export function renderFeishuPluginPanel(): string {
  return `            <div id="channel-feishu" class="pane active">
              <h2>Feishu</h2>
              <form id="feishu-form">
                <label><input id="feishuEnabled" name="enabled" type="checkbox" /> Enabled</label>
                <label for="feishuConnectionMode">Connection Mode</label>
                <input id="feishuConnectionMode" name="connectionMode" autocomplete="off" />
                <label><input id="feishuRequireMention" name="requireMention" type="checkbox" /> Require mention in groups</label>
                <h3>Accounts</h3>
                <div id="feishu-accounts"></div>
                <button type="button" id="feishu-add-account">Add Account</button>
                <button type="submit">Save</button>
                <button type="button" id="feishu-start">Start</button>
                <button type="button" id="feishu-stop" class="secondary">Stop</button>
                <p class="muted" id="feishu-status"></p>
              </form>
              <h2>Send Test</h2>
            <label for="testMarkdown">Markdown</label>
            <textarea id="testMarkdown" rows="5"></textarea>
              <button type="button" id="send-test-markdown">Send Markdown</button>
              <label for="testImagePath">Image Local Path</label>
              <input id="testImagePath" autocomplete="off" />
              <button type="button" id="send-test-image">Send Image</button>
              <label for="testAudioPath">Audio Local Path</label>
              <input id="testAudioPath" autocomplete="off" />
              <button type="button" id="send-test-audio">Send Audio</button>
              <p class="muted" id="send-test-status"></p>
            </div>`;
}
