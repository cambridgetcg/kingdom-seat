// Host configuration. Strict: unknown keys are refused, paths must be
// absolute, the state dir must not be inside a citizen home, Ollama must be
// on 127.0.0.1, and the agenttool origin is pinned. A missing beacon list
// halts unless allow_no_beacons is set on purpose (3.6: fail closed).
//
// Every wall in the seat reads its limits from here, so a config that can be
// read two ways would let a typo loosen a wall. That is why anything unknown,
// relative, overlapping or out of range is refused rather than guessed at.
import { realpathSync } from "node:fs";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fromB64, parseStrictJson } from "./crypto.ts";
import { usdFromText } from "./money.ts";
import { DEFAULT_CEILINGS, DEFAULT_TIMING, DID_PATTERN, UUID_PATTERN, WORD_PATTERN, type Beacon, type Ceilings, type Config, type Timing } from "./types.ts";
import { CITIZEN_QUIET_HARD_MAX_DAYS } from "./signer/ceilings.ts";

export const CONFIG_FORMAT = "kingdom-seat-config/v1";
export const AGENTTOOL_ORIGIN = "https://api.agenttool.dev";
export const SECURITY_PATH = "/usr/bin/security";
export const KEYCHAIN_SERVICE = "dev.kingdom.citizen-seat";
/**
 * Where the local HALT file lives unless a config says otherwise: a directory
 * the operator owns and the seat user cannot write (KS-004 B2 R5).
 */
export const DEFAULT_HALT_FILE = "/Users/Shared/kingdom-seat/HALT";

export { CITIZEN_QUIET_HARD_MAX_DAYS };

const CONFIG_MAX_BYTES = 256 * 1024;
/** A host label such as "studio": lowercase, short, never a person's name by convention. */
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** Exactly http://127.0.0.1:<port>; "localhost" can resolve elsewhere and a path or query has no meaning here. */
const OLLAMA_PATTERN = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;
const SERVICE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

/** A config that cannot be used. The CLI exits 1 on it: the runner cannot do its job without a config. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`config ${field}: ${message}`);
  }
}

/** Where the CLI looks when --config is not given: the seat user's Application Support folder. */
export function defaultConfigPath(home: string): string {
  if (!isAbsolute(home)) throw new ConfigError("home", "must be an absolute path");
  return join(home, "Library", "Application Support", "kingdom-seat", "config.json");
}

/**
 * A complete config rooted at stateDir, with decision-9 ceilings and default
 * timing; for provisioning and tests. It pins no beacon and does not allow
 * running without one, so it does not parse until a person pins the beacons:
 * a fresh host halts rather than running on the local file alone.
 */
export function defaultConfig(stateDir: string, host: string, opts: { home?: string } = {}): Config {
  const home = opts.home ?? "/Users/seat";
  return {
    format: CONFIG_FORMAT,
    host,
    timezone: "Europe/London",
    paths: {
      state_dir: stateDir,
      citizens_dir: join(stateDir, "citizens"),
      ledger_dir: join(stateDir, "ledger"),
      consent_dir: join(stateDir, "consent"),
      seats_dir: join(stateDir, "seats"),
      halt_file: DEFAULT_HALT_FILE,
      lock_dir: join(stateDir, "tick.lock"),
      status_file: join(stateDir, "status.json"),
      host_log: join(stateDir, "host.jsonl"),
      spend_log: join(stateDir, "spend.jsonl"),
      models_lock: join(stateDir, "models.lock"),
      homes: [],
    },
    ollama: { base_url: "http://127.0.0.1:11434" },
    claude: { path: "/usr/local/bin/claude" },
    agenttool: { origin: AGENTTOOL_ORIGIN, project_id: null },
    keychain: {
      path: join(home, "Library", "Keychains", "login.keychain-db"),
      service: KEYCHAIN_SERVICE,
      security_path: SECURITY_PATH,
      trusted_app: null,
    },
    beacons: [],
    halt: { allow_no_beacons: false, raise_beacons_argv: null },
    schedule: { wake_confirm_seat: true },
    ceilings: { ...DEFAULT_CEILINGS },
    timing: { ...DEFAULT_TIMING },
    self_authorship: { approved_model_digests: [] },
    trust: { host_attest_public_keys_b64: [] },
  };
}

