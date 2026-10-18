import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { captionCooldownSeconds, getChannelVideos, getPlayer, getWatch, search, transcriptFor } from "../youtube.js";
import { ytDlpVersion } from "../ytdlp.js";
import { ffmpegVersion } from "../frames.js";
import { READ_ONLY } from "../schema.js";
import { errorText } from "./common.js";

// A long-lived, captioned video used as a canary.
const CANARY = "dQw4w9WgXcQ";

export function registerDoctorTool(server: McpServer): void {
  server.registerTool(
    "youtube_doctor",
    {
      title: "Check YouTube access",
      description:
        "Check that every YouTube path this server uses works from this machine right now (search, video details, transcripts, watch page, channels, yt-dlp and ffmpeg for frames), with timings. Run it when other youtube_* tools fail.",
      inputSchema: {},
      annotations: { title: "Check YouTube access", ...READ_ONLY },
    },
    async () => ({ content: [{ type: "text" as const, text: await runDoctor() }] }),
  );
}

export async function runDoctor(): Promise<string> {
  const checks: Array<[string, () => Promise<string>]> = [
    ["search", async () => `${(await search("lofi hip hop", { limit: 5, filters: {} })).hits.length} results`],
    ["video details", async () => `"${(await getPlayer(CANARY)).title}"`],
    ["transcript", async () => {
      const t = await transcriptFor(CANARY, ["en"]);
      return `${t.segments.length} segments (${t.lang}, via ${t.source})`;
    }],
    ["watch page", async () => {
      const w = await getWatch(CANARY);
      return `published ${w.publishDate?.toISOString().slice(0, 10) ?? "?"}, comments ${w.commentsToken ? "available" : "missing"}`;
    }],
    ["channel", async () => `${(await getChannelVideos("@YouTube", { tab: "videos", sort: "latest", limit: 5 })).videos.length} videos`],
    ["yt-dlp", async () => (await ytDlpVersion()) ?? "not installed (optional: transcript fallback; required for frames)"],
    ["ffmpeg", async () => (await ffmpegVersion()) ?? "not installed (optional: required for frames)"],
  ];
  const lines: string[] = [];
  let failures = 0;
  const pause = captionCooldownSeconds();
  if (pause) lines.push(`! transcripts are in a rate-limit pause for ${pause} s more (the transcript check below will report it)`);
  for (const [name, fn] of checks) {
    const t0 = Date.now();
    try {
      lines.push(`✓ ${name}: ${await fn()} (${Date.now() - t0} ms)`);
    } catch (e) {
      failures++;
      lines.push(`✗ ${name}: ${errorText(e)} (${Date.now() - t0} ms)`);
    }
  }
  lines.push(
    "",
    failures
      ? "Some checks failed. [rate_limited]/[blocked] usually clear in minutes; lower YT_MAX_CONCURRENCY. Other errors may mean YouTube changed: update the server or set YT_*_CLIENT_VERSION."
      : "All checks passed.",
  );
  return lines.join("\n");
}
