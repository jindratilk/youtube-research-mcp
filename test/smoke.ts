// End-to-end smoke test: spawns the built server over stdio like a real MCP client
// and runs the hook-research flow against live YouTube.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));

const show = (title: string, r: any) => {
  console.log(`\n========== ${title} ${r.isError ? "(ERROR)" : ""}`);
  for (const c of r.content) console.log(c.type === "text" ? c.text : `[${c.type} ${c.mimeType} ${c.data.length} b64 chars]`);
};
const only = process.argv[2];
const t = async (name: string, args: any) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  show(`${name} ${JSON.stringify(args).slice(0, 160)} — ${Date.now() - t0} ms`, r);
  return r;
};

console.log("tools:", (await client.listTools()).tools.map((x) => x.name).join(", "));
if (!only || only === "doctor") await t("youtube_doctor", {});
if (!only || only === "search")
  await t("youtube_search", {
    queries: ["AI productivity workflow", "how I use AI to save hours every week", { query: "AI produktivita", hl: "cs", gl: "CZ" }],
    limit: 6,
    publishedAfter: "2026-01",
    minViews: 10000,
    highlights: 4,
  });
if (!only || only === "fetch")
  await t("youtube_fetch", { videos: ["https://youtu.be/TL8V41Ea6oM", "dQw4w9WgXcQ"], start: 0, end: 30, parts: ["details", "transcript", "thumbnail"], descriptionChars: 200 });
if (!only || only === "query")
  await t("youtube_fetch", { videos: ["TL8V41Ea6oM"], parts: ["transcript", "chapters", "comments"], query: ["calendar", "email"], commentsLimit: 5 });
if (!only || only === "channel") await t("youtube_channel", { channel: "@aliabdaal", limit: 40, minOutlier: 2 });
await client.close();
