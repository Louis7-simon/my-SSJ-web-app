import { CalendarClock, Check, Clock3, Home, ListTodo, Mic, Pencil, Search, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AiParseResult, ItemKind, ParsedItem, SavedItem } from "@/lib/types";

type SpeechRecognitionCtor = new () => SpeechRecognition;
type SpeechRecognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};
type SpeechRecognitionEvent = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};
type Page = "capture" | "items" | "summary";
type DailySummary = {
  date: string;
  engine: "yunwu" | "local";
  summary: string;
  schedule: Array<{ time: string; plan: string }>;
  suggestions: string[];
  generatedAt: string;
};

const kindLabels: Record<ItemKind, string> = {
  todo: "待办",
  event: "日程",
  reminder: "提醒",
  note: "备注"
};

const API_BASE_URL = import.meta.env.PROD ? "https://my-ssj-web-app-production.up.railway.app" : "http://localhost:3001";

function apiUrl(path: string) {
  return `${API_BASE_URL}${path}`;
}

function wsUrl(path: string) {
  return `${API_BASE_URL.replace(/^http/, "ws")}${path}`;
}

function downsampleBuffer(buffer: Float32Array, inputSampleRate: number, outputSampleRate: number) {
  if (outputSampleRate === inputSampleRate) return buffer;
  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accumulator = 0;
    let count = 0;
    for (let index = offsetBuffer; index < nextOffsetBuffer && index < buffer.length; index += 1) {
      accumulator += buffer[index];
      count += 1;
    }
    result[offsetResult] = accumulator / count;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function encodePcm16(samples: Float32Array) {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm.buffer;
}

function todayValue() {
  return new Date().toLocaleDateString("en-CA");
}

function tomorrowValue() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toLocaleDateString("en-CA");
}

function formatDate(date: string | null) {
  if (!date) return "无日期";
  if (date === todayValue()) return "今天";
  if (date === tomorrowValue()) return "明天";
  const parsed = new Date(`${date}T00:00:00`);
  return parsed.toLocaleDateString("zh-CN", { month: "short", day: "numeric", weekday: "short" });
}

function buildItemTime(item: SavedItem | ParsedItem) {
  if (!item.date && !item.time) return "未设时间";
  return [formatDate(item.date), item.time].filter(Boolean).join(" ");
}

function groupItemsByTime(items: SavedItem[]) {
  const active = items.filter((item) => item.status === "active");
  return [
    { title: "逾期", items: active.filter((item) => item.date && item.date < todayValue()) },
    { title: "今天", items: active.filter((item) => item.date === todayValue()) },
    { title: "明天", items: active.filter((item) => item.date === tomorrowValue()) },
    { title: "以后", items: active.filter((item) => item.date && item.date > tomorrowValue()) },
    { title: "无日期", items: active.filter((item) => !item.date) },
    { title: "已完成", items: items.filter((item) => item.status === "done").slice(0, 8) }
  ].filter((group) => group.items.length > 0);
}

function groupItemsByCategory(items: SavedItem[]) {
  const active = items.filter((item) => item.status === "active");
  const categories = Array.from(new Set(active.map((item) => item.category || kindLabels[item.kind])));
  const groups = categories.map((category) => ({
    title: category,
    items: active.filter((item) => (item.category || kindLabels[item.kind]) === category)
  }));
  return [...groups, { title: "已完成", items: items.filter((item) => item.status === "done").slice(0, 8) }].filter((group) => group.items.length > 0);
}

