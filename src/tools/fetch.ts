import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  captionCooldownSeconds,
  chaptersFromDescription,
  getComments,
  getPlayer,
  getWatch,
  transcriptFor,
  type KeyMoment,
  type PlayerInfo,
  type Segment,
  type WatchInfo,
} from "../youtube.js";
import { findHighlights, fold } from "../highlights.js";
import { grabFrames } from "../frames.js";
import { limitedFetch, YouTubeError } from "../innertube.js";
import { compactNumber, formatClock, isoDay, parseUrlStart, parseVideoId, watchUrl } from "../parse.js";
import { lenientArray, lenientNumber, READ_ONLY, timeValue } from "../schema.js";
import { errorText } from "./common.js";

const PARTS = ["details", "transcript", "chapters", "comments", "thumbnail", "frames"] as const;
type Part = (typeof PARTS)[number];

const DESCRIPTION = `Read YouTube videos: transcript (whole, a time range, a chapter, or only passages matching a query), real video frames, details, chapters, comments and thumbnail. Batch many videos in one call.

Best for: reading what was said after youtube_search, pulling the same slice from many videos (e.g. the first 30 s of each video to study hooks), quoting with exact timestamps.
Returns: per video a header (title, channel, exact publish date, views, likes, duration) and the requested parts. Transcript lines carry [m:ss] stamps; links with ?t= jump to the moment. Per-video failures are reported inline, never dropped.

Tips:
- Hooks / intros: start=0, end=30 (plus parts ["details","transcript","thumbnail","frames"] if the visual hook matters).
- Frames are real decoded video frames (up to 1280 px): evenly spaced over start–end / the chapter / the whole video (frames=N), or at exact moments (frameAt). The first frames of a video take ~10–20 s (stream lookup); keep frame-heavy calls to a few videos.
- Finding a topic inside long videos: pass query instead of reading whole transcripts.
- Long transcript cut off? Call again with start = the second where it stopped.`;

export function registerFetchTool(server: McpServer): void {
  server.registerTool(
    "youtube_fetch",
    {
      title: "Read YouTube videos",
      description: DESCRIPTION,
      inputSchema: {
        videos: lenientArray(z.string().min(1))
          .refine((a) => a.length >= 1 && a.length <= 25, "Send 1–25 videos")
          .describe("1–25 video URLs or IDs. A ?t= in a URL is used as start when start is not given."),
        parts: lenientArray(z.enum(PARTS))
          .optional()
          .describe(`Any of ${PARTS.join(", ")}. Default ["details","transcript"].`),
        start: timeValue().optional().describe("Range start for transcript and frames: seconds or 'm:ss'."),
        end: timeValue().optional().describe("Range end for transcript and frames: seconds or 'm:ss'."),
        chapter: z.string().optional().describe("Limit transcript and frames to the chapter whose title contains this text."),
        query: lenientArray(z.string())
          .optional()
          .describe("Return only transcript passages matching these phrases (any language/synonyms), not the full text."),
        matches: lenientNumber().optional().describe("Max passages per video in query mode (default 6, max 20)."),
        transcriptLangs: lenientArray(z.string())
          .optional()
          .describe("Preferred transcript languages in order, e.g. ['es','en']. Default: the video's original language."),
        timestamps: z
          .enum(["paragraph", "segment", "none"])
          .optional()
          .describe("paragraph (default): ~30 s blocks with [m:ss]; segment: every caption line; none: plain text."),
        maxCharacters: lenientNumber()
          .optional()
          .describe("Transcript characters per video (default 12000, max 60000)."),
        descriptionChars: lenientNumber().optional().describe("Description characters in details (default 1500)."),
        commentsLimit: lenientNumber().optional().describe("Top comments per video (default 20, max 200)."),
        frames: lenientNumber()
          .optional()
          .describe("With part frames: how many frames, evenly spaced over the range (default 6, max 20 per video, 40 per call)."),
        frameAt: lenientArray(timeValue())
          .optional()
          .describe("With part frames: exact moments instead of even spacing, e.g. [0, 3, '0:12']."),
        frameWidth: lenientNumber().optional().describe("Frame width in px (default 640, max 1280). Wider = readable small text, more tokens."),
      },
      annotations: { title: "Read YouTube videos", ...READ_ONLY },
    },
    async (args) => {
      try {
        return { content: await runFetch(args) };
      } catch (e) {
        return { content: [{ type: "text" as const, text: errorText(e) }], isError: true };
      }
    },
  );
}

