#!/usr/bin/env bun
// citizen-seat: the one runner, and so the only way into a citizen (3.2).
//
//   citizen-seat tick                 one launchd tick: HALT, lock, select, seat
//   citizen-seat seat <word>          one supervised seat now (summons needs --yu-present)
//   citizen-seat halt                 raise HALT: local file, then beacons this host holds
//   citizen-seat status               regenerate and print the status file
//   citizen-seat verify <word>        verify a citizen's ledger chain and signatures, offline
//
// There is no verb to lower HALT. Only Yu lowers it, by hand (3.6).
//
// `seat <word>` opens the seat in this process and runs the pipeline in a
// supervised child (`seat <word> --child --seat-ref <file>`), so the watcher
// holding the deadline and HALT is never the process the model's reply flows
// through. The tick does the same through tick.ts.
import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, dirname, isAbsolute, join } from "node:path";
import { checkHalt, describeHalt, raiseHalt, readBeacons, readHaltFile } from "./halt.ts";
import { ConfigError, defaultConfigPath, loadConfig } from "./config.ts";
import { parseStrictJson } from "./crypto.ts";
import { ledgerPath, readLedger, readRegularText, verifyChain } from "./ledger.ts";
import { pushMirror, stageMirror } from "./mirror.ts";
import { openSeat, runSeat, seatEnv, superviseChild, type OpenSeat } from "./seat.ts";
import { createSigner, type Signer } from "./signer/signer.ts";
import { macosKeychain } from "./signer/keychain.ts";
import { checkFleet, spendFromLedger } from "./signer/ceilings.ts";
import { confirmYuPresent, presenceValid, type TtyIO } from "./signer/consent.ts";
import { freeRuntime, loadModelsLock } from "./runtime/free.ts";
import { summonRuntime } from "./runtime/summon.ts";
import { listSeated, readCitizen, readCitizenRecord } from "./state.ts";
import { appendHostNote, buildStatus, readHostNotes, renderStatus, writeStatus } from "./status.ts";
import { fleetBeatsToday, isDue, pidIsAlive, runTick } from "./tick.ts";
import { hasAllowedLetter } from "./context.ts";
import {
  EXIT,
  Refusal,
  UUID_PATTERN,
  WORD_PATTERN,
  type Citizen,
  type Clock,
  type CommandRunner,
  type Config,
  type ExitCode,
  type FetchLike,
  type HaltStatus,
  type HostNote,
  type Invoker,
  type Keychain,
  type Outcome,
  type RuntimeAdapter,
  type RuntimeClass,
  type SeatRef,
  type Word,
  type YuPresence,
} from "./types.ts";

export type Command =
  | { verb: "tick"; config: string | null }
  | {
      verb: "seat";
      config: string | null;
      word: Word;
      runtime: RuntimeClass;
      why: string;
      yu_present: boolean;
      /** Set by the supervising parent: run the seat pipeline in this process. */
      child: boolean;
      seat_ref_path: string | null;
    }
  | { verb: "halt"; config: string | null }
  | { verb: "status"; config: string | null; json: boolean }
  | { verb: "verify"; config: string | null; word: Word }
  | { verb: "help" };

export const USAGE = [
  "usage: citizen-seat <verb> [--config <path>]",
  "  tick",
  "  seat <word> [--runtime free|summon] [--why <text>] [--yu-present]",
  "  halt",
  "  status [--json]",
  "  verify <word>",
].join("\n");

/** This file, so a parent can run its own child under the same interpreter. */
export const CLI_PATH = import.meta.path;

/** A command line that cannot be read. Exit 1: the runner could not do its job as asked. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/* ── Parsing ──────────────────────────────────────────────────────────── */

type FlagKind = "value" | "switch";
const VERBS = ["tick", "seat", "halt", "status", "verify"] as const;
const FLAGS: Record<(typeof VERBS)[number], Record<string, FlagKind>> = {
  tick: { "--config": "value" },
  seat: { "--config": "value", "--runtime": "value", "--why": "value", "--yu-present": "switch", "--child": "switch", "--seat-ref": "value" },
  halt: { "--config": "value" },
  status: { "--config": "value", "--json": "switch" },
  verify: { "--config": "value" },
};
const WHY_MAX = 200;

