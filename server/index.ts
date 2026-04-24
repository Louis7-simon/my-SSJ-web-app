import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { db, createId, type DailySummaryRow, type ItemRow } from "./db";
import { parseLocally } from "../lib/parser";
import type { AiParseResult, ItemKind, ParsedItem, SavedItem } from "../lib/types";

dotenv.config();

const app = express();
const server = createServer(app);
const primaryPort = Number(process.env.PORT || process.env.API_PORT || 3001);
const secondaryPort = Number(process.env.API_PORT || 0);
const asrServer = new WebSocketServer({ noServer: true });

app.use(
  cors({
    origin: ["https://my-ssj-web-app-production.up.railway.app", "http://localhost:5173"]
  })
);
app.use(express.json({ limit: "1mb" }));

server.on("upgrade", (request, socket, head) => {
  if (request.url?.startsWith("/api/asr/ws")) {
    asrServer.handleUpgrade(request, socket, head, (ws) => {
      asrServer.emit("connection", ws, request);
    });
    return;
  }
  socket.destroy();
});

asrServer.on("connection", (ws) => {
  setupAsrSocket(ws);
});

function isItemKind(value: unknown): value is ItemKind {
  return value === "todo" || value === "event" || value === "reminder" || value === "note";
}

function normalizeParsedItem(value: unknown, sourceText: string): ParsedItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (!isItemKind(item.kind)) return null;

  return {
    kind: item.kind,
    category: typeof item.category === "string" && item.category.trim() ? item.category.trim() : "待办",
    title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : sourceText,
    date: typeof item.date === "string" && item.date ? item.date : null,
    time: typeof item.time === "string" && item.time ? item.time : null,
    reminderMinutesBefore: typeof item.reminderMinutesBefore === "number" ? item.reminderMinutesBefore : null,
    notes: typeof item.notes === "string" ? item.notes : "",
    priority: item.priority === "low" || item.priority === "high" ? item.priority : "medium",
    sourceText: typeof item.sourceText === "string" ? item.sourceText : sourceText
  };
}

function parseJsonArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractTranscript(message: unknown) {
  const payload = (message as { payload?: { output?: unknown } })?.payload;
  const output = payload?.output as Record<string, unknown> | undefined;
  const sentence = output?.sentence as Record<string, unknown> | undefined;
  const candidates = [
    sentence?.text,
    output?.text,
    output?.transcription,
    output?.sentence
  ];
  const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
  return typeof value === "string" ? value : "";
}

function setupAsrSocket(client: WebSocket) {
  const apiKey = process.env.FUNASR_API_KEY || process.env.DASHSCOPE_API_KEY;
  const model = process.env.FUNASR_MODEL || "paraformer-realtime-v2";

  if (!apiKey) {
    client.send(JSON.stringify({ type: "error", message: "Missing FUNASR_API_KEY." }));
    client.close();
    return;
  }

  const taskId = randomUUID();
  const dashscope = new WebSocket("wss://dashscope.aliyuncs.com/api-ws/v1/inference", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-DashScope-DataInspection": "enable"
    }
  });
  let dashscopeReady = false;
  const pendingAudio: Buffer[] = [];

  dashscope.on("open", () => {
    dashscope.send(
      JSON.stringify({
        header: {
          action: "run-task",
          task_id: taskId,
          streaming: "duplex"
        },
        payload: {
          task_group: "audio",
          task: "asr",
          function: "recognition",
          model,
          parameters: {
            format: "pcm",
            sample_rate: 16000,
            language_hints: ["zh"]
          },
          input: {}
        }
      })
    );
  });

  dashscope.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const event = data.header?.event;

      if (event === "task-started") {
        dashscopeReady = true;
        client.send(JSON.stringify({ type: "ready" }));
        while (pendingAudio.length && dashscope.readyState === WebSocket.OPEN) {
          dashscope.send(pendingAudio.shift()!);
        }
        return;
      }

      if (event === "result-generated") {
        const text = extractTranscript(data);
        if (text) client.send(JSON.stringify({ type: "transcript", text }));
        return;
      }

      if (event === "task-finished") {
        client.send(JSON.stringify({ type: "finished" }));
        client.close();
        return;
      }

      if (event === "task-failed") {
        client.send(JSON.stringify({ type: "error", message: data.header?.error_message || "ASR task failed." }));
        client.close();
      }
    } catch {
      // Ignore malformed provider messages.
    }
  });

  dashscope.on("error", () => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "error", message: "FunASR connection failed." }));
      client.close();
    }
  });

  dashscope.on("close", () => {
    if (client.readyState === WebSocket.OPEN) client.close();
  });

  client.on("message", (raw, isBinary) => {
    if (!isBinary) {
      const message = raw.toString();
      if (message === "stop" && dashscope.readyState === WebSocket.OPEN) {
        dashscope.send(
          JSON.stringify({
            header: {
              action: "finish-task",
              task_id: taskId,
              streaming: "duplex"
            },
            payload: {
              input: {}
            }
          })
        );
      }
      return;
    }

    const audio = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    if (dashscopeReady && dashscope.readyState === WebSocket.OPEN) {
      dashscope.send(audio);
    } else {
      pendingAudio.push(audio);
    }
  });

  client.on("close", () => {
    if (dashscope.readyState === WebSocket.OPEN || dashscope.readyState === WebSocket.CONNECTING) {
      dashscope.close();
    }
  });
}

