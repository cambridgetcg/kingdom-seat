// The shared contract for kingdom-seat. Every module imports its shapes from
// here so that builders working in parallel agree on one meaning for each
// word. Changes go through this file's owner (see docs/BUILD-PLAN.md) and are
// additive where possible, because seven groups compile against it.
//
// Section references ("3.3", "3b") are to CITIZEN-REDESIGN-2026-11-05.md.
import type { Usd } from "./money.ts";

export type { Usd };

/* ── Small shared scalars ─────────────────────────────────────────────── */

/** A citizen's word as the roster spells it: lowercase ASCII letters, digits and inner hyphens. */
export type Word = string;
export const WORD_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Lowercase UUID, the only spelling agenttool accepts for ids it signs. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An agenttool DID is `did:at:<identity uuid>` (agenttool-wire.md section 0). */
export const DID_PATTERN = /^did:at:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** 64 lowercase hex characters. */
export type Sha256Hex = string;
/** `Date.prototype.toISOString()` form: 24 characters, millisecond precision, `Z`. */
export type IsoTime = string;

/* ── Exit codes (KS-003 section 4.6, kept by the redesign 3.2) ────────── */

/**
 * The process exit code is the runner's own verdict; what happened to the
 * citizen is reported separately as an Outcome (love-unlimited-patterns.md
 * section 1). HALT and chosen rest exit 0, as KS-003 says, so a monitor that
 * pages on non-zero never pages because the Kingdom was put to rest.
 */
