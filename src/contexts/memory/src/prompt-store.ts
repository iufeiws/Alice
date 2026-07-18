import { normalizePromptLayer } from '../../../contexts/agent-profile/src/domain/prompt-layer.js';
import type { MemoryInductionPrompts, MemoryInductionPromptStore } from './model.js';
import { writeAtomic } from './store.js';

const fs = await import('node:fs');
const path = await import('node:path');

export function createMemoryInductionPromptStore(filePath: string): MemoryInductionPromptStore {
  let current = readMemoryInductionPrompts(filePath);
  if (!fs.existsSync(filePath)) writeMemoryInductionPrompts(filePath, current);
  return {
    get() {
      return { ...current };
    },
    save(prompts) {
      current = normalizeMemoryInductionPrompts(prompts);
      writeMemoryInductionPrompts(filePath, current);
      return { ...current };
    }
  };
}

export function defaultMemoryInductionPrompts(): MemoryInductionPrompts {
  return { meta: {}, messages: [] };
}

export function readMemoryInductionPrompts(filePath: string): MemoryInductionPrompts {
  if (!fs.existsSync(filePath)) return defaultMemoryInductionPrompts();
  return normalizeMemoryInductionPrompts(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

export function writeMemoryInductionPrompts(filePath: string, prompts: MemoryInductionPrompts): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeAtomic(filePath, `${JSON.stringify(prompts, null, 2)}\n`);
}

export function normalizeMemoryInductionPrompts(value: unknown): MemoryInductionPrompts {
  return normalizePromptLayer(value);
}
