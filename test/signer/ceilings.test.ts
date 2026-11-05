// Owner: signer group. Pure ceiling checks; every unknown is at-ceiling.
import { describe, test } from "bun:test";

describe("ceilings fail closed", () => {
  test.todo("[S4-4] checkUsd refuses when usd_today is null (unreadable ledger)");
  test.todo("[S4-4] checkUsd refuses when the requested cost is null (unparsable runtime cost)");
  test.todo("[S4-4] checkUsd refuses any spend at the default $0 ceiling, and allows up to a raised ceiling exactly");
  test.todo("[S4-4] checkCredits refuses when credits_month is null, and at 10 credits a month by default");
  test.todo("[S4-4] checkFleet refuses a null count and the 25th beat of a day at the default 24");
  test.todo("[S4-4] parseCost returns null for missing, negative, NaN, Infinity, strings and objects");
  test.todo("[S4-4] spendFromLedger returns nulls when any entry's spend is unreadable");
  test.todo("checkInterval refuses an awake citizen inside 72 h and never lets a shorter own interval win");
  test.todo("defaultCeilings returns a fresh copy equal to DEFAULT_CEILINGS");
});

describe("citizen quiet cap", () => {
  test.todo("[S4-5] checkCitizenQuiet allows exactly 30 days ahead and refuses 30 days plus 1 ms");
  test.todo("[S4-5] checkCitizenQuiet refuses an until in the past, an unparsable until, and the far-future beacon until");
});