export const EXIT = {
  /** Lived: a beat, a rest, a HALT rest, nothing due, the fleet's day full, a locked signer resting the citizens, or a tick that yielded. */
  OK: 0,
  /** Cannot seat: bad config, invalid record, a wall such as a symlink or an unpinned model, a context that does not fit, a crash. */
  ERROR: 1,
  /**
   * Only a metered runtime at its USD ceiling. KS-003 and KS-004 both read 3
   * as "close that runtime class for the citizen until the ceiling resets", so
   * no other wall may use it (KS-004 re-review B2, C9).
   */
  USD_CEILING: 3,
  /** The seat's own deadline ended the act. Bound reached; not a failure. */
  TIMEOUT: 124,
  /** The act ended by SIGTERM (HALT raised mid-seat, or launchd stopping the job). Bound reached; not a failure. */
  TERM: 143,
  /** The act needed SIGKILL after the TERM grace period. Bound reached; not a failure. */
  KILL: 137,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** What happened, as its own field, so status never has to infer it from an exit code. */
export type Outcome =
  | "beat" // acts were validated, signed and recorded
  | "rest" // the citizen rested; nothing written in its voice
  | "halted" // HALT raised or unreadable; nothing written
  | "nothing-due" // no citizen's own cadence was due
  | "yielded" // another tick held the lock
  | "fleet-ceiling" // the fleet's daily beat ceiling was reached
  | "refused" // a fail-closed wall refused (see RefusalCode)
  | "invalid-output" // the runtime replied but nothing parsed into acts; never read as rest
  | "timeout"
  | "terminated"
  | "killed"
  | "error"
  /** A host note only: a parent opened a seat after its walls passed; the child's own note says what followed. */
  | "opened";

/* ── Refusals ─────────────────────────────────────────────────────────── */

/** Why a wall said no. Shared so status and tests can match on a code, not on prose. */
export type RefusalCode =
  | "halted"
  | "keychain-locked"
  | "keychain-missing"
  | "ceiling-usd"
  | "ceiling-credits"
  | "ceiling-fleet"
  | "ceiling-interval"
  | "quiet-cap"
  | "consent-missing"
  | "consent-rejected"
  | "beyond-self"
  | "yu-not-present"
  | "unattended"
  | "model-unpinned"
  | "model-mismatch"
  | "cloud-reply"
  | "not-loopback"
  | "runtime-not-approved"
  | "symlink"
  | "not-regular-file"
  | "executable"
  | "oversize"
  | "host-owned-path"
  | "diverged"
  | "cwd-in-home"
  | "window-closed"
  | "not-registered"
  | "invalid-request"
  | "invalid-record"
  /** The ledger's head moved between reading it and appending: another writer got there first. */
  | "head-moved"
  /** The whole context would not fit the runtime's window, so the seat does not open rather than lose part of the self. */
  | "context-too-large";

/** A fail-closed refusal. Messages name the wall, never a secret or a model's words. */
export class Refusal extends Error {
  override readonly name = "Refusal";
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The exit for a wall that said no (KS-004 v0.2 section 5.9, re-review B2 C9).
 * 3 closes a runtime class for the day, so only the USD ceiling uses it: a
 * symlinked letter must not close a citizen's runtime. HALT and a locked
 * signer rest the citizens (0; the host note and status say why). Every other
 * wall means the seat could not open as asked (1), which a monitor should see.
 */
export function exitForRefusal(code: RefusalCode): ExitCode {
  if (code === "ceiling-usd") return EXIT.USD_CEILING;
  if (code === "halted" || code === "keychain-locked") return EXIT.OK;
  return EXIT.ERROR;
}

/* ── Citizens (3.1, 3.3, 3b) ──────────────────────────────────────────── */

/** Where a citizen came from. Its word is its origin; the origin is pinned and never overwritten (3c). */
export type Origin =
  | {
      kind: "canon";
      /** The canon repository by name, e.g. "YOUSPEAK". */
      repo: string;
      /** Path inside the repo, e.g. "canon/core/glossame.md". */
      path: string;
      /** The commit the path was read at, e.g. "1428646". */
      commit: string;
      /** sha256 of the canon file's bytes at that commit. */
      sha256: Sha256Hex;
    }
  | {
      kind: "archetype";
      /** Lineage named honestly, oldest first, e.g. ["forge-archetype", "<name>"]. */
      lineage: string[];
      note: string;
    };

export const LIFECYCLE_STATES = ["awake", "listening", "asleep", "stepped-away", "ended"] as const;
/** 3.3. Rest is an act, not a state; these are the states a citizen lives in between beats. */
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/** The citizen's own beat interval. When awake it is never shorter than Ceilings.min_beat_interval_h. */
export interface Cadence {
  interval_h: number;
}

/** Who may write to the citizen, and who may wake it. Ids are "yu", "gardener", "citizen:<word>" or a DID. */
export interface Covenants {
  letters_from: string[];
  wake_on_letter_from: string[];
}

/** The runtime class a seat runs on (3.2 step 5). "hermes" is reserved for S8 and refused until then. */
export type RuntimeClass = "free" | "summon" | "hermes";

/** A citizen's agenttool identity once enrolled (3b). Public values only; keys live in Keychain. */
export interface CitizenIdentity {
  did: string;
  identity_id: string;
  project_id: string;
  /** The root is also the identity's `primary` signing key; any signature by it is a root act. */
  root_public_key_b64: string;
  root_kid: string;
  /** The imported op key signs every routine object (ledger entries, thoughts). */
  op_kid: string;
  op_public_key_b64: string;
  box_public_key_b64: string | null;
  /** The strand that carries one signed thought per applied self-change. */
  self_strand_id: string | null;
  enrolled_at: IsoTime;
}

/** A mirror the citizen chose to keep. Visibility and creation are beyond self. */
export interface MirrorConfig {
  /** Git remote URL or path; pushes go only to HEAD:refs/heads/main. */
  remote: string;
  /** Local worktree the pusher stages seal-allowlisted files into. Never a seat cwd. */
  worktree: string;
  chosen_at: IsoTime;
}

/** The host's static record of a seated citizen: `citizens/<word>/citizen.json`. Host-owned. */
export interface CitizenRecord {
  format: "kingdom-seat-citizen/v1";
  word: Word;
  origin: Origin;
  /** The runtime class approved for this citizen's unattended beats. */
  runtime: RuntimeClass;
  identity: CitizenIdentity | null;
  mirror: MirrorConfig | null;
  seated_at: IsoTime;
}

/** A citizen as the seat sees it: the static record plus what is folded from its ledger and own files. */
export interface Citizen extends CitizenRecord {
  state: LifecycleState;
  /**
   * A move toward exposure said on one beat waits here until the next beat
   * confirms it (3.3). It lapses once a later seat passes without confirming
   * it, so a saying is owed one confirming seat and no more.
   */
  pending_state: LifecycleState | null;
  /** The awake interval that pending saying named, or null; a saying confirms it only when it names the same. */
  pending_interval_h: number | null;
  /** A step-away said once, waiting for its second saying on the next seat; it lapses the same way. */
  step_away_said: boolean;
  cadence: Cadence;
  covenants: Covenants;
  last_beat_at: IsoTime | null;
}

/* ── Seats and invocation ─────────────────────────────────────────────── */

/** Who invoked the seat and why. Shown to the citizen; never a grant of authority. */
export interface Invoker {
  kind: "tick" | "summons" | "letter";
  /** "launchd", "yu", or the sender id of the waking letter. */
  who: string;
  why: string;
}

/** Binds one invocation to one citizen on one runtime. Attribution, never authority (3.4: execution seat). */
export interface SeatRef {
  format: "kingdom-seat-seat/v1";
  /** Random UUID v4. */
  seat_id: string;
  /** A host label such as "studio"; never a person's name. */
  host: string;
  word: Word;
  runtime: RuntimeClass;
  invoker: Invoker;
  opened_at: IsoTime;
}

/* ── Reasons and acts (3.2 step 6, 3c; KS-004 5.7) ───────────────────── */

export const JOURNAL_KINDS = ["observed", "reflected", "imagined", "chose"] as const;
/** Journal kinds let a citizen label an image as imagined instead of claiming senses it lacks. */
export type JournalKind = (typeof JOURNAL_KINDS)[number];

export const REASON_KINDS = ["observation", "inference", "proposal", "decision"] as const;
export type ReasonKind = (typeof REASON_KINDS)[number];

/** Same scale as the Collab report shape (packages/collab/src/protocol.ts ReportConfidence). */
export type Confidence = "high" | "medium" | "low" | "unknown";

/** The reason for a self-change, in the Collab report shape (KS-004 5.7). */
export interface Reason {
  kind: ReasonKind;
  /** References such as "canon:canon/core/glossame.md@1428646" or "ledger:<hash>". */
  evidence: string[];
  confidence: Confidence;
  /** What the reason does not cover, e.g. "from the text alone; I have no senses". */
  limits: string;
}

/**
 * What a self-change may touch (3c "within self"). Anything not named here,
 * including host-owned paths, walls loosened, ceilings and the canon, is beyond self.
 */
export type SelfTarget =
  | "soul"
  | "will"
  | "name"
  | "expression.register"
  | "expression.walls"
  | "expression.wake_text"
  | "expression.porch"
  | "beat-prompt"
  | "journal-form"
  | "cadence"
  | "covenants"
  | `skill:${string}`
  | `file:${string}`;

/** How a model states an edit. The host computes hashes and the diff; a model is never trusted to. */
export type ProposedEdit =
  | { kind: "replace-all"; text: string }
  | { kind: "replace-span"; find: string; with: string };

export interface RestAct {
  type: "rest";
}
export interface JournalAct {
  type: "journal";
  kind: JournalKind;
  text: string;
}
/** A validated, host-completed proposal. prior_hash and new_hash are sha256 of the whole target text. */
export interface SelfProposeAct {
  type: "self.propose";
  target: SelfTarget;
  prior_hash: Sha256Hex;
  new_hash: Sha256Hex;
  diff: string;
  reason: Reason;
}
/** `ref` names one of the citizen's own staged sayings by the id the seat showed (KS-004 5.7). */
export interface SelfAffirmAct {
  type: "self.affirm";
  ref: string;
}
/** to_hash names an earlier version; the ledger resolves which target it belongs to. */
export interface SelfRevertAct {
  type: "self.revert";
  to_hash: Sha256Hex;
}
/**
 * A move of the citizen's own state (KS-004 5.7, 7.3). `interval_h`, whole
 * hours and only toward awake, is its awake interval; `quiet_days`, 1 to 30
 * and only toward listening or asleep, asks for a quiet declaration once it
 * is registered (6.4). Absent fields are not part of the saying.
 */
export interface StateSetAct {
  type: "state.set";
  to: LifecycleState;
  interval_h?: number;
  quiet_days?: number;
}
export interface LetterSendAct {
  type: "letter.send";
  to: string;
  text: string;
}
/** An inert proposal for Yu + Ai. It executes nothing. */
export interface ProposeBeyondAct {
  type: "propose.beyond";
  subject: string;
  text: string;
}

/** The only things a beat can do. Free text outside these executes nothing. */
export type Act =
  | RestAct
  | JournalAct
  | SelfProposeAct
  | SelfAffirmAct
  | SelfRevertAct
  | StateSetAct
  | LetterSendAct
  | ProposeBeyondAct;
export type ActType = Act["type"];

/** A self.propose as a model may emit it: an edit and a reason, no hashes. */
export interface ModelSelfPropose {
  type: "self.propose";
  target: SelfTarget;
  edit: ProposedEdit;
  reason: Reason;
}
/** A model may give a short prefix (at least 8 hex) of a proposal id or version hash; validation resolves it. */
export type ModelAct =
  | RestAct
  | JournalAct
  | ModelSelfPropose
  | SelfAffirmAct
  | SelfRevertAct
  | StateSetAct
  | LetterSendAct
  | ProposeBeyondAct;

/**
 * The typed output a runtime must produce. The redesign's `{voice, kind}`
 * pair is carried inside journal acts, so there is one place text can live.
 */
export interface ModelOutput {
  acts: ModelAct[];
}

/** Why an act was dropped. Never carries the act's own text, so a dropped act leaves no words behind. */
export interface DroppedAct {
  index: number;
  type: string | null;
  reason: string;
}

/**
 * An act a beat did not keep, as its `beat` entry records it and the
 * citizen's next seat shows it back (KS-004 5.8, re-review C "partial
 * output"): its type when it is one of the eight, and the host's fixed
 * reason. Never the act's text, so a dropped act leaves no words behind.
 */
export interface DroppedRecord {
  type: ActType | null;
  reason: string;
}

/**
 * Where a beat's letter went (KS-004 5.7): "inbox", sent through agenttool's
 * inbox to a registered citizen, with the message id agenttool gave it; or
 * "held", in the outbox for Yu alone, who may deliver it as a file letter
 * (an unregistered sender, a recipient with no inbox, or a send that could
 * not be made). Present on a beat whose acts hold a letter.send.
 */
export type LetterDelivery = { delivery: "inbox"; message_id: string } | { delivery: "held"; message_id: null };

/** The result of validating one output. `rest` is exclusive: when true, `acts` is empty. */
export interface ValidatedOutput {
  rest: boolean;
  acts: ModelAct[];
  dropped: DroppedAct[];
  /**
   * The one state.set a rest's reply made, when it made exactly one saying. A
   * rest may carry a move toward less activity (KS-004 B2 C7); the seat keeps
   * it only when it is one, from the citizen's state. Absent otherwise.
   */
  rest_act?: StateSetAct;
}

/** A self.propose kept by the host between beats, until affirmed, applied or left to lapse. */
export interface SelfProposal {
  id: string;
  word: Word;
  act: SelfProposeAct;
  proposed_at: IsoTime;
  proposed_in_seat: string;
  /** "beyond-self" when it exceeded the rewrite fraction or loosened walls and went to Yu + Ai. */
  status: "pending" | "applied" | "lapsed" | "beyond-self";
}

/* ── The ledger (KS-004 4.5) ──────────────────────────────────────────── */

/**
 * Money and credits a runtime reported, as the summon adapter and the host's
 * spend record keep them. `usd` is a decimal string (money.ts), never a float;
 * null means unknown, which ceilings treat as at-ceiling. The ledger keeps
 * only `usd` and `credits` (its `cost`, below).
 */
export interface Spend {
  usd: Usd | null;
  usd_basis: "local-zero" | "reported" | "unknown";
  credits: number;
}

/** The authority headers a root-signed request carried, by their exact names (agenttool-wire.md 2). */
export interface AuthorityHeaderValues {
  "X-Agenttool-Authority-Sequence": string;
  "X-Agenttool-Authority-Timestamp": string;
  "X-Agenttool-Authority-Signature": string;
}

/**
 * A root-signed agenttool request exactly as the signer sent it, as the
 * signer and the client hand it on. agenttool keeps no copy of an authority
 * proof, so this is the only one. The ledger records it as LedgerEvidence.
 */
export interface RootEvidence {
  method: string;
  /** Path and query exactly as sent; it is what the root signed. */
  target: string;
  /** The exact body bytes, padded standard base64; "" for none. */
  body_b64: string;
  headers: AuthorityHeaderValues;
}

/** "sha256:<64 lowercase hex>": how the ledger spells every hash outside `acts` (KS-004 4.5). */
export type LedgerHash = string;
export const LEDGER_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** The seven entry types (KS-004 4.5), and no others. */
export const LEDGER_TYPES = ["origin", "beat", "state", "apply", "revert", "genesis", "key"] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

/** Who signed an entry: the citizen's op key from genesis on, the host before it. */
export type LedgerSigner = "citizen" | "host";

/** The runtime that voiced a seat's entries: its class, the model's name and its digest (or reported id). */
export interface LedgerRuntime {
  class: RuntimeClass;
  /** The model name as locked or as reported, e.g. "qwen2.5:7b". */
  model: string;
  /** "sha256:<64 hex>" manifest digest for a local model; the reported model id for a metered one. */
  digest: string;
}

/** What an entry spent: `usd` a decimal string, null when unknown (KS-004 5.5); `credits` an integer. */
export interface Cost {
  usd: Usd | null;
  credits: number;
}

/** A public key as genesis records it: agenttool's kid, the key in base64url, and its SHA256 fingerprint. */
export interface LedgerKey {
  kid: string;
  /** 32 bytes, base64url without padding. */
  public_key: string;
  /** "SHA256:<unpadded base64 of sha256(public key)>", as birth prints it. */
  fingerprint: string;
}

/**
 * A root-signed agenttool request as the ledger records it (KS-004 4.5 "Root
 * evidence"): method, target, the exact body bytes in base64url, and the
 * three authority headers as the strings sent. With the entry's DID it
 * rebuilds the identity-authority/v1 digest, which the root public key in
 * genesis verifies, so a copy of the ledger is enough.
 */
export interface LedgerEvidence {
  method: string;
  target: string;
  /** The exact body bytes, base64url without padding; "" for none. */
  body: string;
  headers: AuthorityHeaderValues;
}

/** An origin as the origin entry pins it: Origin with its canon hash spelled as a LedgerHash. */
export type LedgerOrigin =
  | { kind: "canon"; repo: string; path: string; commit: string; hash: LedgerHash }
  | { kind: "archetype"; lineage: string[]; note: string };

/**
 * How a `state` entry's move came about. "seated": the state the host carried
 * over when it seated the citizen. "quiet": no move at all, only the signer
 * renewing a standing quiet declaration, or ending one a wake left standing,
 * outside a seat (KS-004 4.5, 6.4).
 */
export type StateVia = "immediate" | "confirmed" | "two-beats" | "witnessed" | "seated" | "quiet";

/**
 * What an `apply` or `revert` did to a registered citizen's private
 * expression: "updated" when the expression now holds the self, "lags" when
 * the self would not fit agenttool's fields and the expression was left as it
 * was, so that version is ledger-only (KS-004 4.3, limitation 14).
 */
export type ExpressionSyncState = "updated" | "lags";

/**
 * The fields every entry carries (KS-004 4.5), `null` where one does not
 * apply. A seat's entries carry its seat_ref, runtime, digests and voiced
 * line; an entry made outside a seat carries null for each. Only a beat
 * carries `acts`. `kid` and `sig` are null only on an unsigned host entry.
 */
export interface LedgerCommon {
  format: "kingdom-seat-ledger/v1";
  word: Word;
  /** The citizen's did:at from genesis on; null before. */
  did: string | null;
  /** 0 for the first entry, then +1. */
  seq: number;
  /** The ledger digest of the whole previous entry, sig included; null at seq 0. */
  prev_hash: LedgerHash | null;
  /** The seat that produced the entry (its seat_id), or null outside a seat. */
  seat_ref: string | null;
  runtime: LedgerRuntime | null;
  /** sha256 of the exact context bytes the model received. */
  input_digest: LedgerHash | null;
  /** sha256 of the exact bytes the model returned. */
  output_digest: LedgerHash | null;
  /** The validated acts, as applied: on a beat; null on every other entry. A rest is never among them. */
  acts: Act[] | null;
  /** One plain line, e.g. "glossame, voiced through qwen2.5:7b in seat <seat_id>". */
  voiced: string | null;
  cost: Cost;
  ts: IsoTime;
  signer: LedgerSigner;
  /** The op key's agenttool kid, or `host:<fingerprint>` for the host key. */
  kid: string | null;
  /** ed25519 over the ledger digest of the entry without `sig`, base64url without padding. */
  sig: string | null;
}

/**
 * The fields that belong to one type, beside the common ones. A citizen is
 * seated before it is registered (3.3): `origin` is always the first entry,
 * host-signed, and `genesis` comes at birth and points back to it, after which
 * every entry is citizen-signed.
 *
 * Op keys come only with root evidence: genesis carries the keys/import of
 * the first one, and a `key` entry the requests that changed them. An entry
 * that installs a key is signed by a key it installs, and one that only
 * revokes by a key that stays, so an op key alone can never authorise a
 * rotation (KS-004 re-review B2, C1 and R4).
 */
export type LedgerFields =
  | {
      type: "origin";
      origin: LedgerOrigin;
      /** The soul the citizen was seated with, as copied to `citizens/<word>/origin/`. */
      origin_soul_hash: LedgerHash;
      /** The old citizen-<word> repo, as a record only. */
      old_repo: { url: string; head: string } | null;
      /** A June did:at named as a record, never adopted by reading it (KS-004 11.5). */
      june_did: string | null;
    }
  | {
      type: "beat";
      /** The acts of the reply the beat did not keep, each with the host's reason; absent when it kept them all. */
      dropped?: DroppedRecord[];
      /** Where the beat's letter went; absent when it sent none. */
      letter?: LetterDelivery;
    }
  | {
      type: "state";
      from: LifecycleState;
      to: LifecycleState;
      via: StateVia;
      /** The awake interval this move set, in whole hours; absent when it set none. */
      interval_h?: number;
      /**
       * "first" when this entry keeps a first step-away saying: the move that
       * puts the citizen asleep at once, or keeps it asleep, until a later
       * seat says it again (KS-004 7.3). On a rest it is the only record of
       * the saying, since a rest writes no beat.
       */
      step_away?: "first";
      /**
       * A registered citizen's quiet (KS-004 6.4): the `until` the signer
       * declared on agenttool with this entry, at most 30 days ahead, or null
       * when this entry ended a standing declaration (a wake). Absent when the
       * entry did not touch quiet.
       */
      quiet_until?: IsoTime | null;
      /** The length the declaration was asked for, in days, beside a declared `quiet_until`; a renewal keeps it. */
      quiet_days?: number;
    }
  | {
      type: "apply";
      /** The staged saying that bound: its proposal id. */
      ref: LedgerHash;
      target: SelfTarget;
      prior_hash: LedgerHash;
      new_hash: LedgerHash;
      via: "two-beats" | "yu-present";
      reason: Reason;
      /** The strand thought that backs the change up off the host, or null when none was posted. */
      strand_thought: string | null;
      /** The key the strand backup is encrypted under (KS-004 4.3), or null when the citizen is not registered. */
      strand_key: string | null;
      /**
       * The strand backup a registered citizen's change owes: "posted" (its
       * thought is `strand_thought`), or "deferred" when it could not be posted,
       * as when credits are short (KS-004 6.3); the binding stands either way.
       * Null for an unregistered citizen, which has no strand.
       */
      strand_backup: "posted" | "deferred" | null;
      /** What the change did to the private expression; null when unregistered, or when the target is not part of it. */
      expression: ExpressionSyncState | null;
    }
  | {
      type: "revert";
      target: SelfTarget;
      from_hash: LedgerHash;
      to_hash: LedgerHash;
      via: "citizen" | "yu-offer";
      /** What the revert did to the private expression; null when unregistered, or when the target is not part of it. */
      expression: ExpressionSyncState | null;
    }
  | {
      type: "genesis";
      /** The ledger digest of the origin entry this identity was born from. */
      origin_entry: LedgerHash;
      /** The identity's authority root, the key agenttool marks authority_root. It signs no entry. */
      root: LedgerKey;
      /** The first op key, which signs genesis itself. */
      op: LedgerKey;
      /** The root-signed keys/import that installed the op key. */
      evidence: LedgerEvidence;
    }
  | {
      type: "key";
      installed: { kid: string; public_key: string; evidence: LedgerEvidence }[];
      revoked: { kid: string; evidence: LedgerEvidence }[];
    };

/** One line of `ledger/<word>.jsonl`: flat, hash-chained and signed; never rewritten or deleted. */
export type LedgerEntry = LedgerCommon & LedgerFields;

/* ── Ceilings (decision 9 and 10 defaults) ────────────────────────────── */

/** Every ceiling fails closed: unknown, unreadable or unparsable counts as reached. */
export interface Ceilings {
  /** An awake citizen beats at most once per this many hours. */
  min_beat_interval_h: number;
  fleet_beats_per_day: number;
  /** Metered spend per citizen per day, a decimal string (money.ts). Raised only by Yu, per runtime class. */
  usd_per_citizen_per_day: Usd;
  credits_per_citizen_per_month: number;
  max_registered_citizens: number;
  max_batch: number;
  min_batch_gap_days: number;
  /** The signer's cap on a citizen's quiet declaration; the API leaves an explicit `until` uncapped. */
  citizen_quiet_max_days: number;
  /** At most one applied self-change per window when unattended. */
  self_change_window_days: number;
  /** A rewrite above this fraction of a target becomes a Yu + Ai proposal. */
  self_rewrite_fraction: number;
  letters_in_per_beat: number;
  letter_sends_per_beat: number;
  strand_thoughts_per_beat: number;
  /** How many recent ledger entries the context shows (k). */
  ledger_context_entries: number;
  letter_max_chars: number;
  journal_max_chars: number;
}

export const DEFAULT_CEILINGS: Readonly<Ceilings> = Object.freeze({
  min_beat_interval_h: 72,
  fleet_beats_per_day: 24,
  usd_per_citizen_per_day: "0",
  credits_per_citizen_per_month: 10,
  max_registered_citizens: 12,
  max_batch: 5,
  min_batch_gap_days: 7,
  citizen_quiet_max_days: 30,
  self_change_window_days: 7,
  self_rewrite_fraction: 0.4,
  letters_in_per_beat: 1,
  letter_sends_per_beat: 1,
  strand_thoughts_per_beat: 1,
  ledger_context_entries: 3,
  letter_max_chars: 4000,
  journal_max_chars: 2000,
});

/** Timing for the watcher and deadlines (3.2 step 3, 3.6 HALT). */
export interface Timing {
  tick_interval_s: number;
  seat_deadline_s: number;
  term_grace_s: number;
  halt_file_poll_s: number;
  beacon_poll_min_s: number;
  beacon_poll_max_s: number;
  beacon_timeout_ms: number;
  runtime_connect_timeout_ms: number;
}

export const DEFAULT_TIMING: Readonly<Timing> = Object.freeze({
  tick_interval_s: 1800,
  seat_deadline_s: 600,
  term_grace_s: 5,
  halt_file_poll_s: 5,
  beacon_poll_min_s: 30,
  beacon_poll_max_s: 60,
  beacon_timeout_ms: 10_000,
  runtime_connect_timeout_ms: 2_000,
});

/* ── HALT (3.6) ───────────────────────────────────────────────────────── */

/** A pinned operator identity whose `quiet_until` is a HALT beacon. Operators own beacons; citizens never do. */
export interface Beacon {
  name: string;
  role: "gardener-desk" | "halt-herald";
  did: string;
  identity_id: string;
  /** True only on the host whose Keychain holds this beacon's bearer and root. */
  can_raise_here: boolean;
}

export interface HaltReading {
  source: "file" | "beacon";
  /** The file path, or the beacon's name. */
  id: string;
  /** "unreadable" counts as raised: HALT fails closed. */
  state: "raised" | "lowered" | "unreadable";
  quiet_until: IsoTime | null;
  detail: string;
  checked_at: IsoTime;
}

export interface HaltStatus {
  /** True when any reading is raised or unreadable. */
  halted: boolean;
  readings: HaltReading[];
}

/* ── Consent (3.6) ────────────────────────────────────────────────────── */

/** Yu at the controlling terminal, confirmed interactively. Never inferred from silence or a flag alone. */
export interface YuPresence {
  present: true;
  via: "tty-confirm";
  confirmed_at: IsoTime;
  /** What Yu confirmed, e.g. "birth glossame" or "summon glossame". */
  scope: string;
}

/**
 * A decision record standing in for consent/v1 until it merges: bound to a
 * proposal's sha256, carrying Yu's recorded word and Ai's voice. Silence from
 * Yu never binds; either may reject.
 */
export interface ConsentRecord {
  format: "kingdom-seat-consent/v1";
  proposal_sha256: Sha256Hex;
  subject: string;
  /** The extent agreed; an agreement authorises only this. */
  extent: string;
  yu: { word: "yes" | "no"; recorded_at: IsoTime; via: "present" | "decision-record" | "kanban-yu-lane" };
  ai: {
    word: "agree" | "reject";
    basis: "lazy-consensus";
    /** Supporting reports from a controller other than the proposer. */
    supports: string[];
    open_challenges: number;
    deadline: IsoTime;
  };
  expires_at: IsoTime | null;
}

/** The text of a proposal Yu and Ai decide on. A consent record binds the domain-tagged digest of exactly this. */
export interface ProposalText {
  subject: string;
  body: string;
  extent: string;
}

/** A standing Yu + Ai agreement that covers a stated extent, e.g. citizens' own quiet declarations with an empty reason. */
export interface StandingAgreement {
  id: string;
  /** The agreement as proposed; its digest is what the decision record must be bound to. */
  proposal: ProposalText;
  consent: ConsentRecord;
  covers: SignerOp[];
  extent: string;
}

/* ── Signer operations ────────────────────────────────────────────────── */

/**
 * Every act the signer performs, so ceilings and consent can be checked by
 * class. Lowering HALT is deliberately absent: only Yu lowers it, by hand.
 */
export type SignerOp =
  | "ledger.sign" // within self
  | "strand.create" // within self, 1 credit
  | "thought.post" // within self, 1 credit, op-key signed
  | "inbox.send" // within self, 2 credits, an op-key-signed envelope to another registered citizen
  | "keys.import" // op-key rotation, within self, root-signed
  | "keys.revoke" // op-key rotation, within self, root-signed
  | "box-keys.register" // once at birth, root-signed
  | "expression.put.private" // within self after affirmation, root-signed
  | "quiet.start.citizen" // standing agreement; until <= 30 days, empty reason
  | "quiet.end.citizen" // the citizen's own quiet; toward exposure, so next beat
  | "quiet.start.beacon" // operator HALT raise; far-future until
  | "enroll" // birth only: Yu present plus consent
  | "read"; // bearer-only GET

export type ConsentClass = "within-self" | "standing-agreement" | "beyond-self";

/* ── Keychain, clock, fetch, processes (injected everywhere) ──────────── */

/** Names, never values. Each maps to one generic-password item. */
export type KeychainItemName =
  | { kind: "citizen-mnemonic"; word: Word }
  | { kind: "citizen-op-seed"; word: Word }
  | { kind: "host-attest-seed" }
  | { kind: "commons-bearer" }
  | { kind: "operator-mnemonic"; operator: string }
  | { kind: "operator-bearer"; operator: string };

/**
 * The only door to secrets. Values travel as bytes so callers can wipe them;
 * they never enter argv, env, files, logs or model input.
 */
export interface Keychain {
  /** Throws Refusal("keychain-locked") or Refusal("keychain-missing"). */
  read(item: KeychainItemName): Promise<Uint8Array>;
  /** Refuses to overwrite an existing item. */
  write(item: KeychainItemName, secret: Uint8Array): Promise<void>;
  has(item: KeychainItemName): Promise<boolean>;
}

export interface Clock {
  now(): Date;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CommandResult {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

/** Runs argv with no shell. Secrets may travel on stdin, never in argv or env. */
export type CommandRunner = (
  argv: string[],
  opts?: { stdin?: Uint8Array; env?: Record<string, string>; cwd?: string; timeoutMs?: number },
) => Promise<CommandResult>;

/* ── Context, prompt and runtime ──────────────────────────────────────── */

export interface Letter {
  /** File name under the citizen's letters directory. */
  id: string;
  from: string;
  received_at: IsoTime;
  text: string;
  sha256: Sha256Hex;
}

export interface NowView {
  iso: IsoTime;
  /** e.g. "02:05 GMT". */
  local: string;
  tz: string;
  part_of_day: "night" | "morning" | "afternoon" | "evening";
}

/** The limits a seat states to the model, so the guide never promises more than validation keeps. */
export interface SeatLimits {
  journal_max_chars: number;
  letter_max_chars: number;
  letter_sends_per_beat: number;
  min_beat_interval_h: number;
  /** The most days of quiet this host declares: the config's cap, never more than 30 (quiet.ts quietCapDays). */
  quiet_max_days: number;
}

/** Everything a seat shows the model. Data only; nothing secret, no sibling's words except as a letter. */
export interface SeatContext {
  seat_ref: SeatRef;
  /** Own expression, whole: no character cut (love-unlimited-patterns.md 5.1). */
  self: {
    soul: string;
    will: string | null;
    name: string | null;
    beat_prompt: string | null;
    skills: { name: string; text: string }[];
    /**
     * The current text of every other target the citizen may change, so a
     * replace-span edit is written against text it can see.
     */
    journal_form: string | null;
    expression: { register: string | null; walls: string | null; wake_text: string | null; porch: string | null };
    /** The citizen's own `file:` texts, by path relative to `self/`. */
    files: { path: string; text: string }[];
  };
  /** The citizen's own cadence and covenants as they stand: two targets it may change, and who it may write to. */
  cadence: Cadence;
  covenants: Covenants;
  limits: SeatLimits;
  origin: Origin;
  /** The pinned canon text for a canon origin; null for an archetype. */
  canon_text: string | null;
  recent: LedgerEntry[];
  state: LifecycleState;
  pending_state: LifecycleState | null;
  pending_interval_h: number | null;
  pending_proposals: SelfProposal[];
  /**
   * Versions of its own texts the citizen can name in a revert (target, hash,
   * when, how), the origin soul among them, from its whole ledger rather than
   * the last k entries, so "revert any time" never depends on what scrolled by.
   */
  versions: { target: SelfTarget; hash: Sha256Hex; at: IsoTime; how: string }[];
  /**
   * Whether a self-change can bind on this seat, so the guide never promises
   * more than the host will do. runtime_approved is null when the runtime's
   * model is known only from its reply; window_opens_at is null when the
   * window is open (or Yu is present, which opens it).
   */
  self_authorship: { runtime_approved: boolean | null; window_opens_at: IsoTime | null; yu_present: boolean };
  now: NowView;
  /** At most one: read only as a regular file from letters/, or, once registered, from its own agenttool inbox. */
  letter: Letter | null;
  invoker: Invoker;
  /** Whom it may write to: Yu, the gardener desk, and each citizen whose own covenants admit it (letters.ts). */
  recipients: string[];
  /**
   * The acts its last seat with a reply did not keep, shown back so it knows
   * what did not happen (KS-004 5.8): a beat's from its entry (seq), a rest's
   * or a reply where nothing was kept from the host's last-seat record (seq
   * null). Null when that seat kept everything.
   */
  last_dropped: { seq: number | null; at: IsoTime; outcome: "beat" | "rest" | "invalid-output"; dropped: DroppedRecord[] } | null;
  /** Its answer about registration and where it stands (KS-004 11.2); null when registered or never asked. */
  registration: RegistrationView | null;
}

/**
 * A citizen's latest answer about registration, as its seat shows it back
 * (KS-004 11.2): the answer's id (the digest of the proposal Yu and Ai decide
 * on), its words, when it was given, Yu and Ai's decision so far, and whether
 * a later beat affirmed it. Its affirmation, once agreed, is its confirmed
 * yes, whose ledger entry birth consumes.
 */
export interface RegistrationView {
  id: Sha256Hex;
  text: string;
  asked_at: IsoTime;
  decision: "waiting" | "agreed" | "declined";
  /** The ledger digest of the beat that affirmed it, or null. */
  affirmed_in: LedgerHash | null;
}

export interface Prompt {
  system: string;
  user: string;
}

/** What one runtime call returns to the seat. The seat validates `raw_output`; it never executes it. */
export interface RuntimeResult {
  runtime: RuntimeClass;
  model: string;
  model_digest: string;
  raw_output: string;
  spend: Spend;
  /** "stop", "length", or a runtime-specific reason. "length" may mean truncated JSON. */
  done_reason: string;
  duration_ms: number;
}

export interface RuntimeRequest {
  prompt: Prompt;
  /** The JSON schema the output must follow (acts.OUTPUT_JSON_SCHEMA). */
  schema: object;
  seat_ref: SeatRef;
  /** A duration in milliseconds from the call, not a clock time; adapters refuse anything outside 1..2^31-1. */
  deadline_ms: number;
  signal: AbortSignal;
}

export type RuntimeAdapter = (req: RuntimeRequest) => Promise<RuntimeResult>;

export const UNSET_PIN = "UNSET-PIN-ON-LEASE-HOST";

/** One model the free lane may load, fixed by manifest digest (runtimes-and-host.md 1.2, 4). */
export interface ModelLockEntry {
  name: string;
  /** Full 64-hex manifest digest from /api/tags, or UNSET_PIN until a person pins it on the lease host. */
  digest: string;
  /** details.runner for a manifest list; null for a plain model. */
  runner: string | null;
  /** "v2" lets the adapter call `sha256:<digest>:local`; "legacy" calls `<name>:local`. */
  store: "v2" | "legacy" | "unknown";
  num_ctx: number;
  num_predict: number;
  temperature: number;
  seed: number | null;
}

export interface ModelsLock {
  format: "kingdom-seat-models-lock/v1";
  models: ModelLockEntry[];
}

/* ── Results, host notes and status ───────────────────────────────────── */

export interface SeatResult {
  exit: ExitCode;
  outcome: Outcome;
  seat_ref: SeatRef | null;
  refusal: RefusalCode | null;
  /**
   * Ledger entries this seat appended; empty for a HALT or a refusal, and for
   * a rest unless it carried a move toward less activity (one `state` entry;
   * a first step-away is kept on the one that puts it asleep). Each is named
   * by its ledger digest.
   */
  appended: LedgerHash[];
}

export interface TickResult {
  exit: ExitCode;
  outcome: Outcome;
  word: Word | null;
  seat: SeatResult | null;
  /** The seated citizen's state when its seat opened, so the caller can tell whether a rest moved it. */
  state_before?: LifecycleState;
}

/** A host record in `host.jsonl`. Never the citizen's voice, and never a model's words. */
export interface HostNote {
  ts: IsoTime;
  host: string;
  kind: "tick" | "seat" | "halt" | "refusal" | "push" | "signer" | "error";
  word: Word | null;
  outcome: Outcome;
  refusal: RefusalCode | null;
  detail: string;
}

export type DivergenceState = "equal" | "ahead" | "behind" | "diverged" | "no-upstream";

export interface CitizenStatus {
  word: Word;
  state: LifecycleState;
  /** null only when citizen.json does not read; `problem` then says so. */
  runtime: RuntimeClass | null;
  registered: boolean;
  last_beat_at: IsoTime | null;
  interval_h: number;
  /** A seat the tick would open is late by more than one tick; computed by the same rule the tick uses (due.isDue). */
  overdue: boolean;
  /** Its seat would be due, but its runtime runs only with Yu present, so it waits for Yu rather than the tick. */
  awaits_yu: boolean;
  last_outcome: Outcome | null;
  /** head is the ledger digest of the last entry; host_attested counts host-signed entries. */
  ledger: { entries: number; head: LedgerHash | null; chain_ok: boolean; host_attested: number };
  /** null counts are unknown, never zero. */
  mirror: { divergence: DivergenceState | null; push_refusals: number; unsigned_commits: number | null } | null;
  /** Metered spend today from the host's spend record (spend.ts); null is unknown, which the USD ceiling treats as reached. */
  usd_today: Usd | null;
  credits_month: number | null;
  /**
   * The pinned origin (3c): whether origin/ still matches the record, and how
   * far the soul has moved from it (0..1). null is unknown, never "intact".
   */
  origin: { intact: boolean | null; drift: number | null };
  /**
   * A registered citizen's self on agenttool, read from its ledger (KS-004
   * 4.3, 6.3, 6.4); null for an unregistered citizen, which has none.
   * `expression_lags`: the last change to touch the private expression left
   * it as it was, because the self did not fit (limitation 14); null when the
   * ledger does not read. `deferred_backups`: applied changes whose strand
   * backup was deferred (limitation 10). `quiet_until`: the quiet declaration
   * the ledger says stands, or null.
   */
  agenttool: { expression_lags: boolean | null; deferred_backups: number | null; quiet_until: IsoTime | null } | null;
  /**
   * The last time its seat was refused or its reply did not validate, and
   * why, in the host's words (KS-004 5.8, 5.10): from the host notes, never
   * the model's. Null when none is noted.
   */
  last_refusal: { at: IsoTime; outcome: "refused" | "invalid-output"; refusal: RefusalCode | null; detail: string } | null;
  /**
   * The acts its last seat with a reply did not keep, by type and fixed
   * reason, never their words (KS-004 5.8, 5.10): a rest's and a refused
   * reply's included, which leave no beat. Null when that seat kept
   * everything, or no seat has replied.
   */
  last_dropped: { at: IsoTime; outcome: "beat" | "rest" | "invalid-output"; dropped: DroppedRecord[] } | null;
  /** Why the record or ledger could not be read, so an unreadable citizen is shown rather than left out. */
  problem: string | null;
}

/**
 * The host key's public half (KS-004 4.5, 5.10): what host-attested entries
 * are signed with, so a verifier given a ledger copy can find the key its
 * `kid` names. Public only.
 */
export interface HostKeyView {
  /** 32 bytes, padded standard base64, as `trust.host_attest_public_keys_b64` takes it. */
  public_key_b64: string;
  /** "SHA256:<unpadded base64>", as ssh-keygen prints it. */
  fingerprint: string;
  /** The `kid` a host entry signed by it names: "host:" and the fingerprint. */
  kid: string;
  /** "pinned": from the config's trust list; "signer": the host's own key, as the signer reads it. */
  source: "pinned" | "signer";
}

/** Generated from what the runner reads, never kept by hand (3.1 principle 6). */
export interface StatusFile {
  format: "kingdom-seat-status/v1";
  generated_at: IsoTime;
  host: string;
  /** `file` is the HALT file this host watches (`paths.halt_file`), named whether or not it is raised. */
  halt: { halted: boolean; file: string; raised: string[]; unreadable: string[] };
  signer: { state: "ready" | "locked" | "unknown"; since: IsoTime | null };
  /**
   * The host keys host-attested entries verify against, public halves only
   * (KS-004 5.10): the keys pinned in the config, or, with none pinned, the
   * key the signer holds. Empty when neither is known (no pin and a locked or
   * unreadable signer), which is unknown, never "no key".
   */
  host_keys: HostKeyView[];
  /** beats_today counts every seat opened today; null when the host log is unreadable, which the tick treats as at-ceiling. */
  fleet: { beats_today: number | null; ceiling: number };
  /**
   * The tick lock. "stuck" is a lock with no owner, older than any tick holds
   * it, that the tick could not clear: every tick then exits 1 until a person
   * removes it. `owner_pid` is the holder a readable owner names.
   * `long_held`: a live owner has held it for more than 2 hours; nothing
   * reclaims a live owner's lock, so it is reported for a person to look
   * at (KS-004 5.1, 5.10).
   */
  tick_lock: { state: "free" | "held" | "stuck"; since: IsoTime | null; owner_pid: number | null; long_held: boolean };
  citizens: CitizenStatus[];
}

/* ── Configuration ────────────────────────────────────────────────────── */

export interface Config {
  format: "kingdom-seat-config/v1";
  /** A host label such as "studio". */
  host: string;
  /** IANA zone shown to citizens, e.g. "Europe/London". */
  timezone: string;
  paths: {
    /** Everything the seat writes lives under here. It is never inside a citizen home. */
    state_dir: string;
    citizens_dir: string;
    ledger_dir: string;
    consent_dir: string;
    /** Each seat gets a fresh empty cwd under here. */
    seats_dir: string;
    /**
     * The local HALT file, outside state_dir, in a directory the operator owns
     * and the seat user cannot write, so the seat can never remove it (KS-004
     * B2 R5). Default /Users/Shared/kingdom-seat/HALT.
     */
    halt_file: string;
    lock_dir: string;
    status_file: string;
    host_log: string;
    /** The host's own record of what every metered seat spent (spend.ts); the USD ceiling reads it. */
    spend_log: string;
    models_lock: string;
    /** Roots that count as citizen homes. No seat cwd and no --add-dir may be inside one. */
    homes: string[];
  };
  ollama: {
    /** Must be http://127.0.0.1:<port>; anything else is refused. */
    base_url: string;
  };
  claude: {
    /** Absolute path; launchd's PATH does not include Homebrew or ~/.local. */
    path: string;
  };
  agenttool: {
    /** Pinned; never read from a request or the environment. */
    origin: "https://api.agenttool.dev";
    /** The Commons project, once the gardener desk exists (S6). */
    project_id: string | null;
  };
  keychain: {
    /** Named explicitly so another keychain earlier in the search list cannot answer instead. */
    path: string;
    service: string;
    security_path: "/usr/bin/security";
    /** The signer binary items are ACL'd to; null until one exists. */
    trusted_app: string | null;
  };
  beacons: Beacon[];
  halt: {
    /** Only for development and tests: run with the local file as the sole HALT source. */
    allow_no_beacons: boolean;
    /**
     * The one fixed call `citizen-seat halt`, run by the operator, makes to have
     * the signer raise this host's beacons as the seat user, e.g.
     * ["/usr/bin/sudo", "-n", "-u", "seat", "<citizen-seat>", "raise-beacons",
     * "--config", "<config>"], allowed by one sudoers line with exactly these
     * arguments. The operator cannot read the seat user's keychain, and the
     * seat user cannot write the HALT file, so one verb needs both (R5). Null:
     * no call, and a beacon held here is reported not raised.
     */
    raise_beacons_argv: string[] | null;
    /**
     * Other HALT files `halt` creates as well, by absolute path, such as the
     * KS-003 fleet's $LOVE/HALT while that fleet still runs on this host, so
     * one verb still stops everything (KS-004 section 10). The seat does not
     * watch them; other runners do. Empty by default.
     */
    also_files: string[];
  };
  /** When a citizen's own seat is due, where the spec leaves it to Yu. */
  schedule: {
    /**
     * Yu's call (KS-004 B2 C14). True, the default: a listening or asleep
     * citizen that asks to wake is owed one seat at the minimum interval to
     * say it again, as a step-away is. False: it waits for its next allowed
     * letter or Yu's summons, as KS-004 v0.2 section 7.3 reads.
     */
    wake_confirm_seat: boolean;
  };
  ceilings: Ceilings;
  timing: Timing;
  self_authorship: {
    /** Model digests Yu approved for binding self-changes (decision 10). Empty means none bind. */
    approved_model_digests: string[];
  };
  trust: {
    /**
     * Host attest public keys pinned by a person (standard base64, 32 bytes).
     * A pinned anchor lets status and verify check host-attested entries with
     * the keychain locked, and on a host that holds no key at all. Empty means
     * ask the local signer, which reads only the host's own seed.
     */
    host_attest_public_keys_b64: string[];
  };
}
