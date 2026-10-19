// Picks the transcript passages most relevant to a set of queries, in memory,
// per request. Lexical on purpose: fast, deterministic, no model or index.
// Prefix stemming makes inflected forms match ("productivity" ~ "productive",
// "productivity" ~ "productive"); diacritics are folded.

import type { Segment } from "./parse.js";

export interface Highlight {
  start: number;
  end: number;
  text: string;
  score: number;
  matched: string[];
}

const STOPWORDS = new Set(
  (
    "an and are as at be but by do does for from how i if in into is it its me my of on or our so than that the their them " +
    "then there these they this to was we what when where which who why will with you your vs versus about best top " +
    "a aby ale ani co do i jak jako je jsem jsou k kde ke ktery ktera ktere kdyz mi na nad ne nebo o od po pod pro proc s se si " +
    "ta tak tam to tu u v ve z za ze nejlepsi"
  ).split(/\s+/),
);

export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function tokenize(s: string): string[] {
  return fold(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function stem(t: string): string {
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
  if (t.length < 5) return t;
  return t.slice(0, Math.max(5, Math.ceil(t.length * 0.7)));
}

export function queryTerms(queries: string[]): string[] {
  const terms = new Set<string>();
  for (const q of queries) {
    for (const t of tokenize(q)) if (t.length >= 2 && !STOPWORDS.has(t)) terms.add(stem(t));
  }
  return [...terms];
}

function termMatches(token: string, term: string): boolean {
  if (term.length >= 4) return token.startsWith(term);
  return token === term || token === term + "s";
}

interface Window {
  start: number;
  end: number;
  text: string;
  tokens: string[];
}

function buildWindows(segments: Segment[], windowSec: number): Window[] {
  const out: Window[] = [];
  const step = Math.max(1, Math.floor(segments.length / 400)); // cap work on very long videos
  for (let i = 0; i < segments.length; i += step) {
    const start = segments[i].start;
    const parts: string[] = [];
    let end = start;
    for (let j = i; j < segments.length && segments[j].start < start + windowSec; j++) {
      parts.push(segments[j].text);
      end = segments[j].start + segments[j].dur;
    }
    const t = parts.join(" ");
    out.push({ start, end, text: t, tokens: tokenize(t) });
  }
  return out;
}

export function findHighlights(
  segments: Segment[],
  queries: string[],
  opts: { count: number; windowSec?: number; maxChars?: number } = { count: 3 },
): Highlight[] {
  const terms = queryTerms(queries);
  if (!terms.length || !segments.length) return [];
  const windows = buildWindows(segments, opts.windowSec ?? 25);

  // Weight rarer terms higher: a term that appears in every window carries no signal.
  const df = new Map<string, number>();
  const presence = windows.map((w) => {
    const present = new Set<string>();
    for (const term of terms) if (w.tokens.some((tok) => termMatches(tok, term))) present.add(term);
    for (const t of present) df.set(t, (df.get(t) ?? 0) + 1);
    return present;
  });
  const idf = (t: string) => Math.log(1 + windows.length / (1 + (df.get(t) ?? 0)));

  const scored = windows
    .map((w, i) => {
      const present = presence[i];
      if (!present.size) return undefined;
      let score = 0;
      for (const t of present) score += idf(t);
      score *= 1 + 0.5 * (present.size - 1); // reward passages that hit several concepts at once
      return { w, score, matched: [...present] };
    })
    .filter((x): x is { w: Window; score: number; matched: string[] } => !!x)
    .sort((a, b) => b.score - a.score);

  const picked: Highlight[] = [];
  for (const s of scored) {
    if (picked.length >= opts.count) break;
    if (picked.some((p) => s.w.start < p.end && s.w.end > p.start)) continue;
    picked.push({
      start: s.w.start,
      end: s.w.end,
      text: clip(s.w.text, opts.maxChars ?? 320),
      score: Math.round(s.score * 100) / 100,
      matched: s.matched,
    });
  }
  return picked.sort((a, b) => a.start - b.start);
}

function clip(t: string, max: number): string {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(" ") > max * 0.6 ? cut.lastIndexOf(" ") : max) + "…";
}

/**
 * Does `text` match the query phrases? Accent-folded, prefix-stemmed like passage
 * search. mode "any": at least one query term; "all": every term.
 * Returns the number of distinct terms matched (0 = no match).
 */
export function textMatchScore(text: string, queries: string[], mode: "any" | "all" = "any"): number {
  const terms = queryTerms(queries);
  if (!terms.length) return 0;
  const tokens = tokenize(text);
  let hit = 0;
  for (const term of terms) if (tokens.some((tok) => termMatches(tok, term))) hit++;
  return mode === "all" ? (hit === terms.length ? hit : 0) : hit;
}
