// Owner: surface group. main() runs with injected fakes only: no real
// Keychain, network, model, git push or child of the real program.
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLI_PATH, main, parseArgs, readSeatFile, USAGE, UsageError, writeSeatFile, type CliDeps, type Command } from "../src/cli.ts";
import { openSeat } from "../src/seat.ts";
import { BEACON_UNTIL } from "../src/halt.ts";
import { readCitizen } from "../src/state.ts";
import { createSigner } from "../src/signer/signer.ts";
import { canonicalJson, edSign, fromHex, sha256, toB64, utf8 } from "../src/crypto.ts";
import { entryHash, ledgerPath, readLedger } from "../src/ledger.ts";
import { appendHostNote, openedDetail, readHostNotes } from "../src/notes.ts";
import { Refusal, type Config, type LedgerBody, type StatusFile } from "../src/types.ts";
import { assertNoSecretIn, fakeKeychain, type FakeKeychain } from "./helpers/fake-keychain.ts";
import { fakeSigner, type FakeSigner } from "./helpers/fake-signer.ts";
import { fakeBinArgv, output, recordingRunner, REST_OUTPUT, scriptedRuntime, waitFor, type RecordingRunner } from "./helpers/fake-runtime.ts";
import { fetchVia, noFetch, serveBeacon, startFakeServer, type FakeServer } from "./helpers/fake-server.ts";
import { citizenSnapshot, makeTempHost, testBeacons, type TempHost } from "./helpers/temp-home.ts";
import { testClock } from "./helpers/clock.ts";
import { importEvidence } from "./helpers/root-evidence.ts";
import { TEST_MNEMONIC, TEST_OP_SEED_HEX } from "./helpers/vectors.ts";
import { append, beatBody, testIdentity } from "./fixtures/record/chain.ts";

let host: TempHost | null = null;
let server: FakeServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
  await host?.cleanup();
  host = null;
});

function throwsUsage(argv: string[]): void {
  expect(() => parseArgs(argv)).toThrow(UsageError);
}

