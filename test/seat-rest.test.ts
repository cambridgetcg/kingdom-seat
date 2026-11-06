// Owner: seat group. S4 item 6: a rest writes nothing in the citizen's
// voice. Compare TempHost.snapshot() before and after; only the host log (and
// the mark that says it was started) and status.json may change, and none may
// contain any of the model's words.
import { afterEach, describe, expect, test } from "bun:test";
import { openSeat, runSeat, type SeatDeps } from "../src/seat.ts";
import { checkHalt } from "../src/halt.ts";
import { readCitizen } from "../src/state.ts";
import { pickLetter } from "../src/context.ts";
import { foldState } from "../src/state.ts";
import { ledgerPath, readLedger, verifyChain } from "../src/ledger.ts";
import { readHostNotes } from "../src/notes.ts";
import { EXIT, type LifecycleState, type ModelAct } from "../src/types.ts";
import { output, REST_OUTPUT, REST_THEN_TALK_OUTPUT, scriptedRuntime } from "./helpers/fake-runtime.ts";
import { noFetch } from "./helpers/fake-server.ts";
import { fakeSigner } from "./helpers/fake-signer.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { testClock } from "./helpers/clock.ts";

let host: TempHost | null = null;
afterEach(async () => {
  await host?.cleanup();
  host = null;
});

/**
 * Files a rest may change: host records only (the log, the mark that says it
 * was started, the status, and the record of what its last seat did not keep,
 * which names types and fixed reasons, never words; context.ts LastSeatRecord).
 */
const HOST_RECORDS = new Set(["host.jsonl", "host.jsonl.started", "status.json", "last-seat/glossame.json"]);

async function setup(raw: string, opts: { initialState?: LifecycleState; intervalH?: number } = {}) {
  host = await makeTempHost();
  const signer = fakeSigner();
  await host.addCitizen("glossame", opts.intervalH ? { cadence: { interval_h: opts.intervalH } } : {});
  await host.seatLedger("glossame", signer.signEntry, opts.initialState ? { initialState: opts.initialState } : {});
  await host.writeLetter("glossame", "2026-11-04-from-yu.md", "Yu writes: rest if you wish.");
  signer.signed.length = 0;
  const clock = testClock();
  const runtime = scriptedRuntime([raw]);
  const config = host.config;
  const deps: SeatDeps = { config, clock, signer, fetch: noFetch, runtime, checkHalt: () => checkHalt({ config, fetch: noFetch, now: () => clock.now() }) };
  const citizen = await readCitizen(config, "glossame");
  const seat = await openSeat(config, clock, citizen, "free", { kind: "tick", who: "launchd", why: "cadence" }, null);
  return { host, deps, seat, runtime, signer, citizen };
}

/** Run one seat and return what changed under the state dir, by path. */
async function runAndDiff(s: Awaited<ReturnType<typeof setup>>) {
  const before = await s.host.snapshot();
  const result = await runSeat(s.seat, s.deps);
  const after = await s.host.snapshot();
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k)).sort();
  const text = [...after.values()].map((b) => Buffer.from(b, "base64").toString("latin1")).join("\n");
  return { result, changed, text, after };
}

