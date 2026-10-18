---
name: youtube-research
description: "Research YouTube with the youtube_* MCP tools: find videos on a topic in several languages, extract hooks, quotes, claims, tutorials or examples across many videos, study a creator's breakout videos, compare channels. Use for requests like 'find all hooks from videos about X', 'what do creators say about Y', 'go through YouTube and collect Z', 'which videos of @channel worked best and why'."
---

# YouTube Research Orchestrator

You run the research; the youtube_* tools do the fetching. Your job: understand what the user wants as a result, plan queries that cover the topic in every relevant language, dispatch subagents so raw transcripts stay out of your context, then merge, verify and deliver.

Tools (no API key):
- `youtube_search`: several queries in one call, merged and de-duplicated, with transcript highlights and a coverage footer.
- `youtube_fetch`: many videos per call; a transcript range (`start`/`end`), a `chapter`, or only passages matching a `query`; plus real video frames (`parts: ["frames"]`), details, chapters, comments, thumbnail.
- `youtube_channel`: a channel's videos with an outlier score (×median views).
- `youtube_doctor`: run it once if tools start failing.

## Step 0: Dates and scope

If the request involves time ("recent", "this year", "last 3 months"), compute exact dates from today's date first and write the calculation down. Map them to `uploaded` (hour/today/week/month/year) when that fits, otherwise `publishedAfter`.

## Step 1: Define the result before searching

Decide what one row of the result is and which columns it needs. Examples:
- Hooks: video, channel, views, views/day, hook (verbatim), hook type, title + thumbnail angle, link with timestamp.
- Claims: claim (verbatim), who said it, context, timestamp link, agrees/disagrees.
- Creator analysis: video, views, ×median, topic, title pattern, hook.

State what qualifies (language, recency, minimum views, long-form vs Shorts) and turn it into tool filters. If the user asked for a number ("50 hooks"), keep going until you reach it, or explain why coverage ran out.

## Step 2: Assess size

- **Single video or a known channel**: do it yourself with 1–3 calls.
- **Topic sweep** ("all hooks from AI productivity videos"): 1 search round yourself to see the landscape, then 2–4 parallel subagents for fetching and extraction.
- **Exhaustive or multi-angle** (several languages, many channels, comparisons): plan sub-questions, one subagent each, then a merge pass.

If the request could reasonably be a quick look OR a big sweep, ask the user which one, saying what each would cost (calls, time) and deliver.

## Step 3: Plan queries (multilingual)

Read [references/searching.md](references/searching.md). In short:
- Cover the topic from different angles (how-to, results/story, tools, mistakes, opinion), not just synonym swaps.
- Cover languages: the user's language plus English by default, plus any language the topic is big in. Use `{query, hl, gl}` for non-English queries (e.g. `{"query": "productividad con IA", "hl": "es", "gl": "ES"}`) and write those queries natively, not as literal translations.
- Put 4–10 queries in ONE `youtube_search` call. Use `highlightQuery` when what you need inside the video (e.g. "biggest mistake") differs from what the video is about.

## Transcript budget (read before Step 4)

YouTube rate-limits transcript downloads per IP (search, details, channels are far more lenient). Treat transcripts as the scarce resource:
- The exact limit is not published. In testing, ~80–100 transcripts within a few minutes triggered a block lasting well over 20 minutes. Keep a sweep to a few dozen transcripts; if the user needs more, say up front that it will take longer or needs a proxy (`YT_PROXY`).
- Pick before you read: use search metadata (views, views/day, title, key moments) and `youtube_channel` scores to choose which videos deserve a transcript. Use `highlights: 0` on discovery searches when you will fetch transcripts anyway.
- Each video's transcript is downloaded once per session and reused: search highlights, then `start/end`, `chapter` or `query` fetches of the same video cost nothing extra.
- If a tool says transcripts are paused, do not retry sooner than the stated seconds and do not loop. Continue with metadata work (titles, thumbnails, channel stats) meanwhile, then fetch the skipped videos in batches of 5–10.

## Step 4: Dispatch subagents

Use the Agent tool, `model: "haiku"`, at most 3 in parallel (all subagents share one server and one IP; the server queues requests, so more agents does not mean faster). Split the transcript budget between them.

Give each subagent:
1. The absolute path of the reference file(s) to read (this skill's directory + `references/...`).
2. The exact video IDs, or the exact queries, it owns. Split by video lists or by sub-question so subagents do not fetch the same videos.
3. The row schema and the qualification rules.
4. The output format and the closing lines below, verbatim.

Template:
```
Read [skill dir]/references/<task file>.md and follow it.
Use only the youtube_search / youtube_fetch / youtube_channel tools; do not use Bash or files.
Task: <what to extract>, for these videos: <ids>  (or: run these queries: <...>)
A row qualifies if: <rules>
Return a compact markdown table with columns: <columns>. Every row must include the timestamp link from the tool output.
End with EXACTLY these lines:
videos_reviewed: N
skipped: <id: reason>, ... (or "none")
```

Pass the two closing lines verbatim. `videos_reviewed` = videos whose content the subagent actually read in tool output.

## Step 5: Merge, verify, deliver

- De-duplicate by video ID. If the same creator repeats a hook across videos, keep the earliest and note the repeat.
- **Proof, not claims.** Each row needs a `?t=` link and text copied from tool output. Never present a paraphrase as a quote. Auto-generated captions misspell names ("ChachiBT" = ChatGPT): fix obvious ones in [brackets] and keep the rest verbatim.
- Spot-check: pick 2–3 rows from each subagent and confirm them with `youtube_fetch` (`start`/`end` around the timestamp). If a quote does not match, re-check that subagent's rows.
- **Coverage line in the deliverable:** queries × languages run, unique videos found, videos reviewed, skipped and why (no captions, filters, failures). Add up the subagents' `videos_reviewed` lines. Do not drop gaps silently.
- Then give the synthesis the user asked for: patterns, counts per type, best examples. See [references/synthesis.md](references/synthesis.md).

## Task references

| File | Use for |
|---|---|
| [references/searching.md](references/searching.md) | Always: query writing, languages, filters, sizing |
| [references/hooks.md](references/hooks.md) | Hooks, intros, openings, titles + thumbnails |
| [references/quotes-claims.md](references/quotes-claims.md) | What people say about X, claims, opinions, advice, mentions |
| [references/creators-outliers.md](references/creators-outliers.md) | A channel's best videos, comparing creators, what works |
| [references/synthesis.md](references/synthesis.md) | Final write-up: patterns, taxonomy, citations |

## Failure handling

- Transcripts paused (`[rate_limited]`): follow the pause time in the message; keep doing metadata work; retry skipped IDs once after it; report anything still missing as skipped.
- `[blocked]` on search/details: stop the sweep and tell the user; it usually clears within minutes to an hour.
- `no captions`: skip the video for transcript tasks (count it as skipped), but titles/thumbnails can still be used for hook-angle analysis.
- Tools failing everywhere: run `youtube_doctor` and tell the user what it says.
