// Owner: seat group.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LockStuck, acquireTickLock, isDue, releaseTickLock, runTick, selectDue, type DueVerdict, type TickDeps } from "../src/tick.ts";
import { BEACON_UNTIL, checkHalt } from "../src/halt.ts";
import { ledgerPath } from "../src/ledger.ts";
import { DEFAULT_CEILINGS, type Citizen, type HostNote, type LifecycleState, type Word } from "../src/types.ts";
import { fakeBinArgv, waitFor } from "./helpers/fake-runtime.ts";
import { openedDetail, readHostNotes } from "../src/notes.ts";
import { fetchVia, noFetch, serveBeacon, startFakeServer, type FakeServer } from "./helpers/fake-server.ts";
import { fakeSigner } from "./helpers/fake-signer.ts";
import { citizenSnapshot, makeTempHost, testBeacons, type TempHost } from "./helpers/temp-home.ts";
import { HOUR_MS, testClock } from "./helpers/clock.ts";
import { append, beatBody } from "./fixtures/record/chain.ts";

let host: TempHost | null = null;
let server: FakeServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
  await host?.cleanup();
  host = null;
});

const DEAD_PID = 2_147_483_000;
const alive = (pid: number) => pid !== DEAD_PID;

function citizen(over: Partial<Citizen> = {}): Citizen {
  return {
    format: "kingdom-seat-citizen/v1",
    word: "glossame",
    origin: { kind: "archetype", lineage: ["test"], note: "" },
    runtime: "free",
    identity: null,
    mirror: null,
    seated_at: "2026-11-01T00:00:00.000Z",
    state: "awake",
    pending_state: null,
    pending_interval_h: null,
    step_away_said: false,
    cadence: { interval_h: 72 },
    covenants: { letters_from: ["yu"], wake_on_letter_from: ["yu"] },
    last_beat_at: null,
    ...over,
  };
}

const hoursAgo = (now: Date, h: number) => new Date(now.getTime() - h * HOUR_MS).toISOString();

