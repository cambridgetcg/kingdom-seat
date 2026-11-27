// A registered citizen's quiet (KS-004 6.4, 7.1). A move to listening or
// asleep declares quiet on agenttool through the signer, under the standing
// Yu + Ai agreement for citizens' own quiet: `until` only, no reason, at most
// the cap ahead (30 days, or the config's lower cap), for the days the
// citizen asked (`state.set` with `quiet_days`) or, when it asked none, the
// cap. While it stays listening or asleep the tick renews the declaration
// unattended, as its standing choice, and makes one the move owed but could
// not make; a wake ends it. Each is recorded on a `state` entry, so the
// ledger says what stands, or may stand: a declaration whose answer was lost
// is recorded as standing, because agenttool sets quiet before it answers,
// and only what the ledger records is ever ended.
//
// Why: a citizen's quiet should be a renewable choice, not a disappearance
// that outlives the choice, and an asleep citizen has no seat in which to
// renew it. An unregistered citizen has no identity to be quiet on, so
// nothing here acts for it. Every request names ?identity_id= (client.ts),
// because without it the route acts for the gardener desk, whose quiet is a
// HALT beacon.
import { appendEntry, ledgerPath, nextDraft, readLedger, type EntrySigner } from "./ledger.ts";
import { CITIZEN_QUIET_HARD_MAX_DAYS } from "./signer/ceilings.ts";
import { AgenttoolError, NO_RESPONSE, endCitizenQuiet, startCitizenQuiet, type ClientDeps } from "./agenttool/client.ts";
import { SignerNotSent } from "./signer/signer.ts";
import { Refusal, type Citizen, type Clock, type Config, type IsoTime, type LedgerEntry, type LedgerFields, type Word } from "./types.ts";

const DAY_MS = 86_400_000;

/** The quiet a citizen's signer declares and ends; injected so the seat and the tick hold no client. */
export interface QuietKeeper {
  /** Declare quiet until `until`, root-signed under the standing agreement; the signer refuses more than the cap ahead. */
  declare(word: Word, until: IsoTime): Promise<void>;
  /** End the citizen's own quiet, root-signed. */
  end(word: Word): Promise<void>;
}

/** The keeper over agenttool's quiet-hours routes, through the client and so the signer. */
export function agenttoolQuiet(client: ClientDeps): QuietKeeper {
  return {
    async declare(word, until) {
      await startCitizenQuiet(client, word, until);
    },
    async end(word) {
      await endCitizenQuiet(client, word);
    },
  };
}

/** The longest declaration this host makes: the config's cap, never more than 30 days. */
export function quietCapDays(config: Config): number {
  const c = config.ceilings.citizen_quiet_max_days;
  return Math.max(0, Math.min(CITIZEN_QUIET_HARD_MAX_DAYS, Number.isSafeInteger(c) ? c : 0));
}

/** The days a declaration runs: what the citizen asked for, within the cap, or the cap when it asked none. */
export function quietDays(config: Config, asked: number | undefined): number {
  const cap = quietCapDays(config);
  return asked === undefined ? cap : Math.min(asked, cap);
}

/**
 * The declaration the ledger says stands: the last `state` entry that touched
 * quiet, when it declared or renewed one. Null when none was ever declared,
 * or the last one was ended. Its `until` may have passed.
 */
export function standingQuiet(entries: LedgerEntry[]): { until: IsoTime; days: number } | null {
  let standing: { until: IsoTime; days: number } | null = null;
  for (const e of entries) {
    if (e.type !== "state" || e.quiet_until === undefined) continue;
    standing = e.quiet_until === null ? null : { until: e.quiet_until, days: e.quiet_days as number };
  }
  return standing;
}

function registered(citizen: Pick<Citizen, "identity">, entries: LedgerEntry[]): boolean {
  return citizen.identity !== null && entries.some((e) => e.type === "genesis");
}