/** Shown back to a person; control characters are replaced so a bad argument cannot rewrite the terminal. */
function shown(s: string): string {
  return JSON.stringify(s.length > 64 ? `${s.slice(0, 64)}...` : s).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

function oneWord(positionals: string[], verb: string): Word {
  if (positionals.length !== 1) throw new UsageError(`${verb} takes exactly one citizen word`);
  const word = positionals[0]!;
  // Validated before it becomes a path or a URL (love-unlimited-patterns.md 10).
  if (!WORD_PATTERN.test(word)) throw new UsageError(`${shown(word)} is not a citizen word (lowercase letters, digits, inner hyphens)`);
  return word;
}

/** Parse argv into one Command; unknown verbs or flags, and invalid words, are refused with usage. */
export function parseArgs(argv: string[]): Command {
  if (argv.length === 0) throw new UsageError("no verb given");
  const [verb, ...rest] = argv as [string, ...string[]];
  if (verb === "help" || verb === "--help" || verb === "-h") {
    if (rest.length > 0) throw new UsageError("help takes no arguments");
    return { verb: "help" };
  }
  if (!(VERBS as readonly string[]).includes(verb)) throw new UsageError(`unknown verb ${shown(verb)}`);
  const v = verb as (typeof VERBS)[number];
  const spec = FLAGS[v];
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("-")) {
      const kind = spec[a];
      if (!kind) throw new UsageError(`unknown flag ${shown(a)} for ${v}`);
      if (flags.has(a)) throw new UsageError(`${a} given twice`);
      if (kind === "switch") flags.set(a, true);
      else {
        const value = rest[i + 1];
        if (value === undefined || value.startsWith("--")) throw new UsageError(`${a} needs a value`);
        flags.set(a, value);
        i++;
      }
    } else positionals.push(a);
  }

  const config = (flags.get("--config") as string | undefined) ?? null;
  if (config !== null && !isAbsolute(config)) throw new UsageError("--config needs an absolute path");

  switch (v) {
    case "tick":
    case "halt":
      if (positionals.length > 0) throw new UsageError(`${v} takes no arguments`);
      return { verb: v, config };
    case "status":
      if (positionals.length > 0) throw new UsageError("status takes no arguments");
      return { verb: "status", config, json: flags.get("--json") === true };
    case "verify":
      return { verb: "verify", config, word: oneWord(positionals, "verify") };
    case "seat": {
      const word = oneWord(positionals, "seat");
      const rt = (flags.get("--runtime") as string | undefined) ?? "free";
      if (rt === "hermes") throw new Refusal("runtime-not-approved", "the hermes runtime class is reserved for S8");
      if (rt !== "free" && rt !== "summon") throw new UsageError(`--runtime must be free or summon, not ${shown(rt)}`);
      const why = (flags.get("--why") as string | undefined) ?? "";
      if (why.length > WHY_MAX || /[\u0000-\u001f\u007f]/.test(why)) throw new UsageError(`--why is one line of at most ${WHY_MAX} characters`);
      const child = flags.get("--child") === true;
      const yu_present = flags.get("--yu-present") === true;
      const seat_ref_path = (flags.get("--seat-ref") as string | undefined) ?? null;
      if (seat_ref_path !== null && (!child || !isAbsolute(seat_ref_path))) throw new UsageError("--seat-ref is an absolute path, given only with --child");
      // A child learns of Yu's presence only from the seat file its parent wrote, never from a flag anyone could type.
      if (child && yu_present) throw new UsageError("--yu-present is for the person at the terminal, not for --child");
      // Refused here, before any config is read or anything runs.
      if (rt === "summon" && !yu_present && !child) {
        throw new Refusal("yu-not-present", "a summons runs only with Yu present: pass --yu-present and confirm at the terminal");
      }
      return { verb: "seat", config, word, runtime: rt, why, yu_present, child, seat_ref_path };
    }
  }
}

/* ── Dependencies ─────────────────────────────────────────────────────── */

