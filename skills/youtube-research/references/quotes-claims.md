# Finding what people say: quotes, claims, advice, mentions

## Find candidates

`youtube_search` with topic queries, and `highlightQuery` set to the thing you need said, e.g. search "AI productivity workflow" with `highlightQuery: ["biggest mistake", "don't do this", "el mayor error"]`. Highlights show where in each video it is said.

Include the phrasing in every language you searched in, and the synonyms a speaker would actually use (spoken language, not written): "the problem is", "here's the thing", "honestly", "I stopped using".

## Read precisely

Use query mode instead of reading full transcripts:
```
youtube_fetch { "videos": [...], "parts": ["transcript"], "query": ["mistake", "don't", "stop using"], "matches": 6 }
```
Then, for each passage you will cite, confirm the exact wording and context with a tight range:
```
youtube_fetch { "videos": ["<id>"], "parts": ["transcript"], "start": <t-20>, "end": <t+40>, "timestamps": "segment" }
```
Context matters: a speaker setting up a view they then reject ("people say X, but…") is not claiming X.

## What to record

| Column | How |
|---|---|
| quote (verbatim) | Copied from tool output; trim with "…" only at the ends. |
| speaker | Channel, or the guest if it is clearly a guest speaking (podcasts, interviews). If unsure, say "channel X (speaker unclear)". |
| stance | supports / opposes / nuanced / neutral, relative to the user's question. |
| context | One line: what they were talking about. |
| link | `?t=` link of the passage. |

## Comments as a source

`parts: ["comments"]` gives top comments: audience questions, objections, timestamps viewers found valuable. Label them clearly as viewer comments, never as the creator's view (except comments marked [creator]).
