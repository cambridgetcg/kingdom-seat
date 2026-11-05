// Owner: surface group.
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, defaultConfig, defaultConfigPath, loadConfig, parseConfig } from "../src/config.ts";
import { DEFAULT_CEILINGS, DEFAULT_TIMING, type Config } from "../src/types.ts";
import { testBeacons, testConfig } from "./helpers/temp-home.ts";

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

async function tempDir(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), "kingdom-seat-config-")));
  dirs.push(d);
  return d;
}

/** A config that parses: the temp-host shape with both beacons pinned. */
function good(): Config {
  return testConfig("/srv/seat-test", "/srv/seat-test/homes", { beacons: testBeacons() });
}

/** A deep copy as plain JSON, so a test can break one field of an untrusted object. */
function raw(c: Config = good()): any {
  return JSON.parse(JSON.stringify(c));
}

function refuses(value: unknown, field: RegExp | string): void {
  let err: unknown = null;
  try {
    parseConfig(value);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ConfigError);
  expect((err as Error).message).toMatch(field);
}

describe("config", () => {
  test("defaultConfig uses DEFAULT_CEILINGS and DEFAULT_TIMING and absolute paths under the state dir", () => {
    const state = "/Users/seat/Library/Application Support/kingdom-seat";
    const c = defaultConfig(state, "studio");
    expect(c.ceilings).toEqual({ ...DEFAULT_CEILINGS });
    expect(c.timing).toEqual({ ...DEFAULT_TIMING });
    // Copies, so editing one host's config never moves the shared defaults.
    expect(c.ceilings).not.toBe(DEFAULT_CEILINGS);
    for (const [k, p] of Object.entries(c.paths)) {
      if (k === "homes" || k === "state_dir" || k === "halt_file") continue;
      expect(p as string).toStartWith(`${state}/`);
    }
    expect(c.paths.state_dir).toBe(state);
    // HALT lives where the operator, not the seat user, can write (KS-004 B2 R5).
    expect(c.paths.halt_file).toBe("/Users/Shared/kingdom-seat/HALT");
    expect(c.halt).toEqual({ allow_no_beacons: false, raise_beacons_argv: null });
    expect(c.schedule).toEqual({ wake_confirm_seat: true });
    expect(c.agenttool.origin).toBe("https://api.agenttool.dev");
    expect(c.ollama.base_url).toBe("http://127.0.0.1:11434");
    expect(c.keychain.security_path).toBe("/usr/bin/security");
    expect(defaultConfigPath("/Users/seat")).toBe("/Users/seat/Library/Application Support/kingdom-seat/config.json");

    // Fail closed: a fresh default pins no beacon, so it does not parse until a person pins them.
    refuses(raw(c), /beacons: no beacon is pinned/);
    const pinned = parseConfig({ ...raw(c), beacons: testBeacons() });
    expect(pinned.ceilings).toEqual({ ...DEFAULT_CEILINGS });
    expect(pinned.paths).toEqual(c.paths);
  });

  test("parseConfig accepts the temp-host shape and returns a fresh object", () => {
    const input = raw();
    const c = parseConfig(input);
    expect(c).toEqual(good());
    expect(c).not.toBe(input);
    expect(c.paths).not.toBe(input.paths);
    // Omitted ceilings and timing keep the defaults; one override is kept.
    const partial = raw();
    partial.ceilings = { fleet_beats_per_day: 4 };
    delete partial.timing;
    delete partial.self_authorship;
    const p = parseConfig(partial);
    expect(p.ceilings).toEqual({ ...DEFAULT_CEILINGS, fleet_beats_per_day: 4 });
    expect(p.timing).toEqual({ ...DEFAULT_TIMING });
    expect(p.self_authorship).toEqual({ approved_model_digests: [] });
  });

  test("parseConfig refuses unknown keys, relative paths and a state dir inside a home", () => {
    refuses({ ...raw(), extra: 1 }, /unknown key "extra"/);
    const nested = raw();
    nested.paths.halt_path = "/srv/seat-test/state/HALT";
    refuses(nested, /paths: unknown key "halt_path"/);
    const ceil = raw();
    ceil.ceilings.fleet_beat_per_day = 4; // a typo meant to tighten a wall is refused, not ignored
    refuses(ceil, /ceilings: unknown key/);
    const missing = raw();
    delete missing.keychain;
    refuses(missing, /missing key "keychain"/);

    const rel = raw();
    rel.paths.state_dir = "state";
    refuses(rel, /paths.state_dir: must be an absolute path/);
    const dots = raw();
    dots.paths.ledger_dir = "/srv/seat-test/state/../ledger";
    refuses(dots, /paths.ledger_dir: must be a normalised path/);
    const relHome = raw();
    relHome.paths.homes = ["homes"];
    refuses(relHome, /paths.homes\[0\]: must be an absolute path/);
    const outside = raw();
    outside.paths.ledger_dir = "/srv/elsewhere/ledger";
    refuses(outside, /paths.ledger_dir: must be inside paths.state_dir/);
    const overlap = raw();
    overlap.paths.ledger_dir = join(overlap.paths.citizens_dir, "ledger");
    refuses(overlap, /overlaps paths.citizens_dir/);

    const inHome = raw();
    inHome.paths.homes = ["/srv"];
    refuses(inHome, /paths.state_dir: is inside a citizen home/);
    const homeInState = raw();
    homeInState.paths.homes = ["/srv/seat-test/state/citizens/x"];
    refuses(homeInState, /paths.homes\[0\]: is inside paths.state_dir/);
    const lockInHome = raw();
    lockInHome.paths.models_lock = "/srv/seat-test/homes/citizen-glossame/models.lock";
    refuses(lockInHome, /paths.models_lock: is inside a citizen home/);
  });

  test("parseConfig refuses an Ollama base_url that is not http://127.0.0.1:<port>", () => {
    for (const url of [
      "http://localhost:11434",
      "http://0.0.0.0:11434",
      "http://127.0.0.2:11434",
      "https://127.0.0.1:11434",
      "http://127.0.0.1",
      "http://127.0.0.1:11434/",
      "http://127.0.0.1:11434/api",
      "http://127.0.0.1:0",
      "http://127.0.0.1:99999",
      "http://user@127.0.0.1:11434",
      "http://[::1]:11434",
      "http://ollama.com:443",
    ]) {
      const c = raw();
      c.ollama.base_url = url;
      refuses(c, /ollama.base_url/);
    }
    const ok = raw();
    ok.ollama.base_url = "http://127.0.0.1:8800";
    expect(parseConfig(ok).ollama.base_url).toBe("http://127.0.0.1:8800");
  });

  test("parseConfig refuses any agenttool origin other than https://api.agenttool.dev", () => {
    for (const origin of ["https://api.agenttool.dev/", "http://api.agenttool.dev", "https://agenttool.dev", "https://api.agenttool.dev.evil.example", "http://127.0.0.1:8787"]) {
      const c = raw();
      c.agenttool.origin = origin;
      refuses(c, /agenttool.origin: is pinned/);
    }
    const id = raw();
    id.agenttool.project_id = "NOT-A-UUID";
    refuses(id, /agenttool.project_id/);
  });

  test("parseConfig refuses an empty beacon list unless halt.allow_no_beacons is true", () => {
    const none = raw();
    none.beacons = [];
    none.halt.allow_no_beacons = false;
    refuses(none, /beacons: no beacon is pinned/);
    none.halt.allow_no_beacons = true;
    expect(parseConfig(none).beacons).toEqual([]);

    const dup = raw();
    dup.beacons[1].name = dup.beacons[0].name;
    refuses(dup, /two beacons share the name/);
    const mismatched = raw();
    mismatched.beacons[0].did = mismatched.beacons[1].did;
    refuses(mismatched, /must name the same identity/);
    const nonBool = raw();
    nonBool.halt.allow_no_beacons = "yes";
    refuses(nonBool, /halt.allow_no_beacons: must be true or false/);
  });

  test("parseConfig keeps ceilings fail-closed: no negative, fractional count or quiet cap above 30 days", () => {
    const neg = raw();
    neg.ceilings.usd_per_citizen_per_day = -1;
    refuses(neg, /ceilings.usd_per_citizen_per_day/);
    const frac = raw();
    frac.ceilings.fleet_beats_per_day = 2.5;
    refuses(frac, /ceilings.fleet_beats_per_day: must be a whole number/);
    const quiet = raw();
    quiet.ceilings.citizen_quiet_max_days = 31;
    refuses(quiet, /ceilings.citizen_quiet_max_days/);
    const inf = raw();
    inf.ceilings.min_beat_interval_h = 0;
    refuses(inf, /ceilings.min_beat_interval_h/);
    const timing = raw();
    timing.timing.beacon_poll_min_s = 90;
    refuses(timing, /timing.beacon_poll_min_s/);
    const sec = raw();
    sec.keychain.security_path = "/opt/homebrew/bin/security";
    refuses(sec, /keychain.security_path/);
  });

  test("the USD ceiling is a decimal string, never a float, and the spend record is a written path like the others", () => {
    expect(parseConfig(raw()).ceilings.usd_per_citizen_per_day).toBe("0");
    const raised = raw();
    raised.ceilings.usd_per_citizen_per_day = "2.50";
    expect(parseConfig(raised).ceilings.usd_per_citizen_per_day).toBe("2.5");
    // A JSON number has already been read as a float, so it is refused rather than guessed at.
    for (const bad of [2.5, 0, "-1", "1e2", "", " 2", "2.5 "]) {
      const c = raw();
      c.ceilings.usd_per_citizen_per_day = bad;
      refuses(c, /ceilings.usd_per_citizen_per_day: must be a plain decimal string/);
    }
    const outside = raw();
    outside.paths.spend_log = "/srv/elsewhere/spend.jsonl";
    refuses(outside, /paths.spend_log: must be inside paths.state_dir/);
    const overlap = raw();
    overlap.paths.spend_log = overlap.paths.host_log;
    refuses(overlap, /paths.spend_log: overlaps paths.host_log|paths.host_log: overlaps paths.spend_log/);
    const missing = raw();
    delete missing.paths.spend_log;
    refuses(missing, /paths: missing key "spend_log"/);
  });

  test("loadConfig reads a strict regular file and refuses a symlinked config file", async () => {
    const d = await tempDir();
    const file = join(d, "config.json");
    await writeFile(file, JSON.stringify(good()), { mode: 0o600 });
    expect(await loadConfig(file)).toEqual(good());

    const link = join(d, "link.json");
    await symlink(file, link);
    await expect(loadConfig(link)).rejects.toThrow(/symlink; refused, not followed/);

    // A duplicate key could show a person one value and the code another.
    const dup = join(d, "dup.json");
    const text = JSON.stringify(good());
    await writeFile(dup, text.replace('"host":"test-host"', '"host":"test-host","host":"studio"'), { mode: 0o600 });
    await expect(loadConfig(dup)).rejects.toThrow(/not strict JSON/);

    const writable = join(d, "writable.json");
    await writeFile(writable, text);
    await chmod(writable, 0o666);
    await expect(loadConfig(writable)).rejects.toThrow(/writable by group or others/);

    await expect(loadConfig("relative/config.json")).rejects.toThrow(/must be absolute/);
    await expect(loadConfig(join(d, "absent.json"))).rejects.toThrow(/no config at/);
    await mkdir(join(d, "dir.json"));
    await expect(loadConfig(join(d, "dir.json"))).rejects.toThrow(/not a regular file/);
  });

  test("loadConfig refuses a state dir that a symlink puts inside a home", async () => {
    const d = await tempDir();
    const home = join(d, "homes", "citizen-glossame");
    await mkdir(home, { recursive: true });
    // Lexically /<d>/state, but really inside the home.
    await symlink(home, join(d, "state"));
    const c = testConfig(d, join(d, "homes"), { beacons: testBeacons() });
    const file = join(d, "config.json");
    await writeFile(file, JSON.stringify(c), { mode: 0o600 });
    expect(() => parseConfig(raw(c))).not.toThrow();
    await expect(loadConfig(file)).rejects.toThrow(/is inside a citizen home/);
  });
});

