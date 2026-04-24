import type { ParsedItem } from "./types.ts";

const zhNumberMap: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10
};

const weekdayMap: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 0,
  天: 0,
  末: 6
};

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function readNumber(value: string) {
  if (/^\d+$/.test(value)) return Number(value);
  if (value === "十一") return 11;
  if (value === "十二") return 12;
  if (value.startsWith("十")) return 10 + (zhNumberMap[value.slice(1)] ?? 0);
  if (value.endsWith("十")) return (zhNumberMap[value[0]] ?? 1) * 10;
  if (value.includes("十")) {
    const [tens, ones] = value.split("十");
    return (zhNumberMap[tens] ?? 1) * 10 + (zhNumberMap[ones] ?? 0);
  }
  return zhNumberMap[value] ?? null;
}

function resolveWeekdayDate(normalized: string, now: Date) {
  const weekdayMatch = normalized.match(/(下下|下|这|本)?(?:周|星期|礼拜)([一二三四五六日天末])/);
  if (!weekdayMatch) return null;

  const prefix = weekdayMatch[1] ?? "";
  const targetDay = weekdayMap[weekdayMatch[2]];
  const currentDay = now.getDay();
  const daysUntilNextMonday = currentDay === 0 ? 1 : 8 - currentDay;
  const offsetFromMonday = targetDay === 0 ? 6 : targetDay - 1;

  if (prefix === "下下") return toDateInputValue(addDays(now, daysUntilNextMonday + 7 + offsetFromMonday));
  if (prefix === "下") return toDateInputValue(addDays(now, daysUntilNextMonday + offsetFromMonday));
  if (prefix === "这" || prefix === "本") return toDateInputValue(addDays(now, targetDay - currentDay));

  const distance = (targetDay - currentDay + 7) % 7 || 7;
  return toDateInputValue(addDays(now, distance));
}

export function parseLocally(text: string, now = new Date()): ParsedItem {
  const sourceText = text.trim();
  const normalized = sourceText.replace(/\s+/g, "");

  let kind: ParsedItem["kind"] = "todo";
  if (/(备忘|备注|记一下|记录一下|想法)/.test(normalized) && !/(提醒|明天|后天|今天|下午|上午|晚上|早上|\d+点)/.test(normalized)) {
    kind = "note";
  } else if (/(会议|开会|约|日程|行程|见面)/.test(normalized)) {
    kind = "event";
  } else if (/(提醒|叫我|到点)/.test(normalized)) {
    kind = "reminder";
  }

  let date: string | null = null;
  if (/今天/.test(normalized)) date = toDateInputValue(now);
  if (/明天/.test(normalized)) date = toDateInputValue(addDays(now, 1));
  if (/后天/.test(normalized)) date = toDateInputValue(addDays(now, 2));
  if (/大后天/.test(normalized)) date = toDateInputValue(addDays(now, 3));
  date = resolveWeekdayDate(normalized, now) ?? date;

  const dateMatch = normalized.match(/(\d{1,2})[月/](\d{1,2})[日号]?/);
  if (dateMatch) {
    const year = now.getFullYear();
    date = `${year}-${dateMatch[1].padStart(2, "0")}-${dateMatch[2].padStart(2, "0")}`;
  }

  let time: string | null = null;
  const timeMatch = normalized.match(/(凌晨|早上|上午|中午|下午|晚上)?([零一二两三四五六七八九十\d]{1,3})点(?:(半|[零一二两三四五六七八九十\d]{1,3})分?)?/);
  if (timeMatch) {
    let hour = readNumber(timeMatch[2]);
    if (hour !== null) {
      const period = timeMatch[1] ?? "";
      if ((period === "下午" || period === "晚上") && hour < 12) hour += 12;
      if (period === "中午" && hour < 11) hour += 12;
      const minute = timeMatch[3] === "半" ? 30 : timeMatch[3] ? readNumber(timeMatch[3]) ?? 0 : 0;
      time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
  }

  const reminderMinutesBefore = /(提前|之前)/.test(normalized) ? 10 : /(提醒|叫我|到点)/.test(normalized) ? 0 : null;
  const priority = /(重要|紧急|马上|尽快)/.test(normalized) ? "high" : "medium";
  const category = /(客户|合同|报价|王总|李总|张总)/.test(normalized)
    ? "客户跟进"
    : /(发票|报销|付款|收款|工资|账)/.test(normalized)
      ? "财务"
      : kind === "note"
        ? "备注"
        : "待办";

  const title = sourceText
    .replace(/^(帮我|我要|我想|记一下|记录一下|提醒我|到点提醒我)/, "")
    .replace(/(今天|明天|后天|大后天|周末|星期六|周六|(下下|下|这|本)?(周|星期|礼拜)[一二三四五六日天末])/g, "")
    .replace(/(凌晨|早上|上午|中午|下午|晚上)?[零一二两三四五六七八九十\d]{1,3}点(半|[零一二两三四五六七八九十\d]{1,3}分?)?/g, "")
    .replace(/提醒我|提醒|记得|要/g, "")
    .trim();

  return {
    kind,
    category,
    title: title || sourceText,
    date,
    time,
    reminderMinutesBefore,
    notes: kind === "note" ? sourceText : "",
    priority,
    sourceText
  };
}
