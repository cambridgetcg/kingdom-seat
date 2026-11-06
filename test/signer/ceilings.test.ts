// Owner: signer group. Pure ceiling checks; every unknown is at-ceiling.
import { describe, expect, test } from "bun:test";
import { DEFAULT_CEILINGS, type Ceilings, type Cost, type LedgerEntry, type Spend } from "../../src/types.ts";
import {
  CITIZEN_QUIET_HARD_MAX_DAYS,
  checkCitizenQuiet,
  checkCredits,
  checkFleet,
  checkInterval,
  checkUsd,
  creditsFromLedger,
  defaultCeilings,
  localSpend,
  parseCost,
  usdRemaining,
  type SpendSoFar,
} from "../../src/signer/ceilings.ts";
import { DAY_MS, HOUR_MS } from "../helpers/clock.ts";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const spent = (usd_today: string | null, credits_month: number | null): SpendSoFar => ({ word: "glossame", usd_today, credits_month });
const raised = (patch: Partial<Ceilings>): Ceilings => ({ ...defaultCeilings(), ...patch });

/** Only ts and cost matter to creditsFromLedger; the rest is filler. */
function entry(ts: string, cost: Spend | unknown): LedgerEntry {
  return {
    format: "kingdom-seat-ledger/v1",
    word: "glossame",
    did: null,
    seq: 0,
    prev_hash: null,
    type: "state",
    from: "asleep",
    to: "awake",
    via: "confirmed",
    seat_ref: null,
    runtime: null,
    input_digest: null,
    output_digest: null,
    acts: null,
    voiced: null,
    cost: cost as Cost,
    ts,
    signer: "host",
    kid: null,
    sig: null,
  };
}

