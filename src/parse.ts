// Defensive helpers for Innertube JSON. YouTube reshuffles nesting often, so we
// search by key anywhere in the tree instead of hardcoding long paths.

export function findAll(node: unknown, key: string, out: any[] = []): any[] {
  if (Array.isArray(node)) {
    for (const v of node) findAll(v, key, out);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      findAll(v, key, out);
    }
  }
  return out;
}

export function findFirst(node: unknown, key: string): any {
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findFirst(v, key);
      if (r !== undefined) return r;
    }
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) return v;
      const r = findFirst(v, key);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

/** Text from any of YouTube's text shapes: simpleText, runs[], content, plain string. */
export function text(t: any): string {
  if (t == null) return "";
  if (typeof t === "string") return t;
  if (typeof t.simpleText === "string") return t.simpleText;
  if (Array.isArray(t.runs)) return t.runs.map((r: any) => r.text ?? "").join("");
  if (typeof t.content === "string") return t.content;
  return "";
}

/** "2,149,594 views", "2.1M views", "120K", "1,2 mil. zhlédnutí", "No views" -> number */
export function parseCount(s: string | undefined | null): number | undefined {
  if (!s) return undefined;
  const str = String(s).trim();
  if (/^no\b/i.test(str)) return 0;
  const m = str.match(/(\d[\d.,\s ]*)\s*([KMB]|tis\.|mil\.|mld\.)?/i);
  if (!m) return undefined;
  let numStr = m[1].replace(/[\s ]/g, "");
  const suffix = m[2]?.toLowerCase();
  if (suffix) {
    numStr = numStr.replace(",", ".");
    const n = parseFloat(numStr);
    const mult = suffix.startsWith("k") || suffix.startsWith("tis")
      ? 1e3
      : suffix.startsWith("m") && !suffix.startsWith("mld")
        ? 1e6
        : 1e9;
    return Math.round(n * mult);
  }
  return parseInt(numStr.replace(/[.,]/g, ""), 10);
}

/** "1:02:03" | "20:47" -> seconds */
export function parseClock(s: string | undefined | null): number | undefined {
  if (!s) return undefined;
  const parts = String(s).trim().split(":").map((p) => parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? `${h}:` : "") + `${mm}:${String(sec).padStart(2, "0")}`;
}

const UNIT_DAYS: Record<string, number> = {
  second: 1 / 86400,
  minute: 1 / 1440,
  hour: 1 / 24,
  day: 1,
  week: 7,
  month: 30.44,
  year: 365.25,
};

// Relative-date words for the interface languages a research agent is likely to
// pass as `hl`. Matched on diacritic-folded, lowercased text by prefix.
const UNIT_WORDS: Array<[RegExp, keyof typeof UNIT_DAYS]> = [
  [/^(second|sekund|sec)/, "second"],
  [/^(minut|min)/, "minute"],
  [/^(hour|hodin|stund)/, "hour"],
  [/^(day|dny|dnem|den|dni|tag|dia|jour)/, "day"],
  [/^(week|tyd|woche|seman|semaine)/, "week"],
  [/^(month|mesic|monat|mes|mois)/, "month"],
  [/^(year|rok|let|lety|jahr|ano|an)/, "year"],
];

/**
 * "2 months ago", "Streamed 3 weeks ago", "před 3 týdny", "vor 2 Tagen" -> approximate Date.
 */
export function parseRelativeDate(s: string | undefined | null, now = new Date()): Date | undefined {
  if (!s) return undefined;
  const folded = String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const m = folded.match(/(\d+)\s*([a-z]+)/);
  if (!m) return undefined;
  const unit = UNIT_WORDS.find(([re]) => re.test(m[2]))?.[1];
  if (!unit) return undefined;
  const days = parseInt(m[1], 10) * UNIT_DAYS[unit];
  return new Date(now.getTime() - days * 86400_000);
}

/** "Jul 14, 2026", "Streamed live on Jul 14, 2026", "Premiered Jul 14, 2026" -> Date */
export function parseAbsoluteDate(s: string | undefined | null): Date | undefined {
  if (!s) return undefined;
  const m = String(s).match(/([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})/);
  if (!m) return undefined;
  const d = new Date(m[1] + " UTC");
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function isoDay(d: Date | undefined): string | undefined {
  return d ? d.toISOString().slice(0, 10) : undefined;
}

/** Accepts a video id, any youtube/youtu.be/shorts/live/embed URL. */
export function parseVideoId(input: string): string | undefined {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m =
    s.match(/[?&]v=([\w-]{11})/) ||
    s.match(/youtu\.be\/([\w-]{11})/) ||
    s.match(/\/(?:shorts|live|embed|v)\/([\w-]{11})/);
  return m?.[1];
}

/** Optional "?t=90", "&t=1m30s", "#t=0-30" style start time embedded in a URL. */
export function parseUrlStart(input: string): number | undefined {
  const m = input.match(/[?&#]t=(\d+h)?(\d+m)?(\d+)s?\b/);
  if (!m) return undefined;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const mi = m[2] ? parseInt(m[2], 10) : 0;
  return h * 3600 + mi * 60 + parseInt(m[3], 10);
}

export function compactNumber(n: number | undefined): string {
  if (n == null) return "?";
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K";
  return String(n);
}

export function watchUrl(id: string, t?: number): string {
  return `https://youtu.be/${id}` + (t && t > 0 ? `?t=${Math.floor(t)}` : "");
}

export interface Segment {
  start: number;
  dur: number;
  text: string;
}

/** YouTube timedtext `fmt=json3` -> segments in seconds. */
export function parseJson3(j: any): Segment[] {
  const segs: Segment[] = [];
  for (const e of j?.events ?? []) {
    if (!e.segs) continue;
    const t = e.segs
      .map((s: any) => s.utf8 ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!t) continue;
    segs.push({ start: (e.tStartMs ?? 0) / 1000, dur: (e.dDurationMs ?? 0) / 1000, text: t });
  }
  return segs;
}