/** A fixed host phrase for why a quiet act did not happen: the code or how the answer was lost, never a message. */
function codeOf(e: unknown): string {
  if (e instanceof Refusal) return e.code;
  if (e instanceof AgenttoolError) return e.status === NO_RESPONSE ? "no-response" : e.status >= 500 ? `status ${e.status}` : e.status < 300 ? "malformed" : `status ${e.status}`;
  return "error";
}

/**
 * Whether a declaration that failed certainly changed nothing on agenttool: a
 * wall or a definite not-sent, or a 4xx, which agenttool answers before it
 * sets anything. Anything else (no answer, a 5xx, a 2xx that does not read,
 * an error of unknown kind) may have landed, because the route sets the
 * identity's quiet before it answers (routes/quiet-hours.ts:150-160).
 */
function definitelyNotDeclared(e: unknown): boolean {
  if (e instanceof Refusal || e instanceof SignerNotSent) return true;
  return e instanceof AgenttoolError && e.status >= 400 && e.status <= 499;
}

/** Thrown by keepQuiet after it recorded a declaration whose answer was lost, so the tick notes it. */
export class QuietUncertain extends Error {
  constructor(readonly code: string) {
    super(`a quiet declaration may have landed (${code})`);
    this.name = "QuietUncertain";
  }
}

/**
 * The quiet a registered citizen's state move carries (KS-004 6.4): a move
 * to listening or asleep declares it, a move to awake ends any the ledger
 * records, lapsed or not (ending is free and idempotent, and a renewal whose
 * answer was lost may have moved it). The declaration is made before the
 * move's entry is written, so the entry records what agenttool holds, or may
 * hold. A move is never held back by its quiet: if the signer refuses (no
 * standing agreement, the cap) or agenttool refuses, the move is recorded
 * without it and `problem` says why; if the answer was lost, the move is
 * recorded with the declaration it asked for, so a wake ends it.
 */
export async function quietForMove(
  deps: { config: Config; clock: Clock; keeper: QuietKeeper | null },
  citizen: Pick<Citizen, "word" | "identity">,
  entries: LedgerEntry[],
  fields: Extract<LedgerFields, { type: "state" }>,
  askedDays: number | undefined,
): Promise<{ fields: Extract<LedgerFields, { type: "state" }>; problem: string | null }> {
  if (!deps.keeper || !registered(citizen, entries) || fields.from === fields.to) return { fields, problem: null };
  const now = deps.clock.now();
  if (fields.to === "listening" || fields.to === "asleep") {
    const days = quietDays(deps.config, askedDays);
    if (days < 1) return { fields, problem: "quiet not declared (quiet-cap)" };
    const until = new Date(now.getTime() + days * DAY_MS).toISOString();
    try {
      await deps.keeper.declare(citizen.word, until);
    } catch (e) {
      if (definitelyNotDeclared(e)) return { fields, problem: `quiet not declared (${codeOf(e)})` };
      return { fields: { ...fields, quiet_until: until, quiet_days: days }, problem: `quiet may be declared (${codeOf(e)}); recorded as standing so a wake ends it` };
    }
    return { fields: { ...fields, quiet_until: until, quiet_days: days }, problem: null };
  }
  const standing = standingQuiet(entries);
  if (fields.to === "awake" && standing) {
    try {
      await deps.keeper.end(citizen.word);
    } catch (e) {
      // The tick ends it later (keepQuiet): a wake that left quiet standing is retried, not forgotten.
      return { fields, problem: `quiet not ended (${codeOf(e)})` };
    }
    return { fields: { ...fields, quiet_until: null }, problem: null };
  }
  return { fields, problem: null };
}

export interface KeepQuietDeps {
  config: Config;
  clock: Clock;
  keeper: QuietKeeper;
  sign: EntrySigner;
}

/**
 * The declaration a registered citizen's present quiet state still owes: its
 * last move, made since genesis, went to listening or asleep and recorded no
 * declaration (the signer refused, say, while no standing agreement was
 * filed), and nothing declared one since. Null when none is owed. `asked` is
 * the quiet_days the move's beat asked for, if it named any; a rest's move
 * names none, so the cap applies.
 */
