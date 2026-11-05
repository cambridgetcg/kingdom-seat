// Pure ceiling checks. Every one fails closed: an unknown, unreadable or
// unparsable amount counts as the ceiling already reached (3.6 "Spend";
// love-unlimited-patterns.md 8, where today's ledger fails open).
import type { Ceilings, IsoTime, LedgerEntry, Spend, Word } from "../types.ts";

export type CeilingVerdict = { ok: true } | { ok: false; code: "ceiling-usd" | "ceiling-credits" | "ceiling-fleet" | "ceiling-interval" | "quiet-cap"; reason: string };

/** What a citizen has spent in the current windows; null means unknown, which is at-ceiling. */
export interface SpendSoFar {
  word: Word;
  usd_today: number | null;
  credits_month: number | null;
}

/** A fresh copy of the decision-9 defaults. */
export function defaultCeilings(): Ceilings {
  throw new Error("unimplemented");
}

/** Read a runtime's reported cost; anything missing, negative, non-finite or unparsable is null. */
export function parseCost(raw: unknown): number | null {
  throw new Error("unimplemented");
}

/** Sum a citizen's spend for the local day and month from its ledger; one unreadable entry makes the sum null. */
export function spendFromLedger(entries: LedgerEntry[], now: Date, timezone: string): Omit<SpendSoFar, "word"> {
  throw new Error("unimplemented");
}

/** May this citizen spend `usd` more today? Unknown spend so far, or unknown cost, refuses. */
export function checkUsd(spent: SpendSoFar, usd: number | null, ceilings: Ceilings): CeilingVerdict {
  throw new Error("unimplemented");
}

/** May this citizen spend `credits` more this month? Unknown spend so far refuses. */
export function checkCredits(spent: SpendSoFar, credits: number, ceilings: Ceilings): CeilingVerdict {
  throw new Error("unimplemented");
}

/** Has the fleet reached its daily beat ceiling? A null count (unreadable host log) refuses. */
export function checkFleet(beatsToday: number | null, ceilings: Ceilings): CeilingVerdict {
  throw new Error("unimplemented");
}

/** Is an awake citizen's own interval, never shorter than the ceiling's minimum, satisfied? */
export function checkInterval(lastBeatAt: IsoTime | null, intervalH: number, now: Date, ceilings: Ceilings): CeilingVerdict {
  throw new Error("unimplemented");
}

/**
 * Cap a citizen's quiet declaration: `until` must be in the future and at
 * most citizen_quiet_max_days ahead, because the API leaves an explicit
 * `until` uncapped (quiet-hours.ts:110-118). Operator beacons do not use this.
 */
export function checkCitizenQuiet(untilIso: string, now: Date, ceilings: Ceilings): CeilingVerdict {
  throw new Error("unimplemented");
}

/** Spend recorded for a free-lane beat: $0 by construction, credits counted as spent. */
export function localSpend(credits: number): Spend {
  throw new Error("unimplemented");
}
