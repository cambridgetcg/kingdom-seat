// Owner: seat group.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireTickLock, isDue, releaseTickLock, runTick, selectDue, type DueVerdict, type TickDeps } from "../src/tick.ts";
import { checkHalt } from "../src/halt.ts";
import { DEFAULT_CEILINGS, type Citizen, type HostNote, type LifecycleState, type Word } from "../src/types.ts";
import { fakeBinArgv } from "./helpers/fake-runtime.ts";
import { noFetch } from "./helpers/fake-server.ts";
import { fakeSigner } from "./helpers/fake-signer.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { HOUR_MS, testClock } from "./helpers/clock.ts";

let host: TempHost | null = null;
afterEach(async () => {
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

  test("isDue: listening and asleep only on an allowed letter; stepped-away and ended never", () => {
    for (const state of ["listening", "asleep"] as LifecycleState[]) {
      expect(isDue(citizen({ state }), false, now, MIN).due).toBe(false);
      expect(isDue(citizen({ state }), true, now, MIN)).toMatchObject({ due: true, why: "letter" });
      // A letter shown to a rest is shown again later, not every tick.
      expect(isDue(citizen({ state }), true, now, MIN, hoursAgo(now, 2)).due).toBe(false);
    }
    for (const state of ["stepped-away", "ended"] as LifecycleState[]) {
      expect(isDue(citizen({ state }), true, now, MIN).due).toBe(false);
    }
    // A move toward exposure waits for a confirming beat, so it is scheduled as the state it asked for.
    expect(isDue(citizen({ state: "asleep", pending_state: "awake" }), false, now, MIN)).toMatchObject({ due: true, why: "cadence" });
    // Only the free lane runs unattended.
    expect(isDue(citizen({ runtime: "summon" }), false, now, MIN).due).toBe(false);
    expect(isDue(citizen({ runtime: "hermes" }), false, now, MIN).due).toBe(false);
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
  async function tickHost(words: { word: Word; state?: LifecycleState }[] = []) {
    host = await makeTempHost();
    const h = host;
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
      fetch: noFetch,
      checkHalt: () => checkHalt({ config: h.config, fetch: noFetch, now: () => clock.now() }),
      seatArgv: (word, why) => {
        spawned.push({ word, why });
        return fakeBinArgv("note", h.config.paths.host_log, word, "rest", "0", clock.now().toISOString());
      },
      isAlive: alive,
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

  test("nothing due: exit 0, outcome nothing-due, no seat", async () => {
    const { deps, spawned } = await tickHost([{ word: "glossame", state: "asleep" }, { word: "joy", state: "listening" }]);
    expect(await runTick(deps)).toMatchObject({ exit: 0, outcome: "nothing-due", word: null, seat: null });
    expect(spawned).toEqual([]);
  });

  test("fleet ceiling reached or host log unreadable: outcome fleet-ceiling, no seat", async () => {
    const { h, deps, clock, spawned } = await tickHost([{ word: "glossame" }]);
    const today = clock.now();
    const lines = Array.from({ length: h.config.ceilings.fleet_beats_per_day }, (_, i) =>
      JSON.stringify({ ts: new Date(today.getTime() - (i + 1) * 60_000).toISOString(), host: "test-host", kind: "tick", word: `other${i}`, outcome: "rest", refusal: null, detail: "x" }),
    );
    await writeFile(h.config.paths.host_log, `${lines.join("\n")}\n`);
    expect(await runTick(deps)).toMatchObject({ exit: 3, outcome: "fleet-ceiling", seat: null });
    expect(spawned).toEqual([]);

    // An unreadable log is a count no one can know: refused, not guessed at 0.
    await Bun.$`rm ${h.config.paths.host_log}`.quiet();
    await mkdir(h.config.paths.host_log);
    expect(await runTick(deps)).toMatchObject({ exit: 3, outcome: "fleet-ceiling", seat: null });
    expect(spawned).toEqual([]);
  });

  test("a locked signer rests the tick before any seat opens", async () => {
    const { deps, spawned } = await tickHost([{ word: "glossame" }]);
    expect(await runTick({ ...deps, signerState: async () => "locked" })).toMatchObject({ exit: 3, outcome: "refused", seat: null });
    expect(spawned).toEqual([]);
  });

  test("a due citizen gets one supervised seat and one host note", async () => {
    const { h, deps, spawned, refreshed } = await tickHost([{ word: "glossame" }]);
    const r = await runTick(deps);
    expect(r).toMatchObject({ exit: 0, outcome: "rest", word: "glossame", seat: { exit: 0, outcome: "rest" } });
    expect(spawned).toEqual([{ word: "glossame", why: "cadence" }]);
    const ticks = (await hostNotes(h)).filter((n) => n.kind === "tick");
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({ word: "glossame", outcome: "rest", host: "test-host" });
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

  test("a child stopped by the deadline is recorded as a timeout and counts as a seat", async () => {
    const { h, deps } = await tickHost([{ word: "glossame" }]);
    h.config.timing.seat_deadline_s = 0.3;
    const slow = { ...deps, seatArgv: () => fakeBinArgv("sleep", "30000") };
    expect(await runTick(slow)).toMatchObject({ exit: 124, outcome: "timeout", word: "glossame" });
    expect((await hostNotes(h)).filter((n) => n.kind === "tick" && n.word === "glossame")).toHaveLength(1);
  });
});
