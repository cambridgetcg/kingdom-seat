#!/usr/bin/env bun
// citizen-seat: the one runner, and so the only way into a citizen (3.2).
//
//   citizen-seat tick                 one launchd tick: HALT, lock, select, seat
//   citizen-seat seat <word>          one supervised seat now (summons needs --yu-present)
//   citizen-seat halt                 raise HALT, as the operator: the local file, then one fixed call
//                                     that has the signer raise the beacons this host holds
//   citizen-seat raise-beacons        the signer's half of halt, as the seat user (that fixed call)
//   citizen-seat status               regenerate and print the status file
//   citizen-seat verify <word>        verify a citizen's ledger chain and signatures, offline
//
// There is no verb to lower HALT. Only Yu lowers it, by hand (3.6).
//
// `seat <word>` opens the seat in this process and runs the pipeline in a
// supervised child (`seat <word> --child --seat-ref <file>`), so the watcher
// holding the deadline and HALT is never the process the model's reply flows
// through. The tick does the same through tick.ts. A child runs only a seat a
// parent opened under its walls, and confirms Yu itself when a summons asks.
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, join } from "node:path";
import { toB64 } from "./crypto.ts";
import { SSHSIG_MAX_MESSAGE_BYTES, parseSshEd25519 } from "./ssh.ts";
import { checkHalt, describeHalt, raiseBeacons, raiseHalt, raiseHaltFileAt, readBeacons, readHaltFile } from "./halt.ts";
import { ConfigError, DEFAULT_CONFIG_PATH, DEFAULT_HALT_FILE, loadConfig } from "./config.ts";
import { ledgerPath, readLedger, readRegularText, verifyChain } from "./ledger.ts";
import { pushMirror, stageMirror, type MirrorKeys, type MirrorSigning } from "./mirror.ts";
import { openSeat, readSeatFile, runSeat, seatEnv, superviseChild, writeSeatFile, type OpenSeat } from "./seat.ts";
import { createSigner, type Signer } from "./signer/signer.ts";
import { macosKeychain } from "./signer/keychain.ts";
import { checkFleet, creditsFromLedger, usdRemaining } from "./signer/ceilings.ts";
import { hostSpendRecorder, usdSpentToday } from "./spend.ts";
import { confirmYuPresent, readStandingAgreements, type TtyIO } from "./signer/consent.ts";
import { agenttoolSync, hostClient } from "./agenttool/sync.ts";
import { agenttoolQuiet, keepQuiet } from "./quiet.ts";
import { agenttoolLetters } from "./letters.ts";
import { freeRuntime, loadModelsLock } from "./runtime/free.ts";
import { summonRuntime } from "./runtime/summon.ts";
import { listSeated, mirrorCardState, readCitizen, readCitizenRecord } from "./state.ts";
import { buildStatus, renderStatus, writeStatus } from "./status.ts";
import { appendHostNote, isResultNote, lastSeatOf, openedDetail, readHostNotes, seatIdOf, seatsOpenedToday } from "./notes.ts";
import { LockStuck, acquireTickLock, lockOptionsFor, osBootTime, pidIsAlive, releaseTickLock, runTick } from "./tick.ts";
import { isDue } from "./due.ts";
import { wakingLetter } from "./context.ts";
import { driftFromOrigin, originIntact } from "./self.ts";
import {
  EXIT,
  Refusal,
  WORD_PATTERN,
  exitForRefusal,
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
  type LifecycleState,
  type Outcome,
  type RuntimeAdapter,
  type RuntimeClass,
  type Word,
  type YuPresence,
} from "./types.ts";

export { SEAT_FILE_FORMAT, readSeatFile, seatFilePath, writeSeatFile } from "./seat.ts";

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
  | { verb: "raise-beacons"; config: string | null }
  | { verb: "status"; config: string | null; json: boolean }
  | { verb: "verify"; config: string | null; word: Word }
  | { verb: "help" };