export default function App() {
  const [text, setText] = useState("");
  const [items, setItems] = useState<SavedItem[]>([]);
  const [page, setPage] = useState<Page>("capture");
  const [isParsing, setIsParsing] = useState(false);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"time" | "category">("time");
  const [dailySummary, setDailySummary] = useState<DailySummary | null>(null);
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<SavedItem | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [listeningTarget, setListeningTarget] = useState<"main" | "editNotes" | null>(null);
  const [notificationEnabled, setNotificationEnabled] = useState(false);
  const [lastAiMessage, setLastAiMessage] = useState("");
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const asrSocketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const transcriptRef = useRef("");
  const forceCloseTimerRef = useRef<number | null>(null);

  const categories = useMemo(() => Array.from(new Set(items.map((item) => item.category).filter(Boolean))), [items]);
  const todayItems = items.filter((item) => item.status === "active" && item.date === todayValue());
  const overdueItems = items.filter((item) => item.status === "active" && item.date && item.date < todayValue());
  const filteredItems = useMemo(() => {
    const keyword = query.trim();
    if (!keyword) return items;
    return items.filter((item) => `${item.title}${item.notes}${item.sourceText}${item.category}`.includes(keyword));
  }, [items, query]);
  const visibleGroups = viewMode === "time" ? groupItemsByTime(filteredItems) : groupItemsByCategory(filteredItems);

  useEffect(() => {
    void loadItems();
  }, []);

  useEffect(() => {
    setNotificationEnabled("Notification" in window && Notification.permission === "granted");
  }, []);

  useEffect(() => {
    loadOrGenerateDailySummary(false);
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setDate(now.getDate() + 1);
    nextMidnight.setHours(0, 0, 5, 0);
    const timeout = window.setTimeout(() => {
      loadOrGenerateDailySummary(true);
    }, nextMidnight.getTime() - now.getTime());

    return () => window.clearTimeout(timeout);
  }, [items]);

  async function loadItems() {
    const response = await fetch(apiUrl("/api/items"));
    const data = (await response.json()) as { items: SavedItem[] };
    setItems(data.items);
  }

  useEffect(() => {
    const timers = items
      .filter((item) => item.status === "active" && item.date && item.time && item.reminderMinutesBefore !== null)
      .map((item) => {
        const dueAt = new Date(`${item.date}T${item.time}:00`).getTime();
        const remindAt = dueAt - (item.reminderMinutesBefore ?? 0) * 60 * 1000;
        const delay = remindAt - Date.now();
        if (delay < 0 || delay > 24 * 60 * 60 * 1000) return null;

        return window.setTimeout(() => {
          if ("Notification" in window && Notification.permission === "granted") {
            new Notification("随时记提醒", { body: item.title });
          } else {
            alert(`随时记提醒：${item.title}`);
          }
        }, delay);
      });

    return () => {
      timers.forEach((timer) => {
        if (timer) window.clearTimeout(timer);
      });
    };
  }, [items]);

  async function parseAndSave() {
    const value = text.trim();
    if (!value) return;
    setIsParsing(true);
    setLastAiMessage("");

    try {
      const response = await fetch(apiUrl("/api/capture"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: value })
      });
      if (!response.ok) throw new Error("capture failed");
      const result = (await response.json()) as AiParseResult;
      const savedItems = result.items as SavedItem[];
      setItems((current) => [...savedItems, ...current]);
      setText("");
      setLastAiMessage(result.engine === "yunwu" ? `AI 已自动保存 ${savedItems.length} 条事项` : `已使用本地解析保存 ${savedItems.length} 条事项`);
      setPage("items");
    } catch {
      setLastAiMessage("保存失败，请确认后端服务和数据库已启动");
    } finally {
      setIsParsing(false);
    }
  }

  function getTodayItemsForSummary() {
    return items.filter((item) => item.status === "active" && (item.date === todayValue() || !item.date));
  }

  async function loadOrGenerateDailySummary(force: boolean) {
    const date = todayValue();
    setIsGeneratingSummary(true);
    try {
      const response = await fetch(apiUrl("/api/daily-summary"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, force })
      });
      if (!response.ok) throw new Error("summary failed");
      const data = (await response.json()) as DailySummary;
      setDailySummary(data);
    } catch {
      const fallback: DailySummary = {
        date,
        engine: "local",
        summary: `今天有 ${items.length} 条待处理事项。建议先处理有明确时间的安排，再处理其他待办。`,
        schedule: [],
        suggestions: ["先处理最紧急的事项。", "把无日期事项安排到具体时间段。", "给复杂任务拆成更小的下一步。"],
        generatedAt: new Date().toISOString()
      };
      setDailySummary(fallback);
    } finally {
      setIsGeneratingSummary(false);
    }
  }

  async function updateItem(id: string, updates: Partial<SavedItem>) {
    const currentItem = items.find((item) => item.id === id);
    if (!currentItem) return;
    const optimisticItem = { ...currentItem, ...updates, updatedAt: new Date().toISOString() };
    setItems((current) => current.map((item) => (item.id === id ? optimisticItem : item)));
    const response = await fetch(apiUrl(`/api/items/${id}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(optimisticItem)
    });
    if (response.ok) {
      const data = (await response.json()) as { item: SavedItem };
      setItems((current) => current.map((item) => (item.id === id ? data.item : item)));
    }
  }

  async function deleteItem(id: string) {
    const beforeDelete = items;
    setItems((current) => current.filter((item) => item.id !== id));
    const response = await fetch(apiUrl(`/api/items/${id}`), { method: "DELETE" });
    if (!response.ok) setItems(beforeDelete);
  }

  function postponeToTomorrow(id: string) {
    void updateItem(id, { date: tomorrowValue(), status: "active" });
  }

  function startEdit(item: SavedItem) {
    setEditingId(item.id);
    setEditDraft({ ...item });
  }

  function saveEdit() {
    if (!editDraft) return;
    void updateItem(editDraft.id, editDraft);
    setEditingId(null);
    setEditDraft(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft(null);
  }

  function applyTranscript(target: "main" | "editNotes", transcript: string) {
    const textValue = transcript.trim();
    if (!textValue) return;

    if (target === "editNotes") {
      setEditDraft((current) => (current ? { ...current, notes: textValue } : current));
    } else {
      setText(textValue);
    }
  }

  async function startVoice(target: "main" | "editNotes" = "main") {
    if (isListening) return;
    if (asrSocketRef.current) cleanupVoiceResources(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      const socket = new WebSocket(wsUrl("/api/asr/ws"));
      const audioContext = new AudioContext({ latencyHint: "interactive" });
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(1024, 1, 1);

      transcriptRef.current = target === "editNotes" ? editDraft?.notes ?? "" : text;
      asrSocketRef.current = socket;
      audioContextRef.current = audioContext;
      mediaStreamRef.current = stream;
      sourceRef.current = source;
      processorRef.current = processor;
      setListeningTarget(target);
      setIsListening(true);

      socket.binaryType = "arraybuffer";
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data)) as { type?: string; text?: string; message?: string };
          if (data.type === "transcript" && data.text) {
            transcriptRef.current = data.text;
            applyTranscript(target, data.text);
          }
          if (data.type === "finished") {
            cleanupVoiceResources();
          }
          if (data.type === "error") {
            alert(data.message || "语音识别失败，请稍后再试。");
            cleanupVoiceResources(true);
          }
        } catch {
          // Ignore non-JSON messages.
        }
      };
      socket.onclose = () => {
        cleanupVoiceResources();
      };
      socket.onerror = () => {
        alert("语音服务连接失败，请确认后端服务已启动。");
        cleanupVoiceResources(true);
      };

      processor.onaudioprocess = (event) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const samples = downsampleBuffer(input, audioContext.sampleRate, 16000);
        socket.send(encodePcm16(samples));
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
    } catch {
      alert("无法访问麦克风，请检查浏览器权限。");
      setIsListening(false);
      setListeningTarget(null);
    }
  }

  function stopVoice() {
    recognitionRef.current?.stop();
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    void audioContextRef.current?.close();

    const socket = asrSocketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send("stop");
      forceCloseTimerRef.current = window.setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      }, 8000);
    }

    processorRef.current = null;
    sourceRef.current = null;
    mediaStreamRef.current = null;
    audioContextRef.current = null;
    setIsListening(false);
  }

  function cleanupVoiceResources(closeSocket = false) {
    recognitionRef.current?.stop();
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    void audioContextRef.current?.close();
    if (forceCloseTimerRef.current) {
      window.clearTimeout(forceCloseTimerRef.current);
      forceCloseTimerRef.current = null;
    }

    const socket = asrSocketRef.current;
    if (closeSocket && socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close();
    }

    processorRef.current = null;
    sourceRef.current = null;
    mediaStreamRef.current = null;
    audioContextRef.current = null;
    asrSocketRef.current = null;
    setIsListening(false);
    setListeningTarget(null);
  }

  async function enableNotifications() {
    if (!("Notification" in window)) {
      alert("当前浏览器不支持通知。");
      return;
    }
    const permission = await Notification.requestPermission();
    setNotificationEnabled(permission === "granted");
  }

  function renderEditForm(item: SavedItem) {
    if (!editDraft || editingId !== item.id) return null;

    return (
      <div className="mt-3 space-y-3 border-t border-white/10 pt-3">
        <input
          value={editDraft.title}
          onChange={(event) => setEditDraft({ ...editDraft, title: event.target.value })}
          className="h-11 w-full rounded-lg border border-white/10 bg-slate-950/45 px-3 outline-none focus:border-teal-300"
        />
        <div className="grid grid-cols-2 gap-3">
          <select
            value={editDraft.kind}
            onChange={(event) => setEditDraft({ ...editDraft, kind: event.target.value as ItemKind })}
            className="h-11 rounded-lg border border-white/10 bg-slate-950/45 px-3 outline-none focus:border-teal-300"
          >
            {Object.entries(kindLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <input
            value={editDraft.category}
            onChange={(event) => setEditDraft({ ...editDraft, category: event.target.value })}
            placeholder="分类"
            className="h-11 rounded-lg border border-white/10 bg-slate-950/45 px-3 outline-none focus:border-teal-300"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <input
            type="date"
            value={editDraft.date ?? ""}
            onChange={(event) => setEditDraft({ ...editDraft, date: event.target.value || null })}
            className="h-11 rounded-lg border border-white/10 bg-slate-950/45 px-3 outline-none focus:border-teal-300"
          />
          <input
            type="time"
            value={editDraft.time ?? ""}
            onChange={(event) => setEditDraft({ ...editDraft, time: event.target.value || null })}
            className="h-11 rounded-lg border border-white/10 bg-slate-950/45 px-3 outline-none focus:border-teal-300"
          />
        </div>
        <div className="flex items-center gap-2">
          <textarea
            value={editDraft.notes}
            onChange={(event) => setEditDraft({ ...editDraft, notes: event.target.value })}
            placeholder="备注"
            className="min-h-20 flex-1 resize-none rounded-lg border border-white/10 bg-slate-950/45 p-3 outline-none focus:border-teal-300"
          />
          <button
            aria-label="语音输入备注"
            title="语音输入备注"
            onClick={isListening && listeningTarget === "editNotes" ? stopVoice : () => startVoice("editNotes")}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-teal-300 text-slate-950"
          >
            {isListening && listeningTarget === "editNotes" ? <X size={18} /> : <Mic size={18} />}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button onClick={cancelEdit} className="h-10 rounded-lg border border-white/10 bg-white/5 text-slate-300">
            取消
          </button>
          <button onClick={saveEdit} className="h-10 rounded-lg bg-teal-300 font-semibold text-slate-950">
            保存修改
          </button>
        </div>
      </div>
    );
  }

  function renderItemCard(item: SavedItem) {
    return (
      <article key={item.id} className="rounded-lg border border-white/10 bg-white/[0.075] p-3 shadow-[0_14px_40px_rgba(0,0,0,0.18)] backdrop-blur">
        <div className="flex items-start gap-3">
          <button
            aria-label="标记完成"
            title="标记完成"
            onClick={() => updateItem(item.id, { status: item.status === "done" ? "active" : "done" })}
            className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border ${
              item.status === "done" ? "border-teal-300 bg-teal-300 text-slate-950" : "border-white/20 bg-slate-950/30 text-transparent"
            }`}
          >
            <Check size={16} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-teal-300/25 bg-teal-300/10 px-2 py-0.5 text-xs text-teal-100">{item.category}</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-xs text-slate-300">{kindLabels[item.kind]}</span>
              <span className="text-xs text-slate-400">{buildItemTime(item)}</span>
            </div>
            <h3 className={`mt-1 break-words font-semibold ${item.status === "done" ? "text-slate-500 line-through" : "text-white"}`}>{item.title}</h3>
            {item.notes ? <p className="mt-1 break-words text-sm text-slate-300">{item.notes}</p> : null}
            <div className="mt-3 flex gap-2">
              <button onClick={() => postponeToTomorrow(item.id)} className="h-8 rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-slate-300">
                明天
              </button>
              <button onClick={() => startEdit(item)} className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-white/5 text-slate-300" aria-label="修改" title="修改">
                <Pencil size={15} />
              </button>
              <button onClick={() => deleteItem(item.id)} className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-white/5 text-slate-300" aria-label="删除" title="删除">
                <Trash2 size={15} />
              </button>
            </div>
            {renderEditForm(item)}
          </div>
        </div>
      </article>
    );
  }

  function renderCapturePage() {
    return (
      <section className="rounded-lg border border-white/12 bg-white/[0.08] p-4 shadow-[0_24px_70px_rgba(0,0,0,0.28)] backdrop-blur-xl">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
              <Sparkles size={18} className="text-teal-200" />
              AI 自动整理
            </h2>
            <p className="mt-1 text-sm text-slate-300">说一句话，AI 会自动拆分、分类并保存。</p>
          </div>
        </div>

        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="例如：下周二下午三点跟李总聊报价，周五前把正式合同发给他"
          className="mt-4 min-h-28 w-full resize-none rounded-lg border border-white/10 bg-slate-950/45 p-3 text-base outline-none transition focus:border-teal-300 focus:ring-2 focus:ring-teal-300/20"
        />

        <div className="flex min-h-48 flex-col items-center justify-center">
          <button
            aria-label={isListening && listeningTarget === "main" ? "松开停止录音" : "按住开始语音输入"}
            title={isListening && listeningTarget === "main" ? "松开停止录音" : "按住开始语音输入"}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              void startVoice("main");
            }}
            onPointerUp={(event) => {
              event.preventDefault();
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              stopVoice();
            }}
            onPointerCancel={stopVoice}
            onPointerLeave={(event) => {
              if (isListening && listeningTarget === "main" && event.buttons === 1) stopVoice();
            }}
            className={`grid h-28 w-28 place-items-center rounded-full border text-slate-950 shadow-[0_0_54px_rgba(45,212,191,0.38)] transition active:scale-95 ${
              isListening && listeningTarget === "main"
                ? "border-coral/60 bg-coral text-white shadow-[0_0_64px_rgba(255,122,89,0.45)]"
                : "border-teal-200/50 bg-teal-300"
            }`}
          >
            {isListening && listeningTarget === "main" ? <X size={42} /> : <Mic size={42} />}
          </button>
          <p className="mt-4 text-sm font-medium text-teal-100">
            {isListening && listeningTarget === "main" ? "正在听，松开结束" : "按住说话"}
          </p>
        </div>

        <button
          onClick={parseAndSave}
          disabled={!text.trim() || isParsing}
          className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-teal-300 px-4 font-semibold text-slate-950 shadow-[0_0_30px_rgba(45,212,191,0.24)] transition disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-slate-400"
        >
          {isParsing ? "AI 正在整理" : "让 AI 自动保存"}
          <Sparkles size={18} />
        </button>

        {lastAiMessage ? <p className="mt-3 text-sm text-teal-100">{lastAiMessage}</p> : null}
      </section>
    );
  }

  function renderItemsPage() {
    return (
      <section>
        <div className="mb-3 grid grid-cols-2 rounded-lg border border-white/10 bg-white/[0.08] p-1 backdrop-blur">
          <button onClick={() => setViewMode("time")} className={`h-10 rounded-md text-sm font-semibold transition ${viewMode === "time" ? "bg-teal-300 text-slate-950" : "text-slate-300"}`}>
            按时间
          </button>
          <button onClick={() => setViewMode("category")} className={`h-10 rounded-md text-sm font-semibold transition ${viewMode === "category" ? "bg-teal-300 text-slate-950" : "text-slate-300"}`}>
            按分类
          </button>
        </div>

        <div className="mb-3 flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.08] px-3 py-2 backdrop-blur">
          <Search size={18} className="text-teal-200/80" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索事项、分类或备注" className="h-9 flex-1 bg-transparent outline-none" />
        </div>

        {visibleGroups.length === 0 ? (
          <div className="rounded-lg border border-dashed border-white/15 bg-white/[0.06] px-4 py-8 text-center text-slate-300">还没有事项，先记录一句试试。</div>
        ) : (
          <div className="space-y-5">
            {visibleGroups.map((group) => (
              <div key={group.title}>
                <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-teal-100/85">
                  <CalendarClock size={16} />
                  {group.title}
                </h2>
                <div className="space-y-2">{group.items.map((item) => renderItemCard(item))}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  function renderSummaryPage() {
    return (
      <section className="space-y-4">
        <div className="rounded-lg border border-white/12 bg-white/[0.08] p-4 shadow-[0_24px_70px_rgba(0,0,0,0.26)] backdrop-blur-xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
                <Sparkles size={18} className="text-teal-200" />
                今日 AI 总结
              </h2>
              <p className="mt-1 text-sm text-slate-300">{dailySummary ? `${dailySummary.date} · ${dailySummary.engine === "yunwu" ? "云雾 AI" : "本地总结"}` : "正在准备今日报告"}</p>
            </div>
            <button
              onClick={() => loadOrGenerateDailySummary(true)}
              disabled={isGeneratingSummary}
              className="h-9 shrink-0 rounded-lg bg-teal-300 px-3 text-sm font-semibold text-slate-950 disabled:bg-white/10 disabled:text-slate-400"
            >
              {isGeneratingSummary ? "生成中" : "重新生成"}
            </button>
          </div>

          <p className="mt-4 whitespace-pre-line text-sm leading-6 text-slate-100">{dailySummary?.summary ?? "AI 正在根据今天的事项生成事务报告、日程规划和建议。"}</p>
        </div>

        <div className="rounded-lg border border-white/12 bg-white/[0.08] p-4 backdrop-blur-xl">
          <h3 className="mb-3 text-sm font-semibold text-teal-100">日程规划</h3>
          {dailySummary?.schedule.length ? (
            <div className="space-y-2">
              {dailySummary.schedule.map((entry, index) => (
                <div key={`${entry.time}-${index}`} className="rounded-lg border border-white/10 bg-slate-950/30 p-3">
                  <p className="text-xs text-teal-100">{entry.time}</p>
                  <p className="mt-1 text-sm text-slate-100">{entry.plan}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-300">暂无明确时间规划。录入今天的事项后，AI 会自动生成。</p>
          )}
        </div>

        <div className="rounded-lg border border-white/12 bg-white/[0.08] p-4 backdrop-blur-xl">
          <h3 className="mb-3 text-sm font-semibold text-teal-100">执行建议</h3>
          {dailySummary?.suggestions.length ? (
            <div className="space-y-2">
              {dailySummary.suggestions.map((suggestion, index) => (
                <p key={`${suggestion}-${index}`} className="rounded-lg border border-white/10 bg-slate-950/30 p-3 text-sm text-slate-100">
                  {suggestion}
                </p>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-300">暂无建议。</p>
          )}
        </div>
      </section>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col px-4 pb-28 pt-5 text-slate-100">
      <header className="mb-5 flex items-center justify-between">
        <div>
          <p className="text-sm text-teal-200/75">{new Date().toLocaleDateString("zh-CN", { weekday: "long", month: "long", day: "numeric" })}</p>
          <h1 className="text-3xl font-semibold tracking-normal text-white">LOUIS的超级助理</h1>
        </div>
        <button
          onClick={enableNotifications}
          className="rounded-full border border-teal-300/25 bg-white/10 px-3 py-2 text-sm text-teal-100 shadow-[0_0_28px_rgba(45,212,191,0.12)] backdrop-blur"
          title="开启浏览器通知"
        >
          {notificationEnabled ? "通知已开" : `今天 ${todayItems.length}`}
        </button>
      </header>

      <nav className="mb-4 grid grid-cols-3 rounded-lg border border-white/10 bg-white/[0.08] p-1 backdrop-blur">
        <button onClick={() => setPage("capture")} className={`flex h-10 items-center justify-center gap-1 rounded-md text-sm font-semibold transition ${page === "capture" ? "bg-teal-300 text-slate-950" : "text-slate-300"}`}>
          <Home size={16} />
          记录
        </button>
        <button onClick={() => setPage("items")} className={`flex h-10 items-center justify-center gap-1 rounded-md text-sm font-semibold transition ${page === "items" ? "bg-teal-300 text-slate-950" : "text-slate-300"}`}>
          <ListTodo size={16} />
          事项
        </button>
        <button onClick={() => setPage("summary")} className={`flex h-10 items-center justify-center gap-1 rounded-md text-sm font-semibold transition ${page === "summary" ? "bg-teal-300 text-slate-950" : "text-slate-300"}`}>
          <Sparkles size={16} />
          总结
        </button>
      </nav>

      {overdueItems.length > 0 ? (
        <section className="mb-4 rounded-lg border border-coral/40 bg-coral/10 px-4 py-3 shadow-[0_16px_42px_rgba(255,122,89,0.14)] backdrop-blur">
          <div className="flex items-center gap-2 text-sm font-medium text-orange-200">
            <Clock3 size={16} />有 {overdueItems.length} 件事已经过期
          </div>
        </section>
      ) : null}

      {page === "capture" ? renderCapturePage() : null}
      {page === "items" ? renderItemsPage() : null}
      {page === "summary" ? renderSummaryPage() : null}
    </main>
  );
}
