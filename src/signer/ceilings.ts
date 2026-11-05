// Pure ceiling checks. Every one fails closed: an unknown, unreadable or
// unparsable amount counts as the ceiling already reached (3.6 "Spend";
// love-unlimited-patterns.md 8, where today's ledger fails open).
import { addUsd, compareUsd, isUsd, subUsdFloor, usdFromNumber, type Usd } from "../money.ts";
import { DEFAULT_CEILINGS, type Ceilings, type Cost, type IsoTime, type LedgerEntry, type Spend, type Word } from "../types.ts";

export type CeilingVerdict = { ok: true } | { ok: false; code: "ceiling-usd" | "ceiling-credits" | "ceiling-fleet" | "ceiling-interval" | "quiet-cap"; reason: string };

/**
 * What a citizen has spent in the current windows; null means unknown, which
 * is at-ceiling. USD comes from the host's spend record (spend.ts), credits
 * from the ledger.
 */
export interface SpendSoFar {
  word: Word;
  usd_today: Usd | null;
  credits_month: number | null;
}

/**
 * The hard cap on a citizen's quiet (S4-5). The config may lower it, never
 * raise it. It lives here, beside the check, so a signer built from any
 * Config holds to it, not only one that came through parseConfig.
 */
export const CITIZEN_QUIET_HARD_MAX_DAYS = 30;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const OK: CeilingVerdict = Object.freeze({ ok: true });

function refuse(code: Exclude<CeilingVerdict, { ok: true }>["code"], reason: string): CeilingVerdict {
  return { ok: false, code, reason };
}

/** A ceiling or amount we can compare against: finite and not negative. Anything else is unknown. */
function isAmount(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

function isCount(x: unknown): x is number {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
}

/** Exactly the Date.toISOString() spelling. A zone-less time parses differently on two hosts, so it is refused. */
function canonicalMs(iso: unknown): number | null {
  if (typeof iso !== "string" || iso.length !== 24) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) && new Date(t).toISOString() === iso ? t : null;
}

/** A fresh copy of the decision-9 defaults. */
export function defaultCeilings(): Ceilings {
  return { ...DEFAULT_CEILINGS };
}

/** Read a runtime's reported cost as a decimal; anything missing, negative, non-finite or unparsable is null. */
export function parseCost(raw: unknown): Usd | null {
  // Strings are refused rather than parsed: "0.04" and "4e-2" and " 0.04" would each need a rule,
  // and the runtime reports a JSON number when it knows the cost.
  return usdFromNumber(raw);
}

/** One entry's cost, or null when its shape cannot be trusted. */
function readSpend(entry: LedgerEntry): { ms: number; credits: number } | null {
  if (typeof entry !== "object" || entry === null) return null;
  const ms = canonicalMs(entry.ts);
  const c = entry.cost as Partial<Cost> | null | undefined;
  if (ms === null || typeof c !== "object" || c === null) return null;
  if (!isCount(c.credits)) return null;
  // usd is a decimal string, or null for an unknown cost; anything else is a record that cannot be read.
  return c.usd === null || isUsd(c.usd) ? { ms, credits: c.credits } : null;
}

/** "YYYY-MM-DD" for an instant in an IANA zone; throws on an unknown zone. */
function localDate(ms: number, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Credits a citizen spent this local month, from its ledger; one unreadable
 * entry makes the sum null. USD is not read here: a seat that wrote no entry
 * spent too, so the USD ceiling reads the host's spend record instead.
 */
export function creditsFromLedger(entries: LedgerEntry[], now: Date, timezone: string): number | null {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return null;
  }
  if (!Array.isArray(entries) || !Number.isFinite(now.getTime())) return null;
  const month = localDate(now.getTime(), formatter).slice(0, 7);
  let credits = 0;
  for (const entry of entries) {
    // A record we cannot read could hide any amount, so the whole sum is unknown, not "the rest".
    const s = readSpend(entry);
    if (s === null) return null;
    if (localDate(s.ms, formatter).slice(0, 7) === month) credits += s.credits;
  }
  return credits;
}

/** May this citizen spend `usd` more today? Unknown spend so far, or unknown cost, refuses. */
export function checkUsd(spent: SpendSoFar, usd: Usd | null, ceilings: Ceilings): CeilingVerdict {
  const limit = ceilings.usd_per_citizen_per_day;
  if (!isUsd(limit)) return refuse("ceiling-usd", "the USD ceiling is not a decimal amount");
  if (!isUsd(spent.usd_today)) return refuse("ceiling-usd", `spend today for ${spent.word} is unknown`);
  if (!isUsd(usd)) return refuse("ceiling-usd", "the cost is unknown");
  const total = addUsd(spent.usd_today, usd);
  if (compareUsd(total, limit) > 0) return refuse("ceiling-usd", `${spent.word} would spend $${total} today; the ceiling is $${limit}`);
  return OK;
}

