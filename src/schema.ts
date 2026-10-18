// Lenient input coercion: agents often send "10" for 10, a single string for an
// array, or a JSON-encoded array. Accept all of them instead of failing the call.

import { z } from "zod";
import { parseClock } from "./parse.js";

export const lenientArray = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((v) => {
    if (typeof v === "string") {
      const s = v.trim();
      if (s.startsWith("[")) {
        try {
          return JSON.parse(s);
        } catch {
          /* fall through */
        }
      }
      return [v];
    }
    return v;
  }, z.array(item));

export const lenientNumber = () =>
  z.preprocess((v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v), z.number());

export const lenientBool = () =>
  z.preprocess((v) => (typeof v === "string" ? /^(true|1|yes)$/i.test(v.trim()) : v), z.boolean());

/** Seconds as a number, "90", "1:30" or "1:02:03". */
export const timeValue = () =>
  z.preprocess((v) => {
    if (typeof v === "string") {
      const s = v.trim();
      return s.includes(":") ? parseClock(s) : Number(s);
    }
    return v;
  }, z.number().min(0));

export const isoDate = () => z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, "Use YYYY-MM-DD or YYYY-MM");

export function toDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  return new Date(s.length === 7 ? `${s}-01T00:00:00Z` : `${s}T00:00:00Z`);
}

export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
