# Searching YouTube well

`youtube_search` runs YouTube's own search. It ranks on titles, descriptions, captions and engagement, so it is keyword-ish with some semantic help. It does not understand boolean operators or quotes.

## Write queries like video titles

Creators title videos for viewers, so phrase queries the way a title or a viewer's search would read.

| Looking for | Weak | Strong |
|---|---|---|
| Productivity with AI | "AI productivity" | "how I use AI to save 10 hours a week" |
| Tool reviews | "Notion AI" | "Notion AI review after 6 months" |
| Mistakes | "AI mistakes" | "AI productivity mistakes to avoid" |
| Spanish creators | "AI productivity" | `{"query": "cómo uso la IA para ahorrar tiempo en el trabajo", "hl": "es", "gl": "ES"}` |

## Angles, not synonyms

"AI productivity" vs "AI efficiency" is the same angle. Different angles:
- how-to / tutorial ("step by step", "workflow", "setup")
- result / story ("I tried X for 30 days", "how I…")
- tools / lists ("best AI tools for…", "my AI stack")
- problems / mistakes / skepticism ("stop using…", "the problem with…")
- audience-specific ("for students", "for freelancers", "for managers")

## Languages

- Default set: the user's language + English. Add languages where the topic is big (e.g. German/Spanish/Hindi creator scenes) when the user wants breadth.
- Non-English queries go as `{query, hl, gl}`: `hl` interface language (`de`, `es`, `fr`), `gl` region (`DE`, `ES`, `FR`). Write them natively, the way locals title videos; borrowed English terms are common ("KI Tools", "ChatGPT trucos").
- Pass `transcriptLangs` (e.g. `["es","en"]`) only if you need a specific caption language; by default the server takes the video's original language, which is what you want for verbatim quotes.

## Filters (prefer server-side)

| Need | Use |
|---|---|
| Recent | `uploaded`: week / month / year (server-side). `publishedAfter` is approximate, applied after search. |
| Long-form only | `shorts: "exclude"` (default) + optionally `duration: "medium"` or `"long"` |
| Shorts only | `shorts: "only"` |
| Proven videos | `minViews` (e.g. 10000), or `sort: "views"` |
| Must have transcript | `captionsOnly: true` (manual subtitles; many good videos only have auto-captions, so do not use it by default) |
| Newest first | `sort: "date"` + `uploaded` window (YouTube no longer sorts by date server-side) |

## Sizing

- `limit` 8–15 per query; 4–10 queries per call. For more coverage add angles and languages rather than raising `limit` to 50: deep result pages are mostly noise.
- `highlights`: keep the default 8 for discovery; set 0 when you only need a list of IDs (faster, fewer requests); raise to 15–25 when highlights are the deliverable.
- Read the coverage footer: it says how many results were dropped by each filter. If most were dropped, loosen that filter.

## When results are poor

1. Rephrase as a title; make it longer and more specific.
2. Try another angle or language, not a synonym.
3. Drop the narrowest filter.
4. If several angles return nothing relevant, say the topic has thin YouTube coverage. Do not stretch weak matches.
