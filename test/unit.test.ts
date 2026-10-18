import { test } from "node:test";
import assert from "node:assert/strict";
import { formatClock, parseAbsoluteDate, parseClock, parseCount, parseRelativeDate, parseUrlStart, parseVideoId } from "../src/parse.js";
import { encodeSearchParams } from "../src/searchParams.js";
import { findHighlights, queryTerms } from "../src/highlights.js";
import { chaptersFromDescription, pickTrack } from "../src/youtube.js";
import { median } from "../src/tools/channel.js";
import { frameTimes } from "../src/tools/fetch.js";

test("counts in en/cs formats", () => {
  assert.equal(parseCount("2,149,594 views"), 2149594);
  assert.equal(parseCount("2.1M views"), 2_100_000);
  assert.equal(parseCount("7 637 zhlédnutí"), 7637);
  assert.equal(parseCount("1,2 mil. zhlédnutí"), 1_200_000);
  assert.equal(parseCount("No views"), 0);
});

test("dates", () => {
  const now = new Date("2026-10-18T00:00:00Z");
  assert.equal(parseRelativeDate("2 months ago", now)?.toISOString().slice(0, 7), "2026-08");
  assert.equal(parseRelativeDate("před 3 týdny", now)?.toISOString().slice(0, 10), "2026-09-27");
  assert.equal(parseRelativeDate("před 6 lety", now)?.getUTCFullYear(), 2020);
  assert.equal(parseAbsoluteDate("Streamed live on Jul 14, 2026")?.toISOString().slice(0, 10), "2026-07-14");
});

test("clock and ids", () => {
  assert.equal(parseClock("1:02:03"), 3723);
  assert.equal(formatClock(3723), "1:02:03");
  assert.equal(formatClock(65), "1:05");
  assert.equal(parseVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42"), "dQw4w9WgXcQ");
  assert.equal(parseVideoId("https://youtube.com/shorts/WAtzGzuazdg"), "WAtzGzuazdg");
  assert.equal(parseVideoId("not a video"), undefined);
  assert.equal(parseUrlStart("https://youtu.be/dQw4w9WgXcQ?t=1m30s"), 90);
});

test("search params protobuf", () => {
  assert.equal(encodeSearchParams({}), "EgIQAQ==");
  // sort=views(3); filters: upload=year(5), type=video(1), duration=long(2), subtitles(1)
  assert.equal(
    Buffer.from(encodeSearchParams({ sort: "views", uploadDate: "year", duration: "long", captionsOnly: true }), "base64").toString("hex"),
    "0803" + "1208" + "0805" + "1001" + "1802" + "2801",
  );
});

test("highlights match inflections and pick relevant passages", () => {
  assert.deepEqual(queryTerms(["AI produktivita a nástroje"]), ["ai", "produktiv", "nastro"]);
  const segs = [
    { start: 0, dur: 5, text: "welcome back to the channel" },
    { start: 40, dur: 5, text: "today we talk about cooking pasta" },
    { start: 80, dur: 5, text: "my AI tools make me more productive every day" },
    { start: 120, dur: 5, text: "subscribe for more" },
  ];
  const h = findHighlights(segs, ["AI productivity tools"], { count: 2 });
  assert.equal(h[0].start, 80);
  assert.ok(h[0].matched.includes("productiv"));
});

test("track choice prefers manual in wanted language, then original audio", () => {
  const tracks = [
    { lang: "en", name: "", auto: true, baseUrl: "a" },
    { lang: "cs", name: "", auto: false, baseUrl: "b" },
    { lang: "en", name: "", auto: false, baseUrl: "c" },
  ];
  assert.equal(pickTrack(tracks, ["cs"])?.baseUrl, "b");
  assert.equal(pickTrack(tracks, [])?.baseUrl, "c");
  assert.equal(pickTrack(tracks, ["de"])?.baseUrl, "c");
});

test("description chapters and median", () => {
  const ch = chaptersFromDescription("Intro text\n0:00 Intro\n1:30 - The hook\n12:05 Outro");
  assert.deepEqual(ch.map((c) => c.start), [0, 90, 725]);
  assert.equal(median([1, 100, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("frame timestamps", () => {
  assert.deepEqual(frameTimes({ frames: 4 }, { start: 0, end: 30 }, 600), [0, 7.5, 15, 22.5]);
  assert.deepEqual(frameTimes({ frames: 2 }, { start: 0, end: Infinity }, 100), [0, 50]);
  assert.deepEqual(frameTimes({ frameAt: [5, 250, 99999] }, { start: 0, end: Infinity }, 300), [5, 250]);
  assert.deepEqual(frameTimes({ frames: 3 }, { start: 0, end: Infinity }, undefined), []);
});
