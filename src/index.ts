#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSearchTool } from "./tools/search.js";
import { registerFetchTool } from "./tools/fetch.js";
import { registerChannelTool } from "./tools/channel.js";
import { registerDoctorTool, runDoctor } from "./tools/doctor.js";

// CLI helpers for humans and installing agents: `--doctor` checks YouTube access and exits.
if (process.argv.includes("--version")) {
  console.log("youtube-research-mcp 0.2.0");
  process.exit(0);
}
if (process.argv.includes("--doctor")) {
  console.log(await runDoctor());
  process.exit(0);
}

const ALL = {
  youtube_search: registerSearchTool,
  youtube_fetch: registerFetchTool,
  youtube_channel: registerChannelTool,
  youtube_doctor: registerDoctorTool,
} as const;

// YT_MCP_TOOLS="youtube_search,youtube_fetch" exposes only those tools (default: all).
const wanted = (process.env.YT_MCP_TOOLS ?? Object.keys(ALL).join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const server = new McpServer(
  { name: "youtube-research", version: "0.2.0" },
  {
    instructions:
      "Keyless YouTube research tools. Typical flow: youtube_search with several query variants (synonyms, languages) in one call → read highlights → youtube_fetch only the videos/ranges you need (start/end, chapter or query) → cite with the ?t= links. Use youtube_channel to find a creator's outlier videos. If calls fail, run youtube_doctor.",
  },
);

for (const name of wanted) {
  const register = ALL[name as keyof typeof ALL];
  if (!register) {
    console.error(`[youtube-research] unknown tool in YT_MCP_TOOLS: ${name}`);
    continue;
  }
  register(server);
}

await server.connect(new StdioServerTransport());