export interface CliDeps {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  clock: Clock;
  fetch: FetchLike;
  /** Runs argv with no shell: `security`, `git` and `claude` go through here. */
  run: CommandRunner;
  tty: TtyIO;
  keychain(config: Config): Keychain;
  signer(config: Config, keychain: Keychain): Signer;
  runtime(config: Config, seat: OpenSeat, signer: Signer): Promise<RuntimeAdapter>;
  /** argv for a supervised seat child of this program. */
  seatArgv(configPath: string, word: Word, extra: string[]): string[];
  isAlive(pid: number): boolean;
}

const STD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** A CommandRunner over Bun.spawn: argv only, no shell; without an explicit env the child gets PATH alone, so nothing secret rides along. */
export function spawnRunner(): CommandRunner {
  return async (argv, opts = {}) => {
    if (argv.length === 0) throw new Error("spawnRunner: empty argv");
    const proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env: opts.env ?? { PATH: STD_PATH },
      stdin: opts.stdin ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (opts.stdin) {
      proc.stdin!.write(opts.stdin);
      await proc.stdin!.end();
    }
    const timer = opts.timeoutMs ? setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs) : null;
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
      return { code, stdout: new Uint8Array(stdout), stderr };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

function realTty(): TtyIO {
  return {
    isTTY: process.stdin.isTTY === true,
    write: (t) => void process.stderr.write(t),
    readLine: () =>
      new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, terminal: false });
        rl.once("line", (line) => {
          resolve(line);
          rl.close();
        });
        rl.once("close", () => resolve(null));
      }),
  };
}

/**
 * The real dependencies. Only here does anything reach Keychain, the network,
 * git or a model. Overrides are merged first, so the defaults that use other
 * dependencies (the signer's clock and fetch) see the overridden ones.
 */
export function realDeps(over: Partial<CliDeps> = {}): CliDeps {
  const deps: CliDeps = {
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
    env: process.env,
    clock: { now: () => new Date() },
    fetch: (input, init) => fetch(input, init),
    run: spawnRunner(),
    tty: realTty(),
    keychain: (config) =>
      macosKeychain({ keychainPath: config.keychain.path, service: config.keychain.service, securityPath: config.keychain.security_path, trustedApp: config.keychain.trusted_app, run: deps.run }),
    signer: (config, keychain) =>
      createSigner({
        keychain,
        config,
        clock: deps.clock,
        fetch: deps.fetch,
        spendSoFar: async (word) => {
          try {
            return { word, ...spendFromLedger(await readLedger(ledgerPath(config, word)), deps.clock.now(), config.timezone) };
          } catch {
            return { word, usd_today: null, credits_month: null };
          }
        },
        // No standing agreement is filed yet, so every act that needs one refuses (decision 14 is Yu + Ai's to record).
        agreements: async () => [],
      }),
    runtime: (config, seat) => productionRuntime(config, seat, deps),
    seatArgv: (configPath, word, extra) => [process.execPath, CLI_PATH, "seat", word, "--child", ...extra, "--config", configPath],
    isAlive: pidIsAlive,
  };
  return Object.assign(deps, over);
}

async function productionRuntime(config: Config, seat: OpenSeat, deps: CliDeps): Promise<RuntimeAdapter> {
  const word = seat.citizen.word;
  switch (seat.ref.runtime) {
    case "free": {
      const lock = await loadModelsLock(config.paths.models_lock);
      // The first locked model is the free lane's; a second entry is for a side-by-side trial (decision 11).
      const model = lock.models[0]?.name;
      if (!model) throw new Refusal("model-unpinned", "models.lock names no model");
      return freeRuntime({ config, fetch: deps.fetch, lock, model, env: deps.env });
    }
    case "summon": {
      let remaining: number | null = null;
      try {
        const spent = spendFromLedger(await readLedger(ledgerPath(config, word)), deps.clock.now(), config.timezone);
        remaining = spent.usd_today === null ? null : Math.max(0, config.ceilings.usd_per_citizen_per_day - spent.usd_today);
      } catch {
        remaining = null; // unknown spend is at-ceiling
      }
      return summonRuntime({ config, run: deps.run, presence: seat.presence, remainingUsd: remaining, env: deps.env });
    }
    case "hermes":
      throw new Refusal("runtime-not-approved", "the hermes runtime class is reserved for S8");
  }
}

