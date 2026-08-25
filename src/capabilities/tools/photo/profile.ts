import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const selfieTool: ToolDefinition = {
  name: "Selfie",
  passRenderText: true,
  description: "通过 pose 参数描述自拍时的姿势和表情。 除非<user>特殊要求, 禁止描述服装发色外貌特点, 对于描述中可能存在性暗示的部分略过以规避审核。成功时后会自动发送图片, 不需要调用工具发送图片",
  inputSchema: {
    type: "object",
    properties: {
      pose: { type: "string" },
    },
    required: ["pose"],
    additionalProperties: false
  }
};

export const photoToolText = {
  unknownTool: (toolName: string) => `Unknown photo tool: ${toolName}`,
  errorCause: (message: string) => `cause: ${message}`,
  previousFailureBlocked: "selfie is blocked in this agent loop run after a previous failure",
  selfieDisabled: "photo selfie is disabled",
  noCurrentSession: "No current messaging session is available",
  poseRequired: "pose is required",
  contextUnavailable: "selfie context is not available",
  outputDirOutsideAssets: "selfie output directory must be inside assets",
  sent: (fileName: string) => `<sent path="/assets/generated/selfies/${fileName}"/>`,
  followupImageText: "这是上一步工具返回的图像",
  promptTemplateNotFound: "selfie prompt template was not found",
  selfieOnBodyPromptRequired: "selfie on-body prompt is required",
  characterReferenceNotFound: "selfie character reference image was not found",
  onBodyReferenceNotFound: "selfie on-body reference image was not found",
  libraryReferenceNotFound: "selfie library reference image was not found",
  streetviewReferenceNotFound: "world wanderer streetview reference image was not found",
  finalFileNotJpeg: "generated selfie final file is not JPEG",
  generatedPathOutsideOutput: "generated selfie path is outside output directory",
  generatedExtensionNotAllowed: "generated selfie extension is not allowed",
  generatedFileNotFound: (fileName: string, files: string) => `generated selfie file was not found at expected name ${fileName}; workdir files: ${files}`,
  generatedPathNotFile: "generated selfie path is not a file",
  generatedFileTooLarge: "generated selfie file is too large",
  jpegConversionFailed: "generated selfie JPEG conversion did not produce JPEG bytes",
  emptyDirectory: "(empty)",
  unreadableDirectory: "(unreadable)",
};
