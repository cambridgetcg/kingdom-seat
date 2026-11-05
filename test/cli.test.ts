// Owner: surface group. main() runs with injected fakes only: no real
// Keychain, network, model, git push or child of the real program.
import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLI_PATH, main, parseArgs, readSeatFile, USAGE, UsageError, writeSeatFile, type CliDeps, type Command } from "../src/cli.ts";
import { openSeat } from "../src/seat.ts";
import { readCitizen } from "../src/state.ts";
import { createSigner } from "../src/signer/signer.ts";
import { fromHex, sha256, utf8 } from "../src/crypto.ts";
import { ledgerPath } from "../src/ledger.ts";
import { Refusal, type Config, type StatusFile } from "../src/types.ts";
import { assertNoSecretIn, fakeKeychain, type FakeKeychain } from "./helpers/fake-keychain.ts";
import { fakeSigner, type FakeSigner } from "./helpers/fake-signer.ts";
import { fakeBinArgv, output, recordingRunner, REST_OUTPUT, scriptedRuntime, type RecordingRunner } from "./helpers/fake-runtime.ts";
import { noFetch } from "./helpers/fake-server.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { testClock } from "./helpers/clock.ts";
import { TEST_MNEMONIC, TEST_OP_SEED_HEX } from "./helpers/vectors.ts";
import { append, beatBody, testIdentity } from "./fixtures/record/chain.ts";