describe("HALT across two users (KS-004 B2 R5)", () => {
  test("the HALT file lives outside the state dir, where the seat user cannot remove it; a path inside it, or a home, is refused", () => {
    expect(parseConfig(raw()).paths.halt_file).toBe("/srv/seat-test/operator/HALT");
    for (const inside of ["/srv/seat-test/state/HALT", "/srv/seat-test/state/citizens/HALT", "/srv/seat-test/state"]) {
      const c = raw();
      c.paths.halt_file = inside;
      refuses(c, /paths.halt_file: must be outside paths.state_dir, in a directory the seat user cannot write/);
    }
    const inHome = raw();
    inHome.paths.halt_file = "/srv/seat-test/homes/citizen-glossame/HALT";
    refuses(inHome, /paths.halt_file: is inside a citizen home/);
    const atRoot = raw();
    atRoot.paths.halt_file = "/HALT";
    refuses(atRoot, /paths.halt_file: must be in a directory of its own/);
  });

  test("loadConfig refuses a HALT file that a symlink puts inside the state dir", async () => {
    const d = await tempDir();
    const c = testConfig(d, join(d, "homes"), { beacons: testBeacons() });
    await mkdir(c.paths.state_dir, { recursive: true });
    // Lexically /<d>/operator/HALT, but the operator's directory is really the seat user's state dir.
    await symlink(c.paths.state_dir, join(d, "operator"));
    const file = join(d, "config.json");
    await writeFile(file, JSON.stringify(c), { mode: 0o600 });
    expect(() => parseConfig(raw(c))).not.toThrow();
    await expect(loadConfig(file)).rejects.toThrow(/paths.halt_file: must be outside paths.state_dir/);
  });

  test("halt.raise_beacons_argv is null or one fixed argv with an absolute program; it may be left out", () => {
    const argv = ["/usr/bin/sudo", "-n", "-u", "seat", "/usr/local/bin/citizen-seat", "raise-beacons", "--config", "/Users/seat/config.json"];
    const c = raw();
    c.halt.raise_beacons_argv = argv;
    expect(parseConfig(c).halt).toEqual({ allow_no_beacons: false, raise_beacons_argv: argv });
    const omitted = raw();
    delete omitted.halt.raise_beacons_argv;
    expect(parseConfig(omitted).halt.raise_beacons_argv).toBeNull();
    for (const bad of [[], ["sudo", "-u", "seat"], "/usr/bin/sudo -u seat", [1], ["/usr/bin/sudo", "two\nlines"], Array.from({ length: 17 }, () => "/x")]) {
      const b = raw();
      b.halt.raise_beacons_argv = bad;
      refuses(b, /halt.raise_beacons_argv/);
    }
    const typo = raw();
    typo.halt.raise_beacon_argv = argv;
    refuses(typo, /halt: unknown key "raise_beacon_argv"/);
  });
});