type Args = {
  videos: string[];
  parts?: Part[];
  start?: number;
  end?: number;
  chapter?: string;
  query?: string[];
  matches?: number;
  transcriptLangs?: string[];
  timestamps?: "paragraph" | "segment" | "none";
  maxCharacters?: number;
  descriptionChars?: number;
  commentsLimit?: number;
  frames?: number;
  frameAt?: number[];
  frameWidth?: number;
};

const MAX_FRAMES_PER_CALL = 40;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export async function runFetch(a: Args): Promise<Content[]> {
  const parts = new Set<Part>(a.parts?.length ? a.parts : ["details", "transcript"]);
  // Keep a frame-heavy batch inside the per-call budget by lowering the per-video count.
  let frameNote = "";
  if (parts.has("frames")) {
    const wanted = a.frameAt?.length ? a.frameAt.length : Math.max(1, Math.min(20, Math.round(a.frames ?? 6)));
    const perVideo = Math.max(1, Math.min(wanted, Math.floor(MAX_FRAMES_PER_CALL / a.videos.length)));
    if (perVideo < wanted) frameNote = `\nFrames capped at ${perVideo} per video (${MAX_FRAMES_PER_CALL} per call); send fewer videos for more frames each.`;
    a = { ...a, frames: perVideo, frameAt: a.frameAt?.slice(0, perVideo) };
  }
  const results = await Promise.all(a.videos.map((v, i) => fetchOne(v, i + 1, parts, a)));
  const content: Content[] = [];
  let ok = 0;
  for (const r of results) {
    if (r.ok) ok++;
    content.push({ type: "text", text: r.text }, ...r.media);
  }
  const pause = captionCooldownSeconds();
  content.push({
    type: "text",
    text:
      `---\nFetched ${ok}/${a.videos.length} videos fully.` +
      (ok < a.videos.length ? " See per-video notes above for what failed and why." : "") +
      frameNote +
      (pause
        ? `\nTranscripts are paused for ${pause} s: YouTube is rate-limiting caption downloads from this IP. Details, chapters, comments and thumbnails still work. Retry the skipped videos after the pause in smaller batches; do not retry sooner, it extends the block.`
        : ""),
  });
  return content;
}