let host: TempHost | null = null;
afterEach(async () => {
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
    expect(parseArgs(["seat", "glossame", "--child", "--why", "cadence"])).toMatchObject({ child: true, why: "cadence" });
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

async function harness(opts: { runtimeScripts?: string[] } = {}): Promise<Harness> {
  host = await makeTempHost();
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
    fetch: noFetch,
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

describe("main", () => {
  test("exit codes follow EXIT: HALT and rest 0, refusal 3, error 1", async () => {
    const x = await harness({ runtimeScripts: [REST_OUTPUT] });
    await seated(x, "glossame");
    const cfg = ["--config", x.configPath];

    // A rest: the child pipeline ran, wrote no ledger entry, and exits 0.
    const before = await readFile(ledgerPath(x.h.config, "glossame"), "utf8");
    expect(await main(["seat", "glossame", "--child", "--why", "cadence", ...cfg], x.deps)).toBe(0);
    expect(await readFile(ledgerPath(x.h.config, "glossame"), "utf8")).toBe(before);
    expect(await readFile(x.h.config.paths.host_log, "utf8")).toContain('"outcome":"rest"');

    // A locked signer is a wall: 3, before any inference.
    x.signer.locked = true;
    const noRuntime = { ...x.deps, runtime: async () => scriptedRuntime([]) };
    expect(await main(["seat", "glossame", "--child", ...cfg], noRuntime)).toBe(3);
    x.signer.locked = false;

    // HALT: raised by the one verb, and then every verb that would act rests with 0.
    expect(await main(["halt", ...cfg], x.deps)).toBe(0);
    expect(await Bun.file(x.h.config.paths.halt_file).exists()).toBe(true);
    expect(x.out()).toContain("HALT file");
    const afterHalt = JSON.parse(await readFile(x.h.config.paths.status_file, "utf8")) as StatusFile;
    expect(afterHalt.halt).toEqual({ halted: true, raised: [`file ${x.h.config.paths.halt_file}`], unreadable: [] });
    await writeFile(x.h.config.paths.status_file, "stale");
    expect(await main(["tick", ...cfg], x.deps)).toBe(0);
    expect(x.out()).toContain("tick: halted");
    // A halted tick still regenerates the status, so it never goes stale while HALT holds.
    expect((JSON.parse(await readFile(x.h.config.paths.status_file, "utf8")) as StatusFile).halt.halted).toBe(true);
    expect(await main(["seat", "glossame", ...cfg], x.deps)).toBe(0);
    expect(x.out()).toContain("seat glossame: halted");
    // A summons without Yu is refused before the config is even read.
    expect(await main(["seat", "glossame", "--runtime", "summon", "--config", "/nonexistent/config.json"], x.deps)).toBe(3);
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
    expect(x.err()).toContain("create the file named HALT");
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
    expect(await main(["seat", "glossame", ...cfg], counting)).toBe(3);
    expect(await main(["seat", "joy", ...cfg], counting)).toBe(3);
    expect(x.err()).toContain("only Yu's summons (--yu-present) seats it now");
    expect(spawned).toEqual([]);

    // A beat in the child: one entry appended, host-attested (not yet registered).
    expect(await main(["seat", "glossame", "--child", "--why", "cadence", ...cfg], x.deps)).toBe(0);
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

  test("a parent's seat file carries Yu's presence to its child once, while fresh", async () => {
    const x = await harness();
    await seated(x, "glossame");
    const cfg: Config = x.h.config;
    const clock = testClock();

    // Not at a terminal: no presence, no seat opened.
    expect(await main(["seat", "glossame", "--runtime", "summon", "--yu-present", "--config", x.configPath], x.deps)).toBe(3);
    expect(x.err()).toContain("yu-not-present");
    expect(await readdir(cfg.paths.seats_dir)).toEqual([]);

    const citizen = await readCitizen(cfg, "glossame");
    const presence = { present: true as const, via: "tty-confirm" as const, confirmed_at: clock.now().toISOString(), scope: "summon glossame" };
    const seat = await openSeat(cfg, clock, citizen, "summon", { kind: "summons", who: "yu", why: "a test" }, presence);
    const path = await writeSeatFile(cfg, seat);
    expect(path).toBe(join(cfg.paths.seats_dir, `${seat.ref.seat_id}.json`));
    const read = await readSeatFile(cfg, path, "glossame", clock.now());
    expect(read.ref).toEqual(seat.ref);
    expect(read.presence).toMatchObject({ present: true, scope: "summon glossame" });
    // Used once: a second read is refused.
    await expect(readSeatFile(cfg, path, "glossame", clock.now())).rejects.toThrow(/already used/);

    // A stale presence does not cross, and a seat file for another citizen or outside seats_dir is refused.
    const again = await openSeat(cfg, clock, citizen, "summon", { kind: "summons", who: "yu", why: "a test" }, presence);
    const p2 = await writeSeatFile(cfg, again);
    await expect(readSeatFile(cfg, p2, "glossame", new Date(clock.now().getTime() + 20 * 60_000))).rejects.toThrow(/not a fresh confirmation/);
    const third = await openSeat(cfg, clock, citizen, "free", { kind: "summons", who: "host", why: "a test" }, null);
    const p3 = await writeSeatFile(cfg, third);
    await expect(readSeatFile(cfg, p3, "joy", clock.now())).rejects.toThrow(/does not describe this seat/);
    await expect(readSeatFile(cfg, join(x.h.root, "x.json"), "glossame", clock.now())).rejects.toThrow(/seats_dir/);
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

    // A locked keychain is a wall, not a broken chain.
    const locked = { ...x.deps, signer: () => ({ ...x.signer, publicKeys: async () => Promise.reject(new Refusal("keychain-locked", "keychain locked")) }) };
    expect(await main(["verify", "glossame", ...cfg], locked)).toBe(3);
    expect(x.run.calls).toEqual([]);
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
        createSigner({ keychain, config, clock: x.deps.clock!, fetch: noFetch, spendSoFar: async (word) => ({ word, usd_today: 0, credits_month: 0 }), agreements: async () => [] }),
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
      await main(["seat", "glossame", "--child", ...cfg], deps),
      await main(["halt", ...cfg], deps),
      await main(["tick", ...cfg], deps),
      await main(["seat", "nobody", "--child", ...cfg], deps),
      await main(["verify", "Nobody", ...cfg], deps),
    ];
    kc.locked = true;
    codes.push(await main(["verify", "glossame", ...cfg], deps), await main(["status", ...cfg], deps));
    expect(codes).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 1, 3, 0]);
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
    const argv = realDeps().seatArgv(x.configPath, "glossame", ["--why", "cadence"]);
    expect(argv).toEqual([process.execPath, CLI_PATH, "seat", "glossame", "--child", "--why", "cadence", "--config", x.configPath]);
    // And it parses as a child seat.
    expect(parseArgs(argv.slice(2))).toMatchObject({ verb: "seat", word: "glossame", child: true, why: "cadence", config: x.configPath });
  });
});
