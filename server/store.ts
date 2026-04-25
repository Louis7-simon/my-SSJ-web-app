import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { db as sqliteDb, getDatabaseInfo as getSqliteDatabaseInfo, type DailySummaryRow, type ItemRow } from "./db.ts";
import type { ItemKind, ItemPriority, ItemStatus, ParsedItem, SavedItem } from "../lib/types.ts";

export type { DailySummaryRow };

export function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

let postgres: Pool | null | undefined;

function getPostgres() {
  if (postgres !== undefined) return postgres;

  const databaseUrl = process.env.DATABASE_URL;
  postgres = databaseUrl
    ? new Pool({
        connectionString: databaseUrl,
        ssl: databaseUrl.includes("railway") || process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined
      })
    : null;

  return postgres;
}

function camelizeItem(row: Record<string, unknown>): ItemRow {
  const kind = String(row.kind);
  const priority = String(row.priority ?? "medium");
  const status = String(row.status ?? "active");

  return {
    id: String(row.id),
    kind: (kind === "todo" || kind === "event" || kind === "reminder" || kind === "note" ? kind : "todo") as ItemKind,
    category: String(row.category),
    title: String(row.title),
    date: typeof row.date === "string" ? row.date : null,
    time: typeof row.time === "string" ? row.time : null,
    reminderMinutesBefore: typeof row.reminderminutesbefore === "number" ? row.reminderminutesbefore : null,
    notes: String(row.notes ?? ""),
    priority: (priority === "low" || priority === "medium" || priority === "high" ? priority : "medium") as ItemPriority,
    sourceText: String(row.sourcetext ?? ""),
    status: (status === "active" || status === "done" ? status : "active") as ItemStatus,
    createdAt: typeof row.createdat === "string" ? row.createdat : new Date(String(row.createdat)).toISOString(),
    updatedAt: typeof row.updatedat === "string" ? row.updatedat : new Date(String(row.updatedat)).toISOString()
  };
}

function camelizeSummary(row: Record<string, unknown>): DailySummaryRow {
  return {
    id: String(row.id),
    date: String(row.date),
    engine: row.engine === "yunwu" ? "yunwu" : "local",
    summary: String(row.summary),
    scheduleJson: String(row.schedulejson ?? "[]"),
    suggestionsJson: String(row.suggestionsjson ?? "[]"),
    generatedAt: typeof row.generatedat === "string" ? row.generatedat : new Date(String(row.generatedat)).toISOString(),
    createdAt: typeof row.createdat === "string" ? row.createdat : new Date(String(row.createdat)).toISOString(),
    updatedAt: typeof row.updatedat === "string" ? row.updatedat : new Date(String(row.updatedat)).toISOString()
  };
}

