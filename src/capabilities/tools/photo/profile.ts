import type { ToolDefinition } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

export const selfieTool: ToolDefinition = {
  name: "selfie",
  description: "根据 action 动作描述自拍。 除非<user>特殊要求,确保只描述拍照时的动作。成功后会自动发送。",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string" },
    },
    required: ["action"],
    additionalProperties: false
  }
};

export const photoToolText = {
  unknownTool: (toolName: string) => `Unknown photo tool: ${toolName}`,
  errorCause: (message: string) => `cause: ${message}`,
  previousFailureBlocked: "selfie is blocked in this agent loop run after a previous failure",
  selfieDisabled: "photo selfie is disabled",
  noCurrentSession: "No current messaging session is available",
  actionRequired: "action is required",
  unsupportedAspectRatio: "unsupported aspectRatio",
  contextUnavailable: "selfie context is not available",
  outputDirOutsideAssets: "selfie output directory must be inside assets",
  takingNotice: "-少女拍照中-",
  sent: "照片已发送",
  followupImageText: "这是上一步工具返回的图像",
  promptTemplateNotFound: "selfie prompt template was not found",
  characterReferenceNotFound: "selfie character reference image was not found",
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
  failureNotice: "-大失败-"
};
