import { createOutputRouter } from "../../../../core/output-router/src/index.js";
import { createOutboundNoticeRuntime } from "./outbound-notice-runtime.js";

export function createApiNoticeRuntime(input: {
  time: any;
  getStore(): any;
  getDefaultTarget(): any;
  getDefaultFeishuTarget(): any;
  appendMessageLog(input: any): unknown;
}) {
  const outputRouter = createOutputRouter();
  const outboundNoticeRuntime = createOutboundNoticeRuntime({
    time: input.time,
    outputRouter,
    getStore: input.getStore,
    getDefaultTarget: input.getDefaultTarget,
    getDefaultFeishuTarget: input.getDefaultFeishuTarget,
    appendMessageLog: input.appendMessageLog
  });

  return { outputRouter, outboundNoticeRuntime };
}
