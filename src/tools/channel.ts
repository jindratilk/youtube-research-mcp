import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getChannelVideos, type ChannelVideo } from "../youtube.js";
import { compactNumber, formatClock, isoDay, watchUrl } from "../parse.js";
import { isoDate, lenientNumber, READ_ONLY, toDate } from "../schema.js";
import { errorText } from "./common.js";

const DESCRIPTION = `List a channel's videos with an outlier score: how many times more views a video got than the channel's median.

Best for: finding a creator's breakout videos (the ones whose hooks/titles/topics worked), reviewing recent uploads, building a list of videos to fetch.
Returns: channel stats (subscribers, video count) and videos with views, outlier ×median, date, duration. The median is computed over the videos listed, so list enough (30+) for a fair baseline.`;

export function registerChannelTool(server: McpServer): void {
  server.registerTool(
    "youtube_channel",
    {
      title: "List channel videos",
      description: DESCRIPTION,
      inputSchema: {
        channel: z.string().min(1).describe("@handle, channel URL or UC… channel ID."),
        tab: z.enum(["videos", "shorts", "streams"]).optional().describe("Default videos."),
        sort: z.enum(["latest", "popular", "oldest"]).optional().describe("Default latest."),
        limit: lenientNumber().optional().describe("Videos to list (default 30, max 300)."),
        publishedAfter: isoDate()
          .optional()
          .describe("YYYY-MM-DD or YYYY-MM, approximate (from '3 weeks ago'-style dates). Works best with sort=latest."),
        minOutlier: lenientNumber()
          .optional()
          .describe("Only show videos with at least this ×median score, e.g. 2. The median still uses all listed videos."),
      },
      annotations: { title: "List channel videos", ...READ_ONLY },
    },
    async (args) => {
      try {
        return { content: [{ type: "text" as const, text: await runChannel(args) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: errorText(e) }], isError: true };
      }
    },
  );
}

type Args = {
  channel: string;
  tab?: "videos" | "shorts" | "streams";
  sort?: "latest" | "popular" | "oldest";
  limit?: number;
  publishedAfter?: string;
  minOutlier?: number;
};

export function median(nums: number[]): number | undefined {
  if (!nums.length) return undefined;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export async function runChannel(a: Args): Promise<string> {
  const limit = Math.max(1, Math.min(300, Math.round(a.limit ?? 30)));
  const tab = a.tab ?? "videos";
  const sort = a.sort ?? "latest";
  const { channel, videos } = await getChannelVideos(a.channel, { tab, sort, limit });

  const after = toDate(a.publishedAfter);
  let dateDropped = 0;
  const inRange = after
    ? videos.filter((v) => {
        const keep = !v.publishedApprox || v.publishedApprox >= after;
        if (!keep) dateDropped++;
        return keep;
      })
    : videos;

  const med = median(inRange.map((v) => v.views).filter((v): v is number => v != null));
  const score = (v: ChannelVideo) => (med && v.views != null ? v.views / med : undefined);
  const shown = a.minOutlier ? inRange.filter((v) => (score(v) ?? 0) >= a.minOutlier!) : inRange;

  const lines: string[] = [];
  lines.push(
    `# ${channel.title}${channel.handle ? ` (${channel.handle})` : ""} · ${channel.id}` +
      [channel.subscribersText, channel.videoCountText].filter(Boolean).map((s) => ` · ${s}`).join(""),
  );
  if (channel.description) lines.push(`About: ${channel.description.replace(/\s+/g, " ").slice(0, 300)}${channel.description.length > 300 ? "…" : ""}`);
  lines.push(
    `Tab ${tab}, sort ${sort}: listed ${videos.length}` +
      (dateDropped ? `, ${dateDropped} older than ${a.publishedAfter} dropped` : "") +
      `; median views ${compactNumber(med)}` +
      (channel.subscribers && med ? ` (${((med / channel.subscribers) * 100).toFixed(1)}% of subscribers)` : "") +
      (a.minOutlier ? `; showing ${shown.length} with ≥${a.minOutlier}× median` : ""),
  );
  lines.push("");
  shown.forEach((v, i) => {
    const s = score(v);
    const meta = [
      v.views != null ? `${compactNumber(v.views)} views` : undefined,
      s != null ? `${s >= 10 ? Math.round(s) : s.toFixed(1)}× median` : undefined,
      v.publishedText ? `${v.publishedText}${v.publishedApprox ? ` (~${isoDay(v.publishedApprox)})` : ""}` : undefined,
      v.durationSec ? formatClock(v.durationSec) : undefined,
    ].filter(Boolean);
    lines.push(`[${i + 1}] ${v.title}\n${watchUrl(v.id)} · ${meta.join(" · ")}`);
  });
  if (!shown.length) lines.push("No videos matched.");
  if (videos.length < limit) lines.push("", `(Channel tab ended after ${videos.length} videos.)`);
  return lines.join("\n");
}
