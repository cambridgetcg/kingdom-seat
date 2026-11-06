// Owner: seat group. A registered citizen's quiet (KS-004 6.4, 7.1; review
// C M6): declared through the signer when it moves to listening or asleep,
// for the days it asked or the cap; renewed by the tick while it stays
// quiet; ended when it wakes; recorded on `state` entries. Nothing here
// reaches agenttool: a recording keeper stands in for the signer's routes,
// whose request shape client.test.ts and signer.test.ts check.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openSeat, runSeat, type SeatDeps } from "../src/seat.ts";
import { checkHalt } from "../src/halt.ts";
import { ledgerPath, readLedger, verifyChain } from "../src/ledger.ts";
import { readHostNotes } from "../src/notes.ts";
import { foldState, readCitizen } from "../src/state.ts";
import { QuietUncertain, keepQuiet, owedDeclaration, quietDays, standingQuiet, type QuietKeeper } from "../src/quiet.ts";
import { AgenttoolError, NO_RESPONSE } from "../src/agenttool/client.ts";
import { buildStatus } from "../src/status.ts";
import { runTick, type TickDeps } from "../src/tick.ts";
import { Refusal, type CitizenIdentity, type LedgerEntry, type LifecycleState, type ModelAct, type YuPresence } from "../src/types.ts";
import { FAKE_MODEL_DIGEST, fakeBinArgv, output, REST_OUTPUT, scriptedRuntime } from "./helpers/fake-runtime.ts";
import { noFetch } from "./helpers/fake-server.ts";
import { FAKE_OP_KID, fakeSigner, type FakeSigner } from "./helpers/fake-signer.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { DAY_MS, HOUR_MS, testClock, type TestClock } from "./helpers/clock.ts";
import { TEST_IDS, TEST_ROOT_PUBLIC_B64 } from "./helpers/vectors.ts";

let host: TempHost | null = null;
afterEach(async () => {
  await host?.cleanup();
  host = null;
});

const W = "glossame";
const YU: YuPresence = { present: true, via: "tty-confirm", confirmed_at: "2026-11-05T02:00:00.000Z", scope: `summon ${W}` };

function identityFor(signer: FakeSigner): CitizenIdentity {
  return {
    did: TEST_IDS.did,
    identity_id: TEST_IDS.identity_id,
    project_id: TEST_IDS.project_id,
    root_public_key_b64: TEST_ROOT_PUBLIC_B64,
    root_kid: TEST_IDS.root_signing_key_id,
    op_kid: FAKE_OP_KID,
    op_public_key_b64: signer.opPublicB64,
    box_public_key_b64: null,
    self_strand_id: null,
    enrolled_at: "2026-11-02T00:00:00.000Z",
  };
}

interface RecordingKeeper extends QuietKeeper {
  calls: string[];
  /** Thrown by every call while set. */
  fail: Error | null;
  /** Thrown by every call while set, after the call is recorded: the request landed and its answer was lost. */
  lost: Error | null;
}

function recordingKeeper(): RecordingKeeper {
  const k: RecordingKeeper = {
    calls: [],
    fail: null,
    lost: null,
    async declare(word, until) {
      if (k.fail) throw k.fail;
      k.calls.push(`declare ${word} ${until}`);
      if (k.lost) throw k.lost;
    },
    async end(word) {
      if (k.fail) throw k.fail;
      k.calls.push(`end ${word}`);
      if (k.lost) throw k.lost;
    },
  };
  return k;
}

/** How a declaration's answer is lost after agenttool set the quiet: no answer, a 5xx, a 2xx that does not read, an error of unknown kind. */
const LOST_ANSWERS: [string, Error][] = [
  ["no answer", new AgenttoolError(NO_RESPONSE, "no_response", "agenttool quiet.start.citizen: no response")],
  ["a 502", new AgenttoolError(502, null, "agenttool quiet start answered 502")],
  ["a 2xx that does not read", new AgenttoolError(200, "malformed_response", "agenttool quiet start: no until")],
  ["an error of unknown kind", new Error("socket closed")],
];