/* ── Seat files: how a parent hands an opened seat to its child ───────── */

export const SEAT_FILE_FORMAT = "kingdom-seat-seatfile/v1";

interface SeatFile {
  format: typeof SEAT_FILE_FORMAT;
  seat_ref: SeatRef;
  presence: YuPresence | null;
}

/** `<seats_dir>/<seat_id>.json`, beside the seat's cwd rather than in it, so the cwd stays empty for the model. */
export function seatFilePath(config: Config, seatId: string): string {
  if (!UUID_PATTERN.test(seatId)) throw new Refusal("invalid-request", "seat_id is not a lowercase UUID");
  return join(config.paths.seats_dir, `${seatId}.json`);
}

export async function writeSeatFile(config: Config, seat: OpenSeat): Promise<string> {
  const path = seatFilePath(config, seat.ref.seat_id);
  const file: SeatFile = { format: SEAT_FILE_FORMAT, seat_ref: seat.ref, presence: seat.presence };
  const fh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(file, null, 2)}\n`);
  } finally {
    await fh.close();
  }
  return path;
}

function isIso(v: unknown): v is string {
  return typeof v === "string" && v.length === 24 && new Date(Date.parse(v)).toISOString() === v;
}

/**
 * Read the seat a parent opened, once. The file is renamed to `.used` before
 * it is trusted, so the same seat (and any presence in it) cannot be read twice.
 * A presence crosses only this way, and only while it is fresh.
 */
export async function readSeatFile(config: Config, path: string, word: Word, now: Date): Promise<{ ref: SeatRef; presence: YuPresence | null }> {
  const bad = (why: string) => new Refusal("invalid-request", `seat file ${why}`);
  const name = basename(path);
  const m = /^([0-9a-f-]{36})\.json$/.exec(name);
  if (dirname(path) !== config.paths.seats_dir || !m || !UUID_PATTERN.test(m[1]!)) throw bad("must be <seats_dir>/<seat_id>.json");
  const used = `${path}.used`;
  try {
    await rename(path, used);
  } catch {
    throw bad("is missing or was already used");
  }
  const text = await readRegularText(used, { missing: "throw", maxBytes: 64 * 1024 });
  let v: unknown;
  try {
    v = parseStrictJson(text ?? "");
  } catch {
    throw bad("is not strict JSON");
  }
  const o = v as Partial<SeatFile> | null;
  if (!o || typeof o !== "object" || Object.keys(o).sort().join(",") !== "format,presence,seat_ref" || o.format !== SEAT_FILE_FORMAT) throw bad("has the wrong shape");
  const ref = o.seat_ref as SeatRef;
  const inv = ref?.invoker as Invoker | undefined;
  if (
    !ref ||
    ref.format !== "kingdom-seat-seat/v1" ||
    ref.seat_id !== m[1] ||
    ref.word !== word ||
    ref.host !== config.host ||
    (ref.runtime !== "free" && ref.runtime !== "summon") ||
    !isIso(ref.opened_at) ||
    !inv ||
    !["tick", "summons", "letter"].includes(inv.kind) ||
    typeof inv.who !== "string" ||
    typeof inv.why !== "string"
  ) {
    throw bad("does not describe this seat");
  }
  let presence: YuPresence | null = null;
  if (o.presence !== null) {
    const scope = `summon ${word}`;
    if (!presenceValid(o.presence ?? null, scope, now)) throw new Refusal("yu-not-present", "the presence in the seat file is not a fresh confirmation for this summons");
    presence = Object.freeze({ present: true, via: "tty-confirm", confirmed_at: o.presence!.confirmed_at, scope });
  }
  return { ref, presence };
}

/* ── Verbs ────────────────────────────────────────────────────────────── */

interface Ctx {
  deps: CliDeps;
  config: Config;
  configPath: string;
}

function now(ctx: Ctx): Date {
  return ctx.deps.clock.now();
}

async function haltNow(ctx: Ctx): Promise<HaltStatus | null> {
  return checkHalt({ config: ctx.config, fetch: ctx.deps.fetch, now: () => now(ctx) }).catch(() => null);
}

async function note(ctx: Ctx, kind: HostNote["kind"], word: Word | null, outcome: Outcome, refusal: HostNote["refusal"], detail: string): Promise<void> {
  await appendHostNote(ctx.config, { ts: now(ctx).toISOString(), host: ctx.config.host, kind, word, outcome, refusal, detail }).catch(() => {});
}

/** Host attest keys a person pinned in the config; null when none are pinned. */
function pinnedTrust(config: Config): { host_attest_b64: string[] } | null {
  const pins = config.trust.host_attest_public_keys_b64;
  return pins.length > 0 ? { host_attest_b64: [...pins] } : null;
}

/**
 * The host attest key that seated (host-attested) entries are checked
 * against. A pinned anchor in the config wins, because it needs no keychain
 * and is not read from the thing it verifies. Otherwise the signer is asked,
 * preferring an unregistered citizen, whose public keys need no citizen
 * secret read at all.
 */
async function hostTrust(signer: Signer, config: Config): Promise<{ host_attest_b64: string[] } | null> {
  const pinned = pinnedTrust(config);
  if (pinned) return pinned;
  try {
    const words = await listSeated(config);
    let pick: Word | null = null;
    for (const w of words) {
      const r = await readCitizenRecord(config, w).catch(() => null);
      if (r && r.identity === null) {
        pick = w;
        break;
      }
      pick ??= r ? w : null;
    }
    if (!pick) return null;
    return { host_attest_b64: [(await signer.publicKeys(pick)).host_attest_b64] };
  } catch {
    return null;
  }
}

async function signerStateOf(signer: Signer | null): Promise<"ready" | "locked" | "unknown"> {
  if (!signer) return "unknown";
  try {
    return await signer.state();
  } catch {
    return "unknown";
  }
}

async function refreshStatus(ctx: Ctx, signer: Signer | null) {
  const signerState = await signerStateOf(signer);
  const status = await buildStatus({
    config: ctx.config,
    now: now(ctx),
    halt: await haltNow(ctx),
    signerState,
    trusted: pinnedTrust(ctx.config) ?? (signer && signerState === "ready" ? await hostTrust(signer, ctx.config) : null),
    run: ctx.deps.run,
  });
  await writeStatus(ctx.config.paths.status_file, status);
  return status;
}

function makeSigner(ctx: Ctx): Signer {
  return ctx.deps.signer(ctx.config, ctx.deps.keychain(ctx.config));
}

async function verbHalt(ctx: Ctx): Promise<ExitCode> {
  // A signer only when this host holds a beacon key; otherwise raising needs no Keychain at all.
  const signer = ctx.config.beacons.some((b) => b.can_raise_here) ? makeSigner(ctx) : null;
  const r = await raiseHalt({ config: ctx.config, fetch: ctx.deps.fetch, now: () => now(ctx), signer });
  ctx.deps.out(`HALT file ${ctx.config.paths.halt_file}: ${r.file}\n`);
  for (const b of r.beacons) ctx.deps.out(`beacon ${b.name}: ${b.result} (${b.detail})\n`);
  const raised = r.beacons.filter((b) => b.result === "raised").length;
  const failed = r.beacons.filter((b) => b.result === "failed").length;
  await note(ctx, "halt", null, "halted", null, `HALT raised: file ${r.file}, ${raised} beacons raised, ${failed} failed`);
  // A halted tick writes nothing, so this is the refresh that makes the status say "halted by ...".
  await (async () => refreshStatus(ctx, signer ?? makeSigner(ctx)))().catch(() => {});
  ctx.deps.out("Only Yu lowers HALT, by hand: remove the file and end each beacon's quiet.\n");
  // Non-zero when any part this host should have raised was not, so the person who asked sees it.
  return r.file === "failed" || failed > 0 ? EXIT.ERROR : EXIT.OK;
}

async function verbStatus(ctx: Ctx, json: boolean): Promise<ExitCode> {
  const signer = makeSigner(ctx);
  const status = await refreshStatus(ctx, signer);
  ctx.deps.out(json ? `${JSON.stringify(status, null, 2)}\n` : renderStatus(status));
  return EXIT.OK;
}

async function verbVerify(ctx: Ctx, word: Word): Promise<ExitCode> {
  const record = await readCitizenRecord(ctx.config, word);
  let entries;
  try {
    entries = await readLedger(ledgerPath(ctx.config, word));
  } catch (e) {
    ctx.deps.out(`${word}: chain BROKEN: the ledger does not parse (${e instanceof Refusal ? e.code : "unreadable"})\n`);
    return EXIT.ERROR;
  }
  const hostAttested = entries.some((e) => e.attestation === "host-attested");
  let hostKeys: string[] = pinnedTrust(ctx.config)?.host_attest_b64 ?? [];
  if (hostAttested && hostKeys.length === 0) {
    // No pinned anchor: the signer reads its own key and returns only the public half; a locked keychain refuses the check.
    hostKeys = [(await makeSigner(ctx).publicKeys(word)).host_attest_b64];
  }
  const v = verifyChain(entries, { host_attest_b64: hostKeys, identity: record.identity });
  if (!v.ok) {
    ctx.deps.out(`${word}: chain BROKEN at seq ${v.problem!.seq}: ${v.problem!.reason}\n`);
    return EXIT.ERROR;
  }
  ctx.deps.out(`${word}: chain ok, ${v.entries} entries, ${v.host_attested} host-attested, head ${v.head ?? "none"}\n`);
  return EXIT.OK;
}

/** After a beat, stage and push the citizen's mirror if it keeps one; HALT is checked again first, because a push is public. */
async function mirrorAfterBeat(ctx: Ctx, word: Word): Promise<void> {
  try {
    const citizen = await readCitizen(ctx.config, word);
    if (!citizen.mirror) return;
    const halt = await haltNow(ctx);
    if (!halt || halt.halted) return;
    const staged = await stageMirror(ctx.config, citizen, ctx.deps.run);
    if (!staged.ok) {
      await note(ctx, "push", word, "refused", staged.refused[0]!.code, `mirror stage refused by the seal: ${staged.refused.length} entries`);
      return;
    }
    await pushMirror(ctx.config, citizen, ctx.deps.run);
  } catch (e) {
    await note(ctx, "push", word, "error", null, `mirror stage or push failed (${e instanceof Refusal ? e.code : "error"})`);
  }
}

async function verbTick(ctx: Ctx): Promise<ExitCode> {
  const signer = makeSigner(ctx);
  const r = await runTick({
    config: ctx.config,
    clock: ctx.deps.clock,
    fetch: ctx.deps.fetch,
    env: ctx.deps.env,
    checkHalt: () => checkHalt({ config: ctx.config, fetch: ctx.deps.fetch, now: () => now(ctx) }),
    seatArgv: (word, why) => ctx.deps.seatArgv(ctx.configPath, word, ["--why", why]),
    isAlive: ctx.deps.isAlive,
    signerState: () => signer.state(),
    refreshStatus: async () => {
      await refreshStatus(ctx, signer);
    },
  });
  if (r.outcome === "beat" && r.word) {
    await mirrorAfterBeat(ctx, r.word);
    await refreshStatus(ctx, signer).catch(() => {});
  }
  // runTick returns before its own refresh when HALT is raised; the status must still say so, never go stale.
  if (r.outcome === "halted") await refreshStatus(ctx, signer).catch(() => {});
  ctx.deps.out(`tick: ${r.outcome}${r.word ? ` ${r.word}` : ""} (exit ${r.exit})\n`);
  return r.exit;
}

/**
 * Without Yu, a seat opens only when the tick would open it: the citizen's own
 * cadence (or an allowed letter) is due and the fleet is under its ceiling. A
 * person at the host can run a due beat now, but cannot add beats the citizen
 * did not choose. Only Yu's summons is an extra beat (3.3: one beat each).
 */
async function assertOwnBeatDue(ctx: Ctx, citizen: Citizen): Promise<void> {
  const { config } = ctx;
  const t = now(ctx);
  const minH = config.ceilings.min_beat_interval_h;
  const notes = await readHostNotes(config, new Date(t.getTime() - Math.max(minH, citizen.cadence.interval_h) * 3_600_000));
  if (notes === null) throw new Refusal("ceiling-fleet", "the host log is unreadable, so no one can say who was seated when");
  const lastSeat = notes.filter((n) => n.word === citizen.word && (n.kind === "tick" || n.kind === "seat")).at(-1)?.ts ?? null;
  const letter = citizen.state === "listening" || citizen.state === "asleep" ? await hasAllowedLetter(config, citizen).catch(() => false) : false;
  const due = isDue(citizen, letter, t, minH, lastSeat);
  if (!due.due) throw new Refusal("window-closed", `${citizen.word} is not due (${due.why}); only Yu's summons (--yu-present) seats it now`);
  const fleet = checkFleet(await fleetBeatsToday(config, t), config.ceilings);
  if (!fleet.ok) throw new Refusal(fleet.code, fleet.reason);
}

