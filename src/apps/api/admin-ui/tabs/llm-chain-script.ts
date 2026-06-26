export function renderLlmChainScript(): string {
  return `      async function refreshLLMRequests() {
        const payload = await fetch("/admin/api/llm-requests").then((res) => res.json());
        const blocks = [
          renderLLMRequestBlock("Current Prompt Profile Prebuild", payload.profilePreview),
          renderLLMRequestBlock("Latest Message Context Preview", payload.messagePreview),
          renderLLMRequestBlock("Latest Actual Request", payload.actual)
        ].filter(Boolean);
        $("llmRequests").innerHTML = blocks.length ? blocks.join("") : "No LLM request preview available.";
        $("llmRequests").scrollTop = 0;
      }

      async function refreshLLMChain() {
        const requestPayload = await fetch("/admin/api/llm-requests").then((res) => res.json());
        $("llmChainSessions").innerHTML = renderLLMSessionGroups(requestPayload.activeSession, requestPayload.clearedSessions || [], requestPayload.memorySessions || [], requestPayload.talkActiveSession, requestPayload.talkSessions || []);
        bindLLMSessionDetails("llmChainSessions");
        $("llmChainSessions").scrollTop = $("llmChainSessions").scrollHeight;
      }

      async function refreshActiveSessionTerminal() {
        const payload = await fetch("/admin/api/llm-requests").then((res) => res.json());
        $("activeSessionLogs").innerHTML = renderActiveSessionTerminalRows(payload.activeSession);
        $("activeSessionLogs").scrollTop = $("activeSessionLogs").scrollHeight;
      }

      function renderCurrentLLMSession(session) {
        return \`<div class="log-line">Active session #\${escapeHtml(session.id || "")} mode=\${escapeHtml(session.mode || "normal")} started=\${escapeHtml(session.startedAt || "")} updated=\${escapeHtml(session.updatedAt || "")} rounds=\${escapeHtml(session.roundCount ?? session.requestCount ?? 0)} messages=\${escapeHtml(session.messageCount ?? 0)}</div>\`;
      }

      function renderActiveSessionTerminalRows(session) {
        if (!session) return '<div class="log-line">Active session: none</div>';
        if (isActiveSessionWaiting(session)) return '<div class="log-line">waiting</div>';
        const latest = latestActiveSessionMessage(session);
        return \`<div class="log-line">[\${escapeHtml(latest.role)}] \${escapeHtml(latest.summary)}</div>\`;
      }

      function isActiveSessionWaiting(session) {
        if (session.currentRound && session.currentRound.status === "running") return true;
        const requestRound = typeof session.latestRequest?.round === "number" ? session.latestRequest.round : undefined;
        const responseRound = typeof session.latestResponse?.round === "number" ? session.latestResponse.round : undefined;
        return typeof requestRound === "number" && (typeof responseRound !== "number" || requestRound > responseRound);
      }

      function latestActiveSessionMessage(session) {
        if (session.latestMessage) {
          return {
            role: session.latestMessage.role || "unknown",
            summary: summarizeLLMMessageForRow(session.latestMessage)
          };
        }
        const messages = Array.isArray(session.messages) ? session.messages : [];
        const latest = messages[messages.length - 1];
        if (!latest) return { role: "none", summary: "No messages in active session." };
        return {
          role: latest.role || "unknown",
          summary: summarizeLLMMessageForRow(latest)
        };
      }

      function summarizeLLMMessageForRow(message) {
        if (typeof message.content === "string" && message.content.trim()) return compactLogText(message.content);
        if (Array.isArray(message.toolCalls) && message.toolCalls.length) {
          return "tool_calls: " + message.toolCalls.map((call) => call.function?.name || call.name || call.id || "unknown").join(", ");
        }
        if (message.reasoningContent) return compactLogText(message.reasoningContent);
        return JSON.stringify(message);
      }

      function compactLogText(value) {
        const text = String(value || "").replace(/\\s+/g, " ").trim();
        return text.length > 240 ? text.slice(0, 237) + "..." : text;
      }

      function renderLLMSessionGroups(activeSession, clearedSessions, memorySessions, talkActiveSession, talkSessions) {
        const active = activeSession ? renderCurrentLLMSession(activeSession) : '<div class="log-line">Active session: none</div>';
        const activeGroup = activeSession
          ? renderLLMSessionShell(activeSession, "Active Session")
          : "";
        const archived = sortedLLMSessions(clearedSessions).map((session) => renderLLMSessionShell(session, "Chat Saved Session")).join("");
        const talkActive = talkActiveSession ? renderCurrentLLMSession(talkActiveSession) : '<div class="log-line">Talk active session: none</div>';
        const talkActiveGroup = talkActiveSession
          ? renderLLMSessionShell(talkActiveSession, "Talk Active Session")
          : "";
        const talk = sortedLLMSessions(talkSessions).map((session) => renderLLMSessionShell(session, "Talk Saved Session")).join("");
        const memory = sortedLLMSessions(memorySessions).map((session) => renderLLMSessionShell(session, "Memorize")).join("");
        return [
          '<h2>Chat</h2>',
          archived || '<div class="log-line">Chat saved sessions: none</div>',
          active,
          activeGroup,
          '<h2>Talk</h2>',
          talk || '<div class="log-line">Talk saved sessions: none</div>',
          talkActive,
          talkActiveGroup,
          '<h2>Memorize</h2>',
          memory || '<div class="log-line">Memorize sessions: none</div>'
        ].join("");
      }

      function sortedLLMSessions(sessions) {
        return [...(sessions || [])].sort((left, right) => String(left.startedAt || "").localeCompare(String(right.startedAt || "")) || String(left.id || "").localeCompare(String(right.id || "")));
      }

      function renderLLMSessionShell(session, title) {
        const reason = session.reason ? \` · reason=\${escapeHtml(session.reason)}\` : "";
        const counts = \`\${escapeHtml(session.roundCount ?? session.requestCount ?? 0)} round(s) · \${escapeHtml(session.messageCount ?? 0)} message(s)\`;
        return \`<details class="log-line llm-session-detail" data-session-id="\${escapeAttr(session.id || "")}"><summary>\${escapeHtml(title)} \${escapeHtml(session.id || "")} · \${counts} · mode=\${escapeHtml(session.mode || "normal")} · \${escapeHtml(session.startedAt || "")}\${reason}</summary><div class="llm-session-body">Expand to load.</div></details>\`;
      }

      function bindLLMSessionDetails(containerId) {
        document.querySelectorAll(\`#\${containerId} details.llm-session-detail\`).forEach((detail) => {
          detail.addEventListener("toggle", async () => {
            if (!detail.open || detail.dataset.loaded === "true") return;
            const body = detail.querySelector(".llm-session-body");
            body.textContent = "Loading...";
            const payload = await fetch(\`/admin/api/llm-chain/session?id=\${encodeURIComponent(detail.dataset.sessionId || "")}\`).then((res) => res.json());
            const session = payload.session;
            if (!session) {
              body.textContent = "Session not found.";
              detail.dataset.loaded = "true";
              return;
            }
            body.innerHTML = renderLLMSession(session);
            detail.dataset.loaded = "true";
          });
        });
      }

      function renderLLMSession(session) {
        const entries = Array.isArray(session.jsonlEntries) && session.jsonlEntries.length
          ? session.jsonlEntries
          : [fallbackLLMSessionMetadata(session), ...(Array.isArray(session.messages) ? session.messages : [])];
        return entries.map((entry, index) => renderLLMSessionJsonlEntry(entry, index)).join("");
      }

      function fallbackLLMSessionMetadata(session) {
        return {
          id: session.id,
          startedAt: session.startedAt,
          updatedAt: session.updatedAt,
          mode: session.mode,
          modeStartedAt: session.modeStartedAt,
          modeExpiresAt: session.modeExpiresAt,
          fixedPrefixKind: session.fixedPrefixKind,
          fixedPrefixCursorMessageId: session.fixedPrefixCursorMessageId,
          currentRound: session.currentRound,
          latestRequest: session.latestRequest,
          latestResponse: session.latestResponse,
          clearedAt: session.clearedAt,
          reason: session.reason,
          archiveFilePath: session.archiveFilePath,
          messageCount: Array.isArray(session.messages) ? session.messages.length : session.messageCount
        };
      }

      function renderLLMSessionJsonlEntry(entry, index) {
        const isMeta = index === 0;
        const label = isMeta ? "[meta]" : "[message" + index + "]";
        const role = !isMeta && entry && typeof entry === "object" && entry.role ? " " + entry.role : "";
        const name = !isMeta && entry && typeof entry === "object" && entry.name ? " name=" + entry.name : "";
        return \`
          <details class="log-line">
            <summary>\${escapeHtml(label + role + name)}</summary>
            <pre>\${escapeHtml(JSON.stringify(entry, null, 2))}</pre>
          </details>
        \`;
      }

      function renderLLMTranscript(messages) {
        const parsed = renderParsedLLMMessages(messages);
        return parsed || '<div class="log-line">No messages archived.</div>';
      }

      function renderParsedLLMMessages(messages) {
        const list = Array.isArray(messages) ? messages : [];
        if (!list.length) return "";
        const unresolved = unresolvedPromptVariables(list);
        return [
          unresolved.length ? '<div class="log-line log-warn">unresolved variables\\n' + escapeHtml(unresolved.join("\\n")) + '</div>' : "",
          ...list.map((message, index) => renderParsedLLMMessage(message, index))
        ].join("");
      }

      function renderParsedLLMMessage(message, index) {
        const header = [
          "#" + (index + 1),
          "[" + (message.role || "unknown") + "]",
          message.name ? "name=" + message.name : "",
          message.toolCallId ? "tool_call_id=" + message.toolCallId : ""
        ].filter(Boolean).join(" ");
        const parts = [
          '<strong>' + escapeHtml(header) + '</strong>',
          message.content ? '<div>content</div><pre>' + escapeHtml(message.content) + '</pre>' : "",
          message.reasoningContent ? '<div>reasoning_content</div><pre>' + escapeHtml(message.reasoningContent) + '</pre>' : "",
          Array.isArray(message.toolCalls) && message.toolCalls.length
            ? '<div>tool_calls</div><pre>' + escapeHtml(JSON.stringify(message.toolCalls, null, 2)) + '</pre>'
            : ""
        ].filter(Boolean).join("\\n");
        return '<details class="log-line" open><summary>' + escapeHtml(header) + '</summary>' + parts + '</details>';
      }

      function unresolvedPromptVariables(value) {
        const text = JSON.stringify(value || "");
        const found = text.match(/\\{\\{\\s*[a-zA-Z0-9_/]+\\s*\\}\\}/g) || [];
        return [...new Set(found)].sort();
      }

      function renderLLMRequestBlock(title, current) {
        if (!current) return "";
        const raw = current.rawRequest || {
          model: current.model,
          temperature: current.temperature,
          messages: current.messages,
          tools: current.tools
        };
        return \`
          <div class="log-line">== \${escapeHtml(title)} ==</div>
          <div class="log-line">[\${escapeHtml(current.time || "")}] source=\${escapeHtml(current.source || "actual")} model=\${escapeHtml(current.model || "")} temperature=\${escapeHtml(current.temperature ?? "")}\${current.conversationId ? " conversation=" + escapeHtml(current.conversationId) : ""}</div>
          \${current.tools && current.tools.length ? \`<div class="log-line">tools\\n\${escapeHtml(current.tools.map((tool) => tool.function.name).join(", "))}</div>\` : ""}
          <div class="log-line">parsed messages</div>
          \${renderParsedLLMMessages(current.messages || [])}
          <div class="log-line">raw json\\n\${escapeHtml(JSON.stringify(raw, null, 2))}</div>
        \`;
      }
`;
}
