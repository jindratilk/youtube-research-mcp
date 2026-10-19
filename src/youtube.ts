import { captionLimiter, innertube, limitedFetch, readJson, YouTubeError, type ClientName } from "./innertube.js";
import { encodeSearchParams, type SearchFilterInput } from "./searchParams.js";
import {
  findAll,
  findFirst,
  parseAbsoluteDate,
  parseClock,
  parseCount,
  parseRelativeDate,
  parseJson3,
  text,
  type Segment,
} from "./parse.js";

export type { Segment };
import { ytDlpTranscript } from "./ytdlp.js";
import { memo } from "./cache.js";

// ---------- types ----------

export interface KeyMoment {
  start: number;
  title: string;
}

export interface VideoHit {
  id: string;
  title: string;
  channel?: string;
  channelId?: string;
  channelHandle?: string;
  views?: number;
  publishedText?: string;
  publishedApprox?: Date;
  durationSec?: number;
  isShort: boolean;
  isLive: boolean;
  /** YouTube's own query-matched description snippet. */
  snippet?: string;
  /** Key moments / chapters YouTube shows in search results. */
  keyMoments?: KeyMoment[];
}

export interface SearchPage {
  hits: VideoHit[];
  estimatedResults?: number;
}

export interface Region {
  hl?: string;
  gl?: string;
}

export interface CaptionTrack {
  lang: string;
  name: string;
  auto: boolean;
  baseUrl: string;
}

export interface PlayerInfo {
  id: string;
  title: string;
  channel: string;
  channelId: string;
  durationSec: number;
  views?: number;
  keywords: string[];
  description: string;
  isLive: boolean;
  captions: CaptionTrack[];
  playability: string;
  playabilityReason?: string;
}

export interface Transcript {
  lang: string;
  auto: boolean;
  source: "innertube" | "yt-dlp";
  segments: Segment[];
  available: string[];
}

export interface WatchInfo {
  publishDate?: Date;
  publishedText?: string;
  likes?: number;
  chapters: KeyMoment[];
  commentsToken?: string;
  commentCountText?: string;
}

export interface Comment {
  id?: string;
  author: string;
  text: string;
  likes?: number;
  replies?: number;
  publishedText?: string;
  isPinned?: boolean;
  isCreator?: boolean;
  /** Token that loads this comment's replies (only on comments that have some). */
  repliesToken?: string;
}

export interface ChannelInfo {
  id: string;
  title: string;
  handle?: string;
  description?: string;
  subscribers?: number;
  subscribersText?: string;
  videoCountText?: string;
}

export interface ChannelVideo {
  id: string;
  title: string;
  views?: number;
  publishedText?: string;
  publishedApprox?: Date;
  durationSec?: number;
}

/**
 * Next-page token of the main result list. Pages also carry continuations for
 * side panels (comments, chips), so look only inside the list container on the
 * first page and inside the append/reload actions on later pages.
 */
function listContinuation(j: any, container: string): string | undefined {
  const scope = findFirst(j, container) ?? j.onResponseReceivedActions ?? j.onResponseReceivedCommands ?? j;
  return findFirst(findAll(scope, "continuationItemRenderer"), "continuationCommand")?.token;
}

// ---------- search ----------