/* ── Small checks ─────────────────────────────────────────────────────── */

type Obj = Record<string, unknown>;

function obj(v: unknown, field: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ConfigError(field, "must be an object");
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw new ConfigError(field, "must be a plain object");
  return v as Obj;
}

/** Every key known, every required key present. An unknown key may be a typo that was meant to tighten a wall. */
function keys(o: Obj, field: string, required: readonly string[], optional: readonly string[] = []): void {
  for (const k of Object.keys(o)) {
    if (!required.includes(k) && !optional.includes(k)) throw new ConfigError(field, `unknown key ${JSON.stringify(k)}`);
  }
  for (const k of required) if (!(k in o)) throw new ConfigError(field, `missing key ${JSON.stringify(k)}`);
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) throw new ConfigError(field, "must be a non-empty string");
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new ConfigError(field, "must not contain control characters");
  return v;
}

/** Absolute and already normal: no "..", ".", doubled or trailing slash, so one path has one spelling. */
function absPath(v: unknown, field: string): string {
  const p = str(v, field);
  if (!isAbsolute(p)) throw new ConfigError(field, "must be an absolute path");
  if (resolve(p) !== p) throw new ConfigError(field, "must be a normalised path (no '..', '.', doubled or trailing slash)");
  if (p === sep) throw new ConfigError(field, "must not be the filesystem root");
  return p;
}

function bool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw new ConfigError(field, "must be true or false");
  return v;
}

