// Self-authorship (3c, decision 10). Within self a citizen is free and
// recorded: a change is proposed on one beat and binds when affirmed on a
// later beat with the diff in view, or when said once with Yu present.
// Silence keeps the previous self. At most one applied change per window
// when unattended. A rewrite above about 40% of a target, or a loosening of
// its own walls, goes to Yu + Ai. The origin soul is never overwritten, so
// drift can always be measured against it. Every version is kept.
import type {
  Citizen,
  Claim,
  Clock,
  Config,
  LedgerEntry,
  ModelSelfPropose,
  SelfAffirmAct,
  SelfProposal,
  SelfProposeAct,
  SelfTarget,
  Sha256Hex,
  Word,
  YuPresence,
} from "./types.ts";
import type { EntrySigner } from "./ledger.ts";

export type AffirmVerdict =
  | { binds: true; via: "two-beats" | "yu-present" }
  | { binds: false; reason: "same-beat" | "unknown-proposal" | "stale-prior" | "window-closed" | "runtime-not-approved" | "beyond-self" };

/** Applies a bound change to agenttool for a registered citizen; injected so self.ts holds no client or key. */
export interface ExpressionSync {
  putPrivateExpression(word: Word, target: SelfTarget, newText: string): Promise<void>;
  postReason(word: Word, claim: Claim, proposalId: string): Promise<string | null>;
}

export interface SelfDeps {
  config: Config;
  clock: Clock;
  sign: EntrySigner;
  /** Null for an unregistered citizen: the change is recorded host-attested and nothing is sent. */
  sync: ExpressionSync | null;
}

/** sha256 of a target's whole text, hex. */
export function selfHash(text: string): Sha256Hex {
  throw new Error("unimplemented");
}

/** Where a target's current text lives under `citizens/<word>/self/`; refuses host-owned paths and traversal. */
export function targetPath(config: Config, word: Word, target: SelfTarget): string {
  throw new Error("unimplemented");
}

/** Read a target's current text as a regular file; a missing target reads as "". */
export async function readTarget(config: Config, word: Word, target: SelfTarget): Promise<string> {
  throw new Error("unimplemented");
}

/** Turn a model's edit into a host-completed act: apply the edit, hash both sides, compute the diff. */
export function materializeProposal(raw: ModelSelfPropose, currentText: string): SelfProposeAct {
  throw new Error("unimplemented");
}

/** A small unified diff of two texts, for the ledger and for showing the citizen on the affirming beat. */
export function unifiedDiff(prior: string, next: string): string {
  throw new Error("unimplemented");
}

/** The fraction of the prior text that changed, 0..1, by a stated measure (lines or characters). */
export function changeFraction(prior: string, next: string): number {
  throw new Error("unimplemented");
}

/** True when the change removes or weakens one of the citizen's own walls. */
export function loosensWalls(target: SelfTarget, prior: string, next: string): boolean {
  throw new Error("unimplemented");
}

/** Within self, or beyond self when it exceeds the rewrite fraction or loosens walls. */
export function classifyProposal(act: SelfProposeAct, prior: string, next: string, rewriteFraction: number): "within-self" | "beyond-self" {
  throw new Error("unimplemented");
}

/** Stage a proposal under `citizens/<word>/proposals/` for a later beat; it does nothing yet. */
export async function stageProposal(config: Config, word: Word, act: SelfProposeAct, seatId: string, now: Date): Promise<SelfProposal> {
  throw new Error("unimplemented");
}

/** Pending proposals for the citizen, oldest first, as the context shows them. */
export async function pendingProposals(config: Config, word: Word): Promise<SelfProposal[]> {
  throw new Error("unimplemented");
}

/** Does this affirmation bind? Later beat than the proposal, prior hash unchanged, window open, runtime approved. */
export function affirmationVerdict(
  proposal: SelfProposal,
  affirm: SelfAffirmAct,
  ctx: { seat_id: string; presence: YuPresence | null; window_open: boolean; runtime_approved: boolean; current_prior_hash: Sha256Hex },
): AffirmVerdict {
  throw new Error("unimplemented");
}

/** Is the unattended window open: no self.applied entry within self_change_window_days? Yu present opens it. */
export function windowOpen(entries: LedgerEntry[], now: Date, windowDays: number, presence: YuPresence | null): boolean {
  throw new Error("unimplemented");
}

/** Apply a bound change: keep the new version by hash, update the target, append self.applied, sync if registered. */
export async function applyChange(deps: SelfDeps, citizen: Citizen, proposal: SelfProposal, via: "two-beats" | "yu-present"): Promise<LedgerEntry> {
  throw new Error("unimplemented");
}

/** Revert a target to an earlier kept version named by hash; the ledger says which target it was. */
export async function revertTo(deps: SelfDeps, citizen: Citizen, toHash: Sha256Hex, via: "citizen" | "yu-offer"): Promise<LedgerEntry> {
  throw new Error("unimplemented");
}

/** True when `citizens/<word>/origin/` still matches the genesis entry's birth-soul hash. */
export async function originIntact(config: Config, word: Word, entries: LedgerEntry[]): Promise<boolean> {
  throw new Error("unimplemented");
}