describe("schedule", () => {
  test("schedule.wake_confirm_seat is Yu's call: true when left out, false when set, anything else refused", () => {
    const { schedule: _omitted, ...without } = raw();
    expect(parseConfig(without).schedule).toEqual({ wake_confirm_seat: true });
    const off = raw();
    off.schedule = { wake_confirm_seat: false };
    expect(parseConfig(off).schedule).toEqual({ wake_confirm_seat: false });
    const bad = raw();
    bad.schedule = { wake_confirm_seat: "no" };
    refuses(bad, /schedule.wake_confirm_seat: must be true or false/);
    const typo = raw();
    typo.schedule = { wake_confirm: false };
    refuses(typo, /schedule: unknown key "wake_confirm"/);
  });
});

describe("pinned trust", () => {
  test("host attest keys may be pinned as canonical base64 of 32 bytes; anything else is refused", () => {
    expect(parseConfig(raw()).trust).toEqual({ host_attest_public_keys_b64: [] });
    const { trust: _omitted, ...withoutTrust } = raw();
    expect(parseConfig(withoutTrust).trust).toEqual({ host_attest_public_keys_b64: [] });
    const key = Buffer.alloc(32, 7).toString("base64");
    expect(parseConfig({ ...raw(), trust: { host_attest_public_keys_b64: [key] } }).trust.host_attest_public_keys_b64).toEqual([key]);
    refuses({ ...raw(), trust: { host_attest_public_keys_b64: [Buffer.alloc(31, 7).toString("base64")] } }, /trust\.host_attest_public_keys_b64\[0\]/);
    refuses({ ...raw(), trust: { host_attest_public_keys_b64: [key.replace(/=$/, "")] } }, /trust\.host_attest_public_keys_b64\[0\]/);
    refuses({ ...raw(), trust: { host_attest_public_keys_b64: [key, key] } }, /twice/);
    refuses({ ...raw(), trust: { host_attest_public_keys_b64: key } }, /must be a list/);
    refuses({ ...raw(), trust: { keys: [key] } }, /unknown key/);
  });
});
