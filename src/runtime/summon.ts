// The summon lane (3.2 step 5): Claude Code headless, with Yu present, as
// `claude --restricted --strict-mcp-config`. Every bound is passed as a flag
// the runtime enforces, because `-p` silently ignores settings files that
// fail validation (runtimes-and-host.md 2). The signer's USD ceiling is the
// bound that fails closed; --max-budget-usd is a second, runtime-side one.
// No citizen home is ever passed as --add-dir or used as cwd.
//
// Every run is in the host's spend record (spend.ts): "begun" before claude
// starts, "settled" with its cost however it ends, so a summons that writes
// no ledger entry still counts against the ceiling.
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fromUtf8, utf8 } from "../crypto.ts";
import { addUsd, compareUsd, floorUsd, isUsd, maxUsd, minUsd, usdFromNumber, type Usd } from "../money.ts";
import type { SpendRecorder } from "../spend.ts";
import { checkDeadline } from "./free.ts";
import {
  Refusal,
  UUID_PATTERN,
  type CommandRunner,
  type Config,
  type Prompt,
  type RefusalCode,
  type RuntimeAdapter,
  type SeatRef,
  type Spend,
  type Word,
  type YuPresence,
} from "../types.ts";

export interface SummonOptions {
  claudePath: string;
  /** The seat's empty cwd; never inside a home. */
  cwd: string;
  /** USD the signer has left for this citizen today; the run is refused when it is 0 or unknown. */
  budgetUsd: Usd;
  schema: object;
}