describe("ceilings fail closed", () => {
  test("[S4-4] checkUsd refuses when usd_today is null (unreadable spend record)", () => {
    const v = checkUsd(spent(null, 0), "0", raised({ usd_per_citizen_per_day: "5" }));
    expect(v).toMatchObject({ ok: false, code: "ceiling-usd" });
  });

  test("[S4-4] checkUsd refuses when the requested cost is null (unparsable runtime cost)", () => {
    expect(checkUsd(spent("0", 0), null, raised({ usd_per_citizen_per_day: "5" }))).toMatchObject({ ok: false, code: "ceiling-usd" });
    // A float, or a decimal in any other spelling, is not an amount here.
    for (const bad of [0.5, "-1", "0.50", "1e-3", " 0.5", "NaN"]) {
      expect(checkUsd(spent("0", 0), bad as unknown as string, raised({ usd_per_citizen_per_day: "5" }))).toMatchObject({ ok: false, code: "ceiling-usd" });
    }
  });

  test("[S4-4] checkUsd refuses any spend at the default $0 ceiling, and allows up to a raised ceiling exactly", () => {
    const d = defaultCeilings();
    expect(d.usd_per_citizen_per_day).toBe("0");
    expect(checkUsd(spent("0", 0), "0.0001", d)).toMatchObject({ ok: false, code: "ceiling-usd" });
    // A free-lane beat costs nothing, so it is not spend.
    expect(checkUsd(spent("0", 0), "0", d)).toEqual({ ok: true });
    const c = raised({ usd_per_citizen_per_day: "1" });
    expect(checkUsd(spent("0.5", 0), "0.5", c)).toEqual({ ok: true });
    expect(checkUsd(spent("0.5", 0), "0.5000001", c)).toMatchObject({ ok: false, code: "ceiling-usd" });
    // Exact: in floats 0.1 + 0.2 is above 0.3, so a ceiling of 0.3 would wrongly refuse; in decimals it is exactly at it.
    expect(0.1 + 0.2 > 0.3).toBe(true);
    expect(checkUsd(spent("0.1", 0), "0.2", raised({ usd_per_citizen_per_day: "0.3" }))).toEqual({ ok: true });
    expect(checkUsd(spent("0.1", 0), "0.2000000000000000001", raised({ usd_per_citizen_per_day: "0.3" }))).toMatchObject({ ok: false });
    // A broken ceiling is not a usable amount, so it refuses too, and so does one left as a float.
    expect(checkUsd(spent("0", 0), "0", raised({ usd_per_citizen_per_day: "NaN" }))).toMatchObject({ ok: false });
    expect(checkUsd(spent("0", 0), "0", raised({ usd_per_citizen_per_day: 5 as unknown as string }))).toMatchObject({ ok: false });
  });

  test("usdRemaining is null when spend is unknown and never negative", () => {
    expect(usdRemaining(spent(null, 0), raised({ usd_per_citizen_per_day: "1" }))).toBeNull();
    expect(usdRemaining(spent("0.25", 0), raised({ usd_per_citizen_per_day: "1" }))).toBe("0.75");
    expect(usdRemaining(spent("0.2", 0), raised({ usd_per_citizen_per_day: "0.3" }))).toBe("0.1");
    expect(usdRemaining(spent("2", 0), raised({ usd_per_citizen_per_day: "1" }))).toBe("0");
    expect(usdRemaining(spent("0", 0), defaultCeilings())).toBe("0");
  });

  test("[S4-4] checkCredits refuses when credits_month is null, and at 10 credits a month by default", () => {
    const d = defaultCeilings();
    expect(d.credits_per_citizen_per_month).toBe(10);
    expect(checkCredits(spent("0", null), 1, d)).toMatchObject({ ok: false, code: "ceiling-credits" });
    expect(checkCredits(spent("0", 9), 1, d)).toEqual({ ok: true });
    expect(checkCredits(spent("0", 10), 1, d)).toMatchObject({ ok: false, code: "ceiling-credits" });
    expect(checkCredits(spent("0", 9), 2, d)).toMatchObject({ ok: false, code: "ceiling-credits" });
    expect(checkCredits(spent("0", 0), 1.5, d)).toMatchObject({ ok: false, code: "ceiling-credits" });
    expect(checkCredits(spent("0", 0), -1, d)).toMatchObject({ ok: false, code: "ceiling-credits" });
  });

  test("[S4-4] checkFleet refuses a null count and the 25th beat of a day at the default 24", () => {
    const d = defaultCeilings();
    expect(d.fleet_beats_per_day).toBe(24);
    expect(checkFleet(null, d)).toMatchObject({ ok: false, code: "ceiling-fleet" });
    expect(checkFleet(23, d)).toEqual({ ok: true });
    expect(checkFleet(24, d)).toMatchObject({ ok: false, code: "ceiling-fleet" });
    expect(checkFleet(Number.NaN, d)).toMatchObject({ ok: false, code: "ceiling-fleet" });
    expect(checkFleet(-1, d)).toMatchObject({ ok: false, code: "ceiling-fleet" });
  });

  test("[S4-4] parseCost returns null for missing, negative, NaN, Infinity, strings and objects", () => {
    for (const bad of [undefined, null, -0.01, Number.NaN, Infinity, -Infinity, "0.04", "", {}, { usd: 1 }, [0.1], true, 1e21]) {
      expect(parseCost(bad)).toBeNull();
    }
    expect(parseCost(0)).toBe("0");
    expect(parseCost(-0)).toBe("0");
    // The decimal text a JSON writer printed, recovered exactly, exponent form spelled out.
    expect(parseCost(0.0412)).toBe("0.0412");
    expect(parseCost(JSON.parse("0.30000000000000004"))).toBe("0.30000000000000004");
    expect(parseCost(1.5e-7)).toBe("0.00000015");
    expect(parseCost(12)).toBe("12");
  });

  test("[S4-4] creditsFromLedger is null when any entry's cost is unreadable, a float amount among them", () => {
    const ok = entry("2026-11-05T09:00:00.000Z", { usd: "0.25", credits: 1 });
    expect(creditsFromLedger([ok], NOW, "Europe/London")).toBe(1);
    // An unknown cost is null usd, which still counts its credits.
    expect(creditsFromLedger([ok, entry("2026-11-05T10:00:00.000Z", { usd: null, credits: 2 })], NOW, "Europe/London")).toBe(3);
    const unreadable: unknown[] = [
      null,
      { usd: "0.1" }, // credits missing
      { credits: 0 }, // usd missing
      { usd: 0.1, credits: 0 }, // a float, not a decimal string
      { usd: "0.10", credits: 0 }, // not the one spelling
      { usd: 0, credits: 0 },
      { usd: "0", credits: 1.5 },
      { usd: "0", credits: -1 },
    ];
    for (const s of unreadable) {
      // Even an entry from last month makes the sum unknown: an unreadable record could hide any amount.
      const old = entry("2026-09-01T00:00:00.000Z", s);
      expect(creditsFromLedger([ok, old], NOW, "Europe/London")).toBeNull();
    }
    expect(creditsFromLedger([ok, entry("yesterday", { usd: "0", credits: 0 })], NOW, "Europe/London")).toBeNull();
    expect(creditsFromLedger([ok], NOW, "Not/AZone")).toBeNull();
  });

  test("creditsFromLedger counts the local month; an unknown cost is still a readable entry", () => {
    const entries = [
      entry("2026-11-05T00:30:00.000Z", { usd: "0.1", usd_basis: "reported", credits: 2 }),
      entry("2026-11-04T23:30:00.000Z", { usd: "0.2", usd_basis: "reported", credits: 3 }),
      entry("2026-10-31T23:59:00.000Z", { usd: "9", usd_basis: "reported", credits: 9 }), // last month in London
      entry("2026-11-05T11:00:00.000Z", { usd: "0", usd_basis: "local-zero", credits: 1 }),
      entry("2026-11-05T10:00:00.000Z", { usd: null, usd_basis: "unknown", credits: 0 }),
    ];
    expect(creditsFromLedger(entries, NOW, "Europe/London")).toBe(6);
    // In Tokyo, 2026-10-31T23:59Z is already November.
    expect(creditsFromLedger(entries, NOW, "Asia/Tokyo")).toBe(15);
    expect(creditsFromLedger([], NOW, "Europe/London")).toBe(0);
  });

  test("checkInterval refuses an awake citizen inside 72 h and never lets a shorter own interval win", () => {
    const d = defaultCeilings();
    const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
    expect(checkInterval(null, 72, NOW, d)).toEqual({ ok: true });
    expect(checkInterval(at(72 * HOUR_MS), 72, NOW, d)).toEqual({ ok: true });
    expect(checkInterval(at(72 * HOUR_MS - 1), 72, NOW, d)).toMatchObject({ ok: false, code: "ceiling-interval" });
    // A citizen asking for 1 h still waits 72 h.
    expect(checkInterval(at(2 * HOUR_MS), 1, NOW, d)).toMatchObject({ ok: false, code: "ceiling-interval" });
    expect(checkInterval(at(72 * HOUR_MS), 1, NOW, d)).toEqual({ ok: true });
    // A longer own interval is honoured.
    expect(checkInterval(at(100 * HOUR_MS), 168, NOW, d)).toMatchObject({ ok: false, code: "ceiling-interval" });
    // Unreadable values refuse.
    expect(checkInterval("last tuesday", 72, NOW, d)).toMatchObject({ ok: false, code: "ceiling-interval" });
    expect(checkInterval(at(100 * HOUR_MS), Number.NaN, NOW, d)).toMatchObject({ ok: false, code: "ceiling-interval" });
    expect(checkInterval(at(-HOUR_MS), 72, NOW, d)).toMatchObject({ ok: false, code: "ceiling-interval" });
  });

  test("defaultCeilings returns a fresh copy equal to DEFAULT_CEILINGS", () => {
    const a = defaultCeilings();
    expect(a).toEqual({ ...DEFAULT_CEILINGS });
    a.usd_per_citizen_per_day = "100";
    expect(defaultCeilings().usd_per_citizen_per_day).toBe("0");
    expect(DEFAULT_CEILINGS.usd_per_citizen_per_day).toBe("0");
  });

  test("localSpend is $0 local-zero with whole credits", () => {
    expect(localSpend(1)).toEqual({ usd: "0", usd_basis: "local-zero", credits: 1 });
    expect(() => localSpend(-1)).toThrow();
    expect(() => localSpend(0.5)).toThrow();
  });
});