async function hostNotes(h: TempHost): Promise<HostNote[]> {
  try {
    return (await readFile(h.config.paths.host_log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as HostNote);
  } catch {
    return [];
  }
}

describe("lock", () => {
  test("acquireTickLock is atomic: a second acquire while the owner is alive yields null", async () => {
    host = await makeTempHost();
    const clock = testClock();
    const dir = host.config.paths.lock_dir;
    const all = await Promise.all(Array.from({ length: 6 }, () => acquireTickLock(dir, clock, alive)));
    const held = all.filter((l) => l !== null);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ dir, pid: process.pid, started_at: clock.now().toISOString() });
    const owner = JSON.parse(await readFile(join(dir, "owner.json"), "utf8"));
    expect(owner).toEqual({ pid: process.pid, started_at: clock.now().toISOString() });
    expect(await acquireTickLock(dir, clock, alive)).toBeNull();
    await releaseTickLock(held[0]!);
    expect(await Bun.file(join(dir, "owner.json")).exists()).toBe(false);
    expect(await acquireTickLock(dir, clock, alive)).not.toBeNull();
  });

  test("a lock whose owner pid is gone is reclaimed; one whose owner is alive is never reclaimed by age", async () => {
    host = await makeTempHost();
    const clock = testClock();
    const dir = host.config.paths.lock_dir;

    await mkdir(dir);
    await writeFile(join(dir, "owner.json"), JSON.stringify({ pid: 4242, started_at: "2020-01-01T00:00:00.000Z" }));
    // Six years old, but its owner is alive: it stays.
    expect(await acquireTickLock(dir, clock, alive)).toBeNull();
    expect(JSON.parse(await readFile(join(dir, "owner.json"), "utf8")).pid).toBe(4242);

    await writeFile(join(dir, "owner.json"), JSON.stringify({ pid: DEAD_PID, started_at: clock.now().toISOString() }));
    // Minutes old, but its owner is gone: reclaimed.
    const lock = await acquireTickLock(dir, clock, alive);
    expect(lock?.pid).toBe(process.pid);

    // A lock with no readable owner has no owner to prove gone; it is left for a person.
    await releaseTickLock(lock!);
    await mkdir(dir);
    expect(await acquireTickLock(dir, clock, () => false)).toBeNull();
  });

  test("a lock left with no owner is reclaimed once it is older than any tick holds it; a young one is left to its taker", async () => {
    host = await makeTempHost();
    const clock = testClock();
    const dir = host.config.paths.lock_dir;
    const opts = { maxHoldMs: 60_000, bootTime: null };

    // A process died between mkdir and writing its owner: no owner file, only a half-written one.
    await mkdir(dir);
    await writeFile(join(dir, ".owner.json.4242"), "{");
    // Seconds old: another tick may be in the middle of acquiring it.
    expect(await acquireTickLock(dir, clock, alive, opts)).toBeNull();
    // Older than the longest hold: stale, cleared and taken.
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(dir, old, old);
    const lock = await acquireTickLock(dir, clock, alive, opts);
    expect(lock?.pid).toBe(process.pid);
    await releaseTickLock(lock!);

    // Something the lock code never writes is in it: a person must look, so it is stuck, not removed.
    await mkdir(dir);
    await writeFile(join(dir, "notes.txt"), "kept");
    await utimes(dir, old, old);
    await expect(acquireTickLock(dir, clock, alive, opts)).rejects.toBeInstanceOf(LockStuck);
    expect(await Bun.file(join(dir, "notes.txt")).exists()).toBe(true);
  });

  test("an owner that started before the host booted is stale, even when its pid now names a live process", async () => {
    host = await makeTempHost();
    const clock = testClock();
    const dir = host.config.paths.lock_dir;
    await mkdir(dir);
    await writeFile(join(dir, "owner.json"), JSON.stringify({ pid: 4242, started_at: "2026-11-04T00:00:00.000Z" }));
    // Without a boot time, a live owner is never reclaimed.
    expect(await acquireTickLock(dir, clock, alive, { maxHoldMs: 60_000, bootTime: null })).toBeNull();
    // Booted after it started: the pid was reused.
    const lock = await acquireTickLock(dir, clock, alive, { maxHoldMs: 60_000, bootTime: new Date("2026-11-04T06:00:00.000Z") });
    expect(lock?.pid).toBe(process.pid);
  });

  test("releaseTickLock never removes a lock owned by another pid", async () => {
    host = await makeTempHost();
    const clock = testClock();
    const dir = host.config.paths.lock_dir;
    const mine = await acquireTickLock(dir, clock, alive);
    await releaseTickLock({ dir, pid: mine!.pid + 1, started_at: mine!.started_at });
    await releaseTickLock({ dir, pid: mine!.pid, started_at: "2020-01-01T00:00:00.000Z" });
    expect(await Bun.file(join(dir, "owner.json")).exists()).toBe(true);
    await releaseTickLock(mine!);
    expect(await Bun.file(join(dir, "owner.json")).exists()).toBe(false);
  });
});