export const USAGE = [
  "usage: citizen-seat <verb> [--config <path>]",
  "  tick",
  "  seat <word> [--runtime free|summon] [--why <text>] [--yu-present]",
  "  halt",
  "  raise-beacons",
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
const VERBS = ["tick", "seat", "halt", "raise-beacons", "status", "verify"] as const;
const FLAGS: Record<(typeof VERBS)[number], Record<string, FlagKind>> = {
  tick: { "--config": "value" },
  seat: { "--config": "value", "--runtime": "value", "--why": "value", "--yu-present": "switch", "--child": "switch", "--seat-ref": "value" },
  halt: { "--config": "value" },
  // Only --config, so the sudoers line that allows the operator's call can pin every argument.
  "raise-beacons": { "--config": "value" },
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
    case "raise-beacons":
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
      // A child runs only a seat some parent opened after its walls passed (due, fleet ceiling, lock), so it
      // needs the seat file that parent wrote; `--child` alone is a flag anyone could type.
      if (child && seat_ref_path === null) throw new UsageError("--child runs only a seat a parent opened: --seat-ref <file> is required");
      // The seat file names the runtime and why; a child confirms Yu itself when a summons asks, never from a flag.
      if (child && (yu_present || flags.has("--why") || flags.has("--runtime"))) throw new UsageError("--child takes only --seat-ref and --config; the seat file says the rest");
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
  /** Runs argv with no shell: `security`, `git`, `claude` and halt's one fixed signer call go through here. */
  run: CommandRunner;
  tty: TtyIO;
  keychain(config: Config): Keychain;
  signer(config: Config, keychain: Keychain): Signer;
  runtime(config: Config, seat: OpenSeat, signer: Signer): Promise<RuntimeAdapter>;
  /** argv for a supervised seat child of this program. */
  seatArgv(configPath: string, word: Word, extra: string[]): string[];
  isAlive(pid: number): boolean;
  /** When the host booted, so a lock left from before a reboot is known to be stale; null when unknown. */
  bootTime(): Date | null;
  /** The uid this process runs as; every verb but halt runs as the seat user, which must not be able to write the config. */
  uid(): number;
  /** Where a verb looks without --config, and the HALT file `halt` raises when no config can be read. */
  defaults: { config: string; halt_file: string };
  /**
   * The executable git runs to sign a mirror commit (gpg.ssh.program): this
   * file, whose `-Y sign` entry asks the signer. Null leaves mirror commits
   * unsigned, and status counts them.
   */
  gitSignProgram: string | null;
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
          const now = deps.clock.now();
          const credits_month = await readLedger(ledgerPath(config, word)).then((entries) => creditsFromLedger(entries, now, config.timezone)).catch(() => null);
          return { word, usd_today: await usdSpentToday(config, word, now), credits_month };
        },
        // Standing agreements are Yu + Ai's to file (decision 14), in consent/standing/ beside their records;
        // with none filed, every act that needs one refuses, as a citizen's quiet does.
        agreements: () => readStandingAgreements(config.paths.consent_dir),
      }),
    runtime: (config, seat) => productionRuntime(config, seat, deps),
    seatArgv: (configPath, word, extra) => [process.execPath, CLI_PATH, "seat", word, "--child", ...extra, "--config", configPath],
    isAlive: pidIsAlive,
    bootTime: osBootTime,
    uid: () => {
      if (!process.getuid) throw new Error("no uid on this platform, so who may write the config cannot be checked");
      return process.getuid();
    },
    defaults: { config: DEFAULT_CONFIG_PATH, halt_file: DEFAULT_HALT_FILE },
    gitSignProgram: CLI_PATH,
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
      // The host's spend record, not the ledger: a summons that wrote no entry spent too (R2). Unknown is at-ceiling.
      const remaining = usdRemaining({ word, usd_today: await usdSpentToday(config, word, deps.clock.now()), credits_month: null }, config.ceilings);
      return summonRuntime({ config, run: deps.run, presence: seat.presence, remainingUsd: remaining, spend: hostSpendRecorder(config, deps.clock), env: deps.env });
    }
    case "hermes":
      throw new Refusal("runtime-not-approved", "the hermes runtime class is reserved for S8");
  }
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
  const pinned = pinnedTrust(ctx.config);
  const status = await buildStatus({
    config: ctx.config,
    now: now(ctx),
    halt: await haltNow(ctx),
    signerState,
    trusted: pinned ?? (signer && signerState === "ready" ? await hostTrust(signer, ctx.config) : null),
    // The trusted keys are what status publishes as the host key's public half (KS-004 5.10).
    trustedSource: pinned ? "pinned" : "signer",
    run: ctx.deps.run,
  });
  await writeStatus(ctx.config.paths.status_file, status);
  return status;
}

