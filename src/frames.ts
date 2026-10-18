// Real video frames: yt-dlp resolves a direct stream URL, ffmpeg seeks to each
// timestamp over HTTP range requests and decodes one frame. Only the bytes
// around each timestamp are read; the video is never downloaded in full.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { YouTubeError, Limiter } from "./innertube.js";
import { memo } from "./cache.js";
import { ytDlpArgs, ytDlpBin, ytDlpVersion } from "./ytdlp.js";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const MAX_HEIGHT = Number(process.env.YT_FRAME_MAX_HEIGHT ?? 720);

// ffmpeg processes are heavier than HTTP calls; keep a few at a time.
const ffmpegLimiter = new Limiter(Math.max(1, Number(process.env.YT_FRAME_CONCURRENCY ?? 3)), 0);

let ffmpegAvailability: Promise<string | undefined> | undefined;

/** ffmpeg version line, or undefined when it is not installed. */
export function ffmpegVersion(): Promise<string | undefined> {
  ffmpegAvailability ??= run(FFMPEG, ["-version"], { timeout: 10_000 })
    .then((r) => r.stdout.split("\n")[0].replace(/ Copyright.*/, "").trim())
    .catch(() => undefined);
  return ffmpegAvailability;
}

export async function framesUnavailableReason(): Promise<string | undefined> {
  const [dlp, ff] = await Promise.all([ytDlpVersion(), ffmpegVersion()]);
  const missing = [!dlp && "yt-dlp", !ff && "ffmpeg"].filter(Boolean);
  return missing.length
    ? `frames need ${missing.join(" and ")} installed (e.g. brew install ${missing.join(" ")})`
    : undefined;
}

/** Direct URL of a video-only stream ≤ MAX_HEIGHT. Stream URLs stay valid for hours; cached for the memo TTL. */
const streamUrl = memo("stream", async (id: string) => {
  try {
    const { stdout } = await run(
      ytDlpBin(),
      [
        ...ytDlpArgs(),
        "--get-url",
        "--no-playlist",
        "-f",
        `bv*[height<=${MAX_HEIGHT}][vcodec^=avc1]/bv*[height<=${MAX_HEIGHT}]/b[height<=${MAX_HEIGHT}]/b`,
        `https://www.youtube.com/watch?v=${id}`,
      ],
      { timeout: 60_000 },
    );
    const url = stdout.trim().split("\n")[0];
    if (!url.startsWith("http")) throw new Error("no stream URL");
    return url;
  } catch (e: any) {
    const msg = String(e?.stderr ?? e?.message ?? e);
    if (/429|Too Many Requests/i.test(msg)) throw new YouTubeError("YouTube rate-limited the stream lookup (HTTP 429)", "rate_limited", 429);
    if (/Sign in to confirm|not a bot/i.test(msg)) throw new YouTubeError("YouTube asked to confirm this is not a bot", "blocked");
    if (/Private video|Video unavailable|removed/i.test(msg)) throw new YouTubeError("Video unavailable", "unavailable");
    throw new YouTubeError(`Could not resolve a video stream: ${msg.split("\n").find((l) => l.includes("ERROR")) ?? msg.slice(0, 200)}`, "unavailable");
  }
});

export interface Frame {
  at: number;
  jpeg: Buffer;
}

async function grabOne(url: string, at: number, width: number, dir: string): Promise<Frame> {
  const out = join(dir, `f${Math.round(at * 1000)}.jpg`);
  await ffmpegLimiter.acquire();
  try {
    const proxy = process.env.YT_PROXY ? ["-http_proxy", process.env.YT_PROXY] : [];
    await run(
      FFMPEG,
      [
        "-loglevel", "error",
        "-nostdin",
        ...proxy,
        "-ss", at.toFixed(2), // input seeking: jumps via range requests, then decodes to the exact time
        "-i", url,
        "-frames:v", "1",
        "-vf", `scale='min(${width},iw)':-2`,
        "-q:v", "4",
        "-y", out,
      ],
      { timeout: 45_000 },
    );
    return { at, jpeg: await readFile(out) };
  } finally {
    ffmpegLimiter.release();
  }
}

/**
 * Grab frames at the given timestamps (seconds). Timestamps past the end are
 * dropped by the caller; a timestamp ffmpeg cannot decode is reported per frame.
 */
export async function grabFrames(
  id: string,
  timestamps: number[],
  width: number,
): Promise<{ frames: Frame[]; failed: Array<{ at: number; error: string }> }> {
  const reason = await framesUnavailableReason();
  if (reason) throw new YouTubeError(reason, "unavailable");
  const url = await streamUrl(id);
  const dir = await mkdtemp(join(tmpdir(), "yt-frames-"));
  try {
    const settled = await Promise.allSettled(timestamps.map((t) => grabOne(url, t, width, dir)));
    const frames: Frame[] = [];
    const failed: Array<{ at: number; error: string }> = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") frames.push(r.value);
      else failed.push({ at: timestamps[i], error: String((r.reason as any)?.stderr || (r.reason as any)?.message || r.reason).split("\n")[0].slice(0, 160) });
    });
    return { frames: frames.sort((a, b) => a.at - b.at), failed };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