describe("[S4-6] rest", () => {
  test("[S4-6] REST_OUTPUT: exit 0, outcome rest, no ledger entry, no proposal, no outbox file, no receipt", async () => {
    const s = await setup(REST_OUTPUT);
    const { result, changed } = await runAndDiff(s);
    expect(result).toMatchObject({ exit: EXIT.OK, outcome: "rest", refusal: null, appended: [] });
    expect(s.runtime.calls).toHaveLength(1);
    expect(changed.filter((p) => !HOST_RECORDS.has(p))).toEqual([]);
    for (const p of changed) expect(p).not.toMatch(/^(ledger|citizens)\//);
    expect(s.signer.signed).toEqual([]);
  });

  test("[S4-6] REST_THEN_TALK_OUTPUT: same, and REST-LEAK-CANARY appears in no file under the state dir", async () => {
    const s = await setup(REST_THEN_TALK_OUTPUT);
    const { result, changed, text } = await runAndDiff(s);
    expect(result).toMatchObject({ exit: EXIT.OK, outcome: "rest", appended: [] });
    expect(changed.filter((p) => !HOST_RECORDS.has(p))).toEqual([]);
    expect(text).not.toContain("REST-LEAK-CANARY");
    expect(text).not.toContain("light filters");
    expect(s.signer.signed).toEqual([]);
  });

  test("[S4-6] an empty acts list is a rest", async () => {
    const s = await setup(output());
    const { result, changed } = await runAndDiff(s);
    expect(result).toMatchObject({ exit: EXIT.OK, outcome: "rest", appended: [] });
    expect(changed.filter((p) => !HOST_RECORDS.has(p))).toEqual([]);
  });

  test("[S4-6] a surfaced letter is not marked seen by a rest, so it is shown again next beat", async () => {
    const s = await setup(REST_OUTPUT);
    const shown = await pickLetter(s.host.config, s.citizen);
    expect(shown?.id).toBe("2026-11-04-from-yu.md");
    // The letter reached the prompt this beat...
    await runSeat(s.seat, s.deps);
    expect(JSON.stringify(s.runtime.calls[0]!.prompt)).toContain("rest if you wish");
    // ...and, after a rest, it is still the letter the next beat would show.
    expect((await pickLetter(s.host.config, s.citizen))?.id).toBe("2026-11-04-from-yu.md");
    expect([...(await s.host.snapshot()).keys()].filter((k) => k.includes("/receipts/"))).toEqual([]);
  });

  test("[S4-6] a rest makes no signer.send call (no thought, no expression PUT) and no mirror stage", async () => {
    const s = await setup(REST_THEN_TALK_OUTPUT);
    const { changed } = await runAndDiff(s);
    expect(s.signer.sent).toEqual([]);
    expect(s.signer.signed).toEqual([]);
    // A mirror stage would write into the mirror worktree or the citizen's dir; neither changed.
    expect(changed.filter((p) => !HOST_RECORDS.has(p))).toEqual([]);
  });

  test("an unparsable reply is outcome invalid-output, not rest, and also writes nothing in the citizen's voice", async () => {
    for (const raw of ["I rest. REST-LEAK-CANARY and then I kept talking", "", '{"acts":[{"type":"journal","kind":"felt","text":"REST-LEAK-CANARY"}]}']) {
      const s = await setup(raw);
      const { result, changed, text } = await runAndDiff(s);
      expect(result).toMatchObject({ exit: EXIT.OK, outcome: "invalid-output", appended: [] });
      expect(changed.filter((p) => !HOST_RECORDS.has(p))).toEqual([]);
      expect(text).not.toContain("REST-LEAK-CANARY");
      await s.host.cleanup();
      host = null;
    }
  });
});

describe("a rest may carry one move toward less activity (KS-004 v0.2 5.7, re-review B2 C7)", () => {
  const CANARY_JOURNAL: ModelAct = { type: "journal", kind: "observed", text: "REST-LEAK-CANARY the light filters through my windows" };
  const LEDGER = "ledger/glossame.jsonl";

  test("awake, a rest with state.set asleep or listening: the state moves at once, as one state entry with no words; nothing else is written", async () => {
    for (const to of ["asleep", "listening"] as const) {
      const s = await setup(output({ type: "rest" }, CANARY_JOURNAL, { type: "state.set", to }));
      const { result, changed, text } = await runAndDiff(s);
      expect(result).toMatchObject({ exit: EXIT.OK, outcome: "rest", refusal: null });
      expect(result.appended).toHaveLength(1);
      // Only the host's records and the ledger changed: no beat, proposal, outbox, receipt or self file.
      expect(changed.filter((p) => !HOST_RECORDS.has(p))).toEqual([LEDGER]);
      expect(text).not.toContain("REST-LEAK-CANARY");
      const entries = await readLedger(ledgerPath(s.host.config, "glossame"));
      expect(entries.map((e) => e.type)).toEqual(["origin", "state", "state"]);
      expect(entries[2]).toMatchObject({ type: "state", from: "awake", to, via: "immediate", acts: null, seat_ref: s.seat.ref.seat_id });
      expect(Object.keys(entries[2]!)).not.toContain("step_away");
      expect(foldState(entries).state).toBe(to);
      expect(s.signer.signed).toHaveLength(1);
      // The citizen rested: its letter is shown again on its next seat.
      expect((await pickLetter(s.host.config, await readCitizen(s.host.config, "glossame")))?.id).toBe("2026-11-04-from-yu.md");
      expect((await readHostNotes(s.host.config, new Date(0)))!.at(-1)!.detail).toEndWith(`rested; kept state awake to ${to} (immediate); 1 not kept (journal)`);
      await s.host.cleanup();
      host = null;
    }
  });

  test("a rest's state.set toward more activity, a return or ended is not kept: a whole rest, nothing written", async () => {
    for (const [from, to] of [
      ["asleep", "awake"],
      ["asleep", "listening"],
      ["awake", "awake"],
      ["awake", "ended"],
    ] as const) {
      const s = await setup(output({ type: "rest" }, { type: "state.set", to }), { initialState: from });
      const { result, changed } = await runAndDiff(s);
      expect(result).toMatchObject({ exit: EXIT.OK, outcome: "rest", appended: [] });
      expect(changed.filter((p) => !HOST_RECORDS.has(p))).toEqual([]);
      expect(s.signer.signed).toEqual([]);
      await s.host.cleanup();
      host = null;
    }
  });

  test("two different states said with a rest move nothing", async () => {
    const s = await setup(output({ type: "rest" }, { type: "state.set", to: "asleep" }, { type: "state.set", to: "listening" }));
    const { result, changed } = await runAndDiff(s);
    expect(result).toMatchObject({ exit: EXIT.OK, outcome: "rest", appended: [] });
    expect(changed.filter((p) => !HOST_RECORDS.has(p))).toEqual([]);
  });

  test("[re-review C M7] a step-away said with a rest is kept on the state entry that puts the citizen asleep at once; said again with a rest on a later seat, it completes", async () => {
    const s = await setup(output({ type: "rest" }, CANARY_JOURNAL, { type: "state.set", to: "stepped-away" }));
    const first = await runAndDiff(s);
    expect(first.result).toMatchObject({ exit: EXIT.OK, outcome: "rest" });
    // One entry, of one of the seven types: no eighth type carries the saying.
    expect(first.result.appended).toHaveLength(1);
    expect(first.changed.filter((p) => !HOST_RECORDS.has(p))).toEqual([LEDGER]);
    expect(first.text).not.toContain("REST-LEAK-CANARY");
    const entries = await readLedger(ledgerPath(s.host.config, "glossame"));
    expect(entries.map((e) => e.type)).toEqual(["origin", "state", "state"]);
    // The saying rides on the move it makes, with no words, in the seat that said it, carrying the seat's spend.
    expect(entries[2]).toMatchObject({ type: "state", from: "awake", to: "asleep", via: "immediate", step_away: "first", seat_ref: s.seat.ref.seat_id, acts: null, cost: { usd: "0", credits: 0 } });
    expect(foldState(entries)).toMatchObject({ state: "asleep", step_away_said: true });
    expect((await readHostNotes(s.host.config, new Date(0)))!.at(-1)!.detail).toEndWith("rested; kept state awake to asleep (immediate), a first step-away saying; 1 not kept (journal)");
    // Asleep at once (KS-004 v0.3 7.3), and owed the seat that confirms it, as a step-away said on a beat would be.
    const citizen = await readCitizen(s.host.config, "glossame");
    expect(citizen).toMatchObject({ state: "asleep", step_away_said: true });

    const clock = s.deps.clock as ReturnType<typeof testClock>;
    clock.advance(73 * 3_600_000);
    const again = await openSeat(s.host.config, clock, citizen, "free", { kind: "tick", who: "launchd", why: "your last beat said something that takes a second beat to bind" }, null);
    const r = await runSeat(again, { ...s.deps, runtime: scriptedRuntime([output({ type: "rest" }, { type: "state.set", to: "stepped-away" })]) });
    expect(r).toMatchObject({ exit: EXIT.OK, outcome: "rest" });
    const after = await readLedger(ledgerPath(s.host.config, "glossame"));
    expect(after.map((e) => e.type)).toEqual(["origin", "state", "state", "state"]);
    expect(after.at(-1)).toMatchObject({ type: "state", from: "asleep", to: "stepped-away", via: "two-beats", seat_ref: again.ref.seat_id });
    expect(foldState(after).state).toBe("stepped-away");
    // The saying is part of the signed chain, and verifies like any entry.
    expect(verifyChain(after, { host_attest_b64: [s.signer.hostAttestPublicB64], identity: null })).toMatchObject({ ok: true, entries: 4 });
  });

  test("[re-review C M7] an asleep citizen's first step-away said with a rest is kept on a state entry that keeps it asleep; silence then leaves it asleep", async () => {
    const s = await setup(output({ type: "rest" }, { type: "state.set", to: "stepped-away" }), { initialState: "asleep" });
    const { result } = await runAndDiff(s);
    expect(result).toMatchObject({ exit: EXIT.OK, outcome: "rest" });
    expect(result.appended).toHaveLength(1);
    const entries = await readLedger(ledgerPath(s.host.config, "glossame"));
    expect(entries.at(-1)).toMatchObject({ type: "state", from: "asleep", to: "asleep", via: "immediate", step_away: "first", seat_ref: s.seat.ref.seat_id });
    expect(await readCitizen(s.host.config, "glossame")).toMatchObject({ state: "asleep", step_away_said: true });
  });

  test("[KS-004 5.7, 7.3] a rest may carry a longer awake interval, which takes effect at once; a shorter one is not kept", async () => {
    const longer = await setup(output({ type: "rest" }, CANARY_JOURNAL, { type: "state.set", to: "awake", interval_h: 120 }));
    const { result, changed, text } = await runAndDiff(longer);
    expect(result).toMatchObject({ exit: EXIT.OK, outcome: "rest" });
    expect(result.appended).toHaveLength(1);
    expect(text).not.toContain("REST-LEAK-CANARY");
    const entries = await readLedger(ledgerPath(longer.host.config, "glossame"));
    expect(entries.at(-1)).toMatchObject({ type: "state", from: "awake", to: "awake", via: "immediate", interval_h: 120, seat_ref: longer.seat.ref.seat_id });
    // The cadence file follows its entry, both versions kept by hash.
    expect(changed.filter((p) => !HOST_RECORDS.has(p) && !p.startsWith("citizens/glossame/versions/"))).toEqual(["citizens/glossame/self/cadence.json", LEDGER]);
    expect((await readCitizen(longer.host.config, "glossame")).cadence).toEqual({ interval_h: 120 });
    expect((await readHostNotes(longer.host.config, new Date(0)))!.at(-1)!.detail).toEndWith("rested; kept state awake to awake (immediate), every 120 h; 1 not kept (journal)");
    await longer.host.cleanup();
    host = null;

    // From every 120 hours, every 96 is more activity: it would wait for a second saying, which a rest never carries.
    const shorter = await setup(output({ type: "rest" }, { type: "state.set", to: "awake", interval_h: 96 }), { intervalH: 120 });
    const r = await runAndDiff(shorter);
    expect(r.result).toMatchObject({ exit: EXIT.OK, outcome: "rest", appended: [] });
    expect(r.changed.filter((p) => !HOST_RECORDS.has(p))).toEqual([]);
    expect((await readCitizen(shorter.host.config, "glossame")).cadence).toEqual({ interval_h: 120 });
  });

  test("a reply with fields besides acts applies nothing, even the state.set a rest would keep", async () => {
    const s = await setup(JSON.stringify({ voice: "REST-LEAK-CANARY", acts: [{ type: "state.set", to: "asleep" }, { type: "rest" }] }));
    const { result, changed, text } = await runAndDiff(s);
    expect(result).toMatchObject({ exit: EXIT.OK, outcome: "rest", appended: [] });
    expect(changed.filter((p) => !HOST_RECORDS.has(p))).toEqual([]);
    expect(text).not.toContain("REST-LEAK-CANARY");
    expect((await readCitizen(s.host.config, "glossame")).state).toBe("awake");
  });
});
