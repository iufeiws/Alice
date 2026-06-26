import { renderAdminSidebar } from "./sidebar.js";
import { renderAdminTerminal } from "./terminal.js";
import { renderPromptsTab } from "./tabs/prompts.js";
import { renderShellsTab } from "./tabs/shells.js";
import { renderLlmRequestTab } from "./tabs/llm-request.js";
import { renderLlmChainTab } from "./tabs/llm-chain.js";
import { renderTokenUsageTab } from "./tabs/token-usage.js";
import { renderMemoryTab } from "./tabs/memory.js";
import { renderPluginsTab } from "./tabs/plugins.js";
import { renderInitiatedBehaviorsTab } from "./tabs/initiated-behaviors.js";
import { renderToolPreviewTab } from "./tabs/tool-preview.js";

export function renderAdminLayout(): string {
  return `
    <div id="shell" class="shell">
${renderAdminSidebar()}
      <main>
        <div class="tabbar main-tabs">
          <button class="tab active" data-main-tab="prompts" type="button">Prompt</button>
          <button class="tab" data-main-tab="shells" type="button">Shell</button>
          <button class="tab" data-main-tab="llm-chain" type="button">LLM Sessions</button>
          <button class="tab" data-main-tab="token-usage" type="button">Token Usage</button>
          <button class="tab" data-main-tab="memory" type="button">Memory</button>
          <button class="tab" data-main-tab="plugins" type="button">Plugin</button>
          <button class="tab" data-main-tab="initiated-behaviors" type="button">Initiated Behaviors</button>
          <button class="tab" data-main-tab="tool-preview" type="button">Tool Preview</button>
        </div>
${renderPromptsTab()}
${renderShellsTab()}
${renderLlmRequestTab()}
${renderLlmChainTab()}
${renderTokenUsageTab()}
${renderMemoryTab()}
${renderPluginsTab()}
${renderInitiatedBehaviorsTab()}
${renderToolPreviewTab()}
      </main>
${renderAdminTerminal()}
    </div>`;
}