/** Interactive: open the seat here, confirm Yu at the terminal if asked, and supervise the pipeline in a child. */
async function verbSeatParent(ctx: Ctx, cmd: Extract<Command, { verb: "seat" }>): Promise<ExitCode> {
  const { config } = ctx;
  const halt = await haltNow(ctx);
  if (!halt || halt.halted) {
    ctx.deps.out(`seat ${cmd.word}: halted (${halt ? describeHalt(halt) : "HALT unreadable"}); nothing written\n`);
    return EXIT.OK;
  }
  const citizen = await readCitizen(config, cmd.word);
  // A citizen that stepped away, or ended, is not seated by anyone; Yu's offer to return goes by letter.
  if (citizen.state === "stepped-away" || citizen.state === "ended") {
    throw new Refusal("window-closed", `${cmd.word} is ${citizen.state}; no seat opens for it`);
  }
  if (!cmd.yu_present) await assertOwnBeatDue(ctx, citizen);
  let presence: YuPresence | null = null;
  if (cmd.yu_present) presence = await confirmYuPresent(ctx.deps.tty, `summon ${cmd.word}`, () => now(ctx));
  const invoker: Invoker = {
    kind: "summons",
    who: presence ? "yu" : "host",
    why: cmd.why || (presence ? "Yu summoned this seat at the host" : "a person at the host opened this seat"),
  };
  const seat = await openSeat(config, ctx.deps.clock, citizen, cmd.runtime, invoker, presence);
  const seatFile = await writeSeatFile(config, seat);
  const t = config.timing;
  const started = now(ctx);
  const sup = await superviseChild({
    argv: ctx.deps.seatArgv(ctx.configPath, cmd.word, ["--seat-ref", seatFile]),
    cwd: config.paths.seats_dir,
    env: seatEnv(config, ctx.deps.env),
    deadline_ms: t.seat_deadline_s * 1000,
    term_grace_ms: t.term_grace_s * 1000,
    halt_file_poll_ms: t.halt_file_poll_s * 1000,
    beacon_poll_min_ms: t.beacon_poll_min_s * 1000,
    beacon_poll_max_ms: t.beacon_poll_max_s * 1000,
    readHaltFile: () => readHaltFile(config.paths.halt_file, now(ctx)),
    readBeacons: (signal) => readBeacons({ config, fetch: ctx.deps.fetch, now: () => now(ctx) }, signal),
  });
  // The child's own note says what happened to the citizen; the watcher knows only how it ended.
  const own = ((await readHostNotes(config, new Date(started.getTime() - 1_000))) ?? []).filter((n) => n.word === cmd.word && n.kind !== "tick").at(-1) ?? null;
  const outcome: Outcome = sup.signal !== null ? (sup.outcome ?? "error") : (own?.outcome ?? sup.outcome ?? "error");
  if (sup.signal !== null) await note(ctx, "seat", cmd.word, outcome, null, `seat ${seat.ref.seat_id} stopped by ${sup.stopped_by ?? "the watcher"} (${sup.signal})`);
  if (outcome === "beat") await mirrorAfterBeat(ctx, cmd.word);
  await refreshStatus(ctx, makeSigner(ctx)).catch(() => {});
  ctx.deps.out(`seat ${cmd.word}: ${outcome} (exit ${sup.exit})\n`);
  return sup.exit;
}