describe("citizen quiet cap", () => {
  const d = defaultCeilings();
  const ahead = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

  test("[S4-5] checkCitizenQuiet allows exactly 30 days ahead and refuses 30 days plus 1 ms", () => {
    expect(d.citizen_quiet_max_days).toBe(30);
    expect(checkCitizenQuiet(ahead(30 * DAY_MS), NOW, d)).toEqual({ ok: true });
    expect(checkCitizenQuiet(ahead(30 * DAY_MS + 1), NOW, d)).toMatchObject({ ok: false, code: "quiet-cap" });
    expect(checkCitizenQuiet(ahead(1), NOW, d)).toEqual({ ok: true });
  });

  test("[S4-5] checkCitizenQuiet refuses an until in the past, an unparsable until, and the far-future beacon until", () => {
    expect(checkCitizenQuiet(NOW.toISOString(), NOW, d)).toMatchObject({ ok: false, code: "quiet-cap" });
    expect(checkCitizenQuiet(ahead(-1), NOW, d)).toMatchObject({ ok: false, code: "quiet-cap" });
    for (const bad of ["soon", "", "2026-11-10", "2026-11-10T00:00:00", "2026-11-10T00:00:00Z", "2026-11-10T00:00:00.000+00:00"]) {
      // Only the toISOString spelling: a zone-less time would mean different instants on two hosts.
      expect(checkCitizenQuiet(bad, NOW, d)).toMatchObject({ ok: false, code: "quiet-cap" });
    }
    expect(checkCitizenQuiet("2999-12-31T00:00:00.000Z", NOW, d)).toMatchObject({ ok: false, code: "quiet-cap" });
    expect(checkCitizenQuiet(ahead(DAY_MS), NOW, raised({ citizen_quiet_max_days: Number.NaN }))).toMatchObject({ ok: false });
  });

  test("[S4-5] a Config that names a cap above 30 days is still held to 30, whoever built it", () => {
    // parseConfig refuses such a value; a signer built from a hand-made Config must not trust it either.
    const loose = raised({ citizen_quiet_max_days: 365 });
    expect(CITIZEN_QUIET_HARD_MAX_DAYS).toBe(30);
    expect(checkCitizenQuiet(ahead(200 * DAY_MS), NOW, loose)).toMatchObject({ ok: false, code: "quiet-cap" });
    expect(checkCitizenQuiet(ahead(30 * DAY_MS + 1), NOW, loose)).toMatchObject({ ok: false, code: "quiet-cap" });
    expect(checkCitizenQuiet(ahead(30 * DAY_MS), NOW, loose)).toEqual({ ok: true });
    // A lower cap is honoured as written.
    expect(checkCitizenQuiet(ahead(8 * DAY_MS), NOW, raised({ citizen_quiet_max_days: 7 }))).toMatchObject({ ok: false, code: "quiet-cap" });
  });
});