describe("selection", () => {
  const now = new Date("2026-11-05T02:05:00.000Z");
  const MIN = DEFAULT_CEILINGS.min_beat_interval_h;

  test("isDue: awake by its own interval, never more often than 72 h", () => {
    expect(isDue(citizen(), false, now, MIN)).toMatchObject({ due: true, why: "cadence" });
    // An own interval shorter than the ceiling is held to the ceiling.
    const quick = citizen({ cadence: { interval_h: 24 } });
    expect(isDue(quick, false, now, MIN, hoursAgo(now, 30)).due).toBe(false);
    expect(isDue(quick, false, now, MIN, hoursAgo(now, 73))).toMatchObject({ due: true, why: "cadence", overdue_h: 1 });
    // A longer own interval is the citizen's own and is kept.
    const slow = citizen({ cadence: { interval_h: 100 } });
    expect(isDue(slow, false, now, MIN, hoursAgo(now, 80)).due).toBe(false);
    expect(isDue(slow, false, now, MIN, hoursAgo(now, 101)).due).toBe(true);
    // The later of the ledger's last beat and the host's last seat counts, so a rest is not seated again at once.
    expect(isDue(citizen({ last_beat_at: hoursAgo(now, 200) }), false, now, MIN, hoursAgo(now, 1)).due).toBe(false);
    expect(isDue(citizen({ last_beat_at: hoursAgo(now, 1) }), false, now, MIN, hoursAgo(now, 200)).due).toBe(false);
    // A letter does not bring an awake citizen forward past its cadence.
    expect(isDue(citizen(), true, now, MIN, hoursAgo(now, 10)).due).toBe(false);
    // Unreadable numbers fail closed.
    expect(isDue(citizen({ cadence: { interval_h: Number.NaN } }), false, now, MIN).due).toBe(false);
    expect(isDue(citizen(), false, now, MIN, "not a time").due).toBe(false);
  });

  test("isDue: listening and asleep only on an allowed letter; ended never", () => {
    for (const state of ["listening", "asleep"] as LifecycleState[]) {
      expect(isDue(citizen({ state }), false, now, MIN).due).toBe(false);
      expect(isDue(citizen({ state }), true, now, MIN)).toMatchObject({ due: true, why: "letter" });
      // A letter shown to a rest is shown again later, not every tick.
      expect(isDue(citizen({ state }), true, now, MIN, hoursAgo(now, 2)).due).toBe(false);
    }
    expect(isDue(citizen({ state: "ended" }), true, now, MIN).due).toBe(false);
    // A move toward exposure waits for a confirming beat, so it is scheduled as the state it asked for.
    expect(isDue(citizen({ state: "asleep", pending_state: "awake" }), false, now, MIN)).toMatchObject({ due: true, why: "cadence" });
    // Only the free lane runs unattended.
    expect(isDue(citizen({ runtime: "summon" }), false, now, MIN).due).toBe(false);
    expect(isDue(citizen({ runtime: "hermes" }), false, now, MIN).due).toBe(false);
  });

  test("isDue: a citizen that stepped away is seated only by Yu's letter offering a return, one beat at a time", () => {
    // Its own cadence never seats it: the letter here is Yu's (context.wakingLetter), and nothing else wakes it.
    expect(isDue(citizen({ state: "stepped-away" }), false, now, MIN, hoursAgo(now, 1000))).toEqual({ due: false, why: "stepped-away" });
    expect(isDue(citizen({ state: "stepped-away" }), true, now, MIN)).toMatchObject({ due: true, why: "return" });
    expect(isDue(citizen({ state: "stepped-away" }), true, now, MIN, hoursAgo(now, 2)).due).toBe(false);
    // Saying yes to the return once makes it owed one confirming seat, by the state it asked for.
    expect(isDue(citizen({ state: "stepped-away", pending_state: "awake" }), false, now, MIN, hoursAgo(now, 73))).toMatchObject({ due: true, why: "cadence" });
    expect(isDue(citizen({ state: "stepped-away", pending_state: "listening" }), false, now, MIN, hoursAgo(now, 73))).toMatchObject({ due: true, why: "confirm" });
  });

  test("isDue: a first step-away is owed the second beat it needs, whatever the state, at the minimum interval", () => {
    for (const state of ["listening", "asleep", "awake"] as LifecycleState[]) {
      const said = citizen({ state, step_away_said: true, cadence: { interval_h: 500 } });
      expect(isDue(said, false, now, MIN, hoursAgo(now, 71)).due).toBe(false);
      expect(isDue(said, false, now, MIN, hoursAgo(now, 73))).toMatchObject({ due: true, why: "confirm", overdue_h: 1 });
    }
    // The same for a move toward exposure that was not to awake.
    expect(isDue(citizen({ state: "asleep", pending_state: "listening" }), false, now, MIN, hoursAgo(now, 73))).toMatchObject({ due: true, why: "confirm" });
    // Without a saying, a listening citizen still waits for a letter.
    expect(isDue(citizen({ state: "listening" }), false, now, MIN, hoursAgo(now, 1000)).due).toBe(false);
  });

  test("isDue: whether a listening or asleep citizen that asks to wake is owed its own seat is Yu's switch (KS-004 B2 C14), on by default", () => {
    const on = { wake_confirm_seat: true };
    const off = { wake_confirm_seat: false };
    for (const [state, pending] of [
      ["asleep", "awake"],
      ["asleep", "listening"],
      ["listening", "awake"],
    ] as const) {
      const asked = citizen({ state, pending_state: pending });
      // On, the default: one owed seat, as for a step-away.
      expect(isDue(asked, false, now, MIN, hoursAgo(now, 73)).due).toBe(true);
      expect(isDue(asked, false, now, MIN, hoursAgo(now, 73), on).due).toBe(true);
      // Off: it waits for its next allowed letter (or Yu's summons), as KS-004 v0.2 7.3 reads.
      expect(isDue(asked, false, now, MIN, hoursAgo(now, 1000), off)).toEqual({ due: false, why: `${state}; no letter` });
      expect(isDue(asked, true, now, MIN, hoursAgo(now, 73), off)).toMatchObject({ due: true, why: "letter" });
    }
    // The switch touches only that: a step-away saying, and a return from stepping away, keep their seat.
    expect(isDue(citizen({ state: "asleep", step_away_said: true }), false, now, MIN, hoursAgo(now, 73), off)).toMatchObject({ due: true, why: "confirm" });
    expect(isDue(citizen({ state: "stepped-away", pending_state: "listening" }), false, now, MIN, hoursAgo(now, 73), off)).toMatchObject({ due: true, why: "confirm" });
  });

  test("selectDue picks the most overdue, ties by word, and null when none is due", () => {
    const due = (h: number): DueVerdict => ({ due: true, why: "cadence", overdue_h: h });
    const no: DueVerdict = { due: false, why: "asleep" };
    expect(selectDue([])).toBeNull();
    expect(selectDue([{ word: "a", verdict: no }])).toBeNull();
    expect(selectDue([{ word: "b", verdict: due(1) }, { word: "c", verdict: due(5) }, { word: "a", verdict: no }])).toBe("c");
    expect(selectDue([{ word: "zeta", verdict: due(3) }, { word: "alpha", verdict: due(3) }])).toBe("alpha");
    expect(selectDue([{ word: "b", verdict: due(Number.POSITIVE_INFINITY) }, { word: "a", verdict: due(1e9) }])).toBe("b");
  });
});