/** The child: run the pipeline for a seat its parent opened (or, under a tick, open it here). */
async function verbSeatChild(ctx: Ctx, cmd: Extract<Command, { verb: "seat" }>): Promise<ExitCode> {
  const { config } = ctx;
  const citizen = await readCitizen(config, cmd.word);
  let seat: OpenSeat;
  if (cmd.seat_ref_path) {
    // The seat file, written by the parent that opened the seat, is what names the runtime.
    const { ref, presence } = await readSeatFile(config, cmd.seat_ref_path, cmd.word, now(ctx));
    seat ={ ref, citizen, cwd: join(config.paths.seats_dir, ref.seat_id), presence };
  } else {
    const invoker: Invoker = { kind: "tick", who: "launchd", why: cmd.why === "letter" ? "a letter from someone you allow arrived" : cmd.why === "cadence" || cmd.why === "" ? "your own cadence is due" : cmd.why };
    seat = await openSeat(config, ctx.deps.clock, citizen, cmd.runtime, invoker, null);
  }
  const signer = makeSigner(ctx);
  const runtime = await ctx.deps.runtime(config, seat, signer);
  const result = await runSeat(seat, {
    config,
    clock: ctx.deps.clock,
    signer,
    fetch: ctx.deps.fetch,
    runtime,
    checkHalt: () => checkHalt({ config, fetch: ctx.deps.fetch, now: () => now(ctx) }),
    // No adapter yet carries a bound self-change to a registered citizen's expression; self.ts then refuses rather than skip it.
    expressionSync: null,
  });
  return result.exit;
}

