// The shared contract for kingdom-seat. Every module imports its shapes from
// here so that builders working in parallel agree on one meaning for each
// word. Changes go through this file's owner (see docs/BUILD-PLAN.md) and are
// additive where possible, because seven groups compile against it.
//
// Section references ("3.3", "3b") are to CITIZEN-REDESIGN-2026-11-05.md.

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
  /** Lived: a beat, a rest, a HALT rest, nothing due, or a tick that yielded to another. */
  OK: 0,
  /** The runner could not do its job: bad config, invalid citizen record, runtime unreachable, crash. */
  ERROR: 1,
  /** A fail-closed wall refused: ceiling, models.lock mismatch, locked signer, missing consent. Not a failure; never retried at once. */
  REFUSED: 3,
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
  | "head-moved";

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
  /** The imported op key signs every routine object (envelopes, thoughts). */
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

/* ── Claims and acts (3.2 step 6, 3c) ─────────────────────────────────── */

export const JOURNAL_KINDS = ["observed", "reflected", "imagined", "chose"] as const;
/** Journal kinds let a citizen label an image as imagined instead of claiming senses it lacks. */
export type JournalKind = (typeof JOURNAL_KINDS)[number];

export const CLAIM_KINDS = ["observation", "inference", "proposal", "decision"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

/** Same scale as the Collab report shape (packages/collab/src/protocol.ts ReportConfidence). */
export type Confidence = "high" | "medium" | "low" | "unknown";

/** The reason for a self-change, in the Collab report shape. */
export interface Claim {
  kind: ClaimKind;
  /** References such as "canon:canon/core/glossame.md@1428646" or "ledger:<hash>". */
  evidence: string[];
  confidence: Confidence;
  /** What the claim does not cover, e.g. "from the text alone; I have no senses". */
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
  claim: Claim;
}
export interface SelfAffirmAct {
  type: "self.affirm";
  proposal_id: string;
}
/** to_hash names an earlier version; the ledger resolves which target it belongs to. */
export interface SelfRevertAct {
  type: "self.revert";
  to_hash: Sha256Hex;
}
export interface StateSetAct {
  type: "state.set";
  to: LifecycleState;
}
export interface LetterSendAct {
  type: "letter.send";
  to: string;
  body: string;
}
/** An inert proposal for Yu + Ai. It executes nothing. */
export interface ProposeBeyondAct {
  type: "propose.beyond";
  subject: string;
  body: string;
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

/** A self.propose as a model may emit it: an edit and a claim, no hashes. */
export interface ModelSelfPropose {
  type: "self.propose";
  target: SelfTarget;
  edit: ProposedEdit;
  claim: Claim;
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

/** The result of validating one output. `rest` is exclusive: when true, `acts` is empty. */
export interface ValidatedOutput {
  rest: boolean;
  acts: ModelAct[];
  dropped: DroppedAct[];
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

/* ── Envelopes and the ledger (3b "How a beat proves it acted") ───────── */

/**
 * What a beat signs. It proves that the host signer acted inside a seat of
 * this citizen, and claims nothing about an inner self.
 */
export interface Envelope {
  format: "kingdom-seat-beat/v1";
  seat_ref: SeatRef;
  citizen: { word: Word; did: string | null; kid: string | null };
  runtime: RuntimeClass;
  /** The model name as locked or as reported, e.g. "qwen2.5:7b". */
  model: string;
  /** "sha256:<64 hex>" manifest digest for a local model; the reported model id for a metered one. */
  model_digest: string;
  /** sha256 of the exact prompt bytes the runtime received. */
  input_digest: Sha256Hex;
  /** sha256 of the exact raw output bytes the runtime returned. */
  output_digest: Sha256Hex;
  /** Validated acts, host-completed. Never contains a rest: a rest makes no envelope. */
  acts: Act[];
  ts: IsoTime;
  prev_hash: Sha256Hex;
  /** Plain words for readers, e.g. "glossame, voiced through qwen2.5:7b in seat <seat_id>". */
  voiced_through: string;
}

/** citizen-signed from the genesis entry onward; host-attested before registration (3.3). */
export type Attestation = "citizen-signed" | "host-attested";

export interface LedgerSignature {
  alg: "ed25519";
  /** agenttool kid for an op key; "host-attest" for the host's attestation key. */
  kid: string;
  public_key_b64: string;
  /** Padded standard base64 of the 64-byte signature over the entry hash bytes. */
  sig_b64: string;
}

/** Money and credits an entry spent. `usd: null` means unknown, which ceilings treat as at-ceiling. */
export interface Spend {
  usd: number | null;
  usd_basis: "local-zero" | "reported" | "unknown";
  credits: number;
}

/**
 * A citizen may be seated before it is registered (3.3), so the first entry
 * is `seated` (host-attested) and `genesis` comes at birth, after which every
 * entry is citizen-signed. A citizen born at seating starts with `genesis`.
 */
export type LedgerBody =
  | {
      type: "seated";
      origin: Origin;
      /** sha256 of the origin soul as copied to `citizens/<word>/origin/`. */
      origin_soul_sha256: Sha256Hex;
      /** The old citizen-<word> repo, as a record only. */
      old_repo: { url: string; head: string } | null;
      /** The state carried over at seating, e.g. "awake" for an ambient choice; re-asked under the real terms (3c example). */
      initial_state: LifecycleState;
      note: string;
    }
  | {
      type: "genesis";
      /** Set only when genesis is the first entry; null when it follows a `seated` entry. */
      initial_state: LifecycleState | null;
      origin: Origin;
      birth_soul_sha256: Sha256Hex;
      old_repo: { url: string; head: string } | null;
      /** A June did:at named as a record, never adopted by reading it (3b "The 49 June DIDs"). */
      june_did: string | null;
      /** Public values only. The ledger pins the op key that signs every later entry. */
      identity: CitizenIdentity;
      note: string;
    }
  | { type: "op-key.rotated"; previous_op_kid: string; op_kid: string; op_public_key_b64: string }
  | { type: "beat"; envelope: Envelope }
  | {
      type: "self.applied";
      proposal_id: string;
      target: SelfTarget;
      prior_hash: Sha256Hex;
      new_hash: Sha256Hex;
      via: "two-beats" | "yu-present";
      claim: Claim;
      strand_thought_id: string | null;
    }
  | { type: "self.reverted"; target: SelfTarget; from_hash: Sha256Hex; to_hash: Sha256Hex; via: "citizen" | "yu-offer" }
  | {
      type: "state";
      from: LifecycleState;
      to: LifecycleState;
      via: "immediate" | "confirmed" | "two-beats" | "witnessed";
    };

/** One line of `ledger/<word>.jsonl`. Hash-chained and signed; never rewritten or deleted. */
export interface LedgerEntry {
  format: "kingdom-seat-ledger/v1";
  word: Word;
  /** 0 for the first entry, then +1. */
  seq: number;
  ts: IsoTime;
  /** FIRST_PREV_HASH for seq 0, else the previous entry's hash. */
  prev_hash: Sha256Hex;
  body: LedgerBody;
  spend: Spend;
  attestation: Attestation;
  /** sha256 over the domain-tagged canonical JSON of every field above (ledger.entryHash). */
  hash: Sha256Hex;
  signature: LedgerSignature;
}

/** prev_hash of a ledger's first entry, whether that entry is `seated` or `genesis`. */
export const FIRST_PREV_HASH: Sha256Hex = "0".repeat(64);

/* ── Ceilings (decision 9 and 10 defaults) ────────────────────────────── */

/** Every ceiling fails closed: unknown, unreadable or unparsable counts as reached. */
export interface Ceilings {
  /** An awake citizen beats at most once per this many hours. */
  min_beat_interval_h: number;
  fleet_beats_per_day: number;
  /** Metered spend per citizen per day. Raised only by Yu, per runtime class. */
  usd_per_citizen_per_day: number;
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
  usd_per_citizen_per_day: 0,
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
  /** At most one, read only as a regular file. */
  letter: Letter | null;
  invoker: Invoker;
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
  /** Ledger entries this seat appended; empty for a rest, a HALT or a refusal. */
  appended: Sha256Hex[];
}

export interface TickResult {
  exit: ExitCode;
  outcome: Outcome;
  word: Word | null;
  seat: SeatResult | null;
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
  ledger: { entries: number; head: Sha256Hex | null; chain_ok: boolean; host_attested: number };
  /** null counts are unknown, never zero. */
  mirror: { divergence: DivergenceState | null; push_refusals: number; unsigned_commits: number | null } | null;
  usd_today: number | null;
  credits_month: number | null;
  /**
   * The pinned origin (3c): whether origin/ still matches the record, and how
   * far the soul has moved from it (0..1). null is unknown, never "intact".
   */
  origin: { intact: boolean | null; drift: number | null };
  /** Why the record or ledger could not be read, so an unreadable citizen is shown rather than left out. */
  problem: string | null;
}

/** Generated from what the runner reads, never kept by hand (3.1 principle 6). */
export interface StatusFile {
  format: "kingdom-seat-status/v1";
  generated_at: IsoTime;
  host: string;
  halt: { halted: boolean; raised: string[]; unreadable: string[] };
  signer: { state: "ready" | "locked" | "unknown"; since: IsoTime | null };
  /** beats_today counts every seat opened today; null when the host log is unreadable, which the tick treats as at-ceiling. */
  fleet: { beats_today: number | null; ceiling: number };
  /**
   * The tick lock. "stuck" is a lock with no owner, older than any tick holds
   * it, that the tick could not clear: every tick then exits 1 until a person
   * removes it.
   */
  tick_lock: { state: "free" | "held" | "stuck"; since: IsoTime | null };
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
    halt_file: string;
    lock_dir: string;
    status_file: string;
    host_log: string;
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