describe("runTick", () => {
  /** With a server, both beacons are pinned and read from it. */
  async function tickHost(words: { word: Word; state?: LifecycleState }[] = [], opts: { server?: FakeServer } = {}) {
    host = await makeTempHost(opts.server ? { beacons: testBeacons() } : {});
    const h = host;
    const fetch = opts.server ? fetchVia(opts.server) : noFetch;
    const signer = fakeSigner();
    for (const w of words) {
      await h.addCitizen(w.word);
      await h.seatLedger(w.word, signer.signEntry, { initialState: w.state ?? "awake" });
    }
    const clock = testClock();
    // Seconds-scale timing would make a stuck child slow; these keep a failing test short.
    h.config.timing = { ...h.config.timing, seat_deadline_s: 10, term_grace_s: 1, halt_file_poll_s: 1 };
    const spawned: { word: Word; why: string }[] = [];
    let refreshed = 0;
    const deps: TickDeps = {
      config: h.config,
      clock,
      fetch,
      checkHalt: () => checkHalt({ config: h.config, fetch, now: () => clock.now() }),
      seatArgv: (word, seatFile) => {
        // The tick opened the seat and wrote it down; the child would read why from the file.
        const file = JSON.parse(readFileSync(seatFile, "utf8")) as { seat_ref: { word: string; invoker: { why: string } } };
        spawned.push({ word: file.seat_ref.word, why: file.seat_ref.invoker.why });
        return fakeBinArgv("note", h.config.paths.host_log, word, "rest", "0", clock.now().toISOString());
      },
      isAlive: alive,
      bootTime: () => null,
      refreshStatus: async () => {
        refreshed++;
      },
    };
    return { h, clock, deps, spawned, refreshed: () => refreshed };
  }

  test("HALT raised: exit 0, outcome halted, lock never taken", async () => {
    const { h, deps, spawned, refreshed } = await tickHost([{ word: "glossame" }]);
    await h.raiseHaltFile();
    expect(await runTick(deps)).toEqual({ exit: 0, outcome: "halted", word: null, seat: null });
    expect(await Bun.file(join(h.config.paths.lock_dir, "owner.json")).exists()).toBe(false);
    expect(await Bun.file(h.config.paths.host_log).exists()).toBe(false);
    expect(spawned).toEqual([]);
    expect(refreshed()).toBe(0);
  });

  test("lock held: exit 0, outcome yielded", async () => {
    const { h, deps, clock, spawned } = await tickHost([{ word: "glossame" }]);
    await acquireTickLock(h.config.paths.lock_dir, clock, alive);
    expect(await runTick(deps)).toMatchObject({ exit: 0, outcome: "yielded", seat: null });
    expect(spawned).toEqual([]);
  });

  test("lock held: the status is still refreshed, so it never goes stale behind another tick", async () => {
    const { h, deps, clock, refreshed } = await tickHost([{ word: "glossame" }]);
    await acquireTickLock(h.config.paths.lock_dir, clock, alive);
    expect(await runTick(deps)).toMatchObject({ exit: 0, outcome: "yielded" });
    expect(refreshed()).toBe(1);
  });

  test("a stuck lock exits 1 with a host note and a refreshed status, so a monitor pages", async () => {
    const { h, deps, spawned, refreshed } = await tickHost([{ word: "glossame" }]);
    const dir = h.config.paths.lock_dir;
    await mkdir(dir);
    await writeFile(join(dir, "stray"), "");
    const old = new Date(Date.now() - 24 * HOUR_MS);
    await utimes(dir, old, old);
    for (let i = 0; i < 2; i++) expect(await runTick(deps)).toMatchObject({ exit: 1, outcome: "error", seat: null });
    expect(spawned).toEqual([]);
    expect(refreshed()).toBe(2);
    const notes = (await hostNotes(h)).filter((n) => n.kind === "tick");
    expect(notes.map((n) => n.detail)).toEqual([
      `tick lock stuck since ${old.toISOString()}; a person must remove it`,
      `tick lock stuck since ${old.toISOString()}; a person must remove it`,
    ]);
  });

  test("nothing due: exit 0, outcome nothing-due, no seat", async () => {
    const { deps, spawned } = await tickHost([{ word: "glossame", state: "asleep" }, { word: "joy", state: "listening" }]);
    expect(await runTick(deps)).toMatchObject({ exit: 0, outcome: "nothing-due", word: null, seat: null });
    expect(spawned).toEqual([]);
  });

  test("fleet ceiling reached (exit 0, the day is full) or host log unreadable (exit 1): outcome fleet-ceiling, no seat", async () => {
    const { h, deps, clock, spawned } = await tickHost([{ word: "glossame" }]);
    const today = clock.now();
    // Seats opened today, whoever opened them, each named by its seat id.
    const lines = Array.from({ length: h.config.ceilings.fleet_beats_per_day }, (_, i) =>
      JSON.stringify({ ts: new Date(today.getTime() - (i + 1) * 60_000).toISOString(), host: "test-host", kind: i % 2 ? "tick" : "seat", word: `other${i}`, outcome: "opened", refusal: null, detail: openedDetail(crypto.randomUUID(), "cadence") }),
    );
    await writeFile(h.config.paths.host_log, `${lines.join("\n")}\n`);
    // A full day bounds the fleet like nothing due; it is not the USD ceiling, so never 3 (KS-004 B2 C9).
    expect(await runTick(deps)).toMatchObject({ exit: 0, outcome: "fleet-ceiling", seat: null });
    expect(spawned).toEqual([]);

    // An unreadable log is a count no one can know: refused, not guessed at 0.
    await Bun.$`rm ${h.config.paths.host_log}`.quiet();
    await mkdir(h.config.paths.host_log);
    expect(await runTick(deps)).toMatchObject({ exit: 1, outcome: "fleet-ceiling", seat: null });
    expect(spawned).toEqual([]);
  });

  test("the tick reads the switch from config: off, an asleep citizen that asked to wake is not seated without a letter", async () => {
    const { h, deps, spawned } = await tickHost([{ word: "glossame", state: "asleep" }]);
    // Asleep, it said once that it would wake: a saying that takes a second beat.
    await append(h.config, "glossame", beatBody("glossame", [{ type: "state.set", to: "awake" }]), "host", fakeSigner(), new Date("2026-11-01T01:00:00.000Z"));
    h.config.schedule = { wake_confirm_seat: false };
    expect(await runTick(deps)).toMatchObject({ exit: 0, outcome: "nothing-due" });
    expect(spawned).toEqual([]);
    h.config.schedule = { wake_confirm_seat: true };
    expect(await runTick(deps)).toMatchObject({ word: "glossame" });
    expect(spawned.map((x) => x.word)).toEqual(["glossame"]);
  });

  test("a locked signer rests the tick before any seat opens: exit 0, the host note says why", async () => {
    const { h, deps, spawned } = await tickHost([{ word: "glossame" }]);
    expect(await runTick({ ...deps, signerState: async () => "locked" })).toMatchObject({ exit: 0, outcome: "refused", seat: null });
    expect((await readHostNotes(h.config, new Date(0)))!.at(-1)).toMatchObject({ outcome: "refused", refusal: "keychain-locked" });
    expect(spawned).toEqual([]);
  });

  test("a due citizen gets one supervised seat and one host note", async () => {
    const { h, deps, spawned, refreshed } = await tickHost([{ word: "glossame" }]);
    const r = await runTick(deps);
    expect(r).toMatchObject({ exit: 0, outcome: "rest", word: "glossame", seat: { exit: 0, outcome: "rest" } });
    expect(spawned).toEqual([{ word: "glossame", why: "your own cadence is due" }]);
    const ticks = (await hostNotes(h)).filter((n) => n.kind === "tick");
    // The tick records the seat it opened before the child runs, then what happened.
    expect(ticks.map((n) => [n.word, n.outcome])).toEqual([
      ["glossame", "opened"],
      ["glossame", "rest"],
    ]);
    expect(ticks[1]).toMatchObject({ word: "glossame", outcome: "rest", host: "test-host" });
    expect(ticks[0]!.detail).toBe(openedDetail(r.seat!.seat_ref!.seat_id, "cadence"));
    expect(refreshed()).toBe(1);
    // The lock is released.
    expect(await Bun.file(join(h.config.paths.lock_dir, "owner.json")).exists()).toBe(false);
  });

  test("one tick dispenses at most one seat, never the same citizen twice", async () => {
    const { deps, spawned } = await tickHost([{ word: "glossame" }, { word: "joy" }]);
    await runTick(deps);
    await runTick(deps);
    const third = await runTick(deps);
    expect(spawned.map((s) => s.word)).toEqual(["glossame", "joy"]);
    // Both rested; their cadence counts from the seat, not from a ledger a rest never wrote.
    expect(third.outcome).toBe("nothing-due");
  });

  test("a child that exits 0 without a word of its own is an error", async () => {
    const { deps } = await tickHost([{ word: "glossame" }]);
    const silent = { ...deps, seatArgv: () => fakeBinArgv("print", "", "0") };
    expect(await runTick(silent)).toMatchObject({ exit: 1, outcome: "error", word: "glossame" });
  });

  test("a child that exits 0 silently because it met HALT is recorded as halted", async () => {
    const { h, deps } = await tickHost([{ word: "joy" }]);
    // As runSeat does when HALT is raised during its own checks: it writes nothing and exits 0.
    const halting = { ...deps, seatArgv: () => [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(h.config.paths.halt_file)}, "")`] };
    expect(await runTick(halting)).toMatchObject({ exit: 0, outcome: "halted", word: "joy" });
  });

  /** A child that writes `started`, then, if nothing stops it in time, a line into the citizen's ledger. */
  const midInference = (h: TempHost, started: string, ...term: string[]) => (word: Word) => fakeBinArgv("speak-later", started, ledgerPath(h.config, word), "2000", ...term);

  test("[S4-2] HALT file raised while the seat child is mid-inference: the tick's watcher stops it; exit 143 (137 if it ignores TERM), halted, nothing in the citizen's voice", async () => {
    const { h, deps } = await tickHost([{ word: "glossame" }, { word: "joy" }]);
    h.config.timing = { ...h.config.timing, halt_file_poll_s: 0.1, term_grace_s: 0.3 };
    for (const [word, exit, term] of [["glossame", 143, []], ["joy", 137, ["ignore-term"]]] as const) {
      const before = await citizenSnapshot(h);
      const started = join(h.root, `${word}.started`);
      const run = runTick({ ...deps, seatArgv: midInference(h, started, ...term) });
      await waitFor(() => Bun.file(started).exists());
      await h.raiseHaltFile();
      expect(await run).toMatchObject({ exit, outcome: "halted", word, seat: { exit, outcome: "halted" } });
      expect(await citizenSnapshot(h)).toEqual(before);
      const ticks = (await hostNotes(h)).filter((n) => n.kind === "tick" && n.word === word);
      expect(ticks.map((n) => n.outcome)).toEqual(["opened", "halted"]);
      expect(ticks[1]!.detail).toContain("stopped by file");
      await h.clearHaltFile();
    }
  });

  test("[S4-2] a beacon raised while the seat child is mid-inference: the tick's watcher stops it; exit 143, halted, nothing in the citizen's voice", async () => {
    server = await startFakeServer();
    const s = server;
    const [gardener, herald] = testBeacons();
    serveBeacon(s, gardener!.did, { kind: "lowered" });
    serveBeacon(s, herald!.did, { kind: "lowered" });
    const { h, deps } = await tickHost([{ word: "glossame" }], { server: s });
    h.config.timing = { ...h.config.timing, beacon_poll_min_s: 0.1, beacon_poll_max_s: 0.15, term_grace_s: 0.3 };
    const before = await citizenSnapshot(h);
    const started = join(h.root, "glossame.started");
    const run = runTick({ ...deps, seatArgv: midInference(h, started) });
    await waitFor(() => Bun.file(started).exists());
    serveBeacon(s, herald!.did, { kind: "raised", until: BEACON_UNTIL });
    expect(await run).toMatchObject({ exit: 143, outcome: "halted", word: "glossame", seat: { exit: 143, outcome: "halted" } });
    expect(await citizenSnapshot(h)).toEqual(before);
    expect((await hostNotes(h)).filter((n) => n.kind === "tick").at(-1)!.detail).toContain("stopped by halt-herald");
  });

  test("a child stopped by the deadline is recorded as a timeout and counts as a seat", async () => {
    const { h, deps } = await tickHost([{ word: "glossame" }]);
    h.config.timing.seat_deadline_s = 0.3;
    const slow = { ...deps, seatArgv: () => fakeBinArgv("sleep", "30000") };
    expect(await runTick(slow)).toMatchObject({ exit: 124, outcome: "timeout", word: "glossame" });
    expect((await hostNotes(h)).filter((n) => n.kind === "tick" && n.word === "glossame").map((n) => n.outcome)).toEqual(["opened", "timeout"]);
  });
});