function makeSigner(ctx: Ctx): Signer {
  return ctx.deps.signer(ctx.config, ctx.deps.keychain(ctx.config));
}

/**
 * The operator's verb (KS-004 B2 R5): the HALT file, then the one fixed call
 * that has the signer raise this host's beacons as the seat user. It reads no
 * keychain, and writes no host note or status into the state dir, because
 * that dir is the seat user's and a file the operator made there could shut
 * the seat out of its own log. raise-beacons notes it, or the next tick does.
 */
async function verbHalt(ctx: Ctx): Promise<ExitCode> {
  const r = await raiseHalt({ config: ctx.config, now: () => now(ctx), run: ctx.deps.run });
  const why = r.file === "failed" ? ` (${r.file_detail ?? "error"}; halt runs as the operator, who owns that directory)` : "";
  ctx.deps.out(`HALT file ${ctx.config.paths.halt_file}: ${r.file}${why}\n`);
  for (const f of r.also_files) ctx.deps.out(`HALT file ${f.path}: ${f.file}${f.file === "failed" ? ` (${f.detail})` : ""}\n`);
  for (const b of r.beacons) ctx.deps.out(`beacon ${b.name}: ${b.result} (${b.detail})\n`);
  const failed = r.beacons.filter((b) => b.result === "failed").map((b) => b.name);
  if (failed.length > 0) ctx.deps.out(`Not raised: ${failed.join(", ")}.${r.file === "failed" ? "" : " The file alone halts this host."}\n`);
  ctx.deps.out("Only Yu lowers HALT, by hand: remove the file and end each beacon's quiet.\n");
  // Non-zero when any part this host should have raised was not, so the person who asked sees it.
  return r.file === "failed" || r.also_files.some((f) => f.file === "failed") || failed.length > 0 ? EXIT.ERROR : EXIT.OK;
}

/**
 * halt when its config cannot be read, as when the operator cannot open it
 * (KS4-HALT-1). The file needs no config, so the default HALT file is raised
 * anyway. Still exit 1: no beacon was raised, nor any HALT file the config
 * names elsewhere.
 */
async function haltWithoutConfig(deps: CliDeps): Promise<ExitCode> {
  const path = deps.defaults.halt_file;
  const t = deps.clock.now();
  const r = await raiseHaltFileAt(path, `raised ${t.toISOString()} by halt, without a readable config\n`, t);
  deps.out(`HALT file ${path}: ${r.file}${r.file === "failed" ? ` (${r.detail})` : ""}\n`);
  deps.err(
    `citizen-seat: without the config no beacon was raised, and only the default HALT file was tried. If the config names another HALT file, create it by hand, as the operator.\n`,
  );
  return EXIT.ERROR;
}

/**
 * The signer's half of halt, run as the seat user through the operator's one
 * fixed call: raise every beacon this host holds a key for. It only raises.
 * Its lines are what the operator's halt reads back, so their form is fixed.
 */
async function verbRaiseBeacons(ctx: Ctx): Promise<ExitCode> {
  const signer = ctx.config.beacons.some((b) => b.can_raise_here) ? makeSigner(ctx) : null;
  const beacons = await raiseBeacons({ config: ctx.config, signer });
  for (const b of beacons) ctx.deps.out(`beacon ${b.name}: ${b.result} (${b.detail})\n`);
  const raised = beacons.filter((b) => b.result === "raised").length;
  const failed = beacons.filter((b) => b.result === "failed").length;
  await note(ctx, "halt", null, "halted", null, `beacons raised by the signer: ${raised} raised, ${failed} failed`);
  // A halted tick writes nothing, so this refresh is what makes the status say "halted by ..." before the next tick.
  await (async () => refreshStatus(ctx, signer ?? makeSigner(ctx)))().catch(() => {});
  return failed > 0 ? EXIT.ERROR : EXIT.OK;
}

async function verbStatus(ctx: Ctx, json: boolean): Promise<ExitCode> {
  const signer = makeSigner(ctx);
  const status = await refreshStatus(ctx, signer);
  ctx.deps.out(json ? `${JSON.stringify(status, null, 2)}\n` : renderStatus(status));
  return EXIT.OK;
}