async function fetchOne(
  input: string,
  n: number,
  parts: Set<Part>,
  a: Args,
): Promise<{ ok: boolean; text: string; media: Content[] }> {
  const id = parseVideoId(input);
  if (!id) return { ok: false, text: `## [${n}] ${input}\nError: not a YouTube video URL or ID.`, media: [] };

  const out: string[] = [];
  const problems: string[] = [];
  const media: Content[] = [];

  const needWatch = parts.has("details") || parts.has("chapters") || parts.has("comments") || !!a.chapter;
  const [playerR, watchR] = await Promise.allSettled([
    getPlayer(id),
    needWatch ? getWatch(id) : Promise.resolve(undefined),
  ]);
  const player = playerR.status === "fulfilled" ? playerR.value : undefined;
  const watch = watchR.status === "fulfilled" ? watchR.value : undefined;
  if (playerR.status === "rejected") problems.push(`details: ${errorText(playerR.reason)}`);
  if (watchR.status === "rejected") problems.push(`watch page: ${errorText(watchR.reason)}`);

  out.push(`## [${n}] ${player?.title ?? id}`);
  out.push(header(id, player, watch));

  const chapters = watch?.chapters.length ? watch.chapters : chaptersFromDescription(player?.description ?? "");
  const range = resolveRange(id, a, chapters, player?.durationSec);

  if (parts.has("details") && player) {
    if (player.keywords.length) out.push(`Tags: ${player.keywords.slice(0, 20).join(", ")}`);
    const max = Math.max(0, a.descriptionChars ?? 1500);
    if (player.description && max) {
      const d = player.description.trim();
      out.push(`Description:\n${d.length > max ? d.slice(0, max) + `… [${d.length - max} more chars, raise descriptionChars]` : d}`);
    }
  }

  if (parts.has("chapters")) {
    out.push(
      chapters.length
        ? `Chapters:\n${chapters.map((c) => `  [${formatClock(c.start)}](${watchUrl(id, c.start)}) ${c.title}`).join("\n")}`
        : "Chapters: none",
    );
  }

  if (parts.has("transcript")) {
    try {
      out.push(await transcriptSection(id, a, range, player));
    } catch (e) {
      problems.push(
        e instanceof YouTubeError && e.reason === "rate_limited"
          ? "transcript: skipped, YouTube rate limit (see end of output)"
          : `transcript: ${errorText(e)}`,
      );
    }
  }

  if (parts.has("comments")) {
    if (!watch?.commentsToken) {
      problems.push("comments: turned off or unavailable for this video");
    } else {
      try {
        const limit = Math.max(1, Math.min(200, a.commentsLimit ?? 20));
        const comments = await getComments(watch.commentsToken, { limit });
        out.push(
          `Top comments (${comments.length}${watch.commentCountText ? ` of ${watch.commentCountText}` : ""}):\n` +
            comments
              .map((c) => {
                const tags = [c.isPinned ? "pinned" : "", c.isCreator ? "creator" : ""].filter(Boolean).join(",");
                const stats = [c.likes ? `${compactNumber(c.likes)}♥` : "", c.replies ? `${c.replies} replies` : "", c.publishedText ?? ""]
                  .filter(Boolean)
                  .join(" · ");
                return `- ${c.author}${tags ? ` [${tags}]` : ""} (${stats}): ${c.text.replace(/\n+/g, " ⏎ ")}`;
              })
              .join("\n"),
        );
      } catch (e) {
        problems.push(`comments: ${errorText(e)}`);
      }
    }
  }

  if (parts.has("thumbnail")) {
    try {
      media.push({ type: "text", text: `[${n}] thumbnail (https://i.ytimg.com/vi/${id}/hqdefault.jpg):` }, await thumbnail(id));
      out.push("Thumbnail: attached below");
    } catch (e) {
      problems.push(`thumbnail: ${errorText(e)}`);
    }
  }

  if (parts.has("frames")) {
    if ("error" in range) {
      problems.push(`frames: ${range.error}`);
    } else {
      try {
        const times = frameTimes(a, range, player?.durationSec);
        if (!times.length) {
          problems.push("frames: no timestamps inside the video");
        } else {
          const width = Math.max(160, Math.min(1280, Math.round(a.frameWidth ?? 640)));
          const { frames, failed } = await grabFrames(id, times, width);
          out.push(`Frames (${frames.length}, ${width}px${range.scope}): attached below at ${frames.map((f) => formatClock(f.at)).join(", ")}`);
          for (const f of frames) {
            media.push(
              { type: "text", text: `[${n}] frame [${formatClock(f.at)}](${watchUrl(id, f.at)})` },
              { type: "image", data: f.jpeg.toString("base64"), mimeType: "image/jpeg" },
            );
          }
          const pastEnd = (a.frameAt?.length ?? 0) - times.length;
          if (a.frameAt?.length && pastEnd > 0) problems.push(`frames: ${pastEnd} timestamp(s) past the end of the video skipped`);
          if (failed.length) problems.push(`frames: ${failed.length} failed (${failed.map((f) => `${formatClock(f.at)}: ${f.error}`).join("; ")})`);
        }
      } catch (e) {
        problems.push(`frames: ${errorText(e)}`);
      }
    }
  }

  if (problems.length) out.push(`Notes: ${problems.join(" | ")}`);
  return { ok: problems.length === 0, text: out.join("\n") + "\n", media };
}

type Range = { start: number; end: number; scope: string } | { error: string };

/** start/end, a ?t= in the URL, or a chapter → one range shared by transcript and frames. */
function resolveRange(id: string, a: Args, chapters: KeyMoment[], durationSec?: number): Range {
  if (a.chapter) {
    const want = fold(a.chapter);
    const i = chapters.findIndex((c) => fold(c.title).includes(want));
    if (i === -1) {
      return { error: `no chapter matching "${a.chapter}". Chapters: ${chapters.map((c) => c.title).join(" | ") || "none"}` };
    }
    return { start: chapters[i].start, end: chapters[i + 1]?.start ?? durationSec ?? Infinity, scope: ` chapter "${chapters[i].title}"` };
  }
  const start = a.start ?? parseUrlStart(a.videos.find((v) => parseVideoId(v) === id) ?? "") ?? 0;
  return { start, end: a.end ?? Infinity, scope: "" };
}

/** Explicit frameAt, else N frames evenly spaced from the range start (never the very last instant, often black). */
export function frameTimes(a: Pick<Args, "frameAt" | "frames">, range: { start: number; end: number }, durationSec?: number): number[] {
  const limit = durationSec ? durationSec - 0.5 : Infinity;
  if (a.frameAt?.length) return a.frameAt.filter((t) => t < limit);
  const end = Math.min(range.end, durationSec ?? range.end);
  if (!Number.isFinite(end) || end <= range.start) return [];
  const n = Math.max(1, a.frames ?? 6);
  const step = (end - range.start) / n;
  return Array.from({ length: n }, (_, i) => Math.round((range.start + i * step) * 10) / 10).filter((t) => t < limit);
}