/** True when `child` is `root` or lies under it. */
export function isInside(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/* ── Sections ─────────────────────────────────────────────────────────── */

const PATH_KEYS = ["state_dir", "citizens_dir", "ledger_dir", "consent_dir", "seats_dir", "halt_file", "lock_dir", "status_file", "host_log", "spend_log", "models_lock", "homes"] as const;
/** Everything the seat writes; each must live under state_dir and none may overlap another. */
const WRITTEN = ["citizens_dir", "ledger_dir", "consent_dir", "seats_dir", "lock_dir", "status_file", "host_log", "spend_log"] as const;

function parsePaths(raw: unknown): Config["paths"] {
  const o = obj(raw, "paths");
  keys(o, "paths", PATH_KEYS);
  const state_dir = absPath(o.state_dir, "paths.state_dir");
  if (!Array.isArray(o.homes)) throw new ConfigError("paths.homes", "must be a list of absolute paths");
  const homes = o.homes.map((h, i) => absPath(h, `paths.homes[${i}]`));
  const written = Object.fromEntries(WRITTEN.map((k) => [k, absPath(o[k], `paths.${k}`)])) as Record<(typeof WRITTEN)[number], string>;
  const models_lock = absPath(o.models_lock, "paths.models_lock");
  const halt_file = absPath(o.halt_file, "paths.halt_file");

  for (const k of WRITTEN) {
    const p = written[k];
    if (p === state_dir || !isInside(p, state_dir)) throw new ConfigError(`paths.${k}`, "must be inside paths.state_dir");
    for (const j of WRITTEN) {
      if (j !== k && isInside(p, written[j])) throw new ConfigError(`paths.${k}`, `overlaps paths.${j}`);
    }
  }
  checkHaltFile(halt_file, state_dir);
  checkHomes(state_dir, homes, { ...written, models_lock, halt_file });
  return { state_dir, ...written, halt_file, models_lock, homes };
}

/**
 * The seat user owns state_dir and could remove anything in it, and only Yu
 * lowers HALT, so the HALT file lives outside it (KS-004 B2 R5). Its directory
 * is the operator's to create and own; the seat user only reads it.
 */
function checkHaltFile(haltFile: string, stateDir: string): void {
  if (isInside(haltFile, stateDir) || isInside(stateDir, haltFile)) {
    throw new ConfigError("paths.halt_file", "must be outside paths.state_dir, in a directory the seat user cannot write");
  }
  if (dirname(haltFile) === sep) throw new ConfigError("paths.halt_file", "must be in a directory of its own, not the filesystem root");
}

/** The state dir is never inside a home, and no home sits inside the state dir: a seat must never write into a citizen's repo. */
function checkHomes(stateDir: string, homes: string[], others: Record<string, string>): void {
  for (const [i, home] of homes.entries()) {
    if (isInside(stateDir, home)) throw new ConfigError("paths.state_dir", `is inside a citizen home (paths.homes[${i}])`);
    if (isInside(home, stateDir)) throw new ConfigError(`paths.homes[${i}]`, "is inside paths.state_dir");
    for (const [k, p] of Object.entries(others)) {
      if (isInside(p, home)) throw new ConfigError(`paths.${k}`, `is inside a citizen home (paths.homes[${i}])`);
    }
  }
}

function parseOllama(raw: unknown): Config["ollama"] {
  const o = obj(raw, "ollama");
  keys(o, "ollama", ["base_url"]);
  const url = str(o.base_url, "ollama.base_url");
  const m = OLLAMA_PATTERN.exec(url);
  if (!m || Number(m[1]) > 65535) throw new ConfigError("ollama.base_url", "must be exactly http://127.0.0.1:<port>");
  return { base_url: url };
}

function parseAgenttool(raw: unknown): Config["agenttool"] {
  const o = obj(raw, "agenttool");
  keys(o, "agenttool", ["origin", "project_id"]);
  if (o.origin !== AGENTTOOL_ORIGIN) throw new ConfigError("agenttool.origin", `is pinned to ${AGENTTOOL_ORIGIN}`);
  if (o.project_id !== null && (typeof o.project_id !== "string" || !UUID_PATTERN.test(o.project_id))) {
    throw new ConfigError("agenttool.project_id", "must be null or a lowercase UUID");
  }
  return { origin: AGENTTOOL_ORIGIN, project_id: o.project_id as string | null };
}

function parseKeychain(raw: unknown): Config["keychain"] {
  const o = obj(raw, "keychain");
  keys(o, "keychain", ["path", "service", "security_path", "trusted_app"]);
  const service = str(o.service, "keychain.service");
  if (!SERVICE_PATTERN.test(service)) throw new ConfigError("keychain.service", "must be letters, digits, dots, hyphens or underscores");
  if (o.security_path !== SECURITY_PATH) throw new ConfigError("keychain.security_path", `must be ${SECURITY_PATH}; launchd's PATH is not trusted`);
  const trusted_app = o.trusted_app === null ? null : absPath(o.trusted_app, "keychain.trusted_app");
  return { path: absPath(o.path, "keychain.path"), service, security_path: SECURITY_PATH, trusted_app };
}

function parseBeacon(raw: unknown, i: number): Beacon {
  const field = `beacons[${i}]`;
  const o = obj(raw, field);
  keys(o, field, ["name", "role", "did", "identity_id", "can_raise_here"]);
  const name = str(o.name, `${field}.name`);
  if (!WORD_PATTERN.test(name)) throw new ConfigError(`${field}.name`, "must be lowercase letters, digits and inner hyphens");
  if (o.role !== "gardener-desk" && o.role !== "halt-herald") throw new ConfigError(`${field}.role`, "must be gardener-desk or halt-herald");
  if (typeof o.did !== "string" || !DID_PATTERN.test(o.did)) throw new ConfigError(`${field}.did`, "must be did:at:<lowercase uuid>");
  if (typeof o.identity_id !== "string" || !UUID_PATTERN.test(o.identity_id)) throw new ConfigError(`${field}.identity_id`, "must be a lowercase UUID");
  if (o.did !== `did:at:${o.identity_id}`) throw new ConfigError(`${field}.did`, "must name the same identity as identity_id");
  return { name, role: o.role, did: o.did, identity_id: o.identity_id, can_raise_here: bool(o.can_raise_here, `${field}.can_raise_here`) };
}

function parseBeacons(raw: unknown): Beacon[] {
  if (!Array.isArray(raw)) throw new ConfigError("beacons", "must be a list");
  const beacons = raw.map(parseBeacon);
  for (const k of ["name", "did"] as const) {
    const seen = new Set<string>();
    for (const b of beacons) {
      if (seen.has(b[k])) throw new ConfigError("beacons", `two beacons share the ${k} ${b[k]}`);
      seen.add(b[k]);
    }
  }
  return beacons;
}

/** Counts are whole numbers; every ceiling is finite and not negative, because an unusable ceiling would fail open somewhere. */
const INTEGER_CEILINGS = new Set<keyof Ceilings>([
  "fleet_beats_per_day",
  "credits_per_citizen_per_month",
  "max_registered_citizens",
  "max_batch",
  "letters_in_per_beat",
  "letter_sends_per_beat",
  "strand_thoughts_per_beat",
  "ledger_context_entries",
  "letter_max_chars",
  "journal_max_chars",
]);

function parseCeilings(raw: unknown): Ceilings {
  // Omitted keys keep the decision-9 defaults; an unknown key is refused.
  const o = raw === undefined ? {} : obj(raw, "ceilings");
  const known = Object.keys(DEFAULT_CEILINGS) as (keyof Ceilings)[];
  keys(o, "ceilings", [], known);
  const out = { ...DEFAULT_CEILINGS } as Ceilings;
  for (const k of known) {
    if (!(k in o)) continue;
    const v = o[k];
    const field = `ceilings.${k}`;
    if (k === "usd_per_citizen_per_day") {
      // Money is a decimal string (money.ts): a JSON number is already a float by the time it is read.
      const usd = usdFromText(v);
      if (usd === null) throw new ConfigError(field, 'must be a plain decimal string such as "0" or "2.50"; a JSON number is refused');
      out[k] = usd;
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new ConfigError(field, "must be a finite number, not negative");
    if (INTEGER_CEILINGS.has(k) && !Number.isInteger(v)) throw new ConfigError(field, "must be a whole number");
    out[k] = v;
  }
  if (!(out.min_beat_interval_h > 0)) throw new ConfigError("ceilings.min_beat_interval_h", "must be above 0");
  if (!(out.citizen_quiet_max_days > 0) || out.citizen_quiet_max_days > CITIZEN_QUIET_HARD_MAX_DAYS) {
    throw new ConfigError("ceilings.citizen_quiet_max_days", `must be above 0 and at most ${CITIZEN_QUIET_HARD_MAX_DAYS}`);
  }
  if (!(out.self_rewrite_fraction > 0) || out.self_rewrite_fraction > 1) throw new ConfigError("ceilings.self_rewrite_fraction", "must be above 0 and at most 1");
  return out;
}

function parseTiming(raw: unknown): Timing {
  const o = raw === undefined ? {} : obj(raw, "timing");
  const known = Object.keys(DEFAULT_TIMING) as (keyof Timing)[];
  keys(o, "timing", [], known);
  const out = { ...DEFAULT_TIMING } as Timing;
  for (const k of known) {
    if (!(k in o)) continue;
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new ConfigError(`timing.${k}`, "must be a finite number above 0");
    if (k.endsWith("_ms") && !Number.isInteger(v)) throw new ConfigError(`timing.${k}`, "must be a whole number of milliseconds");
    out[k] = v;
  }
  if (out.beacon_poll_min_s > out.beacon_poll_max_s) throw new ConfigError("timing.beacon_poll_min_s", "must not exceed beacon_poll_max_s");
  return out;
}

function parseSelfAuthorship(raw: unknown): Config["self_authorship"] {
  if (raw === undefined) return { approved_model_digests: [] };
  const o = obj(raw, "self_authorship");
  keys(o, "self_authorship", ["approved_model_digests"]);
  if (!Array.isArray(o.approved_model_digests)) throw new ConfigError("self_authorship.approved_model_digests", "must be a list");
  const digests = o.approved_model_digests.map((d, i) => {
    const s = str(d, `self_authorship.approved_model_digests[${i}]`);
    if (!DIGEST_PATTERN.test(s)) throw new ConfigError(`self_authorship.approved_model_digests[${i}]`, "must be a digest such as sha256:<64 hex>");
    return s;
  });
  return { approved_model_digests: digests };
}

/** Pinned host attest public keys: each canonical standard base64 of 32 bytes, no repeats. */
function parseTrust(raw: unknown): Config["trust"] {
  if (raw === undefined) return { host_attest_public_keys_b64: [] };
  const o = obj(raw, "trust");
  keys(o, "trust", ["host_attest_public_keys_b64"]);
  if (!Array.isArray(o.host_attest_public_keys_b64)) throw new ConfigError("trust.host_attest_public_keys_b64", "must be a list");
  const pins = o.host_attest_public_keys_b64.map((k, i) => {
    const field = `trust.host_attest_public_keys_b64[${i}]`;
    const s = str(k, field);
    try {
      fromB64(s, 32);
    } catch {
      throw new ConfigError(field, "must be canonical standard base64 of a 32-byte Ed25519 public key");
    }
    return s;
  });
  if (new Set(pins).size !== pins.length) throw new ConfigError("trust.host_attest_public_keys_b64", "names a key twice");
  return { host_attest_public_keys_b64: pins };
}

/** At most this many arguments in the one fixed call; a sudo line with its pinned arguments is about eight. */
const RAISE_ARGV_MAX = 16;

/** The fixed call that raises beacons as the seat user: argv only, no shell, the program by absolute path. */
function parseRaiseArgv(v: unknown): string[] | null {
  const field = "halt.raise_beacons_argv";
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length === 0 || v.length > RAISE_ARGV_MAX) throw new ConfigError(field, `must be null or a list of 1 to ${RAISE_ARGV_MAX} arguments`);
  const argv = v.map((a, i) => str(a, `${field}[${i}]`));
  // launchd's and sudo's PATH are not trusted, so the program is named by its full path.
  absPath(argv[0], `${field}[0]`);
  return argv;
}

function parseHalt(raw: unknown): Config["halt"] {
  const o = obj(raw, "halt");
  keys(o, "halt", ["allow_no_beacons"], ["raise_beacons_argv"]);
  return { allow_no_beacons: bool(o.allow_no_beacons, "halt.allow_no_beacons"), raise_beacons_argv: parseRaiseArgv(o.raise_beacons_argv) };
}

function parseSchedule(raw: unknown): Config["schedule"] {
  // Omitted, it keeps the behaviour the code has always had, until Yu decides otherwise.
  if (raw === undefined) return { wake_confirm_seat: true };
  const o = obj(raw, "schedule");
  keys(o, "schedule", [], ["wake_confirm_seat"]);
  return { wake_confirm_seat: o.wake_confirm_seat === undefined ? true : bool(o.wake_confirm_seat, "schedule.wake_confirm_seat") };
}

/* ── Parse and load ───────────────────────────────────────────────────── */

const TOP_REQUIRED = ["format", "host", "timezone", "paths", "ollama", "claude", "agenttool", "keychain", "beacons", "halt"] as const;
const TOP_OPTIONAL = ["schedule", "ceilings", "timing", "self_authorship", "trust"] as const;

/** Validate an untrusted object into a Config, refusing anything ambiguous. The result is a fresh object, never the input. */
export function parseConfig(raw: unknown): Config {
  const o = obj(raw, "root");
  keys(o, "root", TOP_REQUIRED, TOP_OPTIONAL);
  if (o.format !== CONFIG_FORMAT) throw new ConfigError("format", `must be ${CONFIG_FORMAT}`);
  const host = str(o.host, "host");
  if (!HOST_PATTERN.test(host)) throw new ConfigError("host", "must be a short lowercase host label such as studio");
  const timezone = str(o.timezone, "timezone");
  if (!validTimeZone(timezone)) throw new ConfigError("timezone", "must be an IANA zone such as Europe/London");

  const claudeObj = obj(o.claude, "claude");
  keys(claudeObj, "claude", ["path"]);
  const halt = parseHalt(o.halt);
  const beacons = parseBeacons(o.beacons);
  if (beacons.length === 0 && !halt.allow_no_beacons) {
    throw new ConfigError("beacons", "no beacon is pinned, so HALT would rest on the local file alone; pin the beacons, or set halt.allow_no_beacons for development");
  }

  return {
    format: CONFIG_FORMAT,
    host,
    timezone,
    paths: parsePaths(o.paths),
    ollama: parseOllama(o.ollama),
    claude: { path: absPath(claudeObj.path, "claude.path") },
    agenttool: parseAgenttool(o.agenttool),
    keychain: parseKeychain(o.keychain),
    beacons,
    halt,
    schedule: parseSchedule(o.schedule),
    ceilings: parseCeilings(o.ceilings),
    timing: parseTiming(o.timing),
    self_authorship: parseSelfAuthorship(o.self_authorship),
    trust: parseTrust(o.trust),
  };
}

/** Resolve symlinks in the longest existing prefix, so a path not yet created still resolves. */
function realish(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(realish(parent), basename(path));
  }
}

