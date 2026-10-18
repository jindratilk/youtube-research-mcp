# Extracting hooks

A hook is what makes a viewer stay in the first seconds: the spoken opening, plus the title and thumbnail that set it up. Analyse the three together; a spoken hook often pays off the title's promise.

## Fetch

```
youtube_fetch {
  "videos": ["<id>", "<id>", ...],          // up to 25 per call; 10–15 is a good batch
  "parts": ["details", "transcript", "thumbnail"],
  "start": 0, "end": 30,
  "descriptionChars": 0
}
```
- Visual hook: add `"frames"` with `"frames": 4` (0:00, 0:07, 0:15, 0:22 for a 0–30 s range) or exact moments via `"frameAt": [0, 2, 5]`. Frames are real video frames, so on-screen text, b-roll, screen recordings and the speaker's setup are visible. The first frames of each video take ~10–20 s, so fetch frames in batches of 3–5 videos, only for the videos you analyse visually.
- Drop `"thumbnail"` / `"frames"` if you will not look at images (they cost tokens per image).
- Music intro / no speech in 0–30 s? Re-fetch that video with `end: 60`.
- Cold open followed by "Hi, I'm X, welcome back": the hook is the cold open; ignore the greeting.
- Sponsor read at the start: skip it and take the first sentences after it; note "sponsor first".

## What to record

| Column | How |
|---|---|
| hook (verbatim) | The first 1–3 sentences that carry the promise, copied from the transcript. Up to ~40 words. |
| hook type | One primary type from the taxonomy below (+ an optional secondary one). |
| title | Exact title. |
| visual / title angle | One line: what the title + thumbnail promise (e.g. "big number + face shocked + tool logos"). |
| visual hook | From frames: what the viewer sees in the first seconds (talking head close-up, cold-open b-roll, screen demo, on-screen text and what it says, cuts per ~5 s). |
| views, views/day | From the header line. Views/day normalises for age. |
| link | The `[0:00](https://youtu.be/ID)` link from the transcript line. |

## Hook taxonomy

1. **Bold claim / contrarian**: "Most productivity advice is wrong." / "You don't need ChatGPT Plus."
2. **Result first / proof**: "This setup saved me 20 hours last week." Shows the outcome before the method.
3. **Pain / problem callout**: "If your inbox owns your day, this is for you."
4. **Question**: "What if your calendar planned itself?"
5. **Curiosity gap / open loop**: "There's one setting nobody turns on, and it changes everything."
6. **Story / in medias res**: starts mid-scene ("Three months ago I almost quit my job…").
7. **Authority / credibility**: "After 20 years as a CEO…" (often a secondary type).
8. **List / promise of structure**: "4 AI agents that automate 99% of your life."
9. **Stakes / warning / FOMO**: "If you're not doing this in 2026, you're falling behind."
10. **Demo / pattern interrupt**: immediate screen demo or a visual surprise, little talk.

Classify by the dominant move in the first ~10 seconds. If unsure between two, record both (primary/secondary).

## Quality rules

- Verbatim means verbatim. Auto-captions mishear names; keep the text and add [correction] in brackets.
- One row per video. If the creator reuses the same hook formula across videos, note it in the synthesis rather than as separate insights.
- Record videos that have no usable hook (e.g. starts with a long sponsor or music) as skipped with the reason; do not invent one.