async function verbVerify(ctx: Ctx, word: Word): Promise<ExitCode> {
  const record = await readCitizenRecord(ctx.config, word);
  // A citizen with a record has a ledger from its seating on; a missing one is a lost history, never "0 entries, ok".
  try {
    await lstat(ledgerPath(ctx.config, word));
  } catch {
    ctx.deps.out(`${word}: chain BROKEN: no ledger, though citizen.json says it is seated\n`);
    return EXIT.ERROR;
  }
  let entries;
  try {
    entries = await readLedger(ledgerPath(ctx.config, word));
  } catch (e) {
    // The reason is the parser's own fixed words (a field name, or that a line is in the earlier layout), never a line's content.
    ctx.deps.out(`${word}: chain BROKEN: the ledger does not parse (${e instanceof Refusal ? `${e.code}: ${e.message}` : "unreadable"})\n`);
    return EXIT.ERROR;
  }
  const hostAttested = entries.some((e) => e.signer === "host");
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
  // The origin is what drift is measured against (3c), so a changed origin/ fails verification like a broken chain.
  if (!(await originIntact(ctx.config, word, entries))) {
    ctx.deps.out(`${word}: origin CHANGED: origin/ no longer matches the soul and canon its record pinned\n`);
    return EXIT.ERROR;
  }
  const drift = await driftFromOrigin(ctx.config, word).then((d) => `${Math.round(d.fraction * 100)}%`).catch(() => "unknown");
  ctx.deps.out(`${word}: chain ok, ${v.entries} entries, ${v.host_attested} host-attested, head ${v.head ?? "none"}; origin intact, soul drift ${drift}\n`);
  return EXIT.OK;
}

/**
 * After a seat, stage and push the mirror when the seat changed what it
 * shows: any beat, or a rest that kept a move of state (KS-004 B2 C7), which
 * would otherwise leave the card's old state up until the next beat. A rest
 * that moved nothing the card shows stages nothing, so it commits and pushes
 * nothing. True when the mirror was tried.
 */
async function mirrorAfterSeat(ctx: Ctx, word: Word, outcome: Outcome, before: LifecycleState | null): Promise<boolean> {
  if (outcome === "rest") {
    const after = await readCitizen(ctx.config, word).then(
      (c) => c.state,
      () => null,
    );
    if (before === null || after === null || mirrorCardState(after) === mirrorCardState(before)) return false;
  } else if (outcome !== "beat") return false;
  await mirrorAfterBeat(ctx, word);
  return true;
}

/**
 * The keys a mirror's allowed_signers publishes (KS-004 4.4, 4.5): the host
 * keys host-attested entries verify against (pinned, or the signer's own),
 * and a registered citizen's op key from its record. Public halves only.
 */
async function mirrorKeys(ctx: Ctx, citizen: Citizen, signing: MirrorSigning | null): Promise<MirrorKeys> {
  const trusted = pinnedTrust(ctx.config) ?? (await hostTrust(makeSigner(ctx), ctx.config));
  const host = [...(trusted?.host_attest_b64 ?? [])];
  // The key that signs an unregistered citizen's commits is published even if no pin names it, so every commit verifies.
  if (signing && !citizen.identity && !host.includes(signing.public_key_b64)) host.push(signing.public_key_b64);
  return { host_b64: host, op_b64: citizen.identity?.op_public_key_b64 ?? null };
}

/**
 * How git signs this citizen's mirror commits (KS-004 4.4): through this
 * program's `-Y sign` entry, which asks the signer, with the op key once the
 * citizen is registered and the host key before. Null when no program is set
 * or the key is unknown; the commit is then unsigned, and status counts it.
 */