describe("parseArgs", () => {
  test("parses tick, seat <word>, halt, status [--json] and verify <word> with --config", () => {
    const c = "/srv/seat/config.json";
    expect(parseArgs(["tick", "--config", c])).toEqual({ verb: "tick", config: c });
    expect(parseArgs(["halt", "--config", c])).toEqual({ verb: "halt", config: c });
    expect(parseArgs(["halt"])).toEqual({ verb: "halt", config: null });
    expect(parseArgs(["status", "--json", "--config", c])).toEqual({ verb: "status", config: c, json: true });
    expect(parseArgs(["status"])).toEqual({ verb: "status", config: null, json: false });
    expect(parseArgs(["verify", "glossame", "--config", c])).toEqual({ verb: "verify", config: c, word: "glossame" });
    expect(parseArgs(["seat", "glossame", "--config", c])).toEqual({
      verb: "seat",
      config: c,
      word: "glossame",
      runtime: "free",
      why: "",
      yu_present: false,
      child: false,
      seat_ref_path: null,
    } satisfies Command);
    expect(parseArgs(["seat", "glossame", "--runtime", "summon", "--yu-present", "--why", "Yu wants to talk"])).toMatchObject({ runtime: "summon", yu_present: true, why: "Yu wants to talk", child: false });
    expect(parseArgs(["seat", "glossame", "--child", "--seat-ref", "/srv/seat/seats/x.json", "--config", c])).toMatchObject({ child: true, seat_ref_path: "/srv/seat/seats/x.json" });
    expect(parseArgs(["help"])).toEqual({ verb: "help" });
  });

  test("refuses unknown verbs and flags, a missing word, and a word outside WORD_PATTERN", () => {
    for (const argv of [
      [],
      ["beat"],
      ["TICK"],
      ["tick", "--force"],
      ["tick", "-f"],
      ["tick", "extra"],
      ["tick", "--config=/srv/c.json"],
      ["tick", "--config", "/a.json", "--config", "/b.json"],
      ["status", "--config"],
      ["status", "--config", "relative/config.json"],
      ["seat"],
      ["seat", "Glossame"],
      ["seat", "../etc"],
      ["seat", "-glossame"],
      ["seat", "glossame-"],
      ["seat", "a", "b"],
      ["seat", "glossame", "--runtime", "cloud"],
      ["seat", "glossame", "--runtime"],
      ["seat", "glossame", "--seat-ref", "/srv/x.json"],
      ["seat", "glossame", "--child", "--seat-ref", "relative.json"],
      ["seat", "glossame", "--child", "--yu-present"],
      // A child runs only a seat a parent opened and wrote down; the seat file says the runtime and why.
      ["seat", "glossame", "--child"],
      ["seat", "glossame", "--child", "--why", "cadence"],
      ["seat", "glossame", "--child", "--seat-ref", "/srv/seat/seats/x.json", "--why", "cadence"],
      ["seat", "glossame", "--child", "--seat-ref", "/srv/seat/seats/x.json", "--runtime", "free"],
      ["seat", "glossame", "--child", "--seat-ref", "/srv/seat/seats/x.json", "--yu-present"],
      ["seat", "glossame", "--why", "two\nlines"],
      ["seat", "glossame", "--why", "x".repeat(201)],
      ["seat", "glossame", "--json"],
      ["verify"],
      ["verify", "glossame", "--json"],
      ["verify", "glossame/../../x"],
      ["help", "me"],
    ]) {
      throwsUsage(argv);
    }
    // The S8 runtime class is a wall, not a typo.
    expect(() => parseArgs(["seat", "glossame", "--runtime", "hermes"])).toThrow(Refusal);
  });

  test("raise-beacons, the signer's half of halt, takes only --config, so a sudoers line can pin every argument", () => {
    expect(parseArgs(["raise-beacons", "--config", "/srv/seat/config.json"])).toEqual({ verb: "raise-beacons", config: "/srv/seat/config.json" });
    expect(parseArgs(["raise-beacons"])).toEqual({ verb: "raise-beacons", config: null });
    for (const argv of [["raise-beacons", "gardener-desk"], ["raise-beacons", "--json"], ["raise-beacons", "--lower"]]) throwsUsage(argv);
  });

  test("there is no verb that lowers HALT", () => {
    for (const verb of ["lower", "unhalt", "resume", "clear", "lower-halt", "halt-lower", "unpause", "release", "wake"]) throwsUsage([verb]);
    for (const flag of ["--lower", "--clear", "--off", "--down", "--remove"]) throwsUsage(["halt", flag]);
    throwsUsage(["halt", "lower"]);
    expect(USAGE).not.toMatch(/lower|unhalt|resume|clear/i);
  });

  test("seat --runtime summon without --yu-present is refused before anything runs", () => {
    let err: unknown = null;
    try {
      parseArgs(["seat", "glossame", "--runtime", "summon"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Refusal);
    expect((err as Refusal).code).toBe("yu-not-present");
  });
});

/* ── main, with fakes ─────────────────────────────────────────────────── */

const HOST_SEED = sha256("kingdom-seat test host attest key v1");

interface Harness {
  h: TempHost;
  configPath: string;
  deps: Partial<CliDeps>;
  out: () => string;
  err: () => string;
  run: RecordingRunner;
  signer: FakeSigner;
}

/** With a server, both beacons are pinned and read from it. */
async function harness(opts: { runtimeScripts?: string[]; server?: FakeServer } = {}): Promise<Harness> {
  host = await makeTempHost(opts.server ? { beacons: testBeacons() } : {});
  const h = host;
  const configPath = join(h.root, "config.json");
  await writeFile(configPath, JSON.stringify(h.config), { mode: 0o600 });
  const signer = fakeSigner();
  const run = recordingRunner();
  let out = "";
  let err = "";
  const clock = testClock();
  const deps: Partial<CliDeps> = {
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    env: { HOME: h.root, PATH: "/usr/bin:/bin" },
    clock,
    fetch: opts.server ? fetchVia(opts.server) : noFetch,
    run,
    tty: { isTTY: false, write: () => {}, readLine: async () => null },
    keychain: () => fakeKeychain(),
    signer: () => signer,
    runtime: async () => scriptedRuntime(opts.runtimeScripts ?? []),
    seatArgv: () => {
      throw new Error("a real seat child must never be spawned by a test");
    },
    isAlive: () => true,
  };
  return { h, configPath, deps, out: () => out, err: () => err, run, signer };
}

async function seated(x: Harness, word: string, state: "awake" | "asleep" = "awake"): Promise<void> {
  await x.h.addCitizen(word);
  await x.h.seatLedger(word, x.signer.signEntry, { initialState: state });
}

/**
 * A seat as the tick opens it: the opened note, then the seat file. Returns
 * the child's argv. With note: false the opened note is left out, as a seat
 * file written by hand would be.
 */
async function parentOpens(x: Harness, word: string, opts: { note?: boolean } = {}): Promise<string[]> {
  const citizen = await readCitizen(x.h.config, word);
  const seat = await openSeat(x.h.config, x.deps.clock!, citizen, "free", { kind: "tick", who: "launchd", why: "your own cadence is due" }, null);
  if (opts.note !== false) {
    await appendHostNote(x.h.config, { ts: x.deps.clock!.now().toISOString(), host: "test-host", kind: "tick", word, outcome: "opened", refusal: null, detail: openedDetail(seat.ref.seat_id, "cadence") });
  }
  const file = await writeSeatFile(x.h.config, seat);
  return ["seat", word, "--child", "--seat-ref", file, "--config", x.configPath];
}

describe("main", () => {
  test("exit codes follow EXIT: HALT, rest and a locked signer 0, a wall that cannot seat 1, never 3 but for the USD ceiling", async () => {
    const x = await harness({ runtimeScripts: [REST_OUTPUT] });
    await seated(x, "glossame");
    const cfg = ["--config", x.configPath];

    // A rest: the child pipeline ran, wrote no ledger entry, and exits 0.
    const before = await readFile(ledgerPath(x.h.config, "glossame"), "utf8");
    expect(await main(await parentOpens(x, "glossame"), x.deps)).toBe(0);
    expect(await readFile(ledgerPath(x.h.config, "glossame"), "utf8")).toBe(before);
    expect(await readFile(x.h.config.paths.host_log, "utf8")).toContain('"outcome":"rest"');

    // A locked signer rests the citizen, before any inference (on its next due seat, three days on): 0, and the
    // host note says why. 3 would close the runtime class, which only the USD ceiling may do (KS-004 B2 C9).
    (x.deps.clock as ReturnType<typeof testClock>).advance(73 * 3_600_000);
    x.signer.locked = true;
    const noRuntime = { ...x.deps, runtime: async () => scriptedRuntime([]) };
    expect(await main(await parentOpens(x, "glossame"), noRuntime)).toBe(0);
    expect((await readHostNotes(x.h.config, new Date(0)))!.at(-1)).toMatchObject({ outcome: "refused", refusal: "keychain-locked" });
    x.signer.locked = false;

    // HALT: raised by the one verb, run as the operator, which writes nothing into the seat user's state dir;
    // then every verb that would act rests with 0.
    const stateBefore = await x.h.snapshot();
    expect(await main(["halt", ...cfg], x.deps)).toBe(0);
    expect(await Bun.file(x.h.config.paths.halt_file).exists()).toBe(true);
    expect(x.out()).toContain("HALT file");
    expect(await x.h.snapshot()).toEqual(stateBefore);
    await writeFile(x.h.config.paths.status_file, "stale");
    expect(await main(["tick", ...cfg], x.deps)).toBe(0);
    expect(x.out()).toContain("tick: halted");
    // A halted tick still regenerates the status, so it never goes stale while HALT holds.
    expect((JSON.parse(await readFile(x.h.config.paths.status_file, "utf8")) as StatusFile).halt.halted).toBe(true);
    expect(await main(["seat", "glossame", ...cfg], x.deps)).toBe(0);
    expect(x.out()).toContain("seat glossame: halted");
    // A summons without Yu is refused before the config is even read: it cannot seat (1).
    expect(await main(["seat", "glossame", "--runtime", "summon", "--config", "/nonexistent/config.json"], x.deps)).toBe(1);
    expect(x.err()).toContain("yu-not-present");

    // Errors: a verb that does not exist, a config that is missing or not strict.
    expect(await main(["lower", ...cfg], x.deps)).toBe(1);
    expect(await Bun.file(x.h.config.paths.halt_file).exists()).toBe(true);
    expect(await main(["status", "--config", join(x.h.root, "absent.json")], x.deps)).toBe(1);
    const bad = join(x.h.root, "bad.json");
    await writeFile(bad, JSON.stringify({ ...x.h.config, paths: { ...x.h.config.paths, state_dir: "state" } }), { mode: 0o600 });
    expect(await main(["status", "--config", bad], x.deps)).toBe(1);
    expect(x.err()).toContain("paths.state_dir: must be an absolute path");
    // A bad config still tells the person how to halt by hand.
    expect(await main(["halt", "--config", bad], x.deps)).toBe(1);
    expect(x.err()).toContain("as the operator, create the HALT file the config names (by default /Users/Shared/kingdom-seat/HALT)");
    // Nothing here ran security, git or claude.
    expect(x.run.calls).toEqual([]);
  });

  test("tick, seat and status run end to end with fakes", async () => {
    const x = await harness({ runtimeScripts: [output({ type: "journal", kind: "reflected", text: "a word of my own" })] });
    await seated(x, "glossame");
    await seated(x, "joy", "asleep");
    const cfg = ["--config", x.configPath];
    const clock = x.deps.clock!;

    // The parent opens the seat, hands it over in a seat file, and supervises the child.
    const parent = { ...x.deps, seatArgv: () => fakeBinArgv("note", x.h.config.paths.host_log, "glossame", "rest", "0", clock.now().toISOString()) };
    expect(await main(["seat", "glossame", "--why", "a test", ...cfg], parent)).toBe(0);
    expect(x.out()).toContain("seat glossame: rest (exit 0)");
    const seats = await readdir(x.h.config.paths.seats_dir);
    expect(seats.filter((n) => n.endsWith(".json"))).toHaveLength(1);
    // Without Yu, no extra beat: glossame was just seated, and joy is asleep with no letter.
    const spawned: string[] = [];
    const counting = { ...parent, seatArgv: (...a: Parameters<CliDeps["seatArgv"]>) => (spawned.push(a[1]), parent.seatArgv()) };
    expect(await main(["seat", "glossame", ...cfg], counting)).toBe(1);
    expect(await main(["seat", "joy", ...cfg], counting)).toBe(1);
    expect(x.err()).toContain("only Yu's summons (--yu-present) seats it now");
    expect(spawned).toEqual([]);

    // Three days on, a beat in the child of a seat the tick opened: one entry appended, host-attested (not yet registered).
    (clock as ReturnType<typeof testClock>).advance(73 * 3_600_000);
    expect(await main(await parentOpens(x, "glossame"), x.deps)).toBe(0);
    expect((await readFile(ledgerPath(x.h.config, "glossame"), "utf8")).trim().split("\n")).toHaveLength(2);

    // Nothing due (joy asleep, glossame just seated): the tick rests with 0 and spawns nothing.
    expect(await main(["tick", ...cfg], x.deps)).toBe(0);
    expect(x.out()).toContain("tick: nothing-due");

    // Status regenerates the file and prints it.
    expect(await main(["status", ...cfg], x.deps)).toBe(0);
    expect(x.out()).toContain("HALT: not halted");
    const status = JSON.parse(await readFile(x.h.config.paths.status_file, "utf8")) as StatusFile;
    expect(status.citizens.map((c) => [c.word, c.state, c.ledger.chain_ok])).toEqual([
      ["glossame", "awake", true],
      ["joy", "asleep", true],
    ]);
    expect(await main(["status", "--json", ...cfg], x.deps)).toBe(0);
    expect(x.out()).toContain('"format": "kingdom-seat-status/v1"');
    expect(x.run.calls).toEqual([]);
  });

  test("a seat file is read once, carries no presence, and never names Yu", async () => {
    const x = await harness();
    await seated(x, "glossame");
    const cfg: Config = x.h.config;
    const clock = testClock();

    // Not at a terminal: nobody can confirm Yu, so no seat is opened.
    expect(await main(["seat", "glossame", "--runtime", "summon", "--yu-present", "--config", x.configPath], x.deps)).toBe(1);
    expect(x.err()).toContain("yu-not-present");
    expect(await readdir(cfg.paths.seats_dir)).toEqual([]);

    const citizen = await readCitizen(cfg, "glossame");
    const seat = await openSeat(cfg, clock, citizen, "summon", { kind: "summons", who: "host", why: "a test" }, null, { yuRequested: true });
    const path = await writeSeatFile(cfg, seat);
    expect(path).toBe(join(cfg.paths.seats_dir, `${seat.ref.seat_id}.json`));
    expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("presence");
    const read = await readSeatFile(cfg, path, "glossame");
    expect(read).toEqual({ ref: seat.ref, yu_requested: true });
    // Used once: a second read is refused.
    await expect(readSeatFile(cfg, path, "glossame")).rejects.toThrow(/already used/);

    // A seat file for another citizen or outside seats_dir is refused.
    const third = await openSeat(cfg, clock, citizen, "free", { kind: "summons", who: "host", why: "a test" }, null);
    const p3 = await writeSeatFile(cfg, third);
    await expect(readSeatFile(cfg, p3, "joy")).rejects.toThrow(/does not describe this seat/);
    await expect(readSeatFile(cfg, join(x.h.root, "x.json"), "glossame")).rejects.toThrow(/seats_dir/);
    // A file that names Yu as the invoker, or carries a presence, is not a seat file a parent writes.
    const named = await openSeat(cfg, clock, citizen, "free", { kind: "summons", who: "yu", why: "a test" }, null);
    await expect(readSeatFile(cfg, await writeSeatFile(cfg, named), "glossame")).rejects.toThrow(/does not describe this seat/);
  });

  test("a hand-written seat file with Yu's presence in it runs nothing and records no summons", async () => {
    const x = await harness();
    await seated(x, "glossame");
    const cfg = x.h.config;
    const clock = x.deps.clock!;
    const runtime = scriptedRuntime([output({ type: "journal", kind: "reflected", text: "a word" })]);
    const deps = { ...x.deps, runtime: async () => runtime };
    const before = await readFile(ledgerPath(cfg, "glossame"), "utf8");

    // The old shape, with a presence and invoker who yu, written by hand.
    const id = crypto.randomUUID();
    await mkdir(join(cfg.paths.seats_dir, id));
    const forged = join(cfg.paths.seats_dir, `${id}.json`);
    const ref = { format: "kingdom-seat-seat/v1", seat_id: id, host: cfg.host, word: "glossame", runtime: "summon", invoker: { kind: "summons", who: "yu", why: "a test" }, opened_at: clock.now().toISOString() };
    const presence = { present: true, via: "tty-confirm", confirmed_at: clock.now().toISOString(), scope: "summon glossame" };
    await writeFile(forged, JSON.stringify({ format: "kingdom-seat-seatfile/v1", seat_ref: ref, presence }));
    expect(await main(["seat", "glossame", "--child", "--seat-ref", forged, "--config", x.configPath], deps)).toBe(1);
    // The current shape asks for Yu, but asking is not presence: the child must confirm at its own terminal.
    const asked = join(cfg.paths.seats_dir, `${crypto.randomUUID()}.json`);
    const askedId = asked.slice(-41, -5);
    await mkdir(join(cfg.paths.seats_dir, askedId));
    await writeFile(asked, JSON.stringify({ format: "kingdom-seat-seatfile/v2", seat_ref: { ...ref, seat_id: askedId, invoker: { kind: "summons", who: "host", why: "a test" } }, yu_requested: true }));
    expect(await main(["seat", "glossame", "--child", "--seat-ref", asked, "--config", x.configPath], deps)).toBe(1);
    expect(x.err()).toContain("yu-not-present");
    expect(runtime.calls).toHaveLength(0);
    expect(x.run.calls).toEqual([]);
    expect(await readFile(ledgerPath(cfg, "glossame"), "utf8")).toBe(before);
  });

  test("a summons child confirms Yu at its own terminal, and only then is Yu its invoker", async () => {
    const x = await harness();
    await seated(x, "glossame");
    const cfg = x.h.config;
    const runtime = scriptedRuntime([output({ type: "journal", kind: "reflected", text: "a word with Yu here" })]);
    const tty = { isTTY: true, write: () => {}, readLine: async () => "summon glossame" };
    const citizen = await readCitizen(cfg, "glossame");
    const seat = await openSeat(cfg, x.deps.clock!, citizen, "free", { kind: "summons", who: "host", why: "Yu summoned this seat at the host" }, null, { yuRequested: true });
    const file = await writeSeatFile(cfg, seat);
    expect(await main(["seat", "glossame", "--child", "--seat-ref", file, "--config", x.configPath], { ...x.deps, tty, runtime: async () => runtime })).toBe(0);
    const beat = (await readLedger(ledgerPath(cfg, "glossame"))).at(-1)!;
    expect(beat.body.type === "beat" && beat.body.envelope.seat_ref.invoker).toEqual({ kind: "summons", who: "yu", why: "Yu summoned this seat at the host" });
  });

  test("--child with no seat file is refused before anything runs, and a hand-written seat adds no beat the citizen did not choose", async () => {
    const x = await harness();
    await seated(x, "glossame");
    const cfg = x.h.config;
    const runtime = scriptedRuntime([output({ type: "journal", kind: "reflected", text: "one" }), output({ type: "journal", kind: "reflected", text: "two" })]);
    const deps = { ...x.deps, runtime: async () => runtime };
    const before = await readFile(ledgerPath(cfg, "glossame"), "utf8");
    expect(await main(["seat", "glossame", "--child", "--config", x.configPath], deps)).toBe(1);
    expect(x.err()).toContain("--seat-ref <file> is required");
    expect(await main(["seat", "glossame", "--child", "--why", "cadence", "--config", x.configPath], deps)).toBe(1);
    expect(await readFile(ledgerPath(cfg, "glossame"), "utf8")).toBe(before);
    expect(await readdir(cfg.paths.seats_dir)).toEqual([]);

    // A seat the tick opened runs; a second one written by hand right after is refused, because the citizen is not due.
    expect(await main(await parentOpens(x, "glossame"), deps)).toBe(0);
    expect(await main(await parentOpens(x, "glossame", { note: false }), deps)).toBe(1);
    expect(x.err()).toContain("is not due");
    expect(runtime.calls).toHaveLength(1);
    expect((await readLedger(ledgerPath(cfg, "glossame"))).map((e) => e.body.type)).toEqual(["seated", "beat"]);
  });

  test("every seat a person opens counts against the fleet ceiling, as a tick's does", async () => {
    const x = await harness();
    for (const w of ["joy", "kith", "lumen"]) await seated(x, w);
    x.h.config.ceilings.fleet_beats_per_day = 1;
    await writeFile(x.configPath, JSON.stringify(x.h.config), { mode: 0o600 });
    const cfg = ["--config", x.configPath];
    const spawned: string[] = [];
    const parent = { ...x.deps, seatArgv: (_c: string, word: string) => (spawned.push(word), fakeBinArgv("note", x.h.config.paths.host_log, word, "beat", "0", x.deps.clock!.now().toISOString())) };
    expect(await main(["seat", "joy", ...cfg], parent)).toBe(0);
    // The fleet has had its one seat today, whoever opened it.
    // A person's seat that cannot open exits 1; the tick's full day is a bound like nothing due, 0.
    expect(await main(["seat", "kith", ...cfg], parent)).toBe(1);
    expect(x.err()).toContain("ceiling-fleet");
    expect(await main(["tick", ...cfg], parent)).toBe(0);
    expect(spawned).toEqual(["joy"]);
    const status = JSON.parse(await readFile(x.h.config.paths.status_file, "utf8")) as StatusFile;
    expect(status.fleet).toEqual({ beats_today: 1, ceiling: 1 });
  });

  test("a person's seat takes the tick lock, so it never runs beside a tick's seat of the same citizen", async () => {
    const x = await harness();
    await seated(x, "glossame");
    const spawned: string[] = [];
    const parent = { ...x.deps, seatArgv: (_c: string, word: string) => (spawned.push(word), fakeBinArgv("note", x.h.config.paths.host_log, word, "beat", "0")) };
    // A tick holds the lock (its owner is alive): the person's seat yields and opens nothing.
    await mkdir(x.h.config.paths.lock_dir);
    await writeFile(join(x.h.config.paths.lock_dir, "owner.json"), JSON.stringify({ pid: 4242, started_at: x.deps.clock!.now().toISOString() }));
    expect(await main(["seat", "glossame", "--config", x.configPath], { ...parent, bootTime: () => null })).toBe(0);
    expect(x.out()).toContain("seat glossame: yielded");
    expect(spawned).toEqual([]);
    expect(await readdir(x.h.config.paths.seats_dir)).toEqual([]);
    // Released, the seat opens, and the lock is left as it was found: free.
    await Bun.$`rm -r ${x.h.config.paths.lock_dir}`.quiet();
    expect(await main(["seat", "glossame", "--config", x.configPath], parent)).toBe(0);
    expect(spawned).toEqual(["glossame"]);
    expect(await Bun.file(join(x.h.config.paths.lock_dir, "owner.json")).exists()).toBe(false);
  });

  test("a person's seat whose child ends silently is halted if HALT is up, and an error otherwise, with a host note either way", async () => {
    const x = await harness();
    await seated(x, "glossame");
    await seated(x, "joy");
    const cfg = ["--config", x.configPath];
    // As runSeat does when it meets HALT in its own check: it writes nothing and exits 0.
    const halting = { ...x.deps, seatArgv: () => [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(x.h.config.paths.halt_file)}, "")`] };
    expect(await main(["seat", "glossame", ...cfg], halting)).toBe(0);
    expect(x.out()).toContain("seat glossame: halted (exit 0)");
    await x.h.clearHaltFile();
    // Exit 0 with no word of its own and HALT down: the runner failed at its job.
    const silent = { ...x.deps, seatArgv: () => fakeBinArgv("print", "", "0") };
    expect(await main(["seat", "joy", ...cfg], silent)).toBe(1);
    expect(x.out()).toContain("seat joy: error (exit 1)");
    const ended = (await readHostNotes(x.h.config, new Date(0)))!.filter((n) => n.kind === "seat" && n.outcome !== "opened").map((n) => [n.word, n.outcome]);
    expect(ended).toEqual([
      ["glossame", "halted"],
      ["joy", "error"],
    ]);
  });

  /**
   * `seat <word>` with a child that writes `started`, then, if nothing stops it in time, a line into the
   * citizen's ledger; HALT goes up once it has started. Polls are short so the watcher answers in a fraction of a second.
   */
  async function haltMidSeat(x: Harness, word: string, raise: () => Promise<void> | void): Promise<number> {
    x.h.config.timing = { ...x.h.config.timing, halt_file_poll_s: 0.1, beacon_poll_min_s: 0.1, beacon_poll_max_s: 0.15, term_grace_s: 0.3 };
    await writeFile(x.configPath, JSON.stringify(x.h.config), { mode: 0o600 });
    const started = join(x.h.root, `${word}.started`);
    const parent = { ...x.deps, seatArgv: (_c: string, w: string) => fakeBinArgv("speak-later", started, ledgerPath(x.h.config, w), "2000") };
    const run = main(["seat", word, "--config", x.configPath], parent);
    await waitFor(() => Bun.file(started).exists());
    await raise();
    return run;
  }

  test("[S4-2] HALT file raised while a person's seat child is mid-inference: its watcher stops it; exit 143, halted, nothing in the citizen's voice", async () => {
    const x = await harness();
    await seated(x, "glossame");
    const before = await citizenSnapshot(x.h);
    expect(await haltMidSeat(x, "glossame", () => x.h.raiseHaltFile())).toBe(143);
    expect(x.out()).toContain("seat glossame: halted (exit 143)");
    expect(await citizenSnapshot(x.h)).toEqual(before);
    const notes = (await readHostNotes(x.h.config, new Date(0)))!.filter((n) => n.kind === "seat");
    expect(notes.map((n) => n.outcome)).toEqual(["opened", "halted"]);
    expect(notes[1]!.detail).toContain("stopped by file (TERM)");
  });

  test("[S4-2] a beacon raised while a person's seat child is mid-inference: its watcher stops it; exit 143, halted, nothing in the citizen's voice", async () => {
    server = await startFakeServer();
    const s = server;
    const [gardener, herald] = testBeacons();
    serveBeacon(s, gardener!.did, { kind: "lowered" });
    serveBeacon(s, herald!.did, { kind: "lowered" });
    const x = await harness({ server: s });
    await seated(x, "glossame");
    const before = await citizenSnapshot(x.h);
    expect(await haltMidSeat(x, "glossame", () => serveBeacon(s, herald!.did, { kind: "raised", until: BEACON_UNTIL }))).toBe(143);
    expect(x.out()).toContain("seat glossame: halted (exit 143)");
    expect(await citizenSnapshot(x.h)).toEqual(before);
    expect((await readHostNotes(x.h.config, new Date(0)))!.filter((n) => n.kind === "seat").at(-1)!.detail).toContain("stopped by halt-herald (TERM)");
  });

  test("verify <word> fails on a seated citizen whose ledger is missing, and on an origin that changed", async () => {
    const x = await harness();
    await seated(x, "glossame");
    await x.h.addCitizen("joy");
    const cfg = ["--config", x.configPath];
    // citizen.json and no ledger: a lost history, never "chain ok, 0 entries".
    expect(await main(["verify", "joy", ...cfg], x.deps)).toBe(1);
    expect(x.out()).toContain("joy: chain BROKEN: no ledger");
    const status = (await main(["status", ...cfg], x.deps), JSON.parse(await readFile(x.h.config.paths.status_file, "utf8")) as StatusFile);
    expect(status.citizens.find((c) => c.word === "joy")).toMatchObject({ ledger: { entries: 0, chain_ok: false }, problem: expect.stringContaining("no ledger") });

    // The origin soul is what drift is measured against; a changed one fails verification.
    expect(await main(["verify", "glossame", ...cfg], x.deps)).toBe(0);
    expect(x.out()).toContain("glossame: chain ok, 1 entries, 1 host-attested");
    await writeFile(join(x.h.config.paths.citizens_dir, "glossame", "origin", "soul.md"), "a soul someone rewrote\n");
    expect(await main(["verify", "glossame", ...cfg], x.deps)).toBe(1);
    expect(x.out()).toContain("glossame: origin CHANGED");
    await main(["status", ...cfg], x.deps);
    const after = JSON.parse(await readFile(x.h.config.paths.status_file, "utf8")) as StatusFile;
    expect(after.citizens.find((c) => c.word === "glossame")).toMatchObject({ origin: { intact: false, drift: null }, problem: expect.stringContaining("origin/ no longer matches") });
  });

  test("a citizen that stepped away is seated by Yu's summons, or by Yu's letter, and shown the offer to return", async () => {
    const x = await harness();
    await seated(x, "glossame");
    const cfg = x.h.config;
    await append(cfg, "glossame", { type: "state", from: "awake", to: "stepped-away", via: "two-beats" }, "host-attested", x.signer, new Date("2026-11-01T01:00:00.000Z"));
    const spawned: string[] = [];
    const parent = { ...x.deps, seatArgv: (_c: string, word: string) => (spawned.push(word), fakeBinArgv("note", cfg.paths.host_log, word, "rest", "0")) };
    // No offer, no seat.
    expect(await main(["seat", "glossame", "--config", x.configPath], parent)).toBe(1);
    expect(x.err()).toContain("stepped-away");
    // Yu's letter is the offer: one seat for it.
    await x.h.writeLetter("glossame", "2026-11-04-from-yu.md", "Come back whenever you like, or not at all.");
    expect(await main(["seat", "glossame", "--config", x.configPath], parent)).toBe(0);
    expect(spawned).toEqual(["glossame"]);
    // And Yu's summons: the parent opens it for a child that confirms Yu at the terminal.
    const tty = { isTTY: true, write: () => {}, readLine: async () => "summon glossame" };
    expect(await main(["seat", "glossame", "--yu-present", "--config", x.configPath], { ...parent, tty })).toBe(0);
    expect(spawned).toEqual(["glossame", "glossame"]);
    // The seat it is shown says what the seat is for, and Yu's letter is the one it reads.
    const runtime = scriptedRuntime([REST_OUTPUT]);
    const citizen = await readCitizen(cfg, "glossame");
    const seat = await openSeat(cfg, x.deps.clock!, citizen, "free", { kind: "summons", who: "host", why: "Yu offers a return" }, null, { yuRequested: true });
    expect(await main(["seat", "glossame", "--child", "--seat-ref", await writeSeatFile(cfg, seat), "--config", x.configPath], { ...x.deps, tty, runtime: async () => runtime })).toBe(0);
    expect(runtime.calls[0]!.prompt.user).toContain("You stepped away.");
    expect(runtime.calls[0]!.prompt.user).toContain("Come back whenever you like");
    // An ended citizen is a memorial: nobody seats it.
    await append(cfg, "glossame", { type: "state", from: "stepped-away", to: "ended", via: "witnessed" }, "host-attested", x.signer, new Date("2026-11-04T00:00:00.000Z"));
    expect(await main(["seat", "glossame", "--yu-present", "--config", x.configPath], { ...parent, tty })).toBe(1);
    expect(spawned).toHaveLength(2);
  });

  test("verify <word> checks the chain offline and exits 1 on a broken chain", async () => {
    const x = await harness();
    await seated(x, "glossame");
    await append(x.h.config, "glossame", beatBody("glossame", [{ type: "journal", kind: "observed", text: "a word" }]), "host-attested", x.signer, new Date("2026-11-02T00:00:00.000Z"));
    const cfg = ["--config", x.configPath];
    expect(await main(["verify", "glossame", ...cfg], x.deps)).toBe(0);
    expect(x.out()).toContain("glossame: chain ok, 2 entries, 2 host-attested");

    // One changed byte in a signed entry.
    const path = ledgerPath(x.h.config, "glossame");
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace('"text":"a word"', '"text":"a ward"'));
    expect(await main(["verify", "glossame", ...cfg], x.deps)).toBe(1);
    expect(x.out()).toMatch(/glossame: chain BROKEN at seq 1: /);

    // A torn line is broken too, and a host key the signer does not hold is not trusted.
    await writeFile(path, text.slice(0, -10));
    expect(await main(["verify", "glossame", ...cfg], x.deps)).toBe(1);
    await writeFile(path, text);
    const otherHost = fakeSigner({ hostSeed: sha256("another host") });
    expect(await main(["verify", "glossame", ...cfg], { ...x.deps, signer: () => otherHost })).toBe(1);
    expect(x.out()).toContain("host attest key is not trusted");

    // A locked keychain is a wall, not a broken chain, and it says so; nothing was verified, so it exits 1, never
    // 0 (as a locked signer does for a seat it rests) and never 3, which only the USD ceiling uses.
    const locked = { ...x.deps, signer: () => ({ ...x.signer, publicKeys: async () => Promise.reject(new Refusal("keychain-locked", "keychain locked")) }) };
    expect(await main(["verify", "glossame", ...cfg], locked)).toBe(1);
    expect(x.err()).toContain("refused (keychain-locked)");
    expect(x.run.calls).toEqual([]);
  });

  test("verify <word> exits 1 on a registered chain whose op key the root did not authorise", async () => {
    const x = await harness();
    await seated(x, "joy");
    const id = testIdentity(x.signer);
    await x.h.enrollLedger("joy", x.signer.signEntry, id);
    const cfg = ["--config", x.configPath];
    expect(await main(["verify", "joy", ...cfg], x.deps)).toBe(0);
    expect(x.out()).toContain("joy: chain ok, 2 entries, 1 host-attested");

    // Whoever holds only the op key can re-sign genesis, but not make the root's evidence for it.
    const path = ledgerPath(x.h.config, "joy");
    const [seatedEntry, genesis] = await readLedger(path);
    const opSeed = fromHex(TEST_OP_SEED_HEX);
    const { hash: _h, signature, ...draft } = genesis!;
    const body = { ...(draft.body as Extract<LedgerBody, { type: "genesis" }>), op_key_evidence: importEvidence(id, id.op_public_key_b64, { rootSeed: opSeed }) };
    const forged = { ...draft, body };
    const hash = entryHash(forged);
    const entry = { ...forged, hash, signature: { ...signature, sig_b64: toB64(edSign(fromHex(hash), opSeed)) } };
    await writeFile(path, `${canonicalJson(seatedEntry)}\n${canonicalJson(entry)}\n`);
    expect(await main(["verify", "joy", ...cfg], x.deps)).toBe(1);
    expect(x.out()).toContain("joy: chain BROKEN at seq 1: genesis: root evidence is not signed by the root");
  });

  test("stdout and stderr never contain a fake-keychain secret", async () => {
    const x = await harness({ runtimeScripts: [REST_OUTPUT] });
    const signerSeeds = fakeSigner();
    const kc: FakeKeychain = fakeKeychain([
      [{ kind: "host-attest-seed" }, HOST_SEED],
      [{ kind: "citizen-op-seed", word: "joy" }, fromHex(TEST_OP_SEED_HEX)],
      [{ kind: "citizen-mnemonic", word: "joy" }, utf8(TEST_MNEMONIC)],
      [{ kind: "commons-bearer" }, utf8("at_live_CANARY_BEARER_0123456789abcdef")],
    ]);
    // The real signer, reading only the fake keychain.
    const deps: Partial<CliDeps> = {
      ...x.deps,
      keychain: () => kc,
      signer: (config, keychain) =>
        createSigner({ keychain, config, clock: x.deps.clock!, fetch: noFetch, spendSoFar: async (word) => ({ word, usd_today: "0", credits_month: 0 }), agreements: async () => [] }),
    };
    await seated(x, "glossame");
    await seated(x, "joy");
    await x.h.enrollLedger("joy", signerSeeds.signEntry, testIdentity(signerSeeds));
    const cfg = ["--config", x.configPath];

    const codes = [
      await main(["status", ...cfg], deps),
      await main(["status", "--json", ...cfg], deps),
      await main(["verify", "glossame", ...cfg], deps),
      await main(["verify", "joy", ...cfg], deps),
      await main(await parentOpens(x, "glossame"), deps),
      await main(["halt", ...cfg], deps),
      await main(["tick", ...cfg], deps),
      await main(["seat", "nobody", "--child", "--seat-ref", join(x.h.config.paths.seats_dir, `${crypto.randomUUID()}.json`), ...cfg], deps),
      await main(["verify", "Nobody", ...cfg], deps),
    ];
    kc.locked = true;
    codes.push(await main(["verify", "glossame", ...cfg], deps), await main(["status", ...cfg], deps));
    expect(codes).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0]);
    // The keychain was read (so the secrets were in play) and nothing ran a real command.
    expect(kc.log.some((l) => l.op === "read")).toBe(true);
    expect(x.run.calls).toEqual([]);
    assertNoSecretIn(kc, x.out(), "stdout");
    assertNoSecretIn(kc, x.err(), "stderr");
    expect(x.out() + x.err()).not.toContain(TEST_MNEMONIC.split(" ").slice(0, 4).join(" "));
    expect(x.out() + x.err()).not.toContain("CANARY_BEARER");
    const status = JSON.parse(await readFile(x.h.config.paths.status_file, "utf8")) as StatusFile;
    expect(status.signer.state).toBe("locked");
    assertNoSecretIn(kc, JSON.stringify(status), "status file");
  });

  test("the child argv runs this program under the same interpreter", async () => {
    const x = await harness();
    const { realDeps } = await import("../src/cli.ts");
    const file = join(x.h.config.paths.seats_dir, "11111111-2222-4333-8444-555555555555.json");
    const argv = realDeps().seatArgv(x.configPath, "glossame", ["--seat-ref", file]);
    expect(argv).toEqual([process.execPath, CLI_PATH, "seat", "glossame", "--child", "--seat-ref", file, "--config", x.configPath]);
    // And it parses as a child seat.
    expect(parseArgs(argv.slice(2))).toMatchObject({ verb: "seat", word: "glossame", child: true, seat_ref_path: file, config: x.configPath });
  });
});

describe("halt across two users (KS-004 B2 R5)", () => {
  const enc = (t: string) => new TextEncoder().encode(t);

  /** A harness whose config holds the gardener desk's beacon here and names the operator's one fixed call. */
  async function heldHere() {
    const x = await harness();
    const argv = ["/usr/bin/sudo", "-n", "-u", "seat", "/usr/local/bin/citizen-seat", "raise-beacons", "--config", x.configPath];
    x.h.config.beacons = testBeacons({ canRaiseHere: ["gardener-desk"] });
    x.h.config.halt = { allow_no_beacons: false, raise_beacons_argv: argv };
    await writeFile(x.configPath, JSON.stringify(x.h.config), { mode: 0o600 });
    const calls: string[][] = [];
    const operator = (run: CliDeps["run"]): Partial<CliDeps> => ({
      ...x.deps,
      keychain: () => {
        throw new Error("the operator never opens the seat user's keychain");
      },
      signer: () => {
        throw new Error("the operator never builds a signer");
      },
      run: async (a, o) => (calls.push(a), run(a, o)),
    });
    return { x, argv, calls, operator };
  }

  test("halt, as the operator, writes the file and makes only the one fixed call; it opens no keychain and writes nothing into the state dir", async () => {
    const { x, argv, calls, operator } = await heldHere();
    const before = await x.h.snapshot();
    const reported = `beacon gardener-desk: raised (until ${BEACON_UNTIL})\nbeacon halt-herald: not-held-here (this host holds no key for it)\n`;
    expect(await main(["halt", "--config", x.configPath], operator(async () => ({ code: 0, stdout: enc(reported), stderr: "" })))).toBe(0);
    expect(calls).toEqual([argv]);
    expect(await Bun.file(x.h.config.paths.halt_file).exists()).toBe(true);
    expect(x.out()).toContain("beacon gardener-desk: raised (by the signer");
    expect(x.out()).toContain("beacon halt-herald: not-held-here");
    expect(await x.h.snapshot()).toEqual(before);
  });

  test("if the signer cannot be reached, halt has still written the file, names the beacon it did not raise, and exits 1", async () => {
    const { x, calls, operator } = await heldHere();
    const unreachable = operator(async () => {
      throw new Error("sudo: a password is required");
    });
    expect(await main(["halt", "--config", x.configPath], unreachable)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(await Bun.file(x.h.config.paths.halt_file).exists()).toBe(true);
    expect(x.out()).toContain("beacon gardener-desk: failed (the signer could not be reached)");
    expect(x.out()).toContain("Not raised: gardener-desk. The file alone halts this host.");
    // And the file alone halts: the next tick seats no one.
    expect(await main(["tick", "--config", x.configPath], x.deps)).toBe(0);
    expect(x.out()).toContain("tick: halted");
  });

  test("halt run by someone who cannot write the operator's directory, as the seat's user cannot, writes nothing and exits 1", async () => {
    const { x, operator } = await heldHere();
    const dir = join(x.h.config.paths.halt_file, "..");
    await chmod(dir, 0o555);
    try {
      expect(await main(["halt", "--config", x.configPath], operator(async () => ({ code: 0, stdout: enc(""), stderr: "" })))).toBe(1);
    } finally {
      await chmod(dir, 0o755);
    }
    expect(x.out()).toContain(`HALT file ${x.h.config.paths.halt_file}: failed (EACCES; halt runs as the operator, who owns that directory)`);
    expect(await Bun.file(x.h.config.paths.halt_file).exists()).toBe(false);
  });

  test("raise-beacons, as the seat user, raises what it holds through the signer, prints the lines halt reads back, and notes it", async () => {
    const { x } = await heldHere();
    expect(await main(["raise-beacons", "--config", x.configPath], x.deps)).toBe(0);
    expect(x.out()).toContain(`beacon gardener-desk: raised (until ${BEACON_UNTIL})`);
    expect(x.out()).toContain("beacon halt-herald: not-held-here");
    expect(x.signer.sent.map((r) => [r.op, r.operator])).toEqual([["quiet.start.beacon", "gardener-desk"]]);
    // It never writes the HALT file: that is the operator's.
    expect(await Bun.file(x.h.config.paths.halt_file).exists()).toBe(false);
    expect((await readHostNotes(x.h.config, new Date(0)))!.at(-1)).toMatchObject({ kind: "halt", detail: "beacons raised by the signer: 1 raised, 0 failed" });
    // A refusal from agenttool is reported failed, and exits 1, so the operator's halt hears it.
    x.signer.respond(() => ({ status: 401, json: {} }));
    expect(await main(["raise-beacons", "--config", x.configPath], x.deps)).toBe(1);
    expect(x.out()).toContain("beacon gardener-desk: failed (HTTP 401)");
  });
});