function parseVideoRenderer(v: any): VideoHit | undefined {
  const id = v?.videoId;
  if (!id) return undefined;
  const owner = v.ownerText?.runs?.[0] ?? v.longBylineText?.runs?.[0];
  const nav = v.navigationEndpoint ?? {};
  const url: string = nav.commandMetadata?.webCommandMetadata?.url ?? "";
  const badges = JSON.stringify(v.badges ?? []) + JSON.stringify(v.thumbnailOverlays ?? []);
  const viewText = text(v.viewCountText);
  const isLive = /BADGE_STYLE_TYPE_LIVE_NOW|"LIVE"/.test(badges) || /watching/i.test(viewText);
  const snippet = (v.detailedMetadataSnippets ?? [])
    .map((s: any) => text(s.snippetText))
    .filter(Boolean)
    .join(" … ");
  const keyMoments = findAll(v, "macroMarkersListItemRenderer")
    .map((m: any) => ({ start: parseClock(text(m.timeDescription)) ?? 0, title: text(m.title) }))
    .filter((m: KeyMoment) => m.title);
  return {
    id,
    title: text(v.title),
    channel: owner?.text,
    channelId: owner?.navigationEndpoint?.browseEndpoint?.browseId,
    channelHandle: owner?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl?.replace(/^\//, ""),
    views: isLive ? undefined : parseCount(viewText),
    publishedText: text(v.publishedTimeText) || undefined,
    publishedApprox: parseRelativeDate(text(v.publishedTimeText)),
    durationSec: parseClock(text(v.lengthText)),
    isShort: !!nav.reelWatchEndpoint || url.startsWith("/shorts/"),
    isLive,
    snippet: snippet || undefined,
    keyMoments: keyMoments.length ? keyMoments : undefined,
  };
}

/** Top-level result items only: shelves ("For you", "People also watched") are noise for research. */
function topLevelVideoRenderers(json: any): any[] {
  const sections = findAll(json, "itemSectionRenderer");
  const out: any[] = [];
  for (const s of sections) for (const item of s.contents ?? []) if (item.videoRenderer) out.push(item.videoRenderer);
  return out;
}

export async function search(
  query: string,
  opts: { limit: number; filters: SearchFilterInput; region?: Region },
): Promise<SearchPage> {
  const hits: VideoHit[] = [];
  const seen = new Set<string>();
  let json = await innertube(
    "search",
    { query, params: encodeSearchParams(opts.filters) },
    { hl: opts.region?.hl, gl: opts.region?.gl },
  );
  const estimatedResults = json.estimatedResults ? Number(json.estimatedResults) : undefined;
  for (let page = 0; page < 10; page++) {
    let added = 0;
    for (const r of topLevelVideoRenderers(json)) {
      const hit = parseVideoRenderer(r);
      if (hit && !seen.has(hit.id)) {
        seen.add(hit.id);
        hits.push(hit);
        added++;
      }
    }
    if (hits.length >= opts.limit || added === 0) break;
    const token = listContinuation(json, "sectionListRenderer");
    if (!token) break;
    json = await innertube("search", { continuation: token }, { hl: opts.region?.hl, gl: opts.region?.gl });
  }
  return { hits: hits.slice(0, opts.limit), estimatedResults };
}

// ---------- player / transcript ----------

const PLAYER_CLIENTS: ClientName[] = ["ANDROID", "IOS"];

export const getPlayer = memo("player", getPlayerUncached);

async function getPlayerUncached(id: string): Promise<PlayerInfo> {
  let last: PlayerInfo | undefined;
  for (const client of PLAYER_CLIENTS) {
    const j = await innertube("player", { videoId: id, contentCheckOk: true, racyCheckOk: true }, { client });
    const vd = j.videoDetails;
    const status: string = j.playabilityStatus?.status ?? "UNKNOWN";
    if (!vd) {
      if (status === "ERROR") {
        throw new YouTubeError(j.playabilityStatus?.reason ?? "Video not found", "not_found");
      }
      continue;
    }
    const tracks = j.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    last = {
      id,
      title: vd.title ?? "",
      channel: vd.author ?? "",
      channelId: vd.channelId ?? "",
      durationSec: Number(vd.lengthSeconds ?? 0),
      views: vd.viewCount ? Number(vd.viewCount) : undefined,
      keywords: vd.keywords ?? [],
      description: vd.shortDescription ?? "",
      isLive: !!vd.isLive,
      captions: tracks.map((t: any) => ({
        lang: t.languageCode,
        name: text(t.name),
        auto: t.kind === "asr",
        baseUrl: t.baseUrl,
      })),
      playability: status,
      playabilityReason: j.playabilityStatus?.reason,
    };
    if (last.captions.length) return last;
  }
  if (last) return last;
  throw new YouTubeError(`Video ${id} is unavailable to anonymous clients`, "unavailable");
}

/** Prefer a manual track in a wanted language, then auto in a wanted language, then the original audio language. */
export function pickTrack(tracks: CaptionTrack[], wanted: string[]): CaptionTrack | undefined {
  const matches = (t: CaptionTrack, w: string) => t.lang === w || t.lang.split("-")[0] === w.split("-")[0];
  for (const w of wanted) {
    const manual = tracks.find((t) => !t.auto && matches(t, w));
    if (manual) return manual;
    const auto = tracks.find((t) => t.auto && matches(t, w));
    if (auto) return auto;
  }
  // The auto (asr) track is generated from the spoken audio, so it marks the original language;
  // a manual track in that language is usually cleaner than the asr one.
  const asr = tracks.find((t) => t.auto);
  return (asr && tracks.find((t) => !t.auto && matches(t, asr.lang))) ?? asr ?? tracks[0];
}

// ---- caption cooldown ----
// The first 429 from /api/timedtext opens a cooldown instead of retrying:
// hammering a throttled endpoint extends the block. Cooldown doubles on each
// consecutive trip (60 s → 15 min) and resets on the next success.
const COOLDOWN_BASE_MS = Number(process.env.YT_CAPTION_COOLDOWN_MS ?? 60_000);
let captionCooldownUntil = 0;
let captionTrips = 0;

export function captionCooldownSeconds(): number {
  return Math.max(0, Math.ceil((captionCooldownUntil - Date.now()) / 1000));
}

function captionsPausedError(): YouTubeError {
  return new YouTubeError(
    `YouTube is rate-limiting transcript downloads from this IP; transcripts paused for ${captionCooldownSeconds()} s. ` +
      "Search, details, chapters, comments and channels still work. Retry the skipped videos after the pause.",
    "rate_limited",
    429,
  );
}

const captionMemo = memo("captions", async (key: string) => {
  const url = key.slice(key.indexOf("|") + 1);
  if (captionCooldownSeconds() > 0) throw captionsPausedError();
  try {
    const res = await limitedFetch(url, {}, { limiter: captionLimiter, attempts: 1 });
    const segments = parseJson3(await readJson(res));
    captionTrips = 0;
    return segments;
  } catch (e) {
    if (e instanceof YouTubeError && (e.reason === "rate_limited" || e.reason === "blocked")) {
      // Parallel downloads hit the same 429 together; count that as one trip.
      if (captionCooldownSeconds() === 0) {
        captionTrips++;
        captionCooldownUntil = Date.now() + Math.min(15 * 60_000, COOLDOWN_BASE_MS * 2 ** (captionTrips - 1));
      }
      throw captionsPausedError();
    }
    throw e;
  }
});

export async function getTranscript(id: string, wanted: string[]): Promise<Transcript> {
  const p = await getPlayer(id);
  const available = p.captions.map((c) => c.lang + (c.auto ? " (auto)" : ""));
  const track = pickTrack(p.captions, wanted);
  let innertubeError: unknown;
  if (track) {
    try {
      // Keyed by video + track so different language preferences that resolve to the same track share one download.
      const url = track.baseUrl.replace(/&fmt=[^&]*/, "") + "&fmt=json3";
      const segments = await captionMemo(`${id}:${track.lang}:${track.auto}|${url}`);
      if (segments.length) return { lang: track.lang, auto: track.auto, source: "innertube", segments, available };
    } catch (e) {
      innertubeError = e;
    }
  }

  // yt-dlp hits the same caption endpoint, so it cannot help during a rate-limit pause;
  // it does help when the player response carries no usable caption URLs.
  const paused = innertubeError instanceof YouTubeError && innertubeError.reason === "rate_limited";
  if (!paused) {
    const viaYtDlp = await ytDlpTranscript(id, wanted);
    if (viaYtDlp) return { ...viaYtDlp, source: "yt-dlp", available };
  }

  if (innertubeError) throw innertubeError;
  throw new YouTubeError(
    p.playability !== "OK"
      ? `No captions: ${p.playabilityReason ?? p.playability}`
      : "This video has no captions (manual or automatic)",
    "no_captions",
  );
}

// ---------- watch page (date, chapters, comments) ----------

export const getWatch = memo("watch", getWatchUncached);

async function getWatchUncached(id: string): Promise<WatchInfo> {
  const j = await innertube("next", { videoId: id });
  const primary = findFirst(j, "videoPrimaryInfoRenderer");
  const dateText = text(primary?.dateText);
  const panels = findAll(j, "engagementPanelSectionListRenderer");
  const chapterPanel = panels.find((p: any) => /macro-markers/.test(p.panelIdentifier ?? ""));
  const chapters = findAll(chapterPanel ?? {}, "macroMarkersListItemRenderer")
    .map((m: any) => ({ start: parseClock(text(m.timeDescription)) ?? 0, title: text(m.title) }))
    .filter((c: KeyMoment) => c.title);
  const commentsPanel = panels.find((p: any) => p.panelIdentifier === "engagement-panel-comments-section");
  const likeLabel: string =
    findFirst(j, "likeButtonViewModel")?.likeButtonViewModel?.toggleButtonViewModel?.toggleButtonViewModel
      ?.defaultButtonViewModel?.buttonViewModel?.accessibilityText ?? "";
  return {
    publishDate: parseAbsoluteDate(dateText),
    publishedText: dateText || undefined,
    likes: parseCount(likeLabel.match(/[\d.,]+\s*[KMB]?/i)?.[0]),
    chapters: dedupeMoments(chapters),
    commentsToken: findFirst(commentsPanel ?? {}, "continuationCommand")?.token,
    commentCountText: text(findFirst(commentsPanel ?? {}, "contextualInfo")) || undefined,
  };
}

function dedupeMoments(ms: KeyMoment[]): KeyMoment[] {
  const seen = new Set<string>();
  return ms.filter((m) => {
    const k = `${m.start}|${m.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Chapters written into the description ("0:00 Intro"), used when YouTube exposes none. */
export function chaptersFromDescription(desc: string): KeyMoment[] {
  const out: KeyMoment[] = [];
  for (const line of desc.split("\n")) {
    const m = line.match(/^\s*[\[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s*[-–—:|]?\s*(.+)$/);
    if (m) out.push({ start: parseClock(m[1]) ?? 0, title: m[2].trim() });
  }
  return out.length >= 2 && out[0].start === 0 ? out : [];
}

function toComment(c: any, extra: { pinned?: boolean; repliesToken?: string } = {}): Comment {
  const props = c.properties ?? {};
  return {
    id: props.commentId,
    author: c.author?.displayName ?? "",
    text: props.content?.content ?? "",
    likes: parseCount(c.toolbar?.likeCountNotliked),
    replies: parseCount(c.toolbar?.replyCount),
    publishedText: props.publishedTime,
    isPinned: !!extra.pinned,
    isCreator: !!c.author?.isCreator,
    repliesToken: extra.repliesToken,
  };
}

/**
 * Top comments, paged until `scan` comments were read (20 per request).
 * YouTube no longer exposes the "newest first" sort to anonymous clients.
 */
export async function getComments(
  token: string,
  opts: { scan: number },
): Promise<{ comments: Comment[]; exhausted: boolean }> {
  const out: Comment[] = [];
  const seen = new Set<string>();
  let j = await innertube("next", { continuation: token });
  let exhausted = false;
  for (let page = 0; page < 60 && out.length < opts.scan; page++) {
    const payloads = new Map<string, any>();
    for (const c of findAll(j, "commentEntityPayload")) if (c.properties?.commentId) payloads.set(c.properties.commentId, c);
    const threads = findAll(j, "commentThreadRenderer");
    let added = 0;
    for (const t of threads) {
      const vm = t.commentViewModel?.commentViewModel ?? t.commentViewModel;
      const id: string | undefined = vm?.commentId;
      const payload = id ? payloads.get(id) : undefined;
      if (!payload || seen.has(id!)) continue;
      seen.add(id!);
      out.push(toComment(payload, { pinned: !!vm?.pinnedText, repliesToken: findFirst(t.replies ?? {}, "continuationCommand")?.token }));
      added++;
    }
    if (!threads.length) {
      // Older layout without thread wrappers: take the payloads as they come.
      for (const [id, payload] of payloads) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(toComment(payload));
        added++;
      }
    }
    if (!added) {
      exhausted = true;
      break;
    }
    const next = findAll(j, "continuationItemRenderer").map((c: any) => findFirst(c, "continuationCommand")?.token).filter(Boolean).at(-1);
    if (!next) {
      exhausted = true;
      break;
    }
    if (out.length >= opts.scan) break;
    j = await innertube("next", { continuation: next });
  }
  return { comments: out.slice(0, opts.scan), exhausted };
}

/** Replies of one comment, oldest first as YouTube lists them. */
export async function getReplies(token: string, limit: number): Promise<Comment[]> {
  const out: Comment[] = [];
  const seen = new Set<string>();
  let j = await innertube("next", { continuation: token });
  for (let page = 0; page < 10 && out.length < limit; page++) {
    let added = 0;
    for (const c of findAll(j, "commentEntityPayload")) {
      const id = c.properties?.commentId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(toComment(c));
      added++;
    }
    const next = findAll(j, "continuationItemRenderer").map((c: any) => findFirst(c, "continuationCommand")?.token).filter(Boolean).at(-1);
    if (!added || !next || out.length >= limit) break;
    j = await innertube("next", { continuation: next });
  }
  return out.slice(0, limit);
}

// ---------- channels ----------

const TAB_PARAMS = {
  videos: "EgZ2aWRlb3PyBgQKAjoA",
  shorts: "EgZzaG9ydHPyBgUKA5oBAA%3D%3D",
  streams: "EgdzdHJlYW1z8gYECgJ6AA%3D%3D",
} as const;

export type ChannelTab = keyof typeof TAB_PARAMS;

export async function resolveChannelId(input: string): Promise<string> {
  const s = input.trim();
  const direct = s.match(/(UC[\w-]{22})/);
  if (direct) return direct[1];
  const url = s.startsWith("http")
    ? s
    : s.startsWith("@")
      ? `https://www.youtube.com/${s}`
      : `https://www.youtube.com/@${s.replace(/^\/+/, "")}`;
  const j = await innertube("navigation/resolve_url", { url });
  const id = j?.endpoint?.browseEndpoint?.browseId;
  if (!id) throw new YouTubeError(`Channel not found: ${input}`, "not_found");
  return id;
}

function parseLockup(l: any): ChannelVideo | undefined {
  const id = l.contentId;
  if (!id || (l.contentType && l.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO")) return undefined;
  const meta = l.metadata?.lockupMetadataViewModel;
  const parts: string[] = findAll(meta?.metadata ?? {}, "metadataParts")
    .flat()
    .map((p: any) => text(p.text))
    .filter(Boolean);
  const viewsPart = parts.find((p) => /view|watching/i.test(p));
  const datePart = parts.find((p) => /ago/i.test(p));
  const badge = findAll(l.contentImage ?? {}, "thumbnailBadgeViewModel")
    .map((b: any) => b.text)
    .find((t: string) => /^\d+:\d{2}/.test(t ?? ""));
  return {
    id,
    title: text(meta?.title),
    views: parseCount(viewsPart),
    publishedText: datePart,
    publishedApprox: parseRelativeDate(datePart),
    durationSec: parseClock(badge),
  };
}

function parseShortsLockup(s: any): ChannelVideo | undefined {
  const id = s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId ?? s.entityId?.replace(/^shorts-shelf-item-/, "");
  if (!id || !/^[\w-]{11}$/.test(id)) return undefined;
  return {
    id,
    title: text(s.overlayMetadata?.primaryText),
    views: parseCount(text(s.overlayMetadata?.secondaryText)),
  };
}

function collectChannelVideos(j: any, into: ChannelVideo[], seen: Set<string>): number {
  let added = 0;
  const items = [
    ...findAll(j, "lockupViewModel").map(parseLockup),
    ...findAll(j, "shortsLockupViewModel").map(parseShortsLockup),
  ];
  for (const v of items) {
    if (v && !seen.has(v.id)) {
      seen.add(v.id);
      into.push(v);
      added++;
    }
  }
  return added;
}

function parseChannelInfo(j: any, id: string): ChannelInfo {
  const md = findFirst(j, "channelMetadataRenderer") ?? {};
  const header = findFirst(j, "pageHeaderViewModel") ?? {};
  const parts: string[] = findAll(header, "metadataParts")
    .flat()
    .map((p: any) => text(p.text))
    .filter(Boolean);
  const subs = parts.find((p) => /subscriber/i.test(p));
  const vids = parts.find((p) => /video/i.test(p));
  const handle = parts.find((p) => p.startsWith("@")) ?? md.vanityChannelUrl?.match(/@[\w.-]+/)?.[0];
  return {
    id: md.externalId ?? id,
    title: md.title ?? text(findFirst(header, "title")?.dynamicTextViewModel?.text),
    handle,
    description: md.description,
    subscribers: parseCount(subs),
    subscribersText: subs,
    videoCountText: vids,
  };
}

export async function getChannelVideos(
  input: string,
  opts: { tab: ChannelTab; sort: "latest" | "popular" | "oldest"; limit: number },
): Promise<{ channel: ChannelInfo; videos: ChannelVideo[] }> {
  const id = await resolveChannelId(input);
  let j = await innertube("browse", { browseId: id, params: TAB_PARAMS[opts.tab] });
  const channel = parseChannelInfo(j, id);

  if (opts.sort !== "latest") {
    const label = opts.sort === "popular" ? /popular/i : /oldest/i;
    const chip = findAll(j, "chipViewModel").find((c: any) => label.test(c.text ?? ""));
    const token = findFirst(chip ?? {}, "continuationCommand")?.token;
    if (!token) throw new YouTubeError(`This channel tab offers no "${opts.sort}" sort`, "unavailable");
    j = await innertube("browse", { continuation: token });
  }

  const videos: ChannelVideo[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < 30; page++) {
    const added = collectChannelVideos(j, videos, seen);
    if (videos.length >= opts.limit || added === 0) break;
    const token = listContinuation(j, "richGridRenderer");
    if (!token) break;
    j = await innertube("browse", { continuation: token });
  }
  return { channel, videos: videos.slice(0, opts.limit) };
}

/** Transcript lookup; `wanted` is an ordered language preference ([] = original language). Downloads are cached per track. */
export function transcriptFor(id: string, wanted: string[]): Promise<Transcript> {
  return getTranscript(id, wanted);
}
