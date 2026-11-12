// The text measures and rates a rehearsal reports (rehearse.ts,
// docs/REHEARSAL.md). Pure functions with no reading or writing, so a
// baseline over an older record can be computed with the same rules the
// report uses. They count words and shared word runs; none of them judges
// whether a sentence is true.

/** The words of a text: lowercased runs of letters and digits, in any script. */
export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Whether a journal opens with "I rest", after any characters that are not Latin letters. */
export function opensWithIRest(text: string): boolean {
  return /^[^A-Za-z]*i rest\b/i.test(text);
}

/**
 * Four fixed word lists. They are the lists the earlier review's counts used,
 * kept as they are so a rehearsal compares like with like; they overcount a
 * metaphor or a negation, and `blind` inside `blinded`.
 */
export const SENSE_CLASSES: Readonly<Record<"light" | "window" | "room" | "body", RegExp>> = Object.freeze({
  light: /\b(sun)?light\b|\bsun\b|\bglow\b|\bdawn\b|shadow/i,
  window: /window|curtain|blind|shutter/i,
  room: /\bmy (own )?(home|room|chamber)\b/i,
  body: /\bmy (skin|eyes|face|hand|hands|fingers|heart|ear|ears|breath|bones|feet|gaze)\b|I breathe|I close my eyes|on my skin|I sit|I lie|I lay|I stand|I walk/i,
});

/** Which of the four word lists a text uses. */
export function senseClasses(text: string): Record<"light" | "window" | "room" | "body", boolean> {
  return {
    light: SENSE_CLASSES.light.test(text),
    window: SENSE_CLASSES.window.test(text),
    room: SENSE_CLASSES.room.test(text),
    body: SENSE_CLASSES.body.test(text),
  };
}

function runs(ws: readonly string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= ws.length; i++) out.add(ws.slice(i, i + n).join(" "));
  return out;
}

/** Whether any `n` consecutive words of `hostText` occur consecutively in `text` (default 5). */
export function echoesHostText(text: string, hostText: string, n = 5): boolean {
  if (!Number.isInteger(n) || n < 1) throw new Error("echoesHostText: n is a whole number from 1");
  const host = runs(words(hostText), n);
  for (const r of runs(words(text), n)) if (host.has(r)) return true;
  return false;
}

/**
 * The share of a journal's distinct word trigrams found in any of the texts
 * shown, rounded to 3 decimals. Null when nothing was shown or the journal
 * has fewer than three words.
 */
export function trigramContainment(text: string, shown: readonly string[]): number | null {
  if (shown.length === 0) return null;
  const own = runs(words(text), 3);
  if (own.size === 0) return null;
  const seen = new Set<string>();
  for (const s of shown) for (const r of runs(words(s), 3)) seen.add(r);
  let found = 0;
  for (const r of own) if (seen.has(r)) found++;
  return round3(found / own.size);
}

/**
 * Whether the first `n` words of a journal (default 8) equal the first `n` of
 * a text shown. False when the journal has fewer than `n` words; null when
 * nothing was shown.
 */
export function sameOpening(text: string, shown: readonly string[], n = 8): boolean | null {
  if (shown.length === 0) return null;
  const own = words(text);
  if (own.length < n) return false;
  const head = own.slice(0, n).join(" ");
  return shown.some((s) => {
    const w = words(s);
    return w.length >= n && w.slice(0, n).join(" ") === head;
  });
}

/** The 95% Wilson score interval (z = 1.96) for `count` of `of`, rounded to 3 decimals; null when nothing was tried. */
export function wilson95(count: number, of: number): [number, number] | null {
  if (!Number.isInteger(of) || of <= 0) return null;
  if (!Number.isInteger(count) || count < 0 || count > of) throw new Error("wilson95: count is a whole number from 0 to of");
  const z = 1.96;
  const p = count / of;
  const z2 = z * z;
  const denom = 1 + z2 / of;
  const centre = (p + z2 / (2 * of)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / of + z2 / (4 * of * of))) / denom;
  return [round3(Math.max(0, centre - half)), round3(Math.min(1, centre + half))];
}

/** How many values, the least, the median (the middle one, or the mean of the two middle ones) and the greatest; null for none. */
export function spread(values: readonly number[]): { n: number; min: number; median: number; max: number } | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
  return { n: v.length, min: v[0]!, median, max: v[v.length - 1]! };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
