import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { parseLocally } from "./lib/parser";
import type { AiParseResult, ParsedItem } from "./lib/types";

function readRequestBody(request: import("node:http").IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJson(response: import("node:http").ServerResponse, statusCode: number, data: unknown) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(data));
}

function isParsedItem(value: unknown): value is ParsedItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    ["todo", "event", "reminder", "note"].includes(String(item.kind)) &&
    typeof item.category === "string" &&
    typeof item.title === "string" &&
    (typeof item.date === "string" || item.date === null) &&
    (typeof item.time === "string" || item.time === null) &&
    (typeof item.reminderMinutesBefore === "number" || item.reminderMinutesBefore === null) &&
    typeof item.notes === "string" &&
    ["low", "medium", "high"].includes(String(item.priority)) &&
    typeof item.sourceText === "string"
  );
}

function aiApiPlugin(): Plugin {
  return {
    name: "suishiji-ai-api",
    configureServer(server) {
      const env = loadEnv("development", process.cwd(), "");
      const apiKey = env.YUNWU_API_KEY;
      const model = env.YUNWU_MODEL;
      const baseUrl = (env.YUNWU_API_BASE_URL || "https://yunwu.ai/v1").replace(/\/$/, "");

      server.middlewares.use("/api/ai-parse", async (request, response) => {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }

        try {
          const body = JSON.parse(await readRequestBody(request)) as { text?: string; categories?: string[] };
          const text = body.text?.trim();
          if (!text) {
            sendJson(response, 400, { error: "Missing text." });
            return;
          }

          if (!apiKey || !model) {
            const result: AiParseResult = { items: [parseLocally(text)], questions: [], engine: "local" };
            sendJson(response, 200, result);
            return;
          }

          const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
          const categories = Array.from(new Set(body.categories ?? [])).filter(Boolean);
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
            "Each item title must contain exactly one action. Do not merge multiple actions into one title.",
            "All user-facing text in category, title, notes, questions must be Simplified Chinese.",
            `Today is ${today}. Timezone: Asia/Shanghai.`,
            `Existing categories: ${categories.length ? categories.join(", ") : "none"}.`
          ].join("\n");

          const aiResponse = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model,
              temperature: 0.1,
              response_format: { type: "json_object" },
              messages: [
                { role: "system", content: prompt },
                { role: "user", content: text }
              ]
            })
          });

          if (!aiResponse.ok) {
            const result: AiParseResult = { items: [parseLocally(text)], questions: ["AI interface unavailable; local parser was used."], engine: "local" };
            sendJson(response, 200, result);
            return;
          }

          const data = await aiResponse.json();
          const content = data.choices?.[0]?.message?.content;
          const parsed = JSON.parse(content);
          const items = Array.isArray(parsed.items) ? parsed.items.filter(isParsedItem) : [];

          if (!items.length) {
            const result: AiParseResult = { items: [parseLocally(text)], questions: ["AI response was incomplete; local parser was used."], engine: "local" };
            sendJson(response, 200, result);
            return;
          }

          const result: AiParseResult = {
            items,
            questions: Array.isArray(parsed.questions) ? parsed.questions.filter((question: unknown) => typeof question === "string") : [],
            engine: "yunwu"
          };
          sendJson(response, 200, result);
        } catch {
          sendJson(response, 500, { error: "Parse failed." });
        }
      });

      server.middlewares.use("/api/daily-summary", async (request, response) => {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }

        try {
          const body = JSON.parse(await readRequestBody(request)) as { date?: string; items?: ParsedItem[] };
          const date = body.date?.trim();
          const items = Array.isArray(body.items) ? body.items : [];

          if (!date) {
            sendJson(response, 400, { error: "Missing date." });
            return;
          }

          const fallback = {
            engine: "local",
            summary: `今日共有 ${items.length} 条事项。建议先处理有明确时间的日程，再处理无日期待办。`,
            schedule: [],
            suggestions: ["先完成最有时间约束的事项。", "把客户、财务和个人事务分批处理。", "给无日期事项补充截止时间。"]
          };

          if (!apiKey || !model) {
            sendJson(response, 200, fallback);
            return;
          }

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

          const aiResponse = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model,
              temperature: 0.2,
              response_format: { type: "json_object" },
              messages: [
                { role: "system", content: prompt },
                { role: "user", content: JSON.stringify({ date, items }) }
              ]
            })
          });

          if (!aiResponse.ok) {
            sendJson(response, 200, fallback);
            return;
          }

          const data = await aiResponse.json();
          const content = data.choices?.[0]?.message?.content;
          const parsed = JSON.parse(content);

          sendJson(response, 200, {
            engine: "yunwu",
            summary: typeof parsed.summary === "string" ? parsed.summary : fallback.summary,
            schedule: Array.isArray(parsed.schedule) ? parsed.schedule : [],
            suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : []
          });
        } catch {
          sendJson(response, 500, { error: "Summary failed." });
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), aiApiPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, ".")
    }
  }
});
