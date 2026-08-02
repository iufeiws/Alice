import { renderFeishuPluginPanel } from "./plugins/feishu.js";
import { renderWechatPluginPanel } from "./plugins/wechat.js";
export function renderAdminSidebar(): string {
  return `      <aside>
        <div class="side-head">
          <h1>Alice Admin</h1>
          <button id="collapse" class="secondary" type="button">≡</button>
        </div>
        <div class="tabbar">
          <button class="tab active" data-left-tab="llm" type="button">LLM Settings</button>
          <button class="tab" data-left-tab="feishu" type="button">Channel Settings</button>
          <button class="tab" data-left-tab="core" type="button">Alice Core</button>
          <button class="tab" data-left-tab="agent" type="button">Agent Settings</button>
        </div>
        <div class="panel-body">
          <div id="left-llm" class="pane active">
            <h2>LLM API</h2>
            <form id="llm-form">
              <label for="llmPresetSelect">API Preset</label>
              <select id="llmPresetSelect"></select>
              <label for="llmPresetName">Preset Name <span class="shell-marker" id="llmPresetMarker"></span></label>
              <input id="llmPresetName" autocomplete="off" placeholder="preset name" />
              <div class="prompt-actions">
                <button type="button" id="llm-preset-save">Save Preset</button>
                <button type="button" id="llm-preset-rename">Rename</button>
                <button type="button" id="llm-preset-delete" class="secondary">Delete</button>
              </div>
              <label for="baseURL">Base URL</label>
              <input id="baseURL" name="baseURL" autocomplete="off" />
              <label for="model">Model</label>
              <input id="model" name="model" autocomplete="off" />
              <label for="apiKey">API Key</label>
              <input id="apiKey" name="apiKey" type="password" placeholder="Leave blank to keep unchanged" autocomplete="new-password" />
              <label for="temperature">Temperature</label>
              <input id="temperature" name="temperature" inputmode="decimal" />
              <label for="maxTokens">Max Tokens (optional)</label>
              <input id="maxTokens" name="maxTokens" type="number" min="1" step="1" inputmode="numeric" />
              <label for="timeoutMs">Timeout Ms</label>
              <input id="timeoutMs" name="timeoutMs" inputmode="numeric" />
              <label><input id="streamEnabled" name="stream" type="checkbox" /> Streaming</label>
              <label><input id="supportsImage" name="supportsImage" type="checkbox" /> Supports Images</label>
              <label><input id="supportsAudio" name="supportsAudio" type="checkbox" /> Supports Audio</label>
              <label for="extraParams">Extra Params JSON</label>
              <textarea id="extraParams" name="extraParams" rows="6" spellcheck="false">{}</textarea>
              <label for="followupExtraParams">Follow-up Extra Params JSON</label>
              <textarea id="followupExtraParams" name="followupExtraParams" rows="6" spellcheck="false">{}</textarea>
              <p class="muted">First-call params apply to the first LLM request in a session; follow-up params apply to later tool-result requests. Object-body fragments are also accepted. For streaming token usage, include "stream_options":{"include_usage":true}.</p>
              <p class="muted" id="save-status"></p>
            </form>
            <h2>Runtime</h2>
            <pre id="config">Loading...</pre>
          </div>
          <div id="left-feishu" class="pane">
            <div class="subtabs">
              <button class="tab active" data-channel-tab="feishu" type="button">Feishu</button>
              <button class="tab" data-channel-tab="wechat" type="button">WeChat</button>
            </div>
${renderFeishuPluginPanel()}
${renderWechatPluginPanel()}
            <h2>Messaging Tools</h2>
            <button type="button" id="tool-view">View Messages</button>
            <label for="toolSearchContent">Search Content</label>
            <input id="toolSearchContent" autocomplete="off" />
            <label for="toolSearchDirection">Search Direction</label>
            <input id="toolSearchDirection" autocomplete="off" value="backward" />
            <button type="button" id="tool-search">Search Messages</button>
            <label for="toolSendType">Send Type</label>
            <input id="toolSendType" autocomplete="off" value="message" />
            <label for="toolSendContent">Send Content</label>
            <textarea id="toolSendContent" rows="4"></textarea>
            <button type="button" id="tool-send">Send Message</button>
            <pre id="tool-result">No tool run yet.</pre>
            <h2>Unique Bound Contact</h2>
            <pre id="pairings">Loading...</pre>
          </div>
          <div id="left-core" class="pane">
            <h2>Alice Core</h2>
            <form id="core-profile-form">
              <label for="appearanceDescription">Appearance Description</label>
              <textarea id="appearanceDescription" name="appearanceDescription" rows="12" spellcheck="false"></textarea>
              <label for="librarySetting">Library Setting</label>
              <textarea id="librarySetting" name="librarySetting" rows="8" spellcheck="false"></textarea>
              <button type="submit">Save Core Profile</button>
              <p class="muted" id="core-profile-status"></p>
            </form>
            <h2>Variables</h2>
            <pre id="coreProfilePreview">Loading...</pre>
          </div>
          <div id="left-agent" class="pane">
            <h2>Agent</h2>
            <form id="agent-form">
              <label for="projectUsername">Username</label>
              <input id="projectUsername" name="username" autocomplete="off" />
              <label for="inboundDebounceMs">Message Wait Ms</label>
              <input id="inboundDebounceMs" name="inboundDebounceMs" inputmode="numeric" />
              <label for="timezone">Timezone</label>
              <input id="timezone" name="timezone" autocomplete="off" />
              <label for="defaultTargetPlugin">Default Target Plugin</label>
              <select id="defaultTargetPlugin" name="defaultTargetPlugin">
                <option value="auto">auto</option>
                <option value="wechat">wechat</option>
                <option value="feishu">feishu</option>
              </select>
              <button type="submit">Save</button>
              <p class="muted" id="agent-status"></p>
            </form>
            <h2>State</h2>
            <form id="agent-state-form">
              <label for="agentStateSelect">State</label>
              <select id="agentStateSelect" name="state"></select>
              <label for="agentIntimacy">Intimacy</label>
              <input id="agentIntimacy" name="intimacy" inputmode="numeric" />
              <button type="submit">Save State</button>
              <pre id="agentStateSnapshot">Loading...</pre>
            </form>
            <h2>Runtime</h2>
            <button type="button" id="heartbeat-pause" class="secondary">Pause Heartbeat</button>
            <button type="button" id="heartbeat-resume">Start Heartbeat</button>
            <button type="button" id="process-now">Process Now</button>
            <pre id="runtimeStatus">Loading...</pre>
          </div>
        </div>
      </aside>`;
}
