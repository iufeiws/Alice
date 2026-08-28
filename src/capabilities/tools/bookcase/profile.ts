import type { ToolDefinition } from "../../../contexts/tool-execution/src/index.js";

export const bookcaseTool: ToolDefinition = {
  name: "Bookcase",
  passRenderText: true,
  description: [
    "里面装着用于讲故事的书",
    "action=draw 从书橱抽取一本书来讲故事",
    "action=return 讲完之后必须把书还回去。"
  ].join(""),
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["draw", "return"], default: "draw", description: "draw 抽取一本书；return 归还书本并解除固定前缀。" },
      title: { type: "string", description: "可选，按书名模糊匹配。" },
      author: { type: "string", description: "可选，按作者模糊匹配。" },
      genre: { type: "string", description: "可选，按类型模糊匹配，如 Fantasy、Satire、Crime Fiction。" },
      minSummaryChars: { type: "number", default: 1200, description: "母版剧情简介的最小字符数。" },
      seed: { type: "number", description: "可选，提供后随机抽取可复现。" }
    },
    required: ["action"],
    additionalProperties: false
  }
};

export const bookcaseToolText = {
  unknownTool: (toolName: string) => `Unknown bookcase tool: ${toolName}`,
  unsupportedAction: "unsupported action",
  bookIdNotFound: (id: number) => `book id not found: ${id}`,
  noMatchingSummaries: "no matching book summaries found",
  drawNotice: "少女已取书",
  returnNotice: "少女已还书",
  returnMessage: "书已归还书橱；当前固定前缀已解除。"
};

export const bookcaseInstructionBlockLines = [
  "  <instructions>",
  "    - 用第一人称视角为${{user}}讲述这个故事；从梗概中选择一个主角作为爱丽丝，另一个与主角有紧密关系的角色作为${{user}}, 保持外壳设定的称呼。",
  "    - 语言使用中文。",
  "    - 在故事的最后说出故事的引用来源",
  "    - 讲完故事必须使用toolcall action = return 归还书籍, 如果弄丢了${{user}}会生气 ",
  "  </instructions>"
];