function selectAllItems() {
  return db
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

function insertItem(item: ParsedItem) {
  const now = new Date().toISOString();
  const saved: SavedItem = {
    ...item,
    id: createId("item"),
    status: "active",
    createdAt: now,
    updatedAt: now
  };

  db.prepare(
    `
      INSERT INTO items (
        id, kind, category, title, date, time, reminderMinutesBefore,
        notes, priority, sourceText, status, createdAt, updatedAt
      )
      VALUES (
        @id, @kind, @category, @title, @date, @time, @reminderMinutesBefore,
        @notes, @priority, @sourceText, @status, @createdAt, @updatedAt
      )
    `
  ).run(saved);

  return saved;
}

function updateItem(id: string, item: Partial<SavedItem>) {
  const current = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
  if (!current) return null;

  const next: SavedItem = {
    ...current,
    ...item,
    id,
    updatedAt: new Date().toISOString()
  };

  db.prepare(
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
  ).run(next);

  return next;
}

async function callYunwuJson(systemPrompt: string, userContent: string, temperature: number) {
  const apiKey = process.env.YUNWU_API_KEY;
  const model = process.env.YUNWU_MODEL;
  const baseUrl = (process.env.YUNWU_API_BASE_URL || "https://yunwu.ai/v1").replace(/\/$/, "");

  if (!apiKey || !model) return null;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ]
    })
  });

  if (!response.ok) return null;
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  return content ? JSON.parse(content) : null;
}

async function parseWithAi(text: string, categories: string[]): Promise<AiParseResult> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const prompt = [
    "You are a Chinese personal task assistant.",
    "Parse one Chinese natural-language capture into one or more structured items.",
    "Return JSON only. Do not use Markdown.",
    "Schema: { items: [{ kind, category, title, date, time, reminderMinutesBefore, notes, priority, sourceText }], questions: [] }.",
    'kind must be one of "todo", "event", "reminder", "note".',
    "category is a short Chinese user-facing category. Prefer existing categories when suitable.",
    "date must be YYYY-MM-DD or null. time must be HH:mm or null.",
    "Do not invent dates or times that are not implied by the user.",
    "If the user asks for a reminder without saying how early, use reminderMinutesBefore: 0.",
    'priority must be one of "low", "medium", "high".',
    "If the sentence has multiple independent actions, deadlines, deliverables, or people to contact, split them into multiple items.",
    "Each item title must contain exactly one action.",
    "All user-facing text in category, title, notes, questions must be Simplified Chinese.",
    `Today is ${today}. Timezone: Asia/Shanghai.`,
    `Existing categories: ${categories.length ? categories.join(", ") : "none"}.`
  ].join("\n");

  try {
    const parsed = await callYunwuJson(prompt, text, 0.1);
    const items = Array.isArray(parsed?.items)
      ? parsed.items.map((item: unknown) => normalizeParsedItem(item, text)).filter((item: ParsedItem | null): item is ParsedItem => Boolean(item))
      : [];
    if (items.length) {
      return {
        items,
        questions: Array.isArray(parsed?.questions) ? parsed.questions.filter((question: unknown) => typeof question === "string") : [],
        engine: "yunwu"
      };
    }
  } catch {
    // Local parser keeps capture reliable when AI output is unavailable.
  }

  return { items: [parseLocally(text)], questions: [], engine: "local" };
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/items", (_request, response) => {
  response.json({ items: selectAllItems() });
});

