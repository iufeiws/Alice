import assert from "node:assert/strict";
import { test } from "node:test";
import { createFeishuApprovalService, type ApprovalDecision } from "../../../src/contexts/approval/src/index.js";
import type { FeishuCardActionEvent } from "../../../src/channels/feishu/src/types.js";
import type { FeishuPairingStore } from "../../../src/channels/feishu/src/pairing.js";

type CardCall = { receiveId: string; requestId: string; title: string; content: string };

function setup(options: { started?: boolean; paired?: boolean; sendError?: Error } = {}) {
  const calls: CardCall[] = [];
  const client = {
    isStarted: () => options.started !== false,
    async createApprovalCard(input: CardCall & { receiveIdType: "open_id" }) {
      calls.push(input);
      if (options.sendError) throw options.sendError;
      return { messageId: `om_${input.requestId}`, cardId: `card_${input.requestId}` };
    }
  };
  const contacts = options.paired === false ? [] : [{
    id: "feishu:dm:ou_user",
    plugin: "feishu" as const,
    userId: "ou_user",
    sessionId: "feishu:dm:ou_user",
    scope: "dm" as const,
    pairedAt: "2026-07-18T00:00:00.000",
    lastSeenAt: "2026-07-18T00:00:00.000",
    canInitiate: true
  }];
  const pairingStore: FeishuPairingStore = {
    list: () => contacts,
    isPaired: () => true,
    pairFromEvent() { throw new Error("unused"); }
  };
  return { calls, service: createFeishuApprovalService({ client, pairingStore }) };
}

function event(call: CardCall, decision: ApprovalDecision["status"], overrides: Partial<FeishuCardActionEvent> = {}): FeishuCardActionEvent {
  return {
    messageId: `om_${call.requestId}`,
    operatorOpenId: "ou_user",
    value: { kind: "approval", requestId: call.requestId, decision },
    formValue: {},
    ...overrides
  };
}

test("approval resolves approved and replaces the card", async () => {
  const { calls, service } = setup();
  const result = service.request({ title: " 修改 Prompt ", content: " proposed diff " });
  await Promise.resolve();
  assert.deepEqual(calls[0] && { ...calls[0], requestId: Boolean(calls[0].requestId) }, {
    receiveId: "ou_user",
    receiveIdType: "open_id",
    requestId: true,
    title: "修改 Prompt",
    content: "proposed diff"
  });

  const response = service.handleCardAction(event(calls[0], "approved")) as any;
  assert.equal(response.card.data.body.elements[0].content, "已同意");
  assert.deepEqual(response.card.data.body.elements[1], {
    tag: "collapsible_panel",
    expanded: false,
    header: { title: { tag: "plain_text", content: "原审批内容" } },
    elements: [{ tag: "markdown", content: "proposed diff" }]
  });
  assert.deepEqual(await result, { status: "approved" });
});

test("approval resolves rejected and revision requests", async () => {
  const rejectedSetup = setup();
  const rejected = rejectedSetup.service.request({ title: "A", content: "B" });
  await Promise.resolve();
  rejectedSetup.service.handleCardAction(event(rejectedSetup.calls[0], "rejected"));
  assert.deepEqual(await rejected, { status: "rejected" });

  const revisionSetup = setup();
  const revision = revisionSetup.service.request({ title: "A", content: "B" });
  await Promise.resolve();
  revisionSetup.service.handleCardAction(event(revisionSetup.calls[0], "revision_requested", {
    formValue: { revisionComment: "  保留原来的缓存层  " }
  }));
  assert.deepEqual(await revision, { status: "revision_requested", comment: "保留原来的缓存层" });
});

test("invalid actions do not settle a pending approval", async () => {
  const { calls, service } = setup();
  const result = service.request({ title: "A", content: "B" });
  await Promise.resolve();
  const call = calls[0];

  service.handleCardAction(event(call, "revision_requested"));
  service.handleCardAction(event(call, "approved", { operatorOpenId: "ou_other" }));
  service.handleCardAction(event(call, "approved", { messageId: "om_other" }));
  service.handleCardAction({ ...event(call, "approved"), value: { kind: "other", requestId: call.requestId, decision: "approved" } });
  service.handleCardAction(event(call, "approved"));

  assert.deepEqual(await result, { status: "approved" });
  const duplicate = service.handleCardAction(event(call, "rejected")) as any;
  assert.equal(duplicate.card.data.header.title.content, "审批已失效");
});

test("concurrent approvals are correlated by request id", async () => {
  const { calls, service } = setup();
  const first = service.request({ title: "First", content: "1" });
  const second = service.request({ title: "Second", content: "2" });
  await Promise.resolve();

  service.handleCardAction(event(calls[1], "rejected"));
  service.handleCardAction(event(calls[0], "approved"));

  assert.deepEqual(await Promise.all([first, second]), [{ status: "approved" }, { status: "rejected" }]);
});

test("approval fails before waiting when Feishu is unavailable", async () => {
  await assert.rejects(setup({ started: false }).service.request({ title: "A", content: "B" }), /not started/);
  await assert.rejects(setup({ paired: false }).service.request({ title: "A", content: "B" }), /paired user/);
  await assert.rejects(setup({ sendError: new Error("send failed") }).service.request({ title: "A", content: "B" }), /send failed/);
  await assert.rejects(setup().service.request({ title: " ", content: "B" }), /title is required/);
  await assert.rejects(setup().service.request({ title: "A", content: " " }), /content is required/);
});