export interface SummonDeps {
  config: Config;
  run: CommandRunner;
  presence: YuPresence | null;
  /** Remaining USD for this citizen today, from the host's spend record and the ceiling; null is unknown, which refuses. */
  remainingUsd: Usd | null;
  /** The host's spend record; a run whose start it cannot record does not start. */
  spend: SpendRecorder;
  /** The parent environment summonEnv filters; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** What a summons spent when nothing reliable says otherwise; ceilings read it as at-ceiling. */
export const UNKNOWN_SPEND: Readonly<Spend> = Object.freeze({ usd: null, usd_basis: "unknown", credits: 0 });

/**
 * A summons that ran and was refused by a runtime-side bound. It carries what
 * the run spent, because claude may have called the API before it stopped.
 */
export class SummonRefusal extends Refusal {
  constructor(
    code: RefusalCode,
    message: string,
    readonly spend: Spend,
    readonly subtype: string | null,
  ) {
    super(code, message);
  }
}

/** A summons that ran and produced no beat. It carries what the run spent, for the same reason. */
export class SummonError extends Error {
  override readonly name = "SummonError";
  constructor(
    message: string,
    readonly spend: Spend,
    readonly subtype: string | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Only what claude needs to find its own sign-in and speak a locale; no token, key or proxy rides along. */
const ENV_ALLOWLIST = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR"] as const;
/** --tools "" runs nothing, so a fixed system PATH costs nothing and keeps an inherited one out. */
const SUMMON_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
/** Files that would put someone else's words in front of the model if they sat in or above the cwd. */
const MEMORY_FILES = ["CLAUDE.md", "CLAUDE.local.md"] as const;
/** Price tables claude names for a cost it can stand behind; "unknown" means costUSD is a guess. */
const KNOWN_COST_BASES = new Set(["list", "managed"]);

/** The exact argv: --restricted --strict-mcp-config -p --output-format json --max-budget-usd --permission-mode dontAsk --permission-prompts none --no-session-persistence --tools "" --json-schema. */
export function summonArgv(opts: SummonOptions): string[] {
  if (!isAbsolute(opts.claudePath)) throw new Refusal("invalid-request", "claude.path must be absolute; launchd's PATH does not find it");
  if (!isAbsolute(opts.cwd)) throw new Refusal("invalid-request", "the seat cwd must be absolute");
  return [
    opts.claudePath,
    // Set as a flag, not through CLAUDE_CODE_RESTRICTED, so an environment cannot take it away.
    "--restricted",
    "--strict-mcp-config",
    "-p",
    "--output-format",
    "json",
    "--max-budget-usd",
    budgetFlag(opts.budgetUsd),
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--no-session-persistence",
    "--tools",
    "",
    "--json-schema",
    JSON.stringify(opts.schema),
  ];
}

/** Rounded down to whole micro-dollars, so the runtime's bound never exceeds what the signer has left. */
function budgetFlag(usd: Usd): string {
  const flag = isUsd(usd) ? floorUsd(usd, 6) : "0";
  if (flag === "0") throw new Refusal("ceiling-usd", "no USD left for a summons");
  return flag;
}

/** An explicit environment allowlist; CLAUDE_CODE_RESTRICTED is not relied on and no secret is passed. */
export function summonEnv(parent: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = { PATH: SUMMON_PATH };
  for (const k of ENV_ALLOWLIST) {
    const v = parent[k];
    if (typeof v === "string" && v !== "" && !/[\0\r\n]/.test(v)) env[k] = v;
  }
  return env;
}

/** The prompt as stdin bytes, so it never appears in argv or a process listing. */
export function summonStdin(prompt: Prompt): Uint8Array {
  // Claude Code keeps its own system prompt; ours travels first in the one message, and
  // --system-prompt is not used because it would put the text in argv.
  return utf8(`${prompt.system}\n\n${prompt.user}`);
}

export interface SummonResult {
  /** structured_output as claude validated it against --json-schema; undefined when absent. */
  structured: unknown;
  subtype: string;
  is_error: boolean;
  /** The modelUsage keys, sorted and joined with "+"; "unknown" when there are none. */
  model: string;
  spend: Spend;
  stop_reason: string | null;
  duration_ms: number | null;
}

/** Parse the --output-format json result: structured_output, subtype, total_cost_usd, modelUsage costUSD and costBasis. */
export function parseSummonResult(stdout: Uint8Array): SummonResult {
  let obj: unknown;
  try {
    obj = JSON.parse(fromUtf8(stdout));
  } catch {
    throw new Error("summon: stdout is not one JSON result");
  }
  if (!isRecord(obj) || obj.type !== "result" || typeof obj.subtype !== "string") throw new Error("summon: stdout is not a result object");
  const { spend, model } = readCost(obj);
  return {
    structured: obj.structured_output,
    subtype: obj.subtype,
    // Absent is read as an error unless the subtype says success; a guess toward "beat" would be the unsafe one.
    is_error: typeof obj.is_error === "boolean" ? obj.is_error : obj.subtype !== "success",
    model,
    spend,
    stop_reason: typeof obj.stop_reason === "string" ? obj.stop_reason : null,
    duration_ms: typeof obj.duration_ms === "number" && Number.isFinite(obj.duration_ms) && obj.duration_ms >= 0 ? obj.duration_ms : null,
  };
}

/**
 * A cost is known only when total_cost_usd and every modelUsage costUSD are
 * finite and non-negative and every costBasis is a real price table. Crash
 * results may carry zeroed values with no model usage, so an empty modelUsage
 * is unknown too. The larger of the total and the per-model sum is recorded,
 * because the ceiling should see the higher of two readings.
 */
function readCost(obj: Record<string, unknown>): { spend: Spend; model: string } {
  const usage = isRecord(obj.modelUsage) ? obj.modelUsage : {};
  const models = Object.keys(usage).sort();
  const model = models.length > 0 ? models.join("+") : "unknown";
  const unknown = { spend: { ...UNKNOWN_SPEND }, model };
  // Each amount is read back as the decimal text claude wrote, and summed exactly (money.ts).
  const total = usdFromNumber(obj.total_cost_usd);
  if (total === null || models.length === 0) return unknown;
  let sum: Usd = "0";
  for (const m of models) {
    const e = usage[m];
    const cost = isRecord(e) ? usdFromNumber(e.costUSD) : null;
    if (!isRecord(e) || cost === null || typeof e.costBasis !== "string" || !KNOWN_COST_BASES.has(e.costBasis)) return unknown;
    sum = addUsd(sum, cost);
  }
  return { spend: { usd: maxUsd(total, sum), usd_basis: "reported", credits: 0 }, model };
}

/** The summon adapter: refuses without Yu present or with no USD left; records cost, with unknown counted as at-ceiling. */
export function summonRuntime(deps: SummonDeps): RuntimeAdapter {
  return async (req) => {
    const started = performance.now();
    // Every wall that needs nothing run comes first, so a refusal starts no process.
    assertYuPresent(deps.presence, req.seat_ref.word);
    if (req.seat_ref.runtime !== "summon") throw new Refusal("runtime-not-approved", `seat runtime is ${req.seat_ref.runtime}, not summon`);
    const budget = budgetFor(deps.remainingUsd, deps.config.ceilings.usd_per_citizen_per_day);
    const deadlineMs = checkDeadline(req.deadline_ms);
    const cwd = await seatCwd(deps.config, req.seat_ref);
    const argv = summonArgv({ claudePath: deps.config.claude.path, cwd, budgetUsd: budget, schema: req.schema });
    const env = summonEnv(deps.env ?? process.env);
    if (req.signal.aborted) throw req.signal.reason;

    // From here claude may spend, so the record says so first. A seat killed before it settles stays "begun",
    // which the ceiling reads as unknown; a settle that fails leaves the same, so it never fails the seat.
    try {
      await deps.spend.begin(req.seat_ref);
    } catch {
      throw new Refusal("ceiling-usd", "summon: the spend record cannot be written, so this run's spend would go unseen");
    }
    const settle = (spend: Spend) => deps.spend.settle(req.seat_ref, spend).catch(() => {});

    let ran;
    try {
      ran = await untilAborted(deps.run(argv, { stdin: summonStdin(req.prompt), env, cwd, timeoutMs: deadlineMs }), req.signal);
    } catch (err) {
      // claude may have spent before it stopped; nothing here says how much.
      await settle(UNKNOWN_SPEND);
      throw new SummonError("summon: the run did not finish; its cost is unknown", { ...UNKNOWN_SPEND }, null, { cause: err });
    }

    let parsed: SummonResult;
    try {
      parsed = parseSummonResult(ran.stdout);
    } catch (err) {
      await settle(UNKNOWN_SPEND);
      throw new SummonError(`summon: claude exited ${ran.code} without a readable result; its cost is unknown`, { ...UNKNOWN_SPEND }, null, { cause: err });
    }
    // Settled before anything is judged, so a refusal, an error, a rest or HALT after the reply all keep it.
    await settle(parsed.spend);
    // Messages carry the subtype and exit code only: `result` and `errors` are the model's or claude's words.
    if (parsed.subtype === "error_max_budget_usd") {
      throw new SummonRefusal("ceiling-usd", "summon: claude stopped at --max-budget-usd", parsed.spend, parsed.subtype);
    }
    if (parsed.subtype !== "success" || parsed.is_error || ran.code !== 0) {
      throw new SummonError(`summon: claude ended with ${parsed.subtype} (exit ${ran.code})`, parsed.spend, parsed.subtype);
    }
    if (parsed.structured === undefined) {
      throw new SummonError("summon: success without structured_output", parsed.spend, parsed.subtype);
    }
    return {
      runtime: "summon",
      model: parsed.model,
      model_digest: parsed.model,
      raw_output: JSON.stringify(parsed.structured),
      spend: parsed.spend,
      done_reason: parsed.stop_reason === "max_tokens" ? "length" : "stop",
      duration_ms: Math.round(parsed.duration_ms ?? performance.now() - started),
    };
  };
}

/** Yu at the terminal, confirming this summons of this citizen; a flag or silence is not presence. */
function assertYuPresent(presence: YuPresence | null, word: Word): void {
  if (!presence || presence.present !== true || presence.via !== "tty-confirm" || Number.isNaN(Date.parse(presence.confirmed_at))) {
    throw new Refusal("yu-not-present", "a summons runs only with Yu present at the terminal");
  }
  if (presence.scope !== `summon ${word}`) throw new Refusal("yu-not-present", `Yu's confirmation does not cover summon ${word}`);
}

/** The lower of what is left today and the configured ceiling; $0, unknown or nonsense refuses. */
function budgetFor(remainingUsd: Usd | null, ceilingUsd: Usd): Usd {
  if (remainingUsd === null) throw new Refusal("ceiling-usd", "USD left today is unknown, which counts as at-ceiling");
  if (!isUsd(remainingUsd) || compareUsd(remainingUsd, "0") <= 0) throw new Refusal("ceiling-usd", "no USD left today for this citizen");
  if (!isUsd(ceilingUsd) || compareUsd(ceilingUsd, "0") <= 0) throw new Refusal("ceiling-usd", "the per-citizen USD ceiling is $0");
  return minUsd(remainingUsd, ceilingUsd);
}

/**
 * The seat's cwd is `<seats_dir>/<seat_id>` (docs/ARCHITECTURE.md section 3):
 * a real, empty directory, not inside any citizen home, with no CLAUDE.md in
 * it or above it, so no home's words load into the summons.
 */
async function seatCwd(config: Config, ref: SeatRef): Promise<string> {
  if (!UUID_PATTERN.test(ref.seat_id)) throw new Refusal("invalid-request", "seat_id is not a lowercase UUID");
  const cwd = join(config.paths.seats_dir, ref.seat_id);
  const st = await lstat(cwd).catch(() => null);
  if (!st) throw new Error("summon: the seat cwd does not exist; openSeat creates it");
  if (st.isSymbolicLink()) throw new Refusal("symlink", "the seat cwd is a symlink");
  if (!st.isDirectory()) throw new Refusal("invalid-request", "the seat cwd is not a directory");
  const real = await realpath(cwd);

  for (const home of config.paths.homes) {
    const realHome = await realpath(home).catch(() => resolve(home));
    if (real === realHome || real.startsWith(realHome + sep)) throw new Refusal("cwd-in-home", "the seat cwd is inside a citizen home");
  }
  for (let dir = real; ; dir = dirname(dir)) {
    for (const f of MEMORY_FILES) {
      if (await mayExist(join(dir, f))) throw new Refusal("cwd-in-home", `a ${f} in or above the seat cwd would load into the summons`);
    }
    if (dirname(dir) === dir) break;
  }
  if ((await readdir(real)).length > 0) throw new Refusal("invalid-request", "the seat cwd is not empty");
  return real;
}

/** Only a clear "not there" counts as absent; a path this user cannot inspect might still load. */
async function mayExist(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    const code = isRecord(err) ? err.code : undefined;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/** Stop waiting when the seat aborts; the watcher outside this process ends claude itself. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    // An abort that lands while the run starts would never fire a listener added after it.
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