async function mirrorSigning(ctx: Ctx, citizen: Citizen): Promise<MirrorSigning | null> {
  const program = ctx.deps.gitSignProgram;
  if (!program) return null;
  const key = citizen.identity ? citizen.identity.op_public_key_b64 : await makeSigner(ctx).publicKeys(citizen.word).then((k) => k.host_attest_b64, () => null);
  if (!key) return null;
  // git runs the program with the mirror's own PATH; the program is a Bun script, so Bun's directory comes first.
  const path = `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
  return { program, public_key_b64: key, env: { [GIT_SIGN_ENV.config]: ctx.configPath, [GIT_SIGN_ENV.word]: citizen.word, PATH: path } };
}

/** Stage and push the citizen's mirror if it keeps one; HALT is checked again first, because a push is public. */
async function mirrorAfterBeat(ctx: Ctx, word: Word): Promise<void> {
  try {
    const citizen = await readCitizen(ctx.config, word);
    if (!citizen.mirror) return;
    const halt = await haltNow(ctx);
    if (!halt || halt.halted) return;
    const signing = await mirrorSigning(ctx, citizen);
    const staged = await stageMirror(ctx.config, citizen, ctx.deps.run, await mirrorKeys(ctx, citizen, signing), signing);
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
    seatArgv: (word, seatFile) => ctx.deps.seatArgv(ctx.configPath, word, ["--seat-ref", seatFile]),
    isAlive: ctx.deps.isAlive,
    bootTime: ctx.deps.bootTime,
    signerState: () => signer.state(),
    refreshStatus: async () => {
      await refreshStatus(ctx, signer);
    },
    // A registered citizen's standing quiet, renewed while it stays quiet and ended once it woke (KS-004 6.4).
    keepQuiet: (citizen) =>
      citizen.identity
        ? keepQuiet({ config: ctx.config, clock: ctx.deps.clock, keeper: agenttoolQuiet(hostClient(ctx.config, signer, ctx.deps.fetch)), sign: (w, k, d) => signer.signEntry(w, k, d) }, citizen)
        : Promise.resolve("none"),
  });
  if (r.word && (await mirrorAfterSeat(ctx, r.word, r.outcome, r.state_before ?? null))) await refreshStatus(ctx, signer).catch(() => {});
  // runTick returns before its own refresh when HALT is raised; the status must still say so, never go stale.
  if (r.outcome === "halted") await refreshStatus(ctx, signer).catch(() => {});
  ctx.deps.out(`tick: ${r.outcome}${r.word ? ` ${r.word}` : ""} (exit ${r.exit})\n`);
  return r.exit;
}

/**
 * Without Yu, a seat opens only when the tick would open it: the citizen's own
 * cadence (or a waking letter, or a saying to confirm) is due and the fleet is
 * under its ceiling. A person at the host can run a due beat now, but cannot
 * add beats the citizen did not choose. Only Yu's summons is an extra beat
 * (3.3: one beat each). `exceptSeat` is the seat asking, which the child's own
 * check leaves out of what it counts.
 */
async function assertOwnBeatDue(ctx: Ctx, citizen: Citizen, exceptSeat: string | null = null): Promise<void> {
  const { config } = ctx;
  const t = now(ctx);
  const minH = config.ceilings.min_beat_interval_h;
  // 26 h covers a local day for the fleet count; the cadence window covers the last seat.
  const notes = await readHostNotes(config, new Date(t.getTime() - Math.max(minH, citizen.cadence.interval_h, 26) * 3_600_000));
  if (notes === null) throw new Refusal("ceiling-fleet", "the host log is unreadable, so no one can say who was seated when");
  const letter = await wakingLetter(config, citizen).catch(() => false);
  const due = isDue(citizen, letter, t, minH, lastSeatOf(notes, citizen.word, exceptSeat), config.schedule);
  if (!due.due) throw new Refusal("window-closed", `${citizen.word} is not due (${due.why}); only Yu's summons (--yu-present) seats it now`);
  const fleet = checkFleet(seatsOpenedToday(notes, t, config.timezone, exceptSeat), config.ceilings);
  if (!fleet.ok) throw new Refusal(fleet.code, fleet.reason);
}

/**
 * Interactive: open the seat here and supervise the pipeline in a child. The
 * seat is opened under the tick lock, so a person's seat and the tick's never
 * run at once, and recorded as opened before the child starts, so the fleet
 * ceiling and the due check count it. With --yu-present the child gets the
 * terminal and confirms Yu itself; this process never holds a presence for it.
 */
