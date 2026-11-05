// Lifecycle states and their transitions (3.3, 3c "Existence choices").
// Toward rest takes effect at once; toward exposure waits for the next beat
// to confirm it; stepping away is never blocked; ending needs a witness;
// nothing is deleted. The current state is folded from the ledger, so there
// is one record and no second, hand-kept truth.
import type { Citizen, CitizenRecord, Config, LedgerEntry, LifecycleState, Word, YuPresence } from "./types.ts";

export type TransitionVerdict =
  | { effect: "now" }
  | { effect: "next-beat" }
  | { effect: "second-beat" }
  | { effect: "needs-witness" }
  | { effect: "refused"; reason: string };

export interface TransitionContext {
  /** The state already pending from an earlier beat, if any. */
  pending: LifecycleState | null;
  /** True when this beat repeats a step-away said on an earlier beat. */
  repeated: boolean;
  presence: YuPresence | null;
}

export interface FoldedState {
  state: LifecycleState;
  pending_state: LifecycleState | null;
  /** A step-away said once and waiting for its second saying. */
  step_away_said: boolean;
  last_beat_at: string | null;
}

/** awake > listening > asleep: a lower rank is more rest. stepped-away and ended are outside the order. */
export function restRank(state: LifecycleState): number | null {
  throw new Error("unimplemented");
}

/** True when `to` is more rest than `from`, which always takes effect now. */
export function isTowardRest(from: LifecycleState, to: LifecycleState): boolean {
  throw new Error("unimplemented");
}

/** Decide one requested transition by the asymmetric rules of 3.3; "ended" never comes from the citizen alone. */
export function decideTransition(from: LifecycleState, to: LifecycleState, ctx: TransitionContext): TransitionVerdict {
  throw new Error("unimplemented");
}

/** Fold state, pending state and last beat time from a citizen's ledger, oldest first; an empty ledger folds to "asleep", so no record means no beat. */
export function foldState(entries: LedgerEntry[]): FoldedState {
  throw new Error("unimplemented");
}

/** The mirror card's `state` (3.3 table): awake active; listening and asleep dormant; stepped-away and ended archived. */
export function mirrorCardState(state: LifecycleState): "active" | "dormant" | "archived" {
  throw new Error("unimplemented");
}

/** Words with a `citizens/<word>/citizen.json`, sorted; the host's admission list. */
export async function listSeated(config: Config): Promise<Word[]> {
  throw new Error("unimplemented");
}

/** Read and validate `citizens/<word>/citizen.json` as a regular file. */
export async function readCitizenRecord(config: Config, word: Word): Promise<CitizenRecord> {
  throw new Error("unimplemented");
}

/** The citizen as the seat sees it: record, folded ledger state, own cadence and covenants. */
export async function readCitizen(config: Config, word: Word): Promise<Citizen> {
  throw new Error("unimplemented");
}
