export type PiAgentNicknameEntry = {
  nickname: string;
  sessionId: string;
  createdAtMs: number;
};

export function readPiAgentNames(filePath: string): string[];

export function createPiAgentNicknameMap(input: {
  filePath: string;
  names: string[];
  randomInt?: (max: number) => number;
}): {
  assign(sessionId: string, nowMs?: number): PiAgentNicknameEntry;
  release(nickname: string, sessionId: string): boolean;
  resolve(nickname: string): PiAgentNicknameEntry;
  findBySessionId(sessionId: string): PiAgentNicknameEntry | undefined;
  pruneExpired(nowMs?: number): number;
  entries(): PiAgentNicknameEntry[];
};