async function verbSeatParent(ctx: Ctx, cmd: Extract<Command, { verb: "seat" }>): Promise<ExitCode> {
  const { config } = ctx;
  const halt = await haltNow(ctx);
  if (!halt || halt.halted) {
    ctx.deps.out(`seat ${cmd.word}: halted (${halt ? describeHalt(halt) : "HALT unreadable"}); nothing written\n`);
    return EXIT.OK;
  }
  const citizen = await readCitizen(config, cmd.word);
  // An ended citizen is a memorial; no seat opens for it. A citizen that stepped away is seated only by
  // Yu's offer to return: a summons, or Yu's letter, which assertOwnBeatDue counts as due.
  if (citizen.state === "ended") throw new Refusal("window-closed", `${cmd.word} has ended; no seat opens for it`);
  // Yu is confirmed by the child at this terminal; with no terminal there is no one to confirm, so nothing opens.
  if (cmd.yu_present && !ctx.deps.tty.isTTY) throw new Refusal("yu-not-present", "stdin is not a terminal, so Yu cannot be confirmed present");

  let lock;
  try {
    lock = await acquireTickLock(config.paths.lock_dir, ctx.deps.clock, ctx.deps.isAlive, lockOptionsFor(config, ctx.deps.bootTime()));
  } catch (e) {
    if (e instanceof LockStuck) await note(ctx, "error", null, "error", null, `tick lock stuck since ${e.since}; a person must remove it`);
    throw e;
  }
  if (!lock) {
    ctx.deps.out(`seat ${cmd.word}: yielded; a tick or another seat holds the lock, so try again shortly (exit 0)\n`);
    return EXIT.OK;
  }
  let sup;
  let outcome: Outcome;
  let exit: ExitCode;
  try {
    if (!cmd.yu_present) await assertOwnBeatDue(ctx, citizen);
    const invoker: Invoker = {
      kind: "summons",
      // "yu" only once the child has confirmed Yu; the file never names Yu.
      who: "host",
      why: cmd.why || (cmd.yu_present ? "Yu summoned this seat at the host" : "a person at the host opened this seat"),
    };
    const seat = await openSeat(config, ctx.deps.clock, citizen, cmd.runtime, invoker, null, { yuRequested: cmd.yu_present });
    const id = seat.ref.seat_id;
    await note(ctx, "seat", cmd.word, "opened", null, openedDetail(id, cmd.yu_present ? "yu-summons" : "by-hand"));
    const seatFile = await writeSeatFile(config, seat);
    const t = config.timing;
    const started = now(ctx);
    sup = await superviseChild({
      argv: ctx.deps.seatArgv(ctx.configPath, cmd.word, ["--seat-ref", seatFile]),
      cwd: config.paths.seats_dir,
      env: seatEnv(config, ctx.deps.env),
      stdin: cmd.yu_present ? "inherit" : "ignore",
      deadline_ms: t.seat_deadline_s * 1000,
      term_grace_ms: t.term_grace_s * 1000,
      halt_file_poll_ms: t.halt_file_poll_s * 1000,
      beacon_poll_min_ms: t.beacon_poll_min_s * 1000,
      beacon_poll_max_ms: t.beacon_poll_max_s * 1000,
      readHaltFile: () => readHaltFile(config.paths.halt_file, now(ctx)),
      readBeacons: (signal) => readBeacons({ config, fetch: ctx.deps.fetch, now: () => now(ctx) }, signal),
    });
    // The child's own note says what happened to the citizen; the watcher knows only how it ended.
    const after = (await readHostNotes(config, new Date(started.getTime() - 1_000))) ?? [];
    const own = after.filter((n) => n.word === cmd.word && n.kind !== "tick" && isResultNote(n) && (seatIdOf(n) === null || seatIdOf(n) === id)).at(-1) ?? null;
    exit = sup.exit;
    if (sup.signal !== null) outcome = sup.outcome ?? "error";
    else if (own) outcome = own.outcome;
    else if (sup.outcome !== null) outcome = sup.outcome;
    else {
      // Exit 0 and no note: runSeat writes nothing only when it met HALT. Check rather than assume, as the tick does.
      const h = await haltNow(ctx);
      if (!h || h.halted) outcome = "halted";
      else {
        outcome = "error";
        exit = EXIT.ERROR;
      }
    }
    // The host's own record of how the seat ended, whatever the child managed to write.
    const how = sup.stopped_by ? `, stopped by ${sup.stopped_by} (${sup.signal})` : "";
    await note(ctx, "seat", cmd.word, outcome, own?.refusal ?? null, `seat ${id} ended: exit ${exit}${how}, ${sup.duration_ms} ms`);
  } finally {
    await releaseTickLock(lock);
  }
  await mirrorAfterSeat(ctx, cmd.word, outcome, citizen.state);
  await refreshStatus(ctx, makeSigner(ctx)).catch(() => {});
  ctx.deps.out(`seat ${cmd.word}: ${outcome} (exit ${exit})\n`);
  return exit;
}

