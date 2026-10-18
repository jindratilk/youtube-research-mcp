# Creators and outlier videos

An outlier is a video that got far more views than the channel's typical video. Outliers show which topics, titles and hooks worked for that audience, independent of channel size.

## List a channel

```
youtube_channel { "channel": "@handle", "limit": 60, "minOutlier": 2 }
```
- The score is views ÷ median views of the listed videos, so list enough videos (40–100) for a fair baseline.
- `sort: "latest"` (default) for "what works now"; `publishedAfter` narrows to a period. `sort: "popular"` for all-time hits (the baseline is then skewed high, so read the scores as relative).
- `tab: "shorts"` for Shorts (separate baseline: never mix Shorts and long-form in one median).
- Very recent videos (under ~7 days) have not finished growing; mark them "too new" rather than judging them.

## Find creators for a topic

1. `youtube_search` the topic in each relevant language with `highlights: 0` and a generous `limit`.
2. Count channels in the results; pick the ones that recur or have high views/day.
3. `youtube_channel` each (in parallel subagents when there are more than 3).

## Analyse what worked

For the outliers (and a few median videos as a control group):
- `youtube_fetch` with `start: 0, end: 30` and `parts: ["details","transcript","thumbnail"]` (see hooks.md).
- Compare outliers vs the control group: topic, title formula, thumbnail, hook type, length.
- Express findings as contrasts with counts: "6 of 8 outliers open with a result-first hook; 1 of 5 median videos does."

## Columns

video · views · ×median · published · length · topic · title pattern · hook type · link
