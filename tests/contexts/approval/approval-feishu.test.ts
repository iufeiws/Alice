import assert from "node:assert/strict";
import { test } from "node:test";
import { createFeishuApprovalService, type ApprovalDecision } from "../../../src/contexts/approval/src/index.js";
import type { FeishuCardActionEvent } from "../../../src/channels/feishu/src/types.js";
import type { FeishuPairingStore, FeishuPairedContact } from "../../../src/channels/feishu/src/pairing.js";

type CardCall = { receiveId: string; requestId: string; title: string; content: string };

function setup(options: { started?: boolean; paired?: boolean; sendError?: Error; deleteError?: Error } = {}) {
  const calls: CardCall[] = [];
  const deletedMessageIds: string[] = [];
  let deleteError = options.deleteError;
  const client = {
    isStarted: () => options.started !== false,
    async createApprovalCard(input: CardCall & { receiveIdType: "open_id" }) {
      calls.push(input);
      if (options.sendError) throw options.sendError;
      return { messageId: `om_${input.requestId}`, cardId: `card_${input.requestId}` };
    },
    async deleteMessage(input: { messageId: string }) {
      deletedMessageIds.push(input.messageId);
      if (deleteError) throw deleteError;
    }
  };
  const contacts: FeishuPairedContact[] = options.paired === false ? [] : [{
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
    getPaired: (accountId) => accountId ? contacts.find((contact) => contact.accountId === accountId) : contacts[0],
    isPaired: () => true,
    pairFromEvent() { throw new Error("unused"); }
  };
  return {
    calls,
    deletedMessageIds,
    service: createFeishuApprovalService({ client, pairingStore }),
    setDeleteError(error?: Error) { deleteError = error; }
  };
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

test("approval recalls its message before resolving approved", async () => {
  const { calls, deletedMessageIds, service } = setup();
  const result = service.request({ title: " 修改 Prompt ", content: " proposed diff " });
  await Promise.resolve();
  assert.deepEqual(calls[0] && { ...calls[0], requestId: Boolean(calls[0].requestId) }, {
    receiveId: "ou_user",
    receiveIdType: "open_id",
    requestId: true,
    title: "修改 Prompt",
    content: "proposed diff"
  });

  const response = await service.handleCardAction(event(calls[0], "approved", {
    formValue: { comment: "  保留原来的缓存层  " }
  }));
  assert.deepEqual(deletedMessageIds, [`om_${calls[0].requestId}`]);
  assert.deepEqual(response, { toast: { type: "success", content: "已同意\n\n审批意见：保留原来的缓存层" } });
  assert.deepEqual(await result, { status: "approved", comment: "保留原来的缓存层" });
});

test("approval resolves rejected with a comment", async () => {
  const rejectedSetup = setup();
  const rejected = rejectedSetup.service.request({ title: "A", content: "B" });
  await Promise.resolve();
  await rejectedSetup.service.handleCardAction(event(rejectedSetup.calls[0], "rejected", {
    formValue: { comment: "  需要重新设计  " }
  }));
  assert.deepEqual(await rejected, { status: "rejected", comment: "需要重新设计" });
});

test("invalid actions do not settle a pending approval", async () => {
  const { calls, service } = setup();
  const result = service.request({ title: "A", content: "B" });
  await Promise.resolve();
  const call = calls[0];

  await service.handleCardAction({ ...event(call, "approved"), value: { kind: "approval", requestId: call.requestId, decision: "revision_requested" } });
  await service.handleCardAction(event(call, "approved", { operatorOpenId: "ou_other" }));
  await service.handleCardAction(event(call, "approved", { messageId: "om_other" }));
  await service.handleCardAction({ ...event(call, "approved"), value: { kind: "other", requestId: call.requestId, decision: "approved" } });
  await service.handleCardAction(event(call, "approved"));

  assert.deepEqual(await result, { status: "approved", comment: "" });
  const duplicate = await service.handleCardAction(event(call, "rejected"));
  assert.deepEqual(duplicate, { toast: { type: "error", content: "审批已失效" } });
});

test("approval remains pending when message recall fails", async () => {
  const setupResult = setup({ deleteError: new Error("delete failed") });
  const result = setupResult.service.request({ title: "A", content: "B" });
  await Promise.resolve();
  const action = event(setupResult.calls[0], "rejected", { formValue: { comment: "重做" } });

  await assert.rejects(setupResult.service.handleCardAction(action), /delete failed/);
  setupResult.setDeleteError();
  await setupResult.service.handleCardAction(action);

  assert.deepEqual(setupResult.deletedMessageIds, [`om_${setupResult.calls[0].requestId}`, `om_${setupResult.calls[0].requestId}`]);
  assert.deepEqual(await result, { status: "rejected", comment: "重做" });
});

test("concurrent approvals are correlated by request id", async () => {
  const { calls, service } = setup();
  const first = service.request({ title: "First", content: "1" });
  const second = service.request({ title: "Second", content: "2" });
  await Promise.resolve();

  await service.handleCardAction(event(calls[1], "rejected"));
  await service.handleCardAction(event(calls[0], "approved"));

  assert.deepEqual(await Promise.all([first, second]), [
    { status: "approved", comment: "" },
    { status: "rejected", comment: "" }
  ]);
});

test("approval fails before waiting when Feishu is unavailable", async () => {
  await assert.rejects(setup({ started: false }).service.request({ title: "A", content: "B" }), /not started/);
  await assert.rejects(setup({ paired: false }).service.request({ title: "A", content: "B" }), /paired user/);
  await assert.rejects(setup({ sendError: new Error("send failed") }).service.request({ title: "A", content: "B" }), /send failed/);
  await assert.rejects(setup().service.request({ title: " ", content: "B" }), /title is required/);
  await assert.rejects(setup().service.request({ title: "A", content: " " }), /content is required/);
});

test("approval routes by the request account", async () => {
  const created: Array<{ receiveId: string; requestId: string; accountId?: string }> = [];
  const deleted: string[] = [];
  const contacts: FeishuPairedContact[] = [
    { id: "feishu:dm:ou_main", plugin: "feishu", accountId: "main", userId: "ou_main", sessionId: "feishu:dm:ou_main", scope: "dm", pairedAt: "2026-07-18T00:00:00.000", lastSeenAt: "2026-07-18T00:00:00.000", canInitiate: true },
    { id: "feishu:dm:ou_work", plugin: "feishu", accountId: "work", userId: "ou_work", sessionId: "feishu:dm:ou_work", scope: "dm", pairedAt: "2026-07-18T00:00:00.000", lastSeenAt: "2026-07-18T00:00:00.000", canInitiate: true }
  ];
  const client = {
    isStarted: () => true,
    async createApprovalCard(input: any) {
      created.push(input);
      return { messageId: `om_${input.requestId}`, cardId: `card_${input.requestId}` };
    },
    async deleteMessage(input: { messageId: string; accountId?: string }) {
      deleted.push(`${input.accountId ?? "?"}:${input.messageId}`);
    }
  };
  const pairingStore: FeishuPairingStore = {
    list: () => contacts,
    getPaired: (accountId) => accountId ? contacts.find((contact) => contact.accountId === accountId) : contacts[0],
    isPaired: () => true,
    pairFromEvent() { throw new Error("unused"); }
  };
  const service = createFeishuApprovalService({ client, pairingStore });

  const pending = service.request({ title: "A", content: "B", accountId: "work" });
  await Promise.resolve();
  assert.equal(created[0].receiveId, "ou_work");
  assert.equal(created[0].accountId, "work");

  await service.handleCardAction({
    messageId: `om_${created[0].requestId}`,
    operatorOpenId: "ou_work",
    value: { kind: "approval", requestId: created[0].requestId, decision: "approved" },
    formValue: {}
  });
  assert.deepEqual(deleted, [`work:om_${created[0].requestId}`]);
  assert.deepEqual(await pending, { status: "approved", comment: "" });
});