function header(id: string, p?: PlayerInfo, w?: WatchInfo): string {
  const date = w?.publishDate;
  const ageDays = date ? Math.max(1, (Date.now() - date.getTime()) / 86400_000) : undefined;
  const bits = [
    watchUrl(id),
    p?.channel ? `${p.channel}${p.channelId ? ` (${p.channelId})` : ""}` : undefined,
    date ? `published ${isoDay(date)}` : w?.publishedText,
    p?.isLive ? "LIVE" : p?.views != null ? `${compactNumber(p.views)} views` : undefined,
    p?.views != null && ageDays ? `~${compactNumber(Math.round(p.views / ageDays))}/day` : undefined,
    w?.likes ? `${compactNumber(w.likes)} likes` : undefined,
    p?.durationSec ? formatClock(p.durationSec) : undefined,
  ];
  return bits.filter(Boolean).join(" · ");
}

async function transcriptSection(id: string, a: Args, range: Range, player?: PlayerInfo): Promise<string> {
  const tr = await transcriptFor(id, a.transcriptLangs ?? []);
  const label = `Transcript (${tr.lang}${tr.auto ? ", auto-generated" : ""}${tr.source === "yt-dlp" ? ", via yt-dlp" : ""})`;
  if ("error" in range) return `${label}: ${range.error}`;
  const { start, end, scope } = range;
  const segs = tr.segments.filter((s) => s.start + s.dur > start && s.start < end);
  const rangeText =
    start > 0 || end !== Infinity
      ? ` ${formatClock(start)}–${end === Infinity ? formatClock(player?.durationSec ?? segs.at(-1)?.start ?? 0) : formatClock(end)}`
      : "";
  if (!segs.length) return `${label}${scope}${rangeText}: no speech in this range.`;

  if (a.query?.length) {
    const count = Math.max(1, Math.min(20, a.matches ?? 6));
    const hits = findHighlights(segs, a.query, { count, windowSec: 30, maxChars: 600 });
    if (!hits.length) return `${label}${scope}${rangeText}: no passage matches ${JSON.stringify(a.query)}.`;
    return (
      `${label}${scope}${rangeText}, ${hits.length} passages matching ${JSON.stringify(a.query)}:\n` +
      hits.map((h) => `  [${formatClock(h.start)}](${watchUrl(id, h.start)}) "${h.text}"`).join("\n")
    );
  }

  const body = renderSegments(segs, a.timestamps ?? "paragraph");
  const max = Math.max(500, Math.min(60000, a.maxCharacters ?? 12000));
  if (body.text.length <= max) return `${label}${scope}${rangeText}:\n${body.text}`;

  // Cut at a line boundary and tell the agent exactly where to resume.
  const cut = body.text.lastIndexOf("\n", max);
  const shown = body.text.slice(0, cut > max * 0.5 ? cut : max);
  const lastLine = body.starts.findLast((s) => s.offset < shown.length);
  const resumeAt = Math.floor(lastLine ? (body.starts[body.starts.indexOf(lastLine) + 1]?.start ?? lastLine.start) : start);
  return `${label}${scope}${rangeText}:\n${shown}\n… [truncated at ${formatClock(resumeAt)}; call again with start=${resumeAt} to continue, or use query]`;
}

function renderSegments(segs: Segment[], mode: "paragraph" | "segment" | "none") {
  const starts: Array<{ offset: number; start: number }> = [];
  const lines: string[] = [];
  let offset = 0;
  const push = (start: number, line: string) => {
    starts.push({ offset, start });
    lines.push(line);
    offset += line.length + 1;
  };
  if (mode === "none") {
    return { text: segs.map((s) => s.text).join(" "), starts: [{ offset: 0, start: segs[0].start }] };
  }
  if (mode === "segment") {
    for (const s of segs) push(s.start, `[${formatClock(s.start)}] ${s.text}`);
  } else {
    let blockStart = segs[0].start;
    let buf: string[] = [];
    for (const s of segs) {
      if (buf.length && s.start - blockStart >= 30) {
        push(blockStart, `[${formatClock(blockStart)}] ${buf.join(" ")}`);
        buf = [];
        blockStart = s.start;
      }
      buf.push(s.text);
    }
    if (buf.length) push(blockStart, `[${formatClock(blockStart)}] ${buf.join(" ")}`);
  }
  return { text: lines.join("\n"), starts };
}

async function thumbnail(id: string): Promise<Content> {
  const res = await limitedFetch(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
  if (!res.ok) throw new Error(`thumbnail HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" };
}
