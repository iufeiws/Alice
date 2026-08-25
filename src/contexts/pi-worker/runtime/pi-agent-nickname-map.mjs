import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";

const MAP_VERSION = 1;
const NICKNAME_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function readPiAgentNames(filePath) {
  const names = fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((name) => name.trim().replaceAll(" ", "_"))
    .filter(Boolean);
  if (!names.length || new Set(names).size !== names.length || names.some((name) => name.includes(" "))) {
    throw new Error("pi_agent_nickname_name_list_invalid");
  }
  return names;
}

export function createPiAgentNicknameMap(input) {
  if (!input || !Array.isArray(input.names) || !input.names.length) throw new Error("pi_agent_nickname_names_required");
  if (new Set(input.names).size !== input.names.length || input.names.some((name) => typeof name !== "string" || !name || name.includes(" "))) {
    throw new Error("pi_agent_nickname_names_invalid");
  }
  const random = input.randomInt ?? randomInt;
  let entries = loadEntries(input.filePath);

  return {
    assign(sessionId, nowMs = Date.now()) {
      if (typeof sessionId !== "string" || !sessionId) throw new Error("pi_agent_nickname_session_id_required");
      if (!Number.isInteger(nowMs) || nowMs < 0) throw new Error("pi_agent_nickname_timestamp_invalid");
      const existing = entries.find((entry) => entry.sessionId === sessionId);
      if (existing) return { ...existing };

      const used = new Set(entries.map((entry) => entry.nickname));
      const available = input.names.filter((name) => !used.has(name));
      let nickname;
      if (available.length) {
        nickname = available[random(available.length)];
      } else {
        const oldest = entries.reduce((candidate, entry) => entry.createdAtMs < candidate.createdAtMs ? entry : candidate);
        nickname = oldest.nickname;
        entries = entries.filter((entry) => entry.sessionId !== oldest.sessionId);
      }

      const entry = { nickname, sessionId, createdAtMs: nowMs };
      entries.push(entry);
      saveEntries(input.filePath, entries);
      return { ...entry };
    },

    release(nickname, sessionId) {
      const index = entries.findIndex((entry) => entry.nickname === nickname && entry.sessionId === sessionId);
      if (index < 0) return false;
      entries.splice(index, 1);
      saveEntries(input.filePath, entries);
      return true;
    },

    resolve(nickname) {
      if (typeof nickname !== "string" || !nickname) throw new Error("pi_agent_nickname_required");
      const entry = entries.find((candidate) => candidate.nickname === nickname);
      if (!entry) throw new Error("pi_agent_nickname_not_found");
      return { ...entry };
    },

    findBySessionId(sessionId) {
      const entry = entries.find((candidate) => candidate.sessionId === sessionId);
      return entry ? { ...entry } : undefined;
    },

    pruneExpired(nowMs = Date.now()) {
      if (!Number.isInteger(nowMs) || nowMs < 0) throw new Error("pi_agent_nickname_timestamp_invalid");
      const cutoff = nowMs - NICKNAME_MAX_AGE_MS;
      const retained = entries.filter((entry) => entry.createdAtMs >= cutoff);
      const removed = entries.length - retained.length;
      if (removed) {
        entries = retained;
        saveEntries(input.filePath, entries);
      }
      return removed;
    },

    entries() {
      return entries.map((entry) => ({ ...entry }));
    }
  };
}

function loadEntries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || parsed.version !== MAP_VERSION || !Array.isArray(parsed.entries)) throw new Error("pi_agent_nickname_map_invalid");
  const entries = parsed.entries.map((entry) => {
    if (!entry || typeof entry.nickname !== "string" || !entry.nickname || typeof entry.sessionId !== "string" || !entry.sessionId || !Number.isInteger(entry.createdAtMs) || entry.createdAtMs < 0) {
      throw new Error("pi_agent_nickname_map_invalid");
    }
    return { nickname: entry.nickname, sessionId: entry.sessionId, createdAtMs: entry.createdAtMs };
  });
  if (new Set(entries.map((entry) => entry.nickname)).size !== entries.length || new Set(entries.map((entry) => entry.sessionId)).size !== entries.length) {
    throw new Error("pi_agent_nickname_map_invalid");
  }
  return entries;
}

function saveEntries(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: MAP_VERSION, entries }, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}
