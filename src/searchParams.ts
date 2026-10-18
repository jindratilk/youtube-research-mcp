// Encodes YouTube's search filter protobuf (the `sp=` URL parameter) by hand,
// so filters are applied server-side instead of by over-fetching.

export type UploadDate = "hour" | "today" | "week" | "month" | "year";
export type DurationBucket = "short" | "medium" | "long";
export type SortBy = "relevance" | "views";

export interface SearchFilterInput {
  sort?: SortBy;
  uploadDate?: UploadDate;
  duration?: DurationBucket;
  /** Only videos with subtitles/CC. */
  captionsOnly?: boolean;
  /** "video" is the only result type this server returns. */
  type?: "video";
}

// YouTube still honours view-count sort; upload-date and rating sorts are ignored since 2025.
const SORT = { relevance: 0, views: 3 } as const;
const UPLOAD = { hour: 1, today: 2, week: 3, month: 4, year: 5 } as const;
const DURATION = { short: 1, long: 2, medium: 3 } as const; // short <4 min, medium 4–20, long >20

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

const field = (num: number, value: number) => [...varint(num << 3), ...varint(value)];

export function encodeSearchParams(f: SearchFilterInput): string {
  const filters: number[] = [];
  if (f.uploadDate) filters.push(...field(1, UPLOAD[f.uploadDate]));
  filters.push(...field(2, 1)); // type = video
  if (f.duration) filters.push(...field(3, DURATION[f.duration]));
  if (f.captionsOnly) filters.push(...field(5, 1));

  const msg: number[] = [];
  if (f.sort && f.sort !== "relevance") msg.push(...field(1, SORT[f.sort]));
  msg.push(...varint((2 << 3) | 2), ...varint(filters.length), ...filters);
  return Buffer.from(msg).toString("base64");
}
