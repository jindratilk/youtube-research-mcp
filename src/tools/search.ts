import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { captionCooldownSeconds, search, transcriptFor, type VideoHit } from "../youtube.js";
import { findHighlights, type Highlight } from "../highlights.js";
import { compactNumber, formatClock, isoDay, watchUrl } from "../parse.js";
import { isoDate, lenientArray, lenientBool, lenientNumber, READ_ONLY, toDate } from "../schema.js";
import { YouTubeError } from "../innertube.js";
import { errorText } from "./common.js";

const queryItem = z.union([
  z.string().min(1),
  z.object({
    query: z.string().min(1),
    hl: z.string().optional().describe("Interface language for this query, e.g. 'es'"),
    gl: z.string().optional().describe("Region for this query, e.g. 'ES'"),
  }),
]);

const DESCRIPTION = `Search YouTube videos and get back ready-to-use results with transcript highlights: the passages where each video actually talks about your topic, with timestamped links.

Best for: finding videos on a topic, finding what creators say about something, collecting examples (hooks, claims, tutorials) across many videos.
Returns: one merged, de-duplicated list across all queries. Each video has metadata (channel, views, date, duration, views/day), YouTube's matched snippet and key moments, plus transcript highlights for the top results.

Query tips:
- Send several queries in ONE call to cover the topic: synonyms, angles and languages, e.g. ["AI productivity workflow", "how I use AI to save time at work", {"query": "productividad con IA", "hl": "es", "gl": "ES"}].
- Write queries the way a creator would title the video, not as keyword soup.
- Use filters (uploaded, publishedAfter, minViews, duration, shorts) instead of asking for more results.
- If highlights are not enough, call youtube_fetch on the best videos (it can return only a time range, e.g. the first 30 s for a hook, or only passages matching a query).`;

export function registerSearchTool(server: McpServer): void {
  server.registerTool(
    "youtube_search",
    {
      title: "Search YouTube",
      description: DESCRIPTION,
      inputSchema: {
        queries: lenientArray(queryItem)
          .refine((a) => a.length >= 1 && a.length <= 12, "Send 1–12 queries")
          .describe("1–12 queries, run in one call and merged. Strings, or {query, hl, gl} for a language/region-specific query."),
        limit: lenientNumber()
          .optional()
          .describe("Results per query before merging (default 10, max 50)."),
        sort: z
          .enum(["relevance", "views", "date"])
          .optional()
          .describe("relevance (default), views (server-side), or date: newest first among the fetched results; YouTube dropped server-side date sort, so pair it with uploaded."),
        uploaded: z
          .enum(["hour", "today", "week", "month", "year"])
          .optional()
          .describe("Server-side upload-date window. Prefer this over publishedAfter when it fits."),
        publishedAfter: isoDate()
          .optional()
          .describe("YYYY-MM-DD or YYYY-MM. Applied after search on YouTube's relative dates ('3 weeks ago'), so it is approximate (±1 unit)."),
        publishedBefore: isoDate().optional().describe("YYYY-MM-DD or YYYY-MM, approximate like publishedAfter."),
        duration: z
          .enum(["short", "medium", "long"])
          .optional()
          .describe("Server-side: short <4 min, medium 4–20 min, long >20 min."),
        minDurationSec: lenientNumber().optional(),
        maxDurationSec: lenientNumber().optional(),
        minViews: lenientNumber().optional(),
        shorts: z.enum(["exclude", "include", "only"]).optional().describe("Default exclude."),
        captionsOnly: lenientBool().optional().describe("Only videos with subtitles/CC (server-side filter)."),
        highlights: lenientNumber()
          .optional()
          .describe("How many top results get transcript highlights (default 5, 0 = off, max 25). Each downloads one transcript; YouTube rate-limits transcripts per IP, so spend them where they matter."),
        highlightsPerVideo: lenientNumber().optional().describe("Passages per video (default 3, max 8)."),
        highlightQuery: lenientArray(z.string())
          .optional()
          .describe("What to highlight in transcripts, if different from the search queries (e.g. search 'AI productivity', highlight 'biggest mistake')."),
        transcriptLangs: lenientArray(z.string())
          .optional()
          .describe("Preferred transcript languages in order, e.g. ['es','en']. Default: the video's original language."),
      },
      annotations: { title: "Search YouTube", ...READ_ONLY },
    },
    async (args) => {
      try {
        return { content: [{ type: "text" as const, text: await runSearch(args) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: errorText(e) }], isError: true };
      }
    },
  );
}