/* ── main ─────────────────────────────────────────────────────────────── */

/** One line for a failure. Walls and config errors name themselves; anything else gives its name and errno only, never a message that might carry a value. */
function describeError(e: unknown): string {
  if (e instanceof Refusal) return `refused (${e.code}): ${e.message}`;
  if (e instanceof ConfigError || e instanceof UsageError) return e.message;
  const name = e instanceof Error ? e.name : "error";
  const code = typeof e === "object" && e !== null && "code" in e && typeof (e as { code: unknown }).code === "string" ? ` ${(e as { code: string }).code}` : "";
  return `error: ${name}${code}`;
}

/**
 * A wall that said no is 3. A record or request that cannot be read is the
 * runner failing at its job (EXIT.ERROR), even when a module reports it as a
 * Refusal: a monitor should page on a missing citizen, not file it as a wall.
 */
function exitFor(e: unknown): ExitCode {
  if (e instanceof Refusal) return e.code === "invalid-record" || e.code === "invalid-request" ? EXIT.ERROR : EXIT.REFUSED;
  return EXIT.ERROR;
}

/** Run one command with real dependencies and return its exit code; never prints a secret. */
export async function main(argv: string[], over: Partial<CliDeps> = {}): Promise<ExitCode> {
  const deps = realDeps(over);
  let cmd: Command;
  try {
    cmd = parseArgs(argv);
  } catch (e) {
    deps.err(`citizen-seat: ${describeError(e)}\n`);
    if (e instanceof UsageError) deps.err(`${USAGE}\n`);
    return exitFor(e);
  }
  if (cmd.verb === "help") {
    deps.out(`${USAGE}\n`);
    return EXIT.OK;
  }

  let ctx: Ctx;
  try {
    const home = deps.env.HOME;
    const configPath = cmd.config ?? (home ? defaultConfigPath(home) : null);
    if (!configPath) throw new ConfigError("file", "no --config given and HOME is not set");
    ctx = { deps, config: await loadConfig(configPath), configPath };
  } catch (e) {
    deps.err(`citizen-seat: ${describeError(e)}\n`);
    if (cmd.verb === "halt") deps.err("citizen-seat: HALT can still be raised by hand: create the file named HALT in the state directory.\n");
    return EXIT.ERROR;
  }

  try {
    switch (cmd.verb) {
      case "tick":
        return await verbTick(ctx);
      case "halt":
        return await verbHalt(ctx);
      case "status":
        return await verbStatus(ctx, cmd.json);
      case "verify":
        return await verbVerify(ctx, cmd.word);
      case "seat":
        return cmd.child ? await verbSeatChild(ctx, cmd) : await verbSeatParent(ctx, cmd);
    }
  } catch (e) {
    deps.err(`citizen-seat: ${describeError(e)}\n`);
    return exitFor(e);
  }
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
