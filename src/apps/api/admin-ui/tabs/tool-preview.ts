export function renderToolPreviewTab(): string {
  return `        <section id="main-tool-preview" class="pane">
          <div class="tool-preview-grid">
            <div>
              <h2>Tool Return Preview</h2>
              <label for="toolPreviewSelect">Tool</label>
              <select id="toolPreviewSelect"></select>
              <label for="toolPreviewTarget">Target</label>
              <select id="toolPreviewTarget">
                <option value="feishu">Feishu</option>
                <option value="wechat">WeChat</option>
              </select>
              <label for="toolPreviewInput">Arguments JSON</label>
              <textarea id="toolPreviewInput" rows="12" spellcheck="false">{}</textarea>
              <div class="tool-preview-actions">
                <button type="button" id="tool-preview-run">Preview Return</button>
                <button type="button" id="tool-preview-reset" class="secondary">Reset Args</button>
              </div>
              <p class="muted" id="tool-preview-status"></p>
            </div>
            <div>
              <h2>Result</h2>
              <div id="toolPreviewResult" class="logs">Choose a tool and preview its return.</div>
            </div>
          </div>
        </section>`;
}
