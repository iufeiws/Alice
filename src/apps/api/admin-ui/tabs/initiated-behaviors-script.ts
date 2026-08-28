export function renderInitiatedBehaviorsScript(): string {
  return `      let initiatedBehaviorPayload = { plans: [], runs: [], buckets: [] };
      let behaviorConfigId = "";
      let behaviorConfigLayerDocument = { meta: {}, messages: [] };
      const initiatedBehaviorSummaries = {
        sleep_goodnight: "Event behavior with backend sleep_cocoon action=in before the LLM prompt.",
        sleep_morning: "Event behavior for the normal wake transition.",
        sleep_force_wake: "Event behavior for forced wake; distinct from ordinary morning.",
        ritual: "Randomized ritual initiation for dates, holidays, and lightweight greetings.",
        review: "Randomized review initiation for open loops and recent context.",
        story: "Randomized low-frequency first-person story snippet.",
        care: "Randomized low-interruption care check-in.",
        share: "Randomized content share tied to recent interests.",
        invite: "Randomized invitation to a small shared activity.",
        real_world_suggestion: "Randomized real-world suggestion such as food, rest, or sleep."
      };
      async function refreshInitiatedBehaviors() {
        try {
          const response = await fetch("/admin/api/initiated-behaviors");
          initiatedBehaviorPayload = await response.json();
        } catch (error) {
          initiatedBehaviorPayload = { plans: [], runs: [], buckets: [] };
          $("behaviorTableBody").innerHTML = '<tr><td colspan="10" class="muted">Failed to load initiated behaviors.</td></tr>';
          $("behaviorRunsBody").innerHTML = '<tr><td colspan="7" class="muted">Failed to load runs.</td></tr>';
          $("behaviorChartBars").innerHTML = "";
          return;
        }
        renderInitiatedBehaviorList();
      }
      function renderInitiatedBehaviorList() {
        const typeFilter = $("behaviorTypeFilter")?.value || "all";
        const plans = (initiatedBehaviorPayload.plans || []).filter((plan) => typeFilter === "all" || plan.kind === typeFilter);
        const runs = initiatedBehaviorPayload.runs || [];
        $("behaviorTableBody").innerHTML = plans.map((plan) => {
          const responseRatio = behaviorResponseRatio(plan.id, runs);
          const lastRun = runs.find((run) => run.behaviorId === plan.id);
          const source = plan.kind === "event" ? (plan.triggerEvent || "-") : "randomized";
          const weight = plan.kind === "event" ? "-" : valueOrDash(plan.weight);
          const priority = plan.kind === "event" ? "-" : valueOrDash(plan.priority);
          const health = plan.availability?.status === "unavailable" ? "unavailable" : plan.enabled ? "ok" : "disabled";
          return '<tr class="behavior-row" data-behavior-row="' + escapeAttr(plan.id) + '">' +
            '<td><label class="plugin-switch" title="Toggle behavior"><input type="checkbox" data-behavior-enabled="' + escapeAttr(plan.id) + '" ' + (plan.enabled ? "checked " : "") + '/><span class="plugin-switch-visual"></span></label></td>' +
            '<td>' + escapeHtml(weight) + '</td>' +
            '<td>' + escapeHtml(priority) + '</td>' +
            '<td><span class="behavior-id">' + escapeHtml(plan.id) + '</span></td>' +
            '<td><span class="behavior-kind ' + escapeAttr(plan.kind) + '">' + escapeHtml(plan.kind) + '</span></td>' +
            '<td>' + escapeHtml(source) + '</td>' +
            '<td>' + escapeHtml(responseRatio) + '</td>' +
            '<td>' + escapeHtml(lastRun ? formatAdminTime(lastRun.triggeredAt) : "never") + '</td>' +
            '<td><span class="behavior-status ' + (health === "ok" ? "on" : "") + '">' + escapeHtml(health) + '</span></td>' +
            '<td><div class="behavior-table-actions"><button type="button" data-behavior-config="' + escapeAttr(plan.id) + '">Config</button>' + (plan.custom || plan.kind === "randomized" ? '<button type="button" class="secondary" data-behavior-delete="' + escapeAttr(plan.id) + '">Delete</button>' : "") + '</div></td>' +
          '</tr>';
        }).join("") || '<tr><td colspan="10" class="muted">No initiated behavior plans.</td></tr>';
        document.querySelectorAll("[data-behavior-config]").forEach((button) => button.addEventListener("click", () => openInitiatedBehaviorConfig(button.dataset.behaviorConfig)));
        document.querySelectorAll("[data-behavior-delete]").forEach((button) => button.addEventListener("click", () => deleteInitiatedBehavior(button.dataset.behaviorDelete)));
        document.querySelectorAll("[data-behavior-enabled]").forEach((input) => input.addEventListener("change", () => setInitiatedBehaviorEnabled(input.dataset.behaviorEnabled, input.checked, input)));
        renderInitiatedBehaviorRuns(runs);
        renderInitiatedBehaviorChart(initiatedBehaviorPayload.buckets || []);
      }
      async function createInitiatedBehavior() {
        const id = $("behaviorNewId").value.trim();
        const kind = $("behaviorNewKind").value === "randomized" ? "randomized" : "event";
        if (!/^[A-Za-z0-9_-]+$/.test(id)) {
          alert("Behavior id must use letters, numbers, underscores, or hyphens.");
          return;
        }
        $("behaviorAdd").disabled = true;
        try {
          const body = kind === "randomized"
            ? { id, kind, enabled: true, weight: 0, priority: 0, promptProfile: { meta: {}, messages: [] } }
            : { id, kind, enabled: true, triggerEvent: "", promptProfile: { meta: {}, messages: [] } };
          const response = await fetch("/admin/api/initiated-behaviors", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
          if (!response.ok) throw new Error(await response.text());
          $("behaviorNewId").value = "";
          await refreshInitiatedBehaviors();
          openInitiatedBehaviorConfig(id);
        } catch (error) {
          alert("Failed to add behavior: " + (error && error.message ? error.message : String(error)));
        } finally {
          $("behaviorAdd").disabled = false;
        }
      }
      async function deleteInitiatedBehavior(id) {
        if (!id || !confirm("Delete behavior " + id + "?")) return;
        try {
          const response = await fetch("/admin/api/initiated-behaviors/" + encodeURIComponent(id), { method: "DELETE" });
          if (!response.ok) throw new Error(await response.text());
          if (behaviorConfigId === id) closeInitiatedBehaviorConfig();
          await refreshInitiatedBehaviors();
        } catch (error) {
          alert("Failed to delete behavior: " + (error && error.message ? error.message : String(error)));
        }
      }
      async function setInitiatedBehaviorEnabled(id, enabled, input) {
        if (!id) return;
        input.disabled = true;
        try {
          const response = await fetch("/admin/api/initiated-behaviors/" + encodeURIComponent(id), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled })
          });
          if (!response.ok) throw new Error(await response.text());
          await refreshInitiatedBehaviors();
        } catch (error) {
          input.checked = !enabled;
          input.disabled = false;
          alert("Failed to update behavior: " + (error && error.message ? error.message : String(error)));
        }
      }
      function renderInitiatedBehaviorRuns(runs) {
        $("behaviorRunsBody").innerHTML = (runs || []).map((run) =>
          '<tr><td>' + escapeHtml(formatAdminTime(run.triggeredAt)) + '</td><td>' + escapeHtml(run.behaviorId) + '</td><td>' + escapeHtml(run.kind) + '</td><td>' + escapeHtml(run.trigger || "-") + '</td><td>' + escapeHtml(run.result || "-") + '</td><td>' + escapeHtml(formatBool(run.respondedWithin15m)) + '</td><td>' + escapeHtml(run.sessionId || "-") + '</td></tr>'
        ).join("") || '<tr><td colspan="7" class="muted">No runs recorded.</td></tr>';
      }
      function renderInitiatedBehaviorChart(buckets) {
        const maxTotal = Math.max(1, ...(buckets || []).map((bucket) => Number(bucket.total) || 0));
        $("behaviorChartBars").innerHTML = (buckets || []).map((bucket) => {
          const responded = Number(bucket.respondedWithin15m) || 0;
          const missed = Number(bucket.notRespondedWithin15m) || 0;
          const respondedHeight = Math.max(0, Math.round((responded / maxTotal) * 84));
          const missedHeight = Math.max(0, Math.round((missed / maxTotal) * 84));
          const title = formatAdminTime(bucket.startAt) + " total " + valueOrDash(bucket.total);
          return '<div class="behavior-chart-bar-wrap" title="' + escapeAttr(title) + '"><div class="behavior-chart-bar"><span class="behavior-chart-responded" style="height: ' + respondedHeight + 'px"></span><span class="behavior-chart-missed" style="height: ' + missedHeight + 'px"></span></div></div>';
        }).join("");
      }
      function openInitiatedBehaviorConfig(id) {
        const detail = (initiatedBehaviorPayload.plans || []).find((plan) => plan.id === id);
        if (!detail) return;
        behaviorConfigId = id;
        behaviorConfigLayerDocument = cloneLayerDocument(detail.promptProfile);
        $("behaviorListPanel").style.display = "none";
        $("behaviorConfigPanel").classList.add("active");
        $("behaviorConfigPanel").style.display = "block";
        $("behaviorConfigTitle").textContent = detail.id;
        $("behaviorConfigSummary").textContent = initiatedBehaviorSummaries[detail.id] || "";
        $("behaviorConfigType").value = detail.kind;
        $("behaviorConfigType").onchange = () => {
          renderBehaviorConfigSpecific();
          renderBehaviorLayerEditor();
        };
        const triggerLabel = detail.kind === "event" ? (detail.triggerEvent || "event") : "randomized";
        renderBehaviorConfigSpecific(detail);
        $("behaviorConfigSteps").innerHTML = (detail.steps || []).map((step, index) => {
          const status = detail.availability?.steps?.[index];
          return '<div class="behavior-step-item"><strong>' + escapeHtml(step.kind) + '</strong><div>' + escapeHtml(formatBehaviorStepDetail(step)) + '</div>' + (step.arguments ? '<div class="muted">' + escapeHtml(JSON.stringify(step.arguments)) + '</div>' : "") + (status ? '<div class="muted">' + escapeHtml(status.status + (status.reason ? ": " + status.reason : "")) + '</div>' : "") + '</div>';
        }).join("") || '<p class="muted">No steps configured.</p>';
        renderBehaviorLayerEditor();
        const runs = (initiatedBehaviorPayload.runs || []).filter((run) => run.behaviorId === id);
        $("behaviorConfigRuns").innerHTML = '<table class="behavior-recent-table"><thead><tr><th>Time</th><th>Trigger</th><th>Result</th><th>15m</th><th>Session</th></tr></thead><tbody>' + (runs.map((run) => '<tr><td>' + escapeHtml(formatAdminTime(run.triggeredAt)) + '</td><td>' + escapeHtml(run.trigger || triggerLabel) + '</td><td>' + escapeHtml(run.result || "-") + '</td><td>' + escapeHtml(formatBool(run.respondedWithin15m)) + '</td><td>' + escapeHtml(run.sessionId || "-") + '</td></tr>').join("") || '<tr><td colspan="5" class="muted">No runs recorded.</td></tr>') + '</tbody></table>';
      }
      function renderBehaviorConfigSpecific(detail) {
        const current = detail || (initiatedBehaviorPayload.plans || []).find((plan) => plan.id === behaviorConfigId) || {};
        const kind = $("behaviorConfigType").value;
        $("behaviorConfigSpecific").innerHTML = kind === "event"
          ? '<h2>Event</h2><label for="behaviorConfigTriggerEvent">triggerEvent</label><input id="behaviorConfigTriggerEvent" value="' + escapeAttr(current.triggerEvent || "") + '" />'
          : '<h2>Randomized</h2><label for="behaviorConfigWeight">Weight</label><input id="behaviorConfigWeight" type="number" step="0.01" value="' + escapeAttr(valueOrDash(current.weight) === "-" ? "0" : valueOrDash(current.weight)) + '" /><label for="behaviorConfigPriority">Priority</label><input id="behaviorConfigPriority" type="number" step="1" value="' + escapeAttr(valueOrDash(current.priority) === "-" ? "0" : valueOrDash(current.priority)) + '" />';
      }
      function renderBehaviorLayerEditor() {
        const randomized = $("behaviorConfigType").value === "randomized";
        $("behaviorPromptLayerList").innerHTML = renderLayerDocument(behaviorConfigLayerDocument, {
          editorId: "behavior",
          roles: randomized ? ["user", "assistant"] : ["user", "assistant", "tool"],
          showName: !randomized
        }) || '<p class="muted">No prompt messages yet.</p>';
        bindLayerDocument(behaviorConfigLayerDocument, {
          editorId: "behavior",
          render: renderBehaviorLayerEditor,
          onInput: renderBehaviorPromptPreview
        });
        renderBehaviorPromptPreview();
      }
      function addBehaviorLayer(toolCall = false) {
        const randomized = $("behaviorConfigType").value === "randomized";
        addLayerMessage(behaviorConfigLayerDocument, {
          title: "Message " + (behaviorConfigLayerDocument.messages.length + 1),
          role: randomized ? "assistant" : "user",
          toolCall,
          toolName: "Chat"
        });
        renderBehaviorLayerEditor();
      }
      function renderBehaviorPromptPreview() {
        const messages = behaviorConfigLayerDocument.messages
          .filter((message) => message.meta?.enabled !== false)
          .map((message) => behaviorMessageToPreview(message));
        $("behaviorPromptPreview").innerHTML = messages.length
          ? renderLLMRequestBlock("Initiated Behavior Prompt · " + behaviorConfigId, {
            source: "initiated-behavior-config",
            model: "preview",
            temperature: "",
            messages,
            tools: []
          })
          : "No enabled prompt messages.";
      }
      function behaviorMessageToPreview(message) {
        const { meta, ...preview } = message;
        const rendered = {
          ...preview,
          name: message.name ? renderPromptPreviewText(message.name) : undefined,
          content: typeof message.content === "string" ? renderPromptPreviewText(message.content) : message.content,
          reasoningContent: message.reasoningContent ? renderPromptPreviewText(message.reasoningContent) : undefined
        };
        if (Array.isArray(message.toolCalls)) rendered.toolCalls = cloneToolCalls(message.toolCalls).map((call) => ({
            ...call,
            function: {
              name: call.function.name,
              arguments: renderPromptPreviewText(call.function.arguments)
            }
          }));
        return rendered;
      }
      function renderPromptPreviewText(value) {
        return String(value || "").replace(/\$\{\{\s*([a-zA-Z0-9_/]+)\s*\}\}/g, (match, key) => {
          const resolved = promptVariables && Object.prototype.hasOwnProperty.call(promptVariables, key) ? promptVariables[key] : undefined;
          if (resolved === undefined || resolved === null) return match;
          return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
        });
      }
      function bindBehaviorLayerEditorEvents() {
        // Behavior prompt layer events are bound after each render, matching the main Prompt page.
      }
      async function saveBehaviorConfig() {
        if (!behaviorConfigId) return;
        const detail = (initiatedBehaviorPayload.plans || []).find((plan) => plan.id === behaviorConfigId);
        const kind = $("behaviorConfigType").value === "randomized" ? "randomized" : "event";
        const body = {
          kind,
          promptProfile: behaviorConfigLayerDocument
        };
        if (typeof detail?.enabled === "boolean") body.enabled = detail.enabled;
        if (kind === "event") {
          body.triggerEvent = $("behaviorConfigTriggerEvent")?.value || "";
        } else {
          body.weight = Number($("behaviorConfigWeight")?.value) || 0;
          body.priority = Number($("behaviorConfigPriority")?.value) || 0;
        }
        $("behaviorConfigSave").disabled = true;
        try {
          const response = await fetch("/admin/api/initiated-behaviors/" + encodeURIComponent(behaviorConfigId), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
          if (!response.ok) throw new Error(await response.text());
          await refreshInitiatedBehaviors();
          openInitiatedBehaviorConfig(behaviorConfigId);
        } catch (error) {
          alert("Failed to save behavior: " + (error && error.message ? error.message : String(error)));
        } finally {
          $("behaviorConfigSave").disabled = false;
        }
      }
      function resetBehaviorConfig() {
        if (behaviorConfigId) openInitiatedBehaviorConfig(behaviorConfigId);
      }
      function closeInitiatedBehaviorConfig() {
        $("behaviorConfigPanel").classList.remove("active");
        $("behaviorConfigPanel").style.display = "none";
        $("behaviorListPanel").style.display = "block";
      }
      function behaviorResponseRatio(id, runs) {
        const scoped = (runs || []).filter((run) => run.behaviorId === id && typeof run.respondedWithin15m === "boolean");
        if (!scoped.length) return "-";
        const responded = scoped.filter((run) => run.respondedWithin15m === true).length;
        return Math.round((responded / scoped.length) * 100) + "%";
      }
      function formatBehaviorStepDetail(step) {
        if (step.kind === "backend_effect") return step.effect || "";
        if (step.kind === "llm_instruction") return step.promptProfilePath || "";
        if (step.kind === "record_only") return step.reason || "";
        return "";
      }
      function valueOrDash(value) {
        if (value === undefined || value === null || value === "") return "-";
        return String(value);
      }
      function formatBool(value) {
        if (value === true) return "yes";
        if (value === false) return "no";
        return "-";
      }
      function formatAdminTime(value) {
        if (!value) return "-";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString();
      }
`;
}
