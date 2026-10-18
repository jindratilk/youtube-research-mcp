// Prints the HTTP status of one caption download (200 = transcripts work from this IP).
import { innertube, limitedFetch, YouTubeError } from "../src/innertube.js";
const p = await innertube("player", { videoId: "dQw4w9WgXcQ" }, { client: "ANDROID" });
const url = p.captions.playerCaptionsTracklistRenderer.captionTracks[0].baseUrl + "&fmt=json3";
try {
  console.log((await limitedFetch(url, {}, { attempts: 1 })).status);
} catch (e) {
  console.log(e instanceof YouTubeError ? e.status ?? e.reason : String(e));
}
