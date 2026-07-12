import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const sleepCocoonTool: ToolDefinition = {
  name: "sleep_cocoon",
  description: "睡眠茧。action=in 表示钻进睡眠茧准备入睡；action=out 表示在睡着前出来并撤销入睡倒计时。",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["in", "out"] },
      hours: {
        type: "integer",
        minimum: 1,
        description: "可选睡眠小时数；实际睡眠会加入前后十五分钟随机浮动。"
      }
    },
    required: ["action"],
    additionalProperties: false
  }
};

export const sleepCocoonToolText = {
  unknownTool: (toolName: string) => `Unknown sleep_cocoon tool: ${toolName}`,
  unsupportedAction: "unsupported action",
  success: "success",
  alreadyEntered: "already entered sleep cocoon",
  alreadySleeping: "already sleeping",
  noCountdownToCancel: "no sleep cocoon countdown to cancel",
  enterNotice: "少女就寝中",
  exitNotice: "少女起床"
};