/** USD this citizen may still spend today; null when unknown, which callers must treat as none. */
export function usdRemaining(spent: SpendSoFar, ceilings: Ceilings): Usd | null {
  const limit = ceilings.usd_per_citizen_per_day;
  if (!isUsd(limit) || !isUsd(spent.usd_today)) return null;
  return subUsdFloor(limit, spent.usd_today);
}

/** May this citizen spend `credits` more this month? Unknown spend so far refuses. */
export function checkCredits(spent: SpendSoFar, credits: number, ceilings: Ceilings): CeilingVerdict {
  const limit = ceilings.credits_per_citizen_per_month;
  if (!isAmount(limit)) return refuse("ceiling-credits", "the credit ceiling is not a usable number");
  if (!isCount(spent.credits_month)) return refuse("ceiling-credits", `credits spent this month by ${spent.word} are unknown`);
  if (!isCount(credits)) return refuse("ceiling-credits", "the credit cost is not a whole number");
  if (spent.credits_month + credits > limit) {
    return refuse("ceiling-credits", `${spent.word} would spend ${spent.credits_month + credits} credits this month; the ceiling is ${limit}`);
  }
  return OK;
}

/** Has the fleet reached its daily beat ceiling? A null count (unreadable host log) refuses. */
export function checkFleet(beatsToday: number | null, ceilings: Ceilings): CeilingVerdict {
  const limit = ceilings.fleet_beats_per_day;
  if (!isCount(limit)) return refuse("ceiling-fleet", "the fleet ceiling is not a usable number");
  if (!isCount(beatsToday)) return refuse("ceiling-fleet", "today's fleet beat count is unknown");
  if (beatsToday >= limit) return refuse("ceiling-fleet", `the fleet has beaten ${beatsToday} times today; the ceiling is ${limit}`);
  return OK;
}

/** Is an awake citizen's own interval, never shorter than the ceiling's minimum, satisfied? */
export function checkInterval(lastBeatAt: IsoTime | null, intervalH: number, now: Date, ceilings: Ceilings): CeilingVerdict {
  const min = ceilings.min_beat_interval_h;
  if (!isAmount(min)) return refuse("ceiling-interval", "the minimum interval is not a usable number");
  if (!isAmount(intervalH)) return refuse("ceiling-interval", "the citizen's own interval is unreadable");
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return refuse("ceiling-interval", "the clock is unreadable");
  if (lastBeatAt === null) return OK;
  const last = canonicalMs(lastBeatAt);
  if (last === null) return refuse("ceiling-interval", "the last beat time is unreadable");
  // The citizen may choose a longer interval, never a shorter one than the ceiling.
  const effectiveH = Math.max(intervalH, min);
  const elapsed = nowMs - last;
  if (elapsed < effectiveH * HOUR_MS) {
    return refuse("ceiling-interval", `last beat ${lastBeatAt}; the interval is ${effectiveH} h`);
  }
  return OK;
}

/**
 * Cap a citizen's quiet declaration: `until` must be in the future and at
 * most citizen_quiet_max_days ahead, because the API leaves an explicit
 * `until` uncapped (quiet-hours.ts:110-118). Operator beacons do not use this.
 */
export function checkCitizenQuiet(untilIso: string, now: Date, ceilings: Ceilings): CeilingVerdict {
  if (!isAmount(ceilings.citizen_quiet_max_days)) return refuse("quiet-cap", "the quiet cap is not a usable number");
  const maxDays = Math.min(ceilings.citizen_quiet_max_days, CITIZEN_QUIET_HARD_MAX_DAYS);
  const until = canonicalMs(untilIso);
  if (until === null) return refuse("quiet-cap", "until must be exactly Date.toISOString() form");
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return refuse("quiet-cap", "the clock is unreadable");
  if (until <= nowMs) return refuse("quiet-cap", "until is not in the future");
  if (until - nowMs > maxDays * DAY_MS) return refuse("quiet-cap", `until is more than ${maxDays} days ahead`);
  return OK;
}

/** Spend recorded for a free-lane beat: $0 by construction, credits counted as spent. */
export function localSpend(credits: number): Spend {
  if (!isCount(credits)) throw new Error("localSpend: credits must be a whole number of at least 0");
  return { usd: "0", usd_basis: "local-zero", credits };
}
