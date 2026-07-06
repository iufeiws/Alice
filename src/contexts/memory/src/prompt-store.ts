import { normalizePromptLayers } from '../../../contexts/agent-profile/src/domain/prompt-layer.js';
import type { MemoryInductionPrompts, MemoryInductionPromptStore, MemoryPromptLayer } from './model.js';
import { writeAtomic } from './store.js';

const fs = await import('node:fs');
const path = await import('node:path');

export const memoryErrorLayerId = "common_error";

export function createMemoryInductionPromptStore(filePath: string): MemoryInductionPromptStore {
  let current = readMemoryInductionPrompts(filePath);
  if (!fs.existsSync(filePath)) writeMemoryInductionPrompts(filePath, current);
  return {
    get() {
      return { ...current };
    },
    save(prompts) {
      current = normalizeMemoryInductionPrompts({ ...current, ...prompts });
      writeMemoryInductionPrompts(filePath, current);
      return { ...current };
    }
  };
}

export function defaultMemoryInductionPrompts(): MemoryInductionPrompts {
  return {
    commonLayers: [
      layer("common_scope", "共同规则", "system", 10, [
        "你是 Alice 的记忆维护子系统。",
        "只通过 Read / self_talk 工具工作。",
        "普通回复不会保存。",
        "本轮目标：{{memorize/target/fileName}}",
        "写入边界：",
        "- 记忆：长期有效的事实、关系连续性、项目长期背景、用户明确要求长期保留的信息；不要写单日流水账。",
        "- 用户记忆：稳定偏好、语言/语气/交互方式/实现习惯/明确禁忌/长期约束；不要把一次性任务需求误判为偏好。",
        "- 日记：只基于本次聊天记录写当天日记摘要，不沿用旧日记内容。",
        currentMemoryEditInstructions()
      ].join("\n")),
      layer("common_quality", "质量标准", "system", 20, [
        "保留明确、稳定、有未来价值的信息。",
        "删除重复、流水账、短期情绪噪声和已被新信息推翻的内容。",
        "内容使用简体中文，短句，结构清晰。"
      ].join("\n")),
      layer("common_messages", "当天消息记录", "user", 80, [
        "归纳窗口：{{memorize/window/startAt}} -> {{memorize/window/endAt}}",
        "时区：{{memorize/timezone}}",
        "",
        "聊天记录：",
        "{{memorize/messages/content}}"
      ].join("\n")),
      {
        id: "common_read",
        title: "Fake Read",
        role: "tool_request",
        enabled: true,
        order: 90,
        content: "",
        toolCalls: [{
          toolName: "Read",
          toolArguments: "{\"file_path\":\"{{memorize/target/fileName}}\"}"
        }],
        thinking: "先读取长期记忆文件，保持工具上下文一致。"
      },
      {
        id: memoryErrorLayerId,
        title: "Error",
        role: "user",
        name: "Cheshire Cat",
        enabled: true,
        order: 100,
        content: [
          "<Error>",
          "{{memorize/ErrorDetail}}",
          "</Error>"
        ].join("\n")
      }
    ],
    persistentLayers: [],
    userPreferencesLayers: [],
    yesterdaySummaryLayers: []
  };
}

function currentMemoryEditInstructions(): string {
  return [
    "记忆工具规则：",
    "- Read({ file_path, offset?, limit? }) 读取当前记忆目标。",
    "- self_talk({ content }) 记录中间思考。"
  ].join("\n");
}

export function readMemoryInductionPrompts(filePath: string): MemoryInductionPrompts {
  if (!fs.existsSync(filePath)) return defaultMemoryInductionPrompts();
  try {
    return normalizeMemoryInductionPrompts(JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<MemoryInductionPrompts>);
  } catch {
    return defaultMemoryInductionPrompts();
  }
}

export function writeMemoryInductionPrompts(filePath: string, prompts: MemoryInductionPrompts): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeAtomic(filePath, `${JSON.stringify(prompts, null, 2)}\n`);
}

export function normalizeMemoryInductionPrompts(value: Partial<MemoryInductionPrompts>): MemoryInductionPrompts {
  const fallback = defaultMemoryInductionPrompts();
  const commonLayers = normalizePromptLayers(value.commonLayers, fallback.commonLayers);
  if (!commonLayers.some((layer) => layer.id === memoryErrorLayerId)) {
    commonLayers.push(fallback.commonLayers.find((layer) => layer.id === memoryErrorLayerId)!);
  }
  return {
    commonLayers,
    persistentLayers: normalizePromptLayers(value.persistentLayers, fallback.persistentLayers),
    userPreferencesLayers: normalizePromptLayers(value.userPreferencesLayers, fallback.userPreferencesLayers),
    yesterdaySummaryLayers: normalizePromptLayers(value.yesterdaySummaryLayers, fallback.yesterdaySummaryLayers)
  };
}

function layer(id: string, title: string, role: MemoryPromptLayer["role"], order: number, content: string): MemoryPromptLayer {
  return { id, title, role, enabled: true, order, content };
}
