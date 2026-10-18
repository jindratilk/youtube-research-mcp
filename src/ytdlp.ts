// Optional fallback: if yt-dlp is installed, use it for transcripts when the
// direct Innertube path fails. yt-dlp tracks YouTube's anti-bot changes closely.

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseJson3, type Segment } from "./parse.js";

const run = promisify(execFile);
const BIN = process.env.YT_DLP_PATH ?? "yt-dlp";
const DISABLED = /^(0|off|false|no)$/i.test(process.env.YT_DLP ?? "");

let availability: Promise<string | undefined> | undefined;

export const ytDlpBin = () => BIN;

/** Shared flags for every yt-dlp call (quiet, and the proxy when YT_PROXY is set). */
export function ytDlpArgs(): string[] {
  return ["--no-warnings", "--quiet", ...(process.env.YT_PROXY ? ["--proxy", process.env.YT_PROXY] : [])];
}

/** yt-dlp version string, or undefined when it is not installed or disabled. */
export function ytDlpVersion(): Promise<string | undefined> {
  if (DISABLED) return Promise.resolve(undefined);
  availability ??= run(BIN, ["--version"], { timeout: 10_000 })
    .then((r) => r.stdout.trim())
    .catch(() => undefined);
  return availability;
}

export async function ytDlpTranscript(
  id: string,
  wanted: string[],
): Promise<{ lang: string; auto: boolean; segments: Segment[] } | undefined> {
  if (!(await ytDlpVersion())) return undefined;
  const dir = await mkdtemp(join(tmpdir(), "yt-mcp-"));
  try {
    const langs = [...wanted.map((l) => `${l}.*`), ".*-orig"].join(",");
    await run(
      BIN,
      [
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-format",
        "json3",
        "--sub-langs",
        langs,
        ...ytDlpArgs(),
        "-o",
        join(dir, "%(id)s.%(ext)s"),
        `https://www.youtube.com/watch?v=${id}`,
      ],
      { timeout: 90_000 },
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json3"));
    if (!files.length) return undefined;
    const langOf = (f: string) => f.slice(id.length + 1, -".json3".length);
    const rank = (f: string) => {
      const l = langOf(f);
      const i = wanted.findIndex((w) => l === w || l.startsWith(w + "-"));
      return i === -1 ? wanted.length : i;
    };
    files.sort((a, b) => rank(a) - rank(b));
    const file = files[0];
    const segments = parseJson3(JSON.parse(await readFile(join(dir, file), "utf8")));
    const lang = langOf(file);
    return segments.length ? { lang: lang.replace(/-orig$/, ""), auto: lang.endsWith("-orig"), segments } : undefined;
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
