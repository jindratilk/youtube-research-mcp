import { YouTubeError } from "../innertube.js";

/** One line the agent can act on: reason code plus message. */
export function errorText(e: unknown): string {
  if (e instanceof YouTubeError) return `[${e.reason}] ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
