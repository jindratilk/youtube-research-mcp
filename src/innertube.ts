import { ProxyAgent } from "undici";

// Minimal Innertube (YouTube's internal API) client. No API key, no cookies.
// Every request goes through one limiter so a burst of parallel tool calls
// cannot get the machine's IP flagged by YouTube.

const env = process.env;

export const CLIENTS = {
  WEB: {
    clientName: "WEB",
    clientVersion: env.YT_WEB_CLIENT_VERSION ?? "2.20251015.01.00",
  },
  // ANDROID and IOS player responses carry caption URLs that work without a PO token.
  ANDROID: {
    clientName: "ANDROID",
    clientVersion: env.YT_ANDROID_CLIENT_VERSION ?? "20.10.38",
    androidSdkVersion: 30,
    osName: "Android",
    osVersion: "11",
  },
  IOS: {
    clientName: "IOS",
    clientVersion: env.YT_IOS_CLIENT_VERSION ?? "20.10.4",
    deviceMake: "Apple",
    deviceModel: "iPhone16,2",
    osName: "iPhone",
    osVersion: "18.3.2.22D82",
  },
} as const;

export type ClientName = keyof typeof CLIENTS;

const USER_AGENTS: Record<ClientName, string> = {
  WEB: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ANDROID: `com.google.android.youtube/${CLIENTS.ANDROID.clientVersion} (Linux; U; Android 11) gzip`,
  IOS: `com.google.ios.youtube/${CLIENTS.IOS.clientVersion} (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)`,
};

export class YouTubeError extends Error {
  constructor(
    message: string,
    /** Machine-readable reason surfaced to the agent so it can decide what to do. */
    public readonly reason:
      | "rate_limited"
      | "blocked"
      | "not_found"
      | "unavailable"
      | "no_captions"
      | "timeout"
      | "http"
      | "parse",
    public readonly status?: number,
  ) {
    super(message);
  }
}

// ---------- limiters ----------

const TIMEOUT_MS = Math.max(1000, Number(env.YT_TIMEOUT_MS ?? 15000));
const DEBUG = !!env.YT_DEBUG;

// Optional HTTP(S) proxy for every YouTube request. YouTube's limits are per IP,
// so a (rotating) proxy is the way to run large transcript sweeps.
const PROXY = env.YT_PROXY ? new ProxyAgent(env.YT_PROXY) : undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Concurrency cap plus a minimum gap between request starts. */
export class Limiter {
  private active = 0;
  private lastStart = 0;
  private queue: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly gapMs: number,
  ) {}

  async acquire(): Promise<void> {
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    const wait = this.lastStart + this.gapMs - Date.now();
    this.lastStart = Math.max(Date.now(), this.lastStart + this.gapMs);
    if (wait > 0) await sleep(wait);
  }

  release(): void {
    this.active--;
    this.queue.shift()?.();
  }
}

/** Innertube API calls (search, player, next, browse). */
export const apiLimiter = new Limiter(
  Math.max(1, Number(env.YT_MAX_CONCURRENCY ?? 4)),
  Math.max(0, Number(env.YT_MIN_GAP_MS ?? 120)),
);

/**
 * Caption downloads (/api/timedtext). YouTube rate-limits this endpoint per IP
 * much harder than the API, so it gets its own, slower queue.
 */
export const captionLimiter = new Limiter(
  Math.max(1, Number(env.YT_CAPTION_CONCURRENCY ?? 2)),
  Math.max(0, Number(env.YT_CAPTION_GAP_MS ?? 350)),
);

export interface FetchOptions {
  limiter?: Limiter;
  /** Total tries. 429s are retried only when > 1; callers with a cooldown pass 1. */
  attempts?: number;
}

/** Fetch through a limiter with timeout and backoff on 429/5xx. */
export async function limitedFetch(url: string, init: RequestInit = {}, opts: FetchOptions = {}): Promise<Response> {
  const limiter = opts.limiter ?? apiLimiter;
  const attempts = opts.attempts ?? 3;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const queuedAt = Date.now();
    await limiter.acquire();
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        ...(PROXY ? { dispatcher: PROXY } : {}),
      } as RequestInit);
      if (DEBUG) {
        const what = url.replace(/^https:\/\/[^/]+/, "").replace(/\?.*$/, "");
        console.error(`[yt] ${res.status} ${what} queued ${startedAt - queuedAt}ms, took ${Date.now() - startedAt}ms`);
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new YouTubeError(
          res.status === 429 ? "YouTube rate-limited this IP (HTTP 429)" : `YouTube returned HTTP ${res.status}`,
          res.status === 429 ? "rate_limited" : "http",
          res.status,
        );
      } else {
        return res;
      }
    } catch (e: any) {
      lastErr =
        e?.name === "TimeoutError"
          ? new YouTubeError(`Request timed out after ${TIMEOUT_MS} ms`, "timeout")
          : e;
    } finally {
      limiter.release();
    }
    if (i < attempts - 1) await sleep(600 * 2 ** i + Math.random() * 300);
  }
  throw lastErr;
}

/** Google's "Sorry... automated queries" interstitial comes back as HTML. */
function looksBlocked(body: string): boolean {
  return body.startsWith("<") && /automated queries|unusual traffic/i.test(body);
}

export async function readJson(res: Response): Promise<any> {
  const body = await res.text();
  if (looksBlocked(body)) {
    throw new YouTubeError(
      "YouTube is temporarily blocking automated requests from this IP. Wait a few minutes or lower YT_MAX_CONCURRENCY.",
      "blocked",
      res.status,
    );
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new YouTubeError(`Unexpected non-JSON response (HTTP ${res.status})`, "parse", res.status);
  }
}

export interface CallOptions {
  client?: ClientName;
  hl?: string;
  gl?: string;
}

export async function innertube(endpoint: string, body: Record<string, unknown>, opts: CallOptions = {}): Promise<any> {
  const clientName = opts.client ?? "WEB";
  const client = { ...CLIENTS[clientName], hl: opts.hl ?? "en", gl: opts.gl ?? "US" };
  const res = await limitedFetch(`https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": USER_AGENTS[clientName],
      "x-youtube-client-name": clientName === "WEB" ? "1" : clientName === "ANDROID" ? "3" : "5",
      "x-youtube-client-version": client.clientVersion,
      origin: "https://www.youtube.com",
    },
    body: JSON.stringify({ context: { client }, ...body }),
  });
  const json = await readJson(res);
  if (!res.ok) {
    const msg = json?.error?.message ?? `HTTP ${res.status}`;
    throw new YouTubeError(`Innertube ${endpoint}: ${msg}`, res.status === 404 ? "not_found" : "http", res.status);
  }
  return json;
}