type Args = {
  queries: Array<string | { query: string; hl?: string; gl?: string }>;
  limit?: number;
  sort?: "relevance" | "views" | "date";
  uploaded?: "hour" | "today" | "week" | "month" | "year";
  publishedAfter?: string;
  publishedBefore?: string;
  duration?: "short" | "medium" | "long";
  minDurationSec?: number;
  maxDurationSec?: number;
  minViews?: number;
  shorts?: "exclude" | "include" | "only";
  captionsOnly?: boolean;
  highlights?: number;
  highlightsPerVideo?: number;
  highlightQuery?: string[];
  transcriptLangs?: string[];
};

interface Merged {
  hit: VideoHit;
  foundBy: number[];
  bestRank: number;
  highlights?: Highlight[];
  highlightNote?: string;
}

export async function runSearch(a: Args): Promise<string> {
  const limit = clamp(a.limit ?? 10, 1, 50);
  const queries = a.queries.map((q) => (typeof q === "string" ? { query: q } : q));
  const filters = { sort: a.sort === "views" ? ("views" as const) : undefined, uploadDate: a.uploaded, duration: a.duration, captionsOnly: a.captionsOnly };

  // Over-fetch a little when we will drop shorts or apply post-filters, so the agent still gets ~limit results.
  const postFiltering = !!(a.publishedAfter || a.publishedBefore || a.minViews || a.minDurationSec || a.maxDurationSec);
  const fetchLimit = Math.min(60, Math.ceil(limit * (postFiltering ? 1.6 : 1.2)));

  const settled = await Promise.allSettled(
    queries.map((q) => search(q.query, { limit: fetchLimit, filters, region: { hl: q.hl, gl: q.gl } })),
  );

  const merged = new Map<string, Merged>();
  const queryNotes: string[] = [];
  let raw = 0;
  settled.forEach((r, qi) => {
    if (r.status === "rejected") {
      queryNotes.push(`q${qi + 1} failed: ${errorText(r.reason)}`);
      return;
    }
    raw += r.value.hits.length;
    r.value.hits.forEach((hit, rank) => {
      const m = merged.get(hit.id);
      if (m) {
        if (!m.foundBy.includes(qi + 1)) m.foundBy.push(qi + 1);
        m.bestRank = Math.min(m.bestRank, rank);
      } else {
        merged.set(hit.id, { hit, foundBy: [qi + 1], bestRank: rank });
      }
    });
  });

  // ---- post-filters, with counts so nothing disappears silently ----
  const dropped: Record<string, number> = {};
  const drop = (why: string) => (dropped[why] = (dropped[why] ?? 0) + 1);
  const after = toDate(a.publishedAfter);
  const before = toDate(a.publishedBefore);
  const shortsMode = a.shorts ?? "exclude";
  let undated = 0;

  const kept = [...merged.values()].filter(({ hit }) => {
    // Shorts are detected by YouTube's reel endpoint / /shorts/ URL on the result.
    if (shortsMode === "exclude" && hit.isShort) return drop("shorts"), false;
    if (shortsMode === "only" && !hit.isShort) return drop("not shorts"), false;
    if (a.minViews && (hit.views ?? 0) < a.minViews) return drop(`< ${compactNumber(a.minViews)} views`), false;
    if (a.minDurationSec && (hit.durationSec ?? 0) < a.minDurationSec) return drop("too short"), false;
    if (a.maxDurationSec && (hit.durationSec ?? Infinity) > a.maxDurationSec) return drop("too long"), false;
    if (after || before) {
      if (!hit.publishedApprox) {
        undated++;
        return true; // keep: live streams and some layouts carry no date; flagged below
      }
      if (after && hit.publishedApprox < after) return drop("before publishedAfter"), false;
      if (before && hit.publishedApprox > before) return drop("after publishedBefore"), false;
    }
    return true;
  });

  // Ranking: found by more queries first (strong topical signal), then best position; explicit sorts override.
  kept.sort((x, y) => y.foundBy.length - x.foundBy.length || x.bestRank - y.bestRank);
  if (a.sort === "views") kept.sort((x, y) => (y.hit.views ?? 0) - (x.hit.views ?? 0));
  if (a.sort === "date")
    kept.sort((x, y) => (y.hit.publishedApprox?.getTime() ?? 0) - (x.hit.publishedApprox?.getTime() ?? 0));

  const maxOut = Math.min(kept.length, limit * Math.max(1, Math.min(queries.length, 4)));
  const results = kept.slice(0, maxOut);

  // ---- transcript highlights for the top N ----
  const hlCount = clamp(a.highlights ?? 5, 0, 25);
  const perVideo = clamp(a.highlightsPerVideo ?? 3, 1, 8);
  const hlQueries = a.highlightQuery?.length ? a.highlightQuery : queries.map((q) => q.query);
  const langs = a.transcriptLangs ?? [];
  const hlStats = { ok: 0, noMatch: 0, noCaptions: 0, paused: 0, failed: 0 };
  await Promise.all(
    results.slice(0, hlCount).map(async (m) => {
      if (m.hit.isLive) {
        m.highlightNote = "live stream, no transcript yet";
        return;
      }
      try {
        const tr = await transcriptFor(m.hit.id, langs);
        m.highlights = findHighlights(tr.segments, hlQueries, { count: perVideo });
        if (m.highlights.length) hlStats.ok++;
        else {
          hlStats.noMatch++;
          m.highlightNote = `transcript (${tr.lang}) has no passage matching the queries`;
        }
      } catch (e) {
        if (e instanceof YouTubeError && e.reason === "no_captions") {
          hlStats.noCaptions++;
          m.highlightNote = "no captions";
        } else if (e instanceof YouTubeError && e.reason === "rate_limited") {
          hlStats.paused++;
          m.highlightNote = "transcripts paused by YouTube rate limit";
        } else {
          hlStats.failed++;
          m.highlightNote = `transcript failed: ${errorText(e)}`;
        }
      }
    }),
  );

  // ---- format ----
  const now = Date.now();
  const lines: string[] = [];
  lines.push(`Queries: ${queries.map((q, i) => `q${i + 1}="${q.query}"${q.hl ? ` [${q.hl}${q.gl ? "-" + q.gl : ""}]` : ""}`).join(" · ")}`);
  lines.push("");
  results.forEach((m, i) => {
    const h = m.hit;
    const ageDays = h.publishedApprox ? Math.max(1, (now - h.publishedApprox.getTime()) / 86400_000) : undefined;
    const perDay = h.views != null && ageDays ? `~${compactNumber(Math.round(h.views / ageDays))}/day` : undefined;
    const meta = [
      h.channel ? h.channel + (h.channelHandle ? ` (${h.channelHandle})` : "") : undefined,
      h.isLive ? "LIVE" : h.views != null ? `${compactNumber(h.views)} views` : undefined,
      h.publishedText ? `${h.publishedText}${h.publishedApprox ? ` (~${isoDay(h.publishedApprox)})` : ""}` : undefined,
      h.durationSec ? formatClock(h.durationSec) : undefined,
      perDay,
      h.isShort ? "SHORT" : undefined,
    ].filter(Boolean);
    lines.push(`[${i + 1}] ${h.title}`);
    lines.push(`${watchUrl(h.id)} · ${meta.join(" · ")} · found by ${m.foundBy.map((n) => "q" + n).join(",")}`);
    if (h.snippet) lines.push(`Snippet: ${h.snippet}`);
    if (h.keyMoments?.length) {
      lines.push(`Key moments: ${h.keyMoments.slice(0, 12).map((k) => `${formatClock(k.start)} ${k.title}`).join(" · ")}`);
    }
    if (m.highlights?.length) {
      lines.push("Highlights:");
      for (const hl of m.highlights) lines.push(`  [${formatClock(hl.start)}](${watchUrl(h.id, hl.start)}) "${hl.text}"`);
    } else if (m.highlightNote) {
      lines.push(`Highlights: none (${m.highlightNote})`);
    }
    lines.push("");
  });

  if (!results.length) lines.push("No videos matched. Try broader queries, other languages, or fewer filters.", "");

  // Coverage footer: tell the agent exactly what it saw and what was dropped.
  const droppedText = Object.entries(dropped)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  lines.push("---");
  lines.push(
    `Coverage: ${queries.length} queries → ${raw} raw results → ${merged.size} unique → ${kept.length} after filters → showing ${results.length}.` +
      (droppedText ? ` Dropped: ${droppedText}.` : "") +
      (undated ? ` ${undated} kept without a date (could not apply date filter).` : ""),
  );
  if (hlCount) {
    lines.push(
      `Highlights: ${hlStats.ok} with passages, ${hlStats.noMatch} no matching passage, ${hlStats.noCaptions} no captions` +
        (hlStats.paused ? `, ${hlStats.paused} skipped (rate limit)` : "") +
        (hlStats.failed ? `, ${hlStats.failed} failed` : "") +
        ` (top ${Math.min(hlCount, results.length)} checked).`,
    );
  }
  const pause = captionCooldownSeconds();
  if (pause) {
    lines.push(
      `Transcripts are paused for ${pause} s (YouTube rate limit on captions). Metadata above is complete; fetch transcripts after the pause, and use fewer highlights.`,
    );
  }
  if (kept.length > results.length) lines.push(`${kept.length - results.length} more results not shown; raise limit or narrow filters.`);
  for (const n of queryNotes) lines.push(n);
  return lines.join("\n");
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));
