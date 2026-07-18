import { randomUUID } from "node:crypto";
import type { FeishuCardActionEvent, FeishuDynamicCardClient } from "../../../channels/feishu/src/types.js";
import type { FeishuPairingStore } from "../../../channels/feishu/src/pairing.js";

export type ApprovalRequest = {
  title: string;
  content: string;
};

export type ApprovalDecision =
  | { status: "approved" }
  | { status: "rejected" }
  | { status: "revision_requested"; comment: string };

export type ApprovalService = {
  request(input: ApprovalRequest): Promise<ApprovalDecision>;
};

type PendingApproval = ApprovalRequest & {
  approverOpenId: string;
  messageId?: string;
  resolve(decision: ApprovalDecision): void;
};

export function createFeishuApprovalService(input: {
  client: Pick<FeishuDynamicCardClient, "isStarted" | "createApprovalCard">;
  pairingStore: FeishuPairingStore;
}): ApprovalService & { handleCardAction(event: FeishuCardActionEvent): unknown } {
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
    const approverOpenId = input.pairingStore.list()[0]?.userId;
    if (!approverOpenId) throw new Error("Feishu approval requires a paired user with open_id");

    const requestId = randomUUID();
    let resolve!: (decision: ApprovalDecision) => void;
    const decision = new Promise<ApprovalDecision>((done) => { resolve = done; });
    const approval: PendingApproval = { title, content, approverOpenId, resolve };
    pending.set(requestId, approval);
    try {
      const card = await input.client.createApprovalCard({
        receiveIdType: "open_id",
        receiveId: approverOpenId,
        requestId,
        title,
        content
      });
      approval.messageId = card.messageId;
    } catch (error) {
      pending.delete(requestId);
      throw error;
    }
    return await decision;
  }

  function handleCardAction(event: FeishuCardActionEvent): unknown {
    const action = parseAction(event.value);
    if (!action) return toast("无效的审批操作", "error");
    const approval = pending.get(action.requestId);
    if (!approval) return completedCard("审批已失效", "该审批请求已处理或服务已重启。", "grey");
    if (event.operatorOpenId !== approval.approverOpenId) return toast("你不是该请求的审批人", "error");
    if (!event.messageId || event.messageId !== approval.messageId) return toast("审批卡片与请求不匹配", "error");

    let decision: ApprovalDecision;
    if (action.decision === "revision_requested") {
      const comment = typeof event.formValue.revisionComment === "string" ? event.formValue.revisionComment.trim() : "";
      if (!comment) return toast("请先填写修改意见", "warning");
      decision = { status: "revision_requested", comment };
    } else {
      decision = { status: action.decision };
    }
    pending.delete(action.requestId);
    approval.resolve(decision);
    return completedCard(
      approval.title,
      decision.status === "approved" ? "已同意" : decision.status === "rejected" ? "已拒绝" : `已要求修改\n\n${decision.comment}`,
      decision.status === "approved" ? "green" : decision.status === "rejected" ? "red" : "orange"
    );
  }
}

function parseAction(value: unknown): { requestId: string; decision: ApprovalDecision["status"] } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const action = value as Record<string, unknown>;
  if (action.kind !== "approval" || typeof action.requestId !== "string") return undefined;
  if (action.decision !== "approved" && action.decision !== "rejected" && action.decision !== "revision_requested") return undefined;
  return { requestId: action.requestId, decision: action.decision };
}

function toast(content: string, type: "error" | "warning") {
  return { toast: { type, content } };
}

function completedCard(title: string, content: string, template: "green" | "red" | "orange" | "grey") {
  return {
    toast: { type: "success", content },
    card: {
      type: "raw",
      data: {
        schema: "2.0",
        header: { title: { tag: "plain_text", content: title }, template },
        body: { elements: [{ tag: "markdown", content }] }
      }
    }
  };
}