app.post("/api/capture", async (request, response) => {
  const text = String(request.body?.text || "").trim();
  if (!text) {
    response.status(400).json({ error: "Missing text." });
    return;
  }

  const rows = db.prepare("SELECT DISTINCT category FROM items ORDER BY category ASC").all() as Array<{ category: string }>;
  const parsed = await parseWithAi(
    text,
    rows.map((row) => row.category)
  );
  const transaction = db.transaction((items: ParsedItem[]) => items.map(insertItem));
  const savedItems = transaction(parsed.items);

  response.json({ ...parsed, items: savedItems });
});

app.put("/api/items/:id", (request, response) => {
  const item = updateItem(request.params.id, request.body as Partial<SavedItem>);
  if (!item) {
    response.status(404).json({ error: "Item not found." });
    return;
  }
  response.json({ item });
});

app.delete("/api/items/:id", (request, response) => {
  const result = db.prepare("DELETE FROM items WHERE id = ?").run(request.params.id);
  if (!result.changes) {
    response.status(404).json({ error: "Item not found." });
    return;
  }
  response.json({ ok: true });
});

app.post("/api/daily-summary", async (request, response) => {
  const date = String(request.body?.date || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }));
  const force = Boolean(request.body?.force);
  const existing = db.prepare("SELECT * FROM daily_summaries WHERE date = ?").get(date) as DailySummaryRow | undefined;

  if (existing && !force) {
    response.json({
      date,
      engine: existing.engine,
      summary: existing.summary,
      schedule: parseJsonArray(existing.scheduleJson),
      suggestions: parseJsonArray(existing.suggestionsJson),
      generatedAt: existing.generatedAt
    });
    return;
  }

  const savedItems = db
    .prepare(
      `
        SELECT * FROM items
        WHERE status = 'active' AND (date = ? OR date IS NULL)
        ORDER BY COALESCE(time, '99:99') ASC, createdAt ASC
      `
    )
    .all(date) as ItemRow[];
  const fallback = {
    engine: "local" as const,
    summary: `今天有 ${savedItems.length} 条待处理事项。建议先处理有明确时间的安排，再处理其他待办。`,
    schedule: [] as Array<{ time: string; plan: string }>,
    suggestions: ["先处理最紧急的事项。", "把无日期事项安排到具体时间段。", "给复杂任务拆成更小的下一步。"]
  };

  let result: {
    engine: "local" | "yunwu";
    summary: string;
    schedule: Array<{ time: string; plan: string }>;
    suggestions: string[];
  } = fallback;
  try {
    const prompt = [
      "You are a Chinese personal productivity assistant.",
      "Generate a daily report and plan from the user's items for the given date.",
      "Return JSON only. Do not use Markdown.",
      "Schema: { summary: string, schedule: [{ time: string, plan: string }], suggestions: string[] }.",
      "summary should be 2-4 concise Chinese sentences.",
      "schedule should be ordered by time. Put items without explicit time into reasonable suggested time blocks.",
      "suggestions should contain 3-5 concrete Chinese execution suggestions.",
      "Do not invent tasks that are not present, but you may suggest ordering and time blocking.",
      `Report date: ${date}. Timezone: Asia/Shanghai.`
    ].join("\n");
    const parsed = await callYunwuJson(prompt, JSON.stringify({ date, items: savedItems }), 0.2);
    if (typeof parsed?.summary === "string") {
      result = {
        engine: "yunwu",
        summary: parsed.summary,
        schedule: Array.isArray(parsed.schedule) ? parsed.schedule : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((value: unknown) => typeof value === "string") : []
      };
    }
  } catch {
    // Keep fallback.
  }

  const now = new Date().toISOString();
  const row: DailySummaryRow = {
    id: existing?.id || createId("summary"),
    date,
    engine: result.engine,
    summary: result.summary,
    scheduleJson: JSON.stringify(result.schedule),
    suggestionsJson: JSON.stringify(result.suggestions),
    generatedAt: now,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  db.prepare(
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
  ).run(row);

  response.json({
    date,
    engine: row.engine,
    summary: row.summary,
    schedule: parseJsonArray(row.scheduleJson),
    suggestions: parseJsonArray(row.suggestionsJson),
    generatedAt: row.generatedAt
  });
});

const dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(dirname, "../dist");
app.use(express.static(distPath));
app.use((_request, response) => {
  response.sendFile(path.join(distPath, "index.html"));
});

server.listen(primaryPort, "0.0.0.0", () => {
  console.log(`后端服务运行在端口 ${primaryPort}`);
});

if (secondaryPort && secondaryPort !== primaryPort) {
  createServer(app).listen(secondaryPort, "0.0.0.0", () => {
    console.log(`后端服务同时监听端口 ${secondaryPort}`);
  });
}