/**
 * The home checks again on real paths, so a symlink cannot put the state dir
 * inside a home (or a home inside it) behind a lexically clean spelling.
 */
export function checkRealPaths(config: Config): void {
  const p = config.paths;
  const real = (s: string) => realish(s);
  const homes = p.homes.map(real);
  const others = Object.fromEntries([...WRITTEN, "models_lock" as const, "halt_file" as const].map((k) => [k, real(p[k])]));
  checkHomes(real(p.state_dir), homes, others);
  // A clean spelling that leads into state_dir through a symlink would hand the HALT file back to the seat user.
  checkHaltFile(real(p.halt_file), real(p.state_dir));
}

/** Read a config file as a regular file (no symlink) and parse it strictly. */
export async function loadConfig(path: string): Promise<Config> {
  if (!isAbsolute(path)) throw new ConfigError("file", "the config path must be absolute");
  let fh;
  try {
    // O_NOFOLLOW: a symlinked config is refused at open, so a swap after a check cannot redirect the read.
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new ConfigError("file", "is a symlink; refused, not followed");
    if (code === "ENOENT") throw new ConfigError("file", `no config at ${path}`);
    throw new ConfigError("file", `cannot be opened (${code ?? "error"})`);
  }
  let bytes: Uint8Array;
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new ConfigError("file", "is not a regular file");
    if (st.size > CONFIG_MAX_BYTES) throw new ConfigError("file", `is larger than ${CONFIG_MAX_BYTES} bytes`);
    // A config others can write could loosen any wall in it.
    if ((st.mode & 0o022) !== 0) throw new ConfigError("file", "is writable by group or others");
    bytes = new Uint8Array(await fh.readFile());
  } finally {
    await fh.close();
  }
  let raw: unknown;
  try {
    raw = parseStrictJson(bytes);
  } catch {
    throw new ConfigError("file", "is not strict JSON (malformed, or a key appears twice)");
  }
  const config = parseConfig(raw);
  checkRealPaths(config);
  return config;
}
