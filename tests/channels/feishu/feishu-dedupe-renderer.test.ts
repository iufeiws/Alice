import { test } from "node:test";
import assert from "node:assert/strict";
import { renderForFeishu } from "../../../src/channels/feishu/src/index.js";
import type { AgentOutput } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";

test("feishu renderer routes unmodified core Markdown to the supplied card", () => {
  const output: AgentOutput = {
    id: "out_1",
    target: { plugin: "feishu", channelId: "oc_chat", sessionId: "feishu:dm:oc_chat" },
    content: { kind: "markdown", markdown: "## Core text\n\n- **second line**" },
    meta: {
      createdAt: "2026-06-29T00:00:00.000",
      createdAtUtc: "2026-06-28T15:00:00.000Z",
      senderName: "core",
      urgency: "normal"
    }
  };

  const plan = renderForFeishu(output);

  assert.equal(plan.kind, "core-card");
  assert.equal(plan.markdown, "## Core text\n\n- **second line**");
});
