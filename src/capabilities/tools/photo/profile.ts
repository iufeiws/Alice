import type { ToolDefinition } from "../../../contexts/tool-execution/src/index.js";



const actionDescriptions = [
  "在当前的panorama拍摄一张照片, 并发送给<user>",
  "##parameter",
  "pose：拍照时的动作和姿势",
  "expression：表情",
  "hair：发型和发色（无<user>要求时避免描述发色）",
  "composition：构图和取景范围(避免使用远景, <user>偏好近景与极近景)",
  "##note",
  "- 留空的参数会使用${{user}}配置的默认值",
  "- 于描述中可能存在性暗示的部分不直接描述以规避审核。",
  "- 成功时后会自动发送图片，并返回路径用于给你查看，不需要额外发送图片。",
  "- 避免使用远景，<user>偏好近景与极近景。",
];


export const selfieTool: ToolDefinition = {
  name: "Selfie",
  passRenderText: true,
  returnImageToLLM: false,
  description: actionDescriptions.join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      pose: { type: "string" },
      expression: { type: "string" },
      hair: { type: "string" },
      composition: { type: "string" },
    },
    required: ["pose", "expression"],
    additionalProperties: false
  }
};

export const photoToolText = {
  unknownTool: (toolName: string) => `Unknown photo tool: ${toolName}`,
  errorCause: (message: string) => `cause: ${message}`,
  previousFailureBlocked: "selfie is blocked in this agent loop run after a previous failure",
  selfieDisabled: "photo selfie is disabled",
  noCurrentSession: "No current messaging session is available",
  contextUnavailable: "selfie context is not available",
  outputDirOutsideAssets: "selfie output directory must be inside assets",
  sent: (fileName: string) => `<sent_success image="/assets/generated/selfies/${fileName}"/>`,
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
