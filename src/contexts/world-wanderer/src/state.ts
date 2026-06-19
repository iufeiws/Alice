import * as sqlite from "../../../platform/storage/src/sqlite-compat.js";

const path = await import("node:path");

import type {
  GoogleStreetViewPanoGraphResult
} from "../../../channels/google-streetview/src/index.js";
import type {
  WorldWandererConfig,
  WorldWandererPathEntry,
  WorldWandererState
} from "./types.js";
import { normalizeHeading } from "./geo.js";
import { numberValue, stringValue } from "./values.js";

const fs = await import("node:fs");

type DatabaseSync = any;

export function readWorldWandererState(dbPath: string, config: WorldWandererConfig): WorldWandererState {
  const db = openWorldWandererDb(dbPath);
  const pathStack = db.prepare(`
    SELECT time, panoId, lat, lng, lastHeading
    FROM world_wanderer_path
    ORDER BY rowid ASC
  `).all().map((row: unknown) => pathEntryValue(row)).filter((entry: WorldWandererPathEntry | undefined): entry is WorldWandererPathEntry => Boolean(entry));
  db.close();
  return stateFromPath(pathStack, config);
}

export function writeWorldWandererState(dbPath: string, state: WorldWandererState, limit = state.pathStack.length): void {
  const db = openWorldWandererDb(dbPath);
  db.exec("DELETE FROM world_wanderer_path");
  for (const entry of state.pathStack.slice(-limit)) {
    insertPathEntry(db, entry);
  }
  db.close();
}

export function appendWorldWandererPathEntries(dbPath: string, entries: WorldWandererPathEntry[], limit: number): void {
  if (!entries.length) return;
  const db = openWorldWandererDb(dbPath);
  for (const entry of entries) insertPathEntry(db, entry);
  db.prepare(`
    DELETE FROM world_wanderer_path
    WHERE rowid NOT IN (
      SELECT rowid FROM world_wanderer_path ORDER BY rowid DESC LIMIT ?
    )
  `).run(limit);
  db.close();
}

export function pathEntryFromPano(input: {
  pano: GoogleStreetViewPanoGraphResult;
  lastHeading: number;
  time: string;
}): WorldWandererPathEntry {
  return {
    time: input.time,
    panoId: input.pano.panoId,
    lat: input.pano.location.lat,
    lng: input.pano.location.lng,
    lastHeading: normalizeHeading(input.lastHeading)
  };
}

export function stateFromPath(pathStack: WorldWandererPathEntry[], config: WorldWandererConfig): WorldWandererState {
  const current = pathStack.at(-1);
  return {
    location: current ? { lat: current.lat, lng: current.lng } : config.initialLocation,
    lastHeading: current ? normalizeHeading(current.lastHeading) : config.initialHeading,
    panoId: current?.panoId,
    pathStack
  };
}

export function prunePathStack(values: WorldWandererPathEntry[], limit: number): WorldWandererPathEntry[] {
  return values.slice(-limit);
}

function openWorldWandererDb(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db: DatabaseSync = new sqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS world_wanderer_path (
      time TEXT NOT NULL,
      panoId TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      lastHeading REAL NOT NULL
    );
  `);
  return db;
}

function insertPathEntry(db: DatabaseSync, entry: WorldWandererPathEntry): void {
  db.prepare(`
    INSERT INTO world_wanderer_path(time, panoId, lat, lng, lastHeading)
    VALUES (?, ?, ?, ?, ?)
  `).run(entry.time, entry.panoId, entry.lat, entry.lng, normalizeHeading(entry.lastHeading));
}

function pathEntryValue(row: unknown): WorldWandererPathEntry | undefined {
  if (!row || typeof row !== "object") return undefined;
  const value = row as Record<string, unknown>;
  const time = stringValue(value.time);
  const panoId = stringValue(value.panoId);
  const lat = numberValue(value.lat, Number.NaN);
  const lng = numberValue(value.lng, Number.NaN);
  if (!time || !panoId || !Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return {
    time,
    panoId,
    lat,
    lng,
    lastHeading: normalizeHeading(numberValue(value.lastHeading, 0))
  };
}
