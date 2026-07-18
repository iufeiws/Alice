import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFeishuApprovalCard, normalizeFeishuCardActionEvent, serializeFeishuApprovalCard } from "../../../src/channels/feishu/src/client.js";

test("Feishu approval card contains content, revision input, and three decisions", () => {
  const card = buildFeishuApprovalCard({ requestId: "req_1", title: "审批标题", content: "**候选内容**" }) as any;
  assert.equal(card.schema, "2.0");
  assert.equal(card.header.title.content, "审批标题");
  assert.equal(card.body.elements[0].content, "**候选内容**");
  const form = card.body.elements[1];
  assert.equal(form.elements[0].name, "revisionComment");
  assert.equal(form.elements[0].max_length, 1000);
  const buttons = form.elements[1].columns.map((column: any) => column.elements[0]);
  assert.deepEqual(buttons.map((button: any) => button.text.content), ["同意", "拒绝", "修改"]);
  assert.deepEqual(buttons.map((button: any) => button.value), [
    { kind: "approval", requestId: "req_1", decision: "approved" },
    { kind: "approval", requestId: "req_1", decision: "rejected" },
    { kind: "approval", requestId: "req_1", decision: "revision_requested" }
  ]);
});

test("Feishu approval card enforces the 30 KB serialized limit", () => {
  assert.throws(() => serializeFeishuApprovalCard({ requestId: "req_1", title: "A", content: "x".repeat(31 * 1024) }), /exceeds 30 KB/);
});

test("Feishu card action callback is normalized", () => {
  assert.deepEqual(normalizeFeishuCardActionEvent({
    operator: { open_id: "ou_user" },
    context: { open_message_id: "om_1", open_chat_id: "oc_1" },
    action: {
      value: { kind: "approval", requestId: "req_1", decision: "approved" },
      form_value: { revisionComment: "change it" }
    }
  }), {
    messageId: "om_1",
    chatId: "oc_1",
    operatorOpenId: "ou_user",
    value: { kind: "approval", requestId: "req_1", decision: "approved" },
    formValue: { revisionComment: "change it" }
  });
});