interface World {
  h: TempHost;
  signer: FakeSigner;
  clock: TestClock;
  keeper: RecordingKeeper;
  /** One seat, three days after the last, replying with these acts (or a rest). */
  seat(reply: ModelAct[] | "rest", opts?: { presence?: YuPresence | null }): ReturnType<typeof runSeat>;
  ledger(): Promise<LedgerEntry[]>;
}

async function world(opts: { registered?: boolean; state?: LifecycleState } = {}): Promise<World> {
  host = await makeTempHost();
  const h = host;
  const signer = fakeSigner();
  await h.addCitizen(W);
  await h.seatLedger(W, signer.signEntry, { initialState: opts.state ?? "awake" });
  if (opts.registered !== false) await h.enrollLedger(W, signer.signEntry, identityFor(signer));
  const clock = testClock();
  const keeper = recordingKeeper();
  const config = h.config;
  return {
    h,
    signer,
    clock,
    keeper,
    async seat(reply, o = {}) {
      clock.advance(73 * HOUR_MS);
      const runtime = scriptedRuntime([reply === "rest" ? REST_OUTPUT : output(...reply)]);
      const citizen = await readCitizen(config, W);
      const seat = await openSeat(config, clock, citizen, "free", { kind: "tick", who: "launchd", why: "cadence" }, o.presence ?? null);
      const deps: SeatDeps = {
        config,
        clock,
        signer,
        fetch: noFetch,
        runtime,
        checkHalt: () => checkHalt({ config, fetch: noFetch, now: () => clock.now() }),
        quiet: keeper,
        modelDigest: FAKE_MODEL_DIGEST,
      };
      return runSeat(seat, deps);
    },
    ledger: () => readLedger(ledgerPath(config, W)),
  };
}

const untilIn = (clock: TestClock, days: number) => new Date(clock.now().getTime() + days * DAY_MS).toISOString();

