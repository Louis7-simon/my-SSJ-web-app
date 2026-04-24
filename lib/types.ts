export type ItemKind = "todo" | "event" | "reminder" | "note";
export type ItemStatus = "active" | "done";
export type ItemPriority = "low" | "medium" | "high";

export type ParsedItem = {
  kind: ItemKind;
  category: string;
  title: string;
  date: string | null;
  time: string | null;
  reminderMinutesBefore: number | null;
  notes: string;
  priority: ItemPriority;
  sourceText: string;
};

export type AiParseResult = {
  items: ParsedItem[];
  questions?: string[];
  engine: "yunwu" | "local";
};

export type SavedItem = ParsedItem & {
  id: string;
  status: ItemStatus;
  createdAt: string;
  updatedAt: string;
};
