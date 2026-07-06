import type { InboundAudioStreamStartFrame } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { AsrPlugin, AsrPluginDeps } from "./types.js";
import { readAsrPluginConfig } from "./config.js";
import { createAsrInboundStreamSession } from "./stream-session.js";
import { transcribeWithAsrPlugin } from "./transcribe.js";

export * from "./types.js";
export { readAsrPluginConfig } from "./config.js";
export { createAsrInboundStreamSession } from "./stream-session.js";
export { transcribeWithAsrPlugin } from "./transcribe.js";
export {
  defaultMultimodalLlmAsrExtraParams,
  defaultMultimodalLlmAsrPrompt,
  multimodalLlmAsrProtocolCall
} from "./multimodal-llm.js";

export function createAsrPlugin(deps: AsrPluginDeps = {}): AsrPlugin {
  return {
    id: "asr",
    config: readAsrPluginConfig(deps.configPath),
    createInboundStreamSession(start: InboundAudioStreamStartFrame) {
      return createAsrInboundStreamSession(start, readAsrPluginConfig(deps.configPath), deps);
    },
    transcribe(input) {
      return transcribeWithAsrPlugin(input, readAsrPluginConfig(deps.configPath), deps);
    }
  };
}