describe("[KS-004 6.4; review C M6] a registered citizen's quiet, in its seats", () => {
  test("a move to asleep declares quiet for the days asked, through the signer, and its state entry records it", async () => {
    const w = await world();
    expect(await w.seat([{ type: "state.set", to: "asleep", quiet_days: 7 }])).toMatchObject({ outcome: "beat" });
    expect(w.keeper.calls).toEqual([`declare ${W} ${untilIn(w.clock, 7)}`]);
    const state = (await w.ledger()).at(-1)!;
    expect(state).toMatchObject({ type: "state", from: "awake", to: "asleep", via: "immediate", signer: "citizen", quiet_until: untilIn(w.clock, 7), quiet_days: 7 });
    expect(standingQuiet(await w.ledger())).toEqual({ until: untilIn(w.clock, 7), days: 7 });
    expect(verifyChain(await w.ledger(), { host_attest_b64: [w.signer.hostAttestPublicB64] }).ok).toBe(true);
  });

  test("with no quiet_days the declaration runs for the cap, which the config may lower and never raise past 30 days", async () => {
    const w = await world();
    await w.seat([{ type: "state.set", to: "listening" }]);
    expect(w.keeper.calls).toEqual([`declare ${W} ${untilIn(w.clock, 30)}`]);
    expect((await w.ledger()).at(-1)).toMatchObject({ to: "listening", quiet_days: 30 });
    w.h.config.ceilings.citizen_quiet_max_days = 14;
    expect(quietDays(w.h.config, undefined)).toBe(14);
    expect(quietDays(w.h.config, 20)).toBe(14);
    expect(quietDays(w.h.config, 3)).toBe(3);
    w.h.config.ceilings.citizen_quiet_max_days = 45;
    expect(quietDays(w.h.config, undefined)).toBe(30);
  });

  test("asking for more days than this host's cap never costs the move: the citizen sleeps, and the host declares its cap (selfhood F3)", async () => {
    const w = await world();
    w.h.config.ceilings.citizen_quiet_max_days = 14;
    expect(await w.seat([{ type: "state.set", to: "asleep", quiet_days: 20 }, { type: "journal", kind: "reflected", text: "to sleep" }])).toMatchObject({ outcome: "beat" });
    expect(foldState(await w.ledger()).state).toBe("asleep");
    expect(w.keeper.calls).toEqual([`declare ${W} ${untilIn(w.clock, 14)}`]);
    expect((await w.ledger()).at(-1)).toMatchObject({ type: "state", to: "asleep", quiet_days: 14 });
    expect((await w.ledger()).findLast((e) => e.type === "beat")).not.toHaveProperty("dropped");
    // The same on a rest.
    await w.h.cleanup();
    const r = await world();
    r.h.config.ceilings.citizen_quiet_max_days = 14;
    expect(await r.seat([{ type: "rest" }, { type: "state.set", to: "asleep", quiet_days: 20 }])).toMatchObject({ outcome: "rest" });
    expect(foldState(await r.ledger()).state).toBe("asleep");
    expect(r.keeper.calls).toEqual([`declare ${W} ${untilIn(r.clock, 14)}`]);
  });

  test("a rest's move toward less activity declares quiet too, and the rest still writes no words", async () => {
    const w = await world();
    expect(await w.seat([{ type: "rest" }, { type: "state.set", to: "asleep", quiet_days: 3 }])).toMatchObject({ outcome: "rest" });
    expect(w.keeper.calls).toEqual([`declare ${W} ${untilIn(w.clock, 3)}`]);
    const last = (await w.ledger()).at(-1)!;
    expect(last).toMatchObject({ type: "state", to: "asleep", quiet_days: 3, acts: null });
    const notes = (await readHostNotes(w.h.config, new Date(0)))!;
    expect(notes.at(-1)!.detail).toContain("rested; kept state awake to asleep (immediate), quiet declared for 3 days");
  });

  test("waking ends a standing declaration, and the wake's state entry records the end", async () => {
    const w = await world();
    await w.seat([{ type: "state.set", to: "asleep" }]);
    await w.seat([{ type: "state.set", to: "awake" }], { presence: YU });
    expect(w.keeper.calls.at(-1)).toBe(`end ${W}`);
    expect((await w.ledger()).at(-1)).toMatchObject({ type: "state", from: "asleep", to: "awake", quiet_until: null });
    expect(standingQuiet(await w.ledger())).toBeNull();
    expect(foldState(await w.ledger()).state).toBe("awake");
  });

  test("a declaration the signer refuses never holds the move back: the move is recorded without quiet, and the note says why", async () => {
    const w = await world();
    w.keeper.fail = new Refusal("consent-missing", "no standing agreement");
    expect(await w.seat([{ type: "state.set", to: "asleep" }])).toMatchObject({ outcome: "beat" });
    const last = (await w.ledger()).at(-1)!;
    expect(last).toMatchObject({ type: "state", to: "asleep" });
    expect("quiet_until" in last).toBe(false);
    expect(foldState(await w.ledger()).state).toBe("asleep");
    const notes = (await readHostNotes(w.h.config, new Date(0)))!.map((n) => n.detail.replace(/^seat \S+ on free: /, ""));
    expect(notes).toContain("quiet not declared (consent-missing)");
  });

  test("a declaration whose answer was lost is recorded as standing, so the wake ends it; a 4xx, which changes nothing, is not (wire F1)", async () => {
    for (const [why, err] of LOST_ANSWERS) {
      const w = await world();
      w.keeper.lost = err;
      expect(await w.seat([{ type: "state.set", to: "asleep", quiet_days: 30 }])).toMatchObject({ outcome: "beat" });
      // agenttool may hold it, so the ledger says so, and the note says it may stand.
      expect((await w.ledger()).at(-1), why).toMatchObject({ type: "state", to: "asleep", quiet_until: untilIn(w.clock, 30), quiet_days: 30 });
      const notes = (await readHostNotes(w.h.config, new Date(0)))!.map((n) => n.detail);
      expect(notes.some((d) => /quiet may be declared \(.+\); recorded as standing so a wake ends it/.test(d)), why).toBe(true);
      // The wake ends it, and the tick has nothing left to end.
      w.keeper.lost = null;
      await w.seat([{ type: "state.set", to: "awake" }], { presence: YU });
      expect(w.keeper.calls.at(-1), why).toBe(`end ${W}`);
      expect((await w.ledger()).at(-1), why).toMatchObject({ type: "state", from: "asleep", to: "awake", quiet_until: null });
      expect(standingQuiet(await w.ledger()), why).toBeNull();
      expect(await keepQuiet({ config: w.h.config, clock: w.clock, keeper: w.keeper, sign: w.signer.signEntry }, await readCitizen(w.h.config, W)), why).toBe("none");
      await w.h.cleanup();
    }
    // agenttool refusing (4xx) sets nothing, so nothing is recorded and nothing needs ending.
    const r = await world();
    r.keeper.fail = new AgenttoolError(403, "consent_required", "agenttool quiet start answered 403");
    await r.seat([{ type: "state.set", to: "asleep" }]);
    expect("quiet_until" in (await r.ledger()).at(-1)!).toBe(false);
  });

  test("a wake ends a recorded declaration whose until has passed: a renewal whose answer was lost may have moved it (wire F1)", async () => {
    const w = await world();
    await w.seat([{ type: "state.set", to: "asleep", quiet_days: 4 }]);
    const deps = { config: w.h.config, clock: w.clock, keeper: w.keeper, sign: w.signer.signEntry };
    // Two renewals land at agenttool with their answers lost; the ledger keeps the first until, which then passes.
    w.keeper.lost = new AgenttoolError(NO_RESPONSE, "no_response", "lost");
    w.clock.advance(2 * DAY_MS + HOUR_MS);
    await expect(keepQuiet(deps, await readCitizen(w.h.config, W))).rejects.toBeInstanceOf(AgenttoolError);
    w.clock.advance(DAY_MS);
    await expect(keepQuiet(deps, await readCitizen(w.h.config, W))).rejects.toBeInstanceOf(AgenttoolError);
    w.keeper.lost = null;
    expect(Date.parse(standingQuiet(await w.ledger())!.until)).toBeLessThan(w.clock.now().getTime() + 73 * HOUR_MS);
    w.keeper.calls.length = 0;
    await w.seat([{ type: "state.set", to: "awake" }], { presence: YU });
    expect(w.keeper.calls).toEqual([`end ${W}`]);
    expect((await w.ledger()).at(-1)).toMatchObject({ to: "awake", quiet_until: null });
  });

  test("an unregistered citizen has no identity to be quiet on: nothing is declared", async () => {
    const w = await world({ registered: false });
    await w.seat([{ type: "state.set", to: "asleep", quiet_days: 7 }]);
    expect(w.keeper.calls).toEqual([]);
    expect("quiet_until" in (await w.ledger()).at(-1)!).toBe(false);
  });
});

