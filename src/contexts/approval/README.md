# 审批接口

此模块提供与具体业务无关的审批协议，并使用飞书动态卡片完成当前实现。业务功能负责判断自身操作是否需要审批；一旦调用 `ApprovalService.request()`，该请求就会发送卡片并等待审批结果。

## 接口

```ts
type ApprovalRequest = {
  title: string;
  content: string;
};

type ApprovalDecision =
  | { status: "approved" }
  | { status: "rejected" }
  | { status: "revision_requested"; comment: string };

type ApprovalService = {
  request(input: ApprovalRequest): Promise<ApprovalDecision>;
};
```

`title` 显示在卡片标题中，`content` 以 Markdown 显示在卡片正文中。返回值只表达用户的审批决定，不负责执行、撤销或重新生成业务内容。

## 业务接入

由业务模块保存并读取自己的审批开关，通过依赖注入接收 `ApprovalService`：

```ts
import type { ApprovalService } from "../../approval/src/index.js";

async function updatePrompt(input: {
  approval: ApprovalService;
  requiresApproval: boolean;
  proposedPrompt: string;
}) {
  if (!input.requiresApproval) {
    return savePrompt(input.proposedPrompt);
  }

  const decision = await input.approval.request({
    title: "修改 Core Prompt",
    content: input.proposedPrompt
  });

  if (decision.status === "approved") {
    return savePrompt(input.proposedPrompt);
  }
  if (decision.status === "revision_requested") {
    return regeneratePrompt(decision.comment);
  }
  return { changed: false };
}
```

业务代码不得把候选变更提前写入存储；只有收到 `approved` 后才能提交。`revision_requested` 的修改意见应由业务交还给其 Agent 或编辑流程处理。

## 运行时接线

API 启动时会在 `apiCommunicationRuntime.approvalService` 创建飞书实现。它使用当前唯一配对联系人的 `open_id` 发送卡片，并通过飞书 WebSocket 的 `card.action.trigger` 回调接收“同意”“拒绝”“修改”。回调直接进入审批服务，不会作为聊天消息进入 ChatAgent。

使用前必须满足：

- 飞书 runtime 已启动；
- 已存在唯一配对联系人；
- 飞书应用后台已启用 `card.action.trigger` 长连接回调。

缺少这些条件、请求参数为空、卡片超过 30 KB 或发送失败时，`request()` 会直接抛错，不会自动放行。

## 当前边界

- 待审批请求仅保存在进程内，不设置超时；当前调用会一直等待用户操作。
- 服务重启后未完成请求不会恢复，旧卡片再次点击时会显示审批已失效。
- 只有唯一配对用户可以审批；第一个合法决策生效，重复点击不会再次结算。
- 审批模块不保存业务开关，不依赖 ToolPlugin，也不修改 Prompt 或 LLM 请求。