export async function initStore() {
  const postgres = getPostgres();
  if (!postgres) return;

  await postgres.query(`
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
}

export function getDatabaseInfo() {
  const postgres = getPostgres();
  if (postgres) {
    return {
      provider: "postgres",
      path: "DATABASE_URL",
      railwayVolumePath: process.env.RAILWAY_VOLUME_MOUNT_PATH || null
    };
  }

  return {
    provider: "sqlite",
    ...getSqliteDatabaseInfo()
  };
}

export async function listItems() {
  const postgres = getPostgres();
  if (postgres) {
    const result = await postgres.query(`
      SELECT * FROM items
      ORDER BY
        CASE status WHEN 'active' THEN 0 ELSE 1 END,
        COALESCE(date, '9999-99-99') ASC,
        COALESCE(time, '99:99') ASC,
        createdAt DESC
    `);
    return result.rows.map(camelizeItem);
  }

  return sqliteDb
    .prepare(
      `
        SELECT * FROM items
        ORDER BY
          CASE status WHEN 'active' THEN 0 ELSE 1 END,
          COALESCE(date, '9999-99-99') ASC,
          COALESCE(time, '99:99') ASC,
          createdAt DESC
      `
    )
    .all() as ItemRow[];
}

export async function listCategories() {
  const postgres = getPostgres();
  if (postgres) {
    const result = await postgres.query("SELECT DISTINCT category FROM items ORDER BY category ASC");
    return result.rows.map((row) => String(row.category));
  }

  const rows = sqliteDb.prepare("SELECT DISTINCT category FROM items ORDER BY category ASC").all() as Array<{ category: string }>;
  return rows.map((row) => row.category);
}

export async function createItems(items: ParsedItem[]) {
  const savedItems = items.map((item) => {
    const now = new Date().toISOString();
    return {
      ...item,
      id: createId("item"),
      status: "active",
      createdAt: now,
      updatedAt: now
    } satisfies SavedItem;
  });

  const postgres = getPostgres();
  if (postgres) {
    const client = await postgres.connect();
    try {
      await client.query("BEGIN");
      for (const item of savedItems) {
        await client.query(
          `
            INSERT INTO items (
              id, kind, category, title, date, time, reminderMinutesBefore,
              notes, priority, sourceText, status, createdAt, updatedAt
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          `,
          [
            item.id,
            item.kind,
            item.category,
            item.title,
            item.date,
            item.time,
            item.reminderMinutesBefore,
            item.notes,
            item.priority,
            item.sourceText,
            item.status,
            item.createdAt,
            item.updatedAt
          ]
        );
      }
      await client.query("COMMIT");
      return savedItems;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const statement = sqliteDb.prepare(`
    INSERT INTO items (
      id, kind, category, title, date, time, reminderMinutesBefore,
      notes, priority, sourceText, status, createdAt, updatedAt
    )
    VALUES (
      @id, @kind, @category, @title, @date, @time, @reminderMinutesBefore,
      @notes, @priority, @sourceText, @status, @createdAt, @updatedAt
    )
  `);
  sqliteDb.transaction((rows: SavedItem[]) => rows.forEach((item) => statement.run(item)))(savedItems);
  return savedItems;
}

export async function updateItem(id: string, item: Partial<SavedItem>) {
  const current = await getItem(id);
  if (!current) return null;
  const next = { ...current, ...item, id, updatedAt: new Date().toISOString() } satisfies SavedItem;

  const postgres = getPostgres();
  if (postgres) {
    await postgres.query(
      `
        UPDATE items SET
          kind = $2,
          category = $3,
          title = $4,
          date = $5,
          time = $6,
          reminderMinutesBefore = $7,
          notes = $8,
          priority = $9,
          sourceText = $10,
          status = $11,
          updatedAt = $12
        WHERE id = $1
      `,
      [
        id,
        next.kind,
        next.category,
        next.title,
        next.date,
        next.time,
        next.reminderMinutesBefore,
        next.notes,
        next.priority,
        next.sourceText,
        next.status,
        next.updatedAt
      ]
    );
    return next;
  }

  sqliteDb
    .prepare(
      `
        UPDATE items SET
          kind = @kind,
          category = @category,
          title = @title,
          date = @date,
          time = @time,
          reminderMinutesBefore = @reminderMinutesBefore,
          notes = @notes,
          priority = @priority,
          sourceText = @sourceText,
          status = @status,
          updatedAt = @updatedAt
        WHERE id = @id
      `
    )
    .run(next);
  return next;
}

export async function deleteItem(id: string) {
  const postgres = getPostgres();
  if (postgres) {
    const result = await postgres.query("DELETE FROM items WHERE id = $1", [id]);
    return Boolean(result.rowCount);
  }

  const result = sqliteDb.prepare("DELETE FROM items WHERE id = ?").run(id);
  return Boolean(result.changes);
}

export async function getItemsForSummary(date: string) {
  const postgres = getPostgres();
  if (postgres) {
    const result = await postgres.query(
      `
        SELECT * FROM items
        WHERE status = 'active' AND (date = $1 OR date IS NULL)
        ORDER BY COALESCE(time, '99:99') ASC, createdAt ASC
      `,
      [date]
    );
    return result.rows.map(camelizeItem);
  }

  return sqliteDb
    .prepare(
      `
        SELECT * FROM items
        WHERE status = 'active' AND (date = ? OR date IS NULL)
        ORDER BY COALESCE(time, '99:99') ASC, createdAt ASC
      `
    )
    .all(date) as ItemRow[];
}

export async function getDailySummary(date: string) {
  const postgres = getPostgres();
  if (postgres) {
    const result = await postgres.query("SELECT * FROM daily_summaries WHERE date = $1", [date]);
    return result.rows[0] ? camelizeSummary(result.rows[0]) : null;
  }

  return (sqliteDb.prepare("SELECT * FROM daily_summaries WHERE date = ?").get(date) as DailySummaryRow | undefined) ?? null;
}

export async function upsertDailySummary(row: DailySummaryRow) {
  const postgres = getPostgres();
  if (postgres) {
    await postgres.query(
      `
        INSERT INTO daily_summaries (
          id, date, engine, summary, scheduleJson, suggestionsJson,
          generatedAt, createdAt, updatedAt
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT(date) DO UPDATE SET
          engine = EXCLUDED.engine,
          summary = EXCLUDED.summary,
          scheduleJson = EXCLUDED.scheduleJson,
          suggestionsJson = EXCLUDED.suggestionsJson,
          generatedAt = EXCLUDED.generatedAt,
          updatedAt = EXCLUDED.updatedAt
      `,
      [row.id, row.date, row.engine, row.summary, row.scheduleJson, row.suggestionsJson, row.generatedAt, row.createdAt, row.updatedAt]
    );
    return row;
  }

  sqliteDb
    .prepare(
      `
        INSERT INTO daily_summaries (
          id, date, engine, summary, scheduleJson, suggestionsJson,
          generatedAt, createdAt, updatedAt
        )
        VALUES (
          @id, @date, @engine, @summary, @scheduleJson, @suggestionsJson,
          @generatedAt, @createdAt, @updatedAt
        )
        ON CONFLICT(date) DO UPDATE SET
          engine = excluded.engine,
          summary = excluded.summary,
          scheduleJson = excluded.scheduleJson,
          suggestionsJson = excluded.suggestionsJson,
          generatedAt = excluded.generatedAt,
          updatedAt = excluded.updatedAt
      `
    )
    .run(row);
  return row;
}

async function getItem(id: string) {
  const postgres = getPostgres();
  if (postgres) {
    const result = await postgres.query("SELECT * FROM items WHERE id = $1", [id]);
    return result.rows[0] ? camelizeItem(result.rows[0]) : null;
  }

  return (sqliteDb.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined) ?? null;
}