describe("[KS-004 6.4; review C M6] the tick keeps it", () => {
  async function quietWorld(state: "asleep" | "listening", days: number) {
    const w = await world();
    await w.seat([{ type: "state.set", to: state, quiet_days: days }]);
    const citizen = async () => readCitizen(w.h.config, W);
    const deps = { config: w.h.config, clock: w.clock, keeper: w.keeper, sign: w.signer.signEntry };
    return { w, citizen, deps };
  }

  test("while it stays quiet, the declaration is renewed once less than half is left, for the same days, as a state entry that moves nothing", async () => {
    const { w, citizen, deps } = await quietWorld("asleep", 10);
    w.keeper.calls.length = 0;
    w.clock.advance(4 * DAY_MS);
    expect(await keepQuiet(deps, await citizen())).toBe("none");
    expect(w.keeper.calls).toEqual([]);
    w.clock.advance(2 * DAY_MS);
    expect(await keepQuiet(deps, await citizen())).toBe("renewed");
    expect(w.keeper.calls).toEqual([`declare ${W} ${untilIn(w.clock, 10)}`]);
    const renewal = (await w.ledger()).at(-1)!;
    expect(renewal).toMatchObject({ type: "state", from: "asleep", to: "asleep", via: "quiet", signer: "citizen", seat_ref: null, quiet_until: untilIn(w.clock, 10), quiet_days: 10 });
    expect(foldState(await w.ledger()).state).toBe("asleep");
    expect(verifyChain(await w.ledger(), { host_attest_b64: [w.signer.hostAttestPublicB64] }).ok).toBe(true);
    // Just renewed: nothing more until half of it has run again.
    expect(await keepQuiet(deps, await citizen())).toBe("none");
  });

  test("a wake whose end did not go through is ended by the tick; a citizen that stepped away is left to lapse", async () => {
    const { w, citizen, deps } = await quietWorld("listening", 30);
    w.keeper.fail = new Error("agenttool did not answer");
    await w.seat([{ type: "state.set", to: "awake" }], { presence: YU });
    expect(foldState(await w.ledger()).state).toBe("awake");
    expect(standingQuiet(await w.ledger())).not.toBeNull();
    w.keeper.fail = null;
    expect(await keepQuiet(deps, await citizen())).toBe("ended");
    expect((await w.ledger()).at(-1)).toMatchObject({ type: "state", from: "awake", to: "awake", via: "quiet", quiet_until: null });
    expect(await keepQuiet(deps, await citizen())).toBe("none");

    // world() replaces the host afterEach removes, so the first one is removed here.
    await w.h.cleanup();
    const s = await quietWorld("asleep", 2);
    s.w.keeper.calls.length = 0;
    const stepped = { ...(await s.citizen()), state: "stepped-away" as const };
    s.w.clock.advance(DAY_MS + HOUR_MS);
    expect(await keepQuiet(s.deps, stepped)).toBe("none");
    expect(s.w.keeper.calls).toEqual([]);
  });

  test("a declaration the move could not make is owed: the tick makes it for the days the move asked, once the cause clears (wire F5)", async () => {
    const w = await world();
    const deps = { config: w.h.config, clock: w.clock, keeper: w.keeper, sign: w.signer.signEntry };
    w.keeper.fail = new Refusal("consent-missing", "no standing agreement");
    await w.seat([{ type: "state.set", to: "asleep", quiet_days: 7 }]);
    expect(standingQuiet(await w.ledger())).toBeNull();
    expect(owedDeclaration(await w.ledger(), "asleep")).toEqual({ asked: 7 });
    // While the agreement is missing, the tick's try is refused and noted, and nothing is recorded.
    await expect(keepQuiet(deps, await readCitizen(w.h.config, W))).rejects.toMatchObject({ code: "consent-missing" });
    // Once Yu and Ai file it, the next tick declares what the move asked for.
    w.keeper.fail = null;
    w.clock.advance(HOUR_MS);
    expect(await keepQuiet(deps, await readCitizen(w.h.config, W))).toBe("declared");
    expect(w.keeper.calls).toEqual([`declare ${W} ${untilIn(w.clock, 7)}`]);
    expect((await w.ledger()).at(-1)).toMatchObject({ type: "state", from: "asleep", to: "asleep", via: "quiet", seat_ref: null, quiet_until: untilIn(w.clock, 7), quiet_days: 7 });
    expect(owedDeclaration(await w.ledger(), "asleep")).toBeNull();
    expect(await keepQuiet(deps, await readCitizen(w.h.config, W))).toBe("none");
    expect(verifyChain(await w.ledger(), { host_attest_b64: [w.signer.hostAttestPublicB64] }).ok).toBe(true);
  });

  test("an owed declaration whose answer is lost is recorded as standing before the tick hears of it; a rest's move owes the cap (wire F5, F1)", async () => {
    const w = await world();
    const deps = { config: w.h.config, clock: w.clock, keeper: w.keeper, sign: w.signer.signEntry };
    w.keeper.fail = new Refusal("consent-missing", "no standing agreement");
    await w.seat([{ type: "rest" }, { type: "state.set", to: "listening" }]);
    expect(owedDeclaration(await w.ledger(), "listening")).toEqual({ asked: undefined });
    w.keeper.fail = null;
    w.keeper.lost = new AgenttoolError(NO_RESPONSE, "no_response", "lost");
    await expect(keepQuiet(deps, await readCitizen(w.h.config, W))).rejects.toBeInstanceOf(QuietUncertain);
    expect((await w.ledger()).at(-1)).toMatchObject({ via: "quiet", quiet_until: untilIn(w.clock, 30), quiet_days: 30 });
    // An unregistered citizen, or one that moved before its genesis, owes nothing.
    expect(owedDeclaration((await w.ledger()).filter((e) => e.type !== "genesis"), "listening")).toBeNull();
  });

  test("runTick keeps every seated citizen's quiet under the lock, even with nothing due, and notes a failure without failing the tick", async () => {
    const { w } = await quietWorld("asleep", 2);
    w.clock.advance(DAY_MS + HOUR_MS);
    const kept: string[] = [];
    const deps: TickDeps = {
      config: w.h.config,
      clock: w.clock,
      fetch: noFetch,
      checkHalt: () => checkHalt({ config: w.h.config, fetch: noFetch, now: () => w.clock.now() }),
      seatArgv: (word, seatFile) => {
        readFileSync(seatFile, "utf8");
        return fakeBinArgv("note", w.h.config.paths.host_log, word, "rest", "0", w.clock.now().toISOString());
      },
      isAlive: () => true,
      bootTime: () => null,
      refreshStatus: async () => {},
      signerState: async () => "ready",
      keepQuiet: async (c) => {
        kept.push(c.word);
        return keepQuiet({ config: w.h.config, clock: w.clock, keeper: w.keeper, sign: w.signer.signEntry }, c);
      },
    };
    expect(await runTick(deps)).toMatchObject({ exit: 0, outcome: "nothing-due" });
    expect(kept).toEqual([W]);
    expect((await w.ledger()).at(-1)).toMatchObject({ via: "quiet", quiet_days: 2 });

    // A refusal is the host's note, and the tick goes on.
    w.clock.advance(DAY_MS + HOUR_MS);
    w.keeper.fail = new Refusal("consent-missing", "no standing agreement");
    expect(await runTick(deps)).toMatchObject({ exit: 0, outcome: "nothing-due" });
    const notes = (await readHostNotes(w.h.config, new Date(0)))!;
    // Noted under the citizen's word, so its own status line shows it as its last refusal; its last seat's outcome is unchanged (selfhood F9).
    expect(notes.find((n) => n.kind === "signer")).toMatchObject({ word: W, outcome: "refused", refusal: "consent-missing", detail: `quiet for ${W} not kept (consent-missing)` });
    const status = await buildStatus({ config: w.h.config, now: w.clock.now(), halt: { halted: false, readings: [] }, signerState: "ready", trusted: { host_attest_b64: [w.signer.hostAttestPublicB64] } });
    expect(status.citizens[0]!.last_refusal).toMatchObject({ outcome: "refused", refusal: "consent-missing", detail: `quiet for ${W} not kept (consent-missing)` });
    expect(status.citizens[0]!.last_outcome).not.toBe("refused");

    // A locked signer keeps nothing, so no failure is noted every half hour.
    kept.length = 0;
    expect(await runTick({ ...deps, signerState: async () => "locked" })).toMatchObject({ exit: 0 });
    expect(kept).toEqual([]);
  });
});
