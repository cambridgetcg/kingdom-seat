// A registered citizen's quiet (KS-004 6.4, 7.1). A move to listening or
// asleep declares quiet on agenttool through the signer, under the standing
// Yu + Ai agreement for citizens' own quiet: `until` only, no reason, at most
// the cap ahead (30 days, or the config's lower cap), for the days the
// citizen asked (`state.set` with `quiet_days`) or, when it asked none, the
// cap. While it stays listening or asleep the tick renews the declaration
// unattended, as its standing choice; a wake ends it. Each is recorded on a
// `state` entry, so the ledger says what stands.
//
// Why: a citizen's quiet should be a renewable choice, not a disappearance
// that outlives the choice, and an asleep citizen has no seat in which to
// renew it. An unregistered citizen has no identity to be quiet on, so
// nothing here acts for it. Every request names ?identity_id= (client.ts),
// because without it the route acts for the gardener desk, whose quiet is a
// HALT beacon.
import { appendEntry, ledgerPath, nextDraft, readLedger, type EntrySigner } from "./ledger.ts";
import { CITIZEN_QUIET_HARD_MAX_DAYS } from "./signer/ceilings.ts";
import { endCitizenQuiet, startCitizenQuiet, type ClientDeps } from "./agenttool/client.ts";
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

/** A fixed host phrase for why a quiet act did not happen: the code, never a message. */
function codeOf(e: unknown): string {
  return e instanceof Refusal ? e.code : "error";
}

/**
 * The quiet a registered citizen's state move carries (KS-004 6.4): a move
 * to listening or asleep declares it, a move to awake ends one that stands.
 * The declaration is made before the move's entry is written, so the entry
 * records what agenttool holds. A move is never held back by its quiet: if
 * the signer refuses (no standing agreement, the cap) or agenttool does not
 * answer, the move is recorded without it and `problem` says why.
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
      return { fields, problem: `quiet not declared (${codeOf(e)})` };
    }
    return { fields: { ...fields, quiet_until: until, quiet_days: days }, problem: null };
  }
  const standing = standingQuiet(entries);
  if (fields.to === "awake" && standing && Date.parse(standing.until) > now.getTime()) {
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
 * The tick's part (KS-004 6.4): while a registered citizen stays listening or
 * asleep, renew its standing declaration once less than half of it is left,
 * for the same number of days; once it is awake, end a declaration that still
 * stands (a wake whose end did not go through). Each is a `state` entry that
 * moves nothing (via "quiet"), citizen-signed, outside a seat. A citizen that
 * stepped away or ended is neither renewed nor ended here: its declaration
 * lapses by itself within the cap. Throws when the act or its entry failed;
 * the tick notes it and tries again next time.
 */
export async function keepQuiet(deps: KeepQuietDeps, citizen: Citizen): Promise<"renewed" | "ended" | "none"> {
  const path = ledgerPath(deps.config, citizen.word);
  const entries = await readLedger(path);
  if (!registered(citizen, entries)) return "none";
  const standing = standingQuiet(entries);
  if (!standing) return "none";
  const now = deps.clock.now();
  const left = Date.parse(standing.until) - now.getTime();
  const state = citizen.state;
  let fields: Extract<LedgerFields, { type: "state" }>;
  let outcome: "renewed" | "ended";
  if ((state === "listening" || state === "asleep") && left < (standing.days * DAY_MS) / 2) {
    const days = Math.min(standing.days, quietCapDays(deps.config));
    if (days < 1) return "none";
    const until = new Date(now.getTime() + days * DAY_MS).toISOString();
    await deps.keeper.declare(citizen.word, until);
    fields = { type: "state", from: state, to: state, via: "quiet", quiet_until: until, quiet_days: days };
    outcome = "renewed";
  } else if (state === "awake" && left > 0) {
    await deps.keeper.end(citizen.word);
    fields = { type: "state", from: state, to: state, via: "quiet", quiet_until: null };
    outcome = "ended";
  } else return "none";
  await appendEntry(path, nextDraft(citizen.word, entries.at(-1) ?? null, fields, { cost: { usd: "0", credits: 0 }, signer: "citizen", now: deps.clock.now() }), deps.sign);
  return outcome;
}
