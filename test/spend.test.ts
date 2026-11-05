// Owner: signer group. Money as decimal strings (money.ts) and the host's
// spend record (spend.ts): every metered seat's spend is recorded whatever its
// outcome, the USD ceiling reads that record, and a seat whose spend was not
// recorded counts as at the ceiling (KS-004 re-review B2, R2, R3, C4).
// recordingRunner only; no test runs claude.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addUsd, compareUsd, floorUsd, isUsd, subUsdFloor, usdFromNumber, usdFromText } from "../src/money.ts";
import { hostSpendRecorder, readSpendRecord, usdSpentToday, usdToday, type SpendLine } from "../src/spend.ts";
import { usdRemaining } from "../src/signer/ceilings.ts";
import { summonRuntime } from "../src/runtime/summon.ts";
import { openSeat, runSeat, type SeatDeps } from "../src/seat.ts";
import { readCitizen } from "../src/state.ts";
import { realDeps } from "../src/cli.ts";
import { utf8 } from "../src/crypto.ts";
import { DEFAULT_CEILINGS, EXIT, type HaltStatus, type SeatRef, type YuPresence } from "../src/types.ts";
import { recordingRunner } from "./helpers/fake-runtime.ts";
import { noFetch } from "./helpers/fake-server.ts";
import { fakeSigner } from "./helpers/fake-signer.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { testClock } from "./helpers/clock.ts";
import successFixture from "./fixtures/runtime/claude-result-success.json";

let host: TempHost | null = null;
afterEach(async () => {
  await host?.cleanup();
  host = null;
});

const WORD = "glossame";
const NOW = new Date("2026-11-05T12:00:00.000Z");

function line(over: Partial<SpendLine>): SpendLine {
  return {
    format: "kingdom-seat-spend/v1",
    ts: "2026-11-05T09:00:00.000Z",
    host: "test-host",
    word: WORD,
    seat_id: "11111111-1111-4111-8111-111111111111",
    runtime: "summon",
    phase: "settled",
    usd: "0.1",
    usd_basis: "reported",
    ...over,
  };
}