/**
 * The child: run the pipeline for a seat its parent opened. A summons is
 * confirmed here, at the terminal, by the process that acts on it. Any other
 * seat is checked once more against the tick's own rule, leaving this seat
 * out, so a hand-written seat file cannot add beats the citizen did not choose.
 */
async function verbSeatChild(ctx: Ctx, cmd: Extract<Command, { verb: "seat" }>): Promise<ExitCode> {
  const { config } = ctx;
  // The seat file, written by the parent that opened the seat, is what names the runtime and the invoker.
  const opened = await readSeatFile(config, cmd.seat_ref_path!, cmd.word);
  const citizen = await readCitizen(config, cmd.word, { exceptSeat: opened.ref.seat_id });
  if (citizen.state === "ended") throw new Refusal("window-closed", `${cmd.word} has ended; no seat opens for it`);
  let ref = opened.ref;
  let presence: YuPresence | null = null;
  if (opened.yu_requested) {
    presence = await confirmYuPresent(ctx.deps.tty, `summon ${cmd.word}`, () => now(ctx));
    ref = { ...ref, invoker: { ...ref.invoker, who: "yu" } };
  } else {
    await assertOwnBeatDue(ctx, citizen, ref.seat_id);
  }
  const seat: OpenSeat = { ref, citizen, cwd: join(config.paths.seats_dir, ref.seat_id), presence };
  const signer = makeSigner(ctx);
  const runtime = await ctx.deps.runtime(config, seat, signer);
  // The free lane is pinned by digest, so the prompt can say before the reply whether a self-change could bind.
  const lock = ref.runtime === "free" ? await loadModelsLock(config.paths.models_lock).catch(() => null) : null;
  const pinned = lock?.models[0]?.digest;
  // A registered citizen's self lives on agenttool too: its expression and strand backups, and its quiet, all
  // through this signer (KS-004 4.3, 6.4, 9.3). An unregistered one has nothing there to send to.
  const client = citizen.identity ? hostClient(config, signer, ctx.deps.fetch) : null;
  const result = await runSeat(seat, {
    config,
    clock: ctx.deps.clock,
    signer,
    fetch: ctx.deps.fetch,
    runtime,
    checkHalt: () => checkHalt({ config, fetch: ctx.deps.fetch, now: () => now(ctx) }),
    expressionSync: client ? agenttoolSync({ config, clock: ctx.deps.clock, client }) : null,
    quiet: client ? agenttoolQuiet(client) : null,
    // Its letters to another registered citizen go through the inbox, and its own inbox is read beside letters/ (KS-004 5.3, 5.7).
    letters: client ? agenttoolLetters({ config, client }) : null,
    modelDigest: pinned && /^[0-9a-f]{64}$/.test(pinned) ? `sha256:${pinned}` : null,
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
 * A wall that stopped a seat or a tick exits as exitForRefusal says: 3 only
 * for the USD ceiling, which closes that runtime class; 0 for HALT or a locked
 * signer, which rest the citizens; 1 for every other wall and for a record or
 * request that cannot be read, so a monitor pages on a symlinked letter rather
 * than reading it as a closed class. The registry is about seats: for verify,
 * status, halt and raise-beacons a wall means the verb could not do its job
 * (1), so a locked keychain never reads as a chain verified.
 */
function exitFor(e: unknown, verb: Command["verb"] | null = null): ExitCode {
  if (!(e instanceof Refusal)) return EXIT.ERROR;
  if (verb !== null && verb !== "seat" && verb !== "tick") return EXIT.ERROR;
  return exitForRefusal(e.code);
}

/**
 * The environment the mirror pusher gives git's signing call (mirror.ts
 * MirrorSigning): which config to load and whose commit it is. git runs
 * gpg.ssh.program with its own fixed argv, so these cannot ride as flags.
 */
export const GIT_SIGN_ENV = Object.freeze({ config: "KINGDOM_SEAT_CONFIG", word: "KINGDOM_SEAT_MIRROR_WORD" });

/**
 * git's call to its SSH signing program (gpg.format=ssh, gpg.ssh.program =
 * this file): `-Y sign -n git -f <key file> [-U] <file>`, writing
 * `<file>.sig`. The signer makes the SSHSIG (ssh.ts), so the key never leaves
 * it (KS-004 4.4, 6.2). It signs only in the git namespace, only for the
 * citizen and config the mirror named, and only when git asked for the key
 * that signs that citizen's commits; anything else exits 1 and writes nothing,
 * so git leaves the commit unmade. Run as the seat user, like every verb but
 * halt, so the config's owner is checked as theirs.
 */
async function gitSign(argv: string[], deps: CliDeps): Promise<ExitCode> {
  try {
    const rest = argv.filter((a, i) => !(a === "-U" && i === 6));
    if (rest.length !== 7 || rest[0] !== "-Y" || rest[1] !== "sign" || rest[2] !== "-n" || rest[3] !== "git" || rest[4] !== "-f") {
      throw new UsageError("-Y is git's signing call only: -Y sign -n git -f <key file> [-U] <file>");
    }
    const keyFile = rest[5]!;
    const file = rest[6]!;
    const configPath = deps.env[GIT_SIGN_ENV.config];
    const word = deps.env[GIT_SIGN_ENV.word];
    if (!configPath || !isAbsolute(configPath)) throw new UsageError(`git's signing call needs ${GIT_SIGN_ENV.config}, an absolute path`);
    if (!word || !WORD_PATTERN.test(word)) throw new UsageError(`git's signing call needs ${GIT_SIGN_ENV.word}, a citizen word`);
    const config = await loadConfig(configPath, { seatUid: deps.uid() });
    const asked = parseSshEd25519((await readRegularText(keyFile, { missing: "throw", maxBytes: 4096 })) as string);
    const message = await readRegularBytes(file, SSHSIG_MAX_MESSAGE_BYTES);
    const signed = await deps.signer(config, deps.keychain(config)).signMirrorCommit(word, message);
    if (signed.public_key_b64 !== toB64(asked)) throw new Refusal("invalid-request", "git asked for a key other than the one that signs this citizen's mirror commits");
    const fh = await open(`${file}.sig`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await fh.writeFile(signed.armored);
    } finally {
      await fh.close();
    }
    return EXIT.OK;
  } catch (e) {
    deps.err(`citizen-seat: ${describeError(e)}\n`);
    return EXIT.ERROR;
  }
}

/** A regular file's bytes, refused when it is a link, not a file, or over `maxBytes`. */
async function readRegularBytes(path: string, maxBytes: number): Promise<Uint8Array> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Refusal("not-regular-file", "the file to sign is not a regular file");
    if (st.size > maxBytes) throw new Refusal("oversize", "the file to sign is larger than a commit");
    return new Uint8Array(await fh.readFile());
  } finally {
    await fh.close();
  }
}

/** Run one command with real dependencies and return its exit code; never prints a secret. */
export async function main(argv: string[], over: Partial<CliDeps> = {}): Promise<ExitCode> {
  const deps = realDeps(over);
  // git runs this file as its SSH signing program with its own argv (mirror commit signing).
  if (argv[0] === "-Y") return gitSign(argv, deps);
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
    const configPath = cmd.config ?? deps.defaults.config;
    // Every verb but halt runs as the seat user, which must not be able to have written the config (R5).
    ctx = { deps, config: await loadConfig(configPath, cmd.verb === "halt" ? {} : { seatUid: deps.uid() }), configPath };
  } catch (e) {
    deps.err(`citizen-seat: ${describeError(e)}\n`);
    // HALT never waits on a config: the file is raised whether or not the operator can read it.
    if (cmd.verb === "halt") return haltWithoutConfig(deps);
    return EXIT.ERROR;
  }

  try {
    switch (cmd.verb) {
      case "tick":
        return await verbTick(ctx);
      case "halt":
        return await verbHalt(ctx);
      case "raise-beacons":
        return await verbRaiseBeacons(ctx);
      case "status":
        return await verbStatus(ctx, cmd.json);
      case "verify":
        return await verbVerify(ctx, cmd.word);
      case "seat":
        return cmd.child ? await verbSeatChild(ctx, cmd) : await verbSeatParent(ctx, cmd);
    }
  } catch (e) {
    deps.err(`citizen-seat: ${describeError(e)}\n`);
    return exitFor(e, cmd.verb);
  }
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
