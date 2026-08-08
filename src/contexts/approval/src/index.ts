import { randomUUID } from "node:crypto";
import type { FeishuCardActionEvent, FeishuDynamicCardClient } from "../../../channels/feishu/src/types.js";
import type { FeishuPairingStore } from "../../../channels/feishu/src/pairing.js";

export type ApprovalRequest = {
  title: string;
  content: string;
  /** 审批请求来源账户；未提供时用当前账户指针（默认账户）。 */
  accountId?: string;
};

export type ApprovalDecision =
  | { status: "approved"; comment: string }
  | { status: "rejected"; comment: string };

export type ApprovalService = {
  request(input: ApprovalRequest): Promise<ApprovalDecision>;
};

type PendingApproval = ApprovalRequest & {
  approverOpenId: string;
  accountId?: string;
  messageId?: string;
  resolve(decision: ApprovalDecision): void;
};

export function createFeishuApprovalService(input: {
  client: Pick<FeishuDynamicCardClient, "isStarted" | "createApprovalCard" | "deleteMessage">;
  pairingStore: FeishuPairingStore;
  /** 无显式账户上下文时解析默认账户（当前账户指针）。 */
  resolveAccount?(): string | undefined;
}): ApprovalService & { handleCardAction(event: FeishuCardActionEvent): Promise<unknown> } {
  const pending = new Map<string, PendingApproval>();

  return {
    request,
    handleCardAction
  };

  async function request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const title = request.title.trim();
    const content = request.content.trim();
    if (!title) throw new Error("Approval title is required");
    if (!content) throw new Error("Approval content is required");
    if (!input.client.isStarted()) throw new Error("Feishu client is not started");
    const accountId = request.accountId ?? input.resolveAccount?.();
    const contact = input.pairingStore.getPaired(accountId) ?? input.pairingStore.getPaired();
    const approverOpenId = contact?.userId;
    if (!approverOpenId) throw new Error("Feishu approval requires a paired user with open_id");

    const requestId = randomUUID();
    let resolve!: (decision: ApprovalDecision) => void;
    const decision = new Promise<ApprovalDecision>((done) => { resolve = done; });
    const approval: PendingApproval = { title, content, approverOpenId, accountId: contact.accountId, resolve };
    pending.set(requestId, approval);
    try {
      const card = await input.client.createApprovalCard({
        receiveIdType: "open_id",
        receiveId: approverOpenId,
        requestId,
        title,
        content,
        ...(contact.accountId ? { accountId: contact.accountId } : {})
      });
      approval.messageId = card.messageId;
    } catch (error) {
      pending.delete(requestId);
      throw error;
    }
    return await decision;
  }

  async function handleCardAction(event: FeishuCardActionEvent): Promise<unknown> {
    const action = parseAction(event.value);
    if (!action) return toast("无效的审批操作", "error");
    const approval = pending.get(action.requestId);
    if (!approval) return toast("审批已失效", "error");
    if (approval.accountId && event.accountId && event.accountId !== approval.accountId) return toast("审批账户不匹配", "error");
    if (event.operatorOpenId !== approval.approverOpenId) return toast("你不是该请求的审批人", "error");
    if (!event.messageId || event.messageId !== approval.messageId) return toast("审批卡片与请求不匹配", "error");

    const comment = typeof event.formValue.comment === "string" ? event.formValue.comment.trim() : "";
    const decision: ApprovalDecision = { status: action.decision, comment };
    pending.delete(action.requestId);
    try {
      await input.client.deleteMessage({
        messageId: event.messageId,
        ...(approval.accountId ? { accountId: approval.accountId } : {})
      });
    } catch (error) {
      pending.set(action.requestId, approval);
      throw error;
    }
    approval.resolve(decision);
    const result = `${decision.status === "approved" ? "已同意" : "已拒绝"}${comment ? `\n\n审批意见：${comment}` : ""}`;
    return toast(result, "success");
  }
}

function parseAction(value: unknown): { requestId: string; decision: ApprovalDecision["status"] } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const action = value as Record<string, unknown>;
  if (action.kind !== "approval" || typeof action.requestId !== "string") return undefined;
  if (action.decision !== "approved" && action.decision !== "rejected") return undefined;
  return { requestId: action.requestId, decision: action.decision };
}

function toast(content: string, type: "error" | "success") {
  return { toast: { type, content } };
}
