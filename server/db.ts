import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SavedItem } from "../lib/types.ts";

const railwayVolumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const databasePath = railwayVolumePath ? path.join(railwayVolumePath, "suishiji.db") : process.env.DATABASE_PATH || "data/suishiji.db";
const resolvedDatabasePath = path.resolve(process.cwd(), databasePath);
fs.mkdirSync(path.dirname(resolvedDatabasePath), { recursive: true });

export const db = new Database(resolvedDatabasePath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    date TEXT,
    time TEXT,
    reminderMinutesBefore INTEGER,
    notes TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'medium',
    sourceText TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_summaries (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL UNIQUE,
    engine TEXT NOT NULL,
    summary TEXT NOT NULL,
    scheduleJson TEXT NOT NULL DEFAULT '[]',
    suggestionsJson TEXT NOT NULL DEFAULT '[]',
    generatedAt TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
`);

export type ItemRow = SavedItem;

export type DailySummaryRow = {
  id: string;
  date: string;
  engine: "yunwu" | "local";
  summary: string;
  scheduleJson: string;
  suggestionsJson: string;
  generatedAt: string;
  createdAt: string;
  updatedAt: string;
};

export function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function getDatabaseInfo() {
  return {
    path: resolvedDatabasePath,
    railwayVolumePath: railwayVolumePath || null
  };
}