/** One seat: begun at `at`, then settled with `usd` (or never settled, with `settled: false`). */
function seat(n: number, at: string, usd: string | null, opts: { settled?: boolean; word?: string } = {}): SpendLine[] {
  const seat_id = `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
  const word = opts.word ?? WORD;
  const begun = line({ seat_id, word, ts: at, phase: "begun", usd: null, usd_basis: "unknown" });
  if (opts.settled === false) return [begun];
  return [begun, line({ seat_id, word, ts: at, phase: "settled", usd, usd_basis: usd === null ? "unknown" : "reported" })];
}

describe("money as decimal strings", () => {
  test("one spelling per amount, exact sums and comparisons, never a float", () => {
    for (const ok of ["0", "1", "0.5", "12.0421", "0.000000000000000001"]) expect(isUsd(ok)).toBe(true);
    for (const bad of [0, 0.5, "", "-1", "01", "0.50", "1.", ".5", "1e-3", " 1", "NaN", "Infinity"]) expect(isUsd(bad)).toBe(false);
    expect(addUsd("0.1", "0.2")).toBe("0.3");
    expect(addUsd("0.0421", "0.0421")).toBe("0.0842");
    expect(subUsdFloor("1", "0.25")).toBe("0.75");
    expect(subUsdFloor("0.3", "0.30000000000000004")).toBe("0");
    expect(compareUsd("0.3", "0.30000000000000004")).toBe(-1);
    expect(compareUsd("2", "10")).toBe(-1);
    expect(floorUsd("0.0123456789", 6)).toBe("0.012345");
    expect(floorUsd("0.0000001", 6)).toBe("0");
    // What a person writes in a config: trailing zeros allowed and dropped, anything else refused.
    expect(usdFromText("2.50")).toBe("2.5");
    expect(usdFromText("0.000")).toBe("0");
    for (const bad of [2.5, "-1", "1e2", "01", "", "two"]) expect(usdFromText(bad)).toBeNull();
    expect(usdFromNumber(1e21)).toBeNull();
  });
});

describe("the host's spend record", () => {
  test("usdToday sums each seat begun today by its settled amount, in the host's zone", () => {
    const lines = [
      ...seat(1, "2026-11-05T09:00:00.000Z", "0.1"),
      ...seat(2, "2026-11-05T10:00:00.000Z", "0.2"),
      ...seat(3, "2026-11-04T23:30:00.000Z", "5"), // yesterday in London
      ...seat(4, "2026-11-05T11:00:00.000Z", "7", { word: "shemme" }),
      // An unsettled seat on another day does not hide today's.
      ...seat(5, "2026-11-01T09:00:00.000Z", null, { settled: false }),
    ];
    expect(usdToday(lines, WORD, NOW, "Europe/London")).toBe("0.3");
    // In Tokyo, 2026-11-04T23:30Z is already the 5th; the unsettled seat from the 1st still is not today.
    expect(usdToday(lines, WORD, NOW, "Asia/Tokyo")).toBe("5.3");
    expect(usdToday(lines, "shemme", NOW, "Europe/London")).toBe("7");
    expect(usdToday([], WORD, NOW, "Europe/London")).toBe("0");
    expect(usdToday(lines, WORD, NOW, "Not/AZone")).toBeNull();
  });

  test("a seat whose spend was not recorded today counts as at the ceiling", () => {
    const today = seat(1, "2026-11-05T09:00:00.000Z", "0.1");
    const cases: [string, SpendLine[]][] = [
      ["begun and never settled (killed mid-run, or the settle failed)", seat(2, "2026-11-05T10:00:00.000Z", null, { settled: false })],
      ["settled with an unknown cost", seat(2, "2026-11-05T10:00:00.000Z", null)],
      ["settled with no begun line", seat(2, "2026-11-05T10:00:00.000Z", "0.1").slice(1)],
      ["settled twice", [...seat(2, "2026-11-05T10:00:00.000Z", "0.1"), seat(2, "2026-11-05T10:00:00.000Z", "0.1")[1]!]],
    ];
    for (const [why, more] of cases) {
      expect(usdToday([...today, ...more], WORD, NOW, "Europe/London"), why).toBeNull();
      // The ceiling then has nothing left to give: unknown is none.
      expect(usdRemaining({ word: WORD, usd_today: usdToday([...today, ...more], WORD, NOW, "Europe/London"), credits_month: 0 }, { ...DEFAULT_CEILINGS, usd_per_citizen_per_day: "5" }), why).toBeNull();
    }
  });

  test("a record that cannot be read, is torn, holds a float, or was lost after it started, is unknown", async () => {
    host = await makeTempHost();
    const config = host.config;
    const path = config.paths.spend_log;
    const ref: SeatRef = {
      format: "kingdom-seat-seat/v1",
      seat_id: "33333333-3333-4333-8333-333333333333",
      host: "test-host",
      word: WORD,
      runtime: "summon",
      invoker: { kind: "summons", who: "yu", why: "test" },
      opened_at: "2026-11-05T02:05:00.000Z",
    };
    // Never started: an empty history, not an unknown one.
    expect(await readSpendRecord(config)).toEqual([]);
    expect(await usdSpentToday(config, WORD, NOW)).toBe("0");
    const rec = hostSpendRecorder(config, { now: () => new Date("2026-11-05T02:06:00.000Z") });
    await rec.begin(ref);
    await rec.settle(ref, { usd: "0.0421", usd_basis: "reported", credits: 0 });
    expect(await usdSpentToday(config, WORD, NOW)).toBe("0.0421");
    // The recorder refuses to write an amount in any spelling but the one, or a float.
    await expect(rec.settle(ref, { usd: 0.0421 as unknown as string, usd_basis: "reported", credits: 0 })).rejects.toThrow(/refusing a line/);
    await expect(rec.settle(ref, { usd: "0.04210", usd_basis: "reported", credits: 0 })).rejects.toThrow(/refusing a line/);

    const good = await Bun.file(path).text();
    const bad: [string, string][] = [
      ["torn last line", good.slice(0, -1)],
      ["a float amount", good.replace('"usd":"0.0421"', '"usd":0.0421')],
      ["a line that is not JSON", `${good}not json\n`],
      ["an extra field", good.replace('"phase":"settled"', '"phase":"settled","note":"x"')],
    ];
    for (const [why, text] of bad) {
      await writeFile(path, text);
      expect(await readSpendRecord(config), why).toBeNull();
      expect(await usdSpentToday(config, WORD, NOW), why).toBeNull();
    }
    // Lost after it was started: unreadable, never an empty history that would give the day's money back.
    await rm(path);
    expect(await usdSpentToday(config, WORD, NOW)).toBeNull();
    await expect(rec.begin(ref)).rejects.toMatchObject({ code: "invalid-record" });
    // A symlink is refused, not followed.
    await writeFile(join(host.root, "elsewhere.jsonl"), "");
    await symlink(join(host.root, "elsewhere.jsonl"), path);
    expect(await usdSpentToday(config, WORD, NOW)).toBeNull();
    await expect(rec.begin(ref)).rejects.toMatchObject({ code: "symlink" });
  });
});

describe("[R2] a metered seat's spend is recorded whatever its outcome", () => {
  const PRESENT: YuPresence = { present: true, via: "tty-confirm", confirmed_at: "2026-11-05T02:04:00.000Z", scope: `summon ${WORD}` };

  /** A summons seat through the real summon adapter and runSeat; claude is a recording runner. */
  async function summonSeat(h: TempHost, structured: unknown, opts: { haltAfterInference?: boolean } = {}) {
    const clock = testClock();
    const config = h.config;
    const run = recordingRunner(() => ({ code: 0, stdout: utf8(JSON.stringify({ ...successFixture, structured_output: structured })), stderr: "" }));
    const remaining = usdRemaining({ word: WORD, usd_today: await usdSpentToday(config, WORD, clock.now()), credits_month: 0 }, config.ceilings);
    const runtime = summonRuntime({ config, run, presence: PRESENT, remainingUsd: remaining, spend: hostSpendRecorder(config, clock), env: {} });
    let checks = 0;
    const lowered: HaltStatus = { halted: false, readings: [] };
    const raised: HaltStatus = { halted: true, readings: [{ source: "file", id: config.paths.halt_file, state: "raised", quiet_until: null, detail: "test", checked_at: clock.now().toISOString() }] };
    const deps: SeatDeps = {
      config,
      clock,
      signer: fakeSigner(),
      fetch: noFetch,
      runtime,
      // The first check is before inference; with haltAfterInference every later one is raised.
      checkHalt: async () => (opts.haltAfterInference && checks++ > 0 ? raised : lowered),
    };
    const citizen = await readCitizen(config, WORD);
    const s = await openSeat(config, clock, citizen, "summon", { kind: "summons", who: "yu", why: "test" }, PRESENT);
    return { result: await runSeat(s, deps), run, seat_id: s.ref.seat_id };
  }

  test("a rest, a reply discarded at HALT and a beat are each in the record; the next summons gets only what is left", async () => {
    host = await makeTempHost();
    host.config.ceilings = { ...host.config.ceilings, usd_per_citizen_per_day: "0.1" };
    await host.addCitizen(WORD, { runtime: "summon" });
    await host.seatLedger(WORD, fakeSigner().signEntry);

    const rest = await summonSeat(host, { acts: [{ type: "rest" }] });
    expect(rest.result).toMatchObject({ exit: EXIT.OK, outcome: "rest", appended: [] });
    const halted = await summonSeat(host, { acts: [{ type: "journal", kind: "reflected", text: "kept from the ledger by HALT" }] }, { haltAfterInference: true });
    expect(halted.result).toMatchObject({ exit: EXIT.OK, outcome: "halted", appended: [] });

    // Neither wrote a word in the citizen's voice, and both are in the host's own record.
    const lines = (await readSpendRecord(host.config))!;
    for (const id of [rest.seat_id, halted.seat_id]) {
      expect(lines.filter((l) => l.seat_id === id).map((l) => [l.phase, l.usd])).toEqual([
        ["begun", null],
        ["settled", "0.0421"],
      ]);
    }
    expect(await usdSpentToday(host.config, WORD, new Date("2026-11-05T12:00:00.000Z"))).toBe("0.0842");

    // The next summons is held to what is left: $0.1 - $0.0842, as the runtime's own bound.
    const beat = await summonSeat(host, { acts: [{ type: "journal", kind: "reflected", text: "a summoned beat" }] });
    expect(beat.result).toMatchObject({ exit: EXIT.OK, outcome: "beat" });
    expect(beat.run.calls[0]!.argv[beat.run.calls[0]!.argv.indexOf("--max-budget-usd") + 1]).toBe("0.0158");

    // Now past the ceiling: the next summons is refused before claude runs, and records nothing.
    const over = await summonSeat(host, { acts: [{ type: "rest" }] });
    expect(over.result).toMatchObject({ exit: EXIT.REFUSED, outcome: "refused", refusal: "ceiling-usd" });
    expect(over.run.calls).toHaveLength(0);
  });

  test("the CLI's summon runtime is held to what the spend record says is left, and writes to it", async () => {
    host = await makeTempHost();
    host.config.ceilings = { ...host.config.ceilings, usd_per_citizen_per_day: "0.1" };
    await host.addCitizen(WORD, { runtime: "summon" });
    await host.seatLedger(WORD, fakeSigner().signEntry);
    const clock = testClock();
    // A summons earlier today that rested: no ledger entry, only the host's record of its spend.
    const earlier: SeatRef = {
      format: "kingdom-seat-seat/v1",
      seat_id: "55555555-5555-4555-8555-555555555555",
      host: "test-host",
      word: WORD,
      runtime: "summon",
      invoker: { kind: "summons", who: "yu", why: "test" },
      opened_at: "2026-11-05T01:00:00.000Z",
    };
    const rec = hostSpendRecorder(host.config, clock);
    await rec.begin(earlier);
    await rec.settle(earlier, { usd: "0.0421", usd_basis: "reported", credits: 0 });

    const run = recordingRunner(() => ({ code: 0, stdout: utf8(JSON.stringify(successFixture)), stderr: "" }));
    const deps = realDeps({ run, clock, env: {} });
    const s = await openSeat(host.config, clock, await readCitizen(host.config, WORD), "summon", { kind: "summons", who: "yu", why: "test" }, PRESENT);
    const runtime = await deps.runtime(host.config, s, fakeSigner());
    await runtime({ prompt: { system: "s", user: "u" }, schema: {}, seat_ref: s.ref, deadline_ms: 60_000, signal: new AbortController().signal });
    const argv = run.calls[0]!.argv;
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("0.0579");
    expect((await readSpendRecord(host.config))!.filter((l) => l.seat_id === s.ref.seat_id).map((l) => [l.phase, l.usd])).toEqual([
      ["begun", null],
      ["settled", "0.0421"],
    ]);
  });

  test("a seat stopped mid-run leaves only its begun line, and every later summons that day is refused", async () => {
    host = await makeTempHost();
    host.config.ceilings = { ...host.config.ceilings, usd_per_citizen_per_day: "5" };
    await host.addCitizen(WORD, { runtime: "summon" });
    await host.seatLedger(WORD, fakeSigner().signEntry);
    // What the watcher's KILL leaves behind: claude began, and nothing settled it.
    await hostSpendRecorder(host.config, testClock()).begin({
      format: "kingdom-seat-seat/v1",
      seat_id: "44444444-4444-4444-8444-444444444444",
      host: "test-host",
      word: WORD,
      runtime: "summon",
      invoker: { kind: "summons", who: "yu", why: "test" },
      opened_at: "2026-11-05T02:00:00.000Z",
    });
    const next = await summonSeat(host, { acts: [{ type: "rest" }] });
    expect(next.result).toMatchObject({ exit: EXIT.REFUSED, outcome: "refused", refusal: "ceiling-usd" });
    expect(next.run.calls).toHaveLength(0);
    // A settled line arriving later for that seat gives the day back its known spend.
    await appendFile(
      host.config.paths.spend_log,
      `${JSON.stringify(line({ seat_id: "44444444-4444-4444-8444-444444444444", ts: "2026-11-05T02:10:00.000Z", usd: "1" }))}\n`,
    );
    expect(await usdSpentToday(host.config, WORD, new Date("2026-11-05T12:00:00.000Z"))).toBe("1");
  });
});