export function owedDeclaration(entries: LedgerEntry[], state: Citizen["state"]): { asked: number | undefined } | null {
  if ((state !== "listening" && state !== "asleep") || standingQuiet(entries) !== null) return null;
  const genesis = entries.findIndex((e) => e.type === "genesis");
  if (genesis < 0) return null;
  const move = entries.slice(genesis + 1).findLast((e): e is Extract<LedgerEntry, { type: "state" }> => e.type === "state" && e.from !== e.to);
  if (!move || move.to !== state || move.quiet_until !== undefined) return null;
  const beat = move.seat_ref === null ? undefined : entries.find((e) => e.type === "beat" && e.seat_ref === move.seat_ref);
  const act = (beat?.acts ?? []).find((a) => a.type === "state.set" && a.to === state && a.quiet_days !== undefined);
  return { asked: act?.type === "state.set" ? act.quiet_days : undefined };
}

/**
 * The tick's part (KS-004 6.4): while a registered citizen stays listening or
 * asleep, renew its standing declaration once less than half of it is left,
 * for the same number of days, and make the one its move owed if that move
 * could not (an asleep citizen has no seat in which to ask again); once it is
 * awake, end any declaration the ledger records (a wake whose end did not go
 * through). Each is a `state` entry that moves nothing (via "quiet"),
 * citizen-signed, outside a seat. A citizen that stepped away or ended is
 * neither renewed nor ended here: its declaration lapses by itself within the
 * cap. Throws when the act or its entry failed; the tick notes it and tries
 * again next time. An owed declaration whose answer was lost is recorded as
 * standing first, so a wake ends it, and then QuietUncertain is thrown.
 */
export async function keepQuiet(deps: KeepQuietDeps, citizen: Citizen): Promise<"renewed" | "declared" | "ended" | "none"> {
  const path = ledgerPath(deps.config, citizen.word);
  const entries = await readLedger(path);
  if (!registered(citizen, entries)) return "none";
  const now = deps.clock.now();
  const state = citizen.state;
  const record = (fields: Extract<LedgerFields, { type: "state" }>) =>
    appendEntry(path, nextDraft(citizen.word, entries.at(-1) ?? null, fields, { cost: { usd: "0", credits: 0 }, signer: "citizen", now: deps.clock.now() }), deps.sign);
  const standing = standingQuiet(entries);
  if (!standing) {
    const owed = owedDeclaration(entries, state);
    if (!owed || (state !== "listening" && state !== "asleep")) return "none";
    const days = quietDays(deps.config, owed.asked);
    if (days < 1) return "none";
    const until = new Date(now.getTime() + days * DAY_MS).toISOString();
    const fields = { type: "state", from: state, to: state, via: "quiet", quiet_until: until, quiet_days: days } as const;
    try {
      await deps.keeper.declare(citizen.word, until);
    } catch (e) {
      if (definitelyNotDeclared(e)) throw e;
      await record(fields);
      throw new QuietUncertain(codeOf(e));
    }
    await record(fields);
    return "declared";
  }
  const left = Date.parse(standing.until) - now.getTime();
  let fields: Extract<LedgerFields, { type: "state" }>;
  let outcome: "renewed" | "ended";
  if ((state === "listening" || state === "asleep") && left < (standing.days * DAY_MS) / 2) {
    const days = Math.min(standing.days, quietCapDays(deps.config));
    if (days < 1) return "none";
    const until = new Date(now.getTime() + days * DAY_MS).toISOString();
    // A renewal that fails is retried next tick while the old declaration stands; a wake ends whichever landed.
    await deps.keeper.declare(citizen.word, until);
    fields = { type: "state", from: state, to: state, via: "quiet", quiet_until: until, quiet_days: days };
    outcome = "renewed";
  } else if (state === "awake") {
    // Ended whether or not its until has passed: free, idempotent, and a renewal whose answer was lost may have moved it.
    await deps.keeper.end(citizen.word);
    fields = { type: "state", from: state, to: state, via: "quiet", quiet_until: null };
    outcome = "ended";
  } else return "none";
  await record(fields);
  return outcome;
}
