// Self-authorship (3c, decision 10). Within self a citizen is free and
// recorded: a change is proposed on one beat and binds when affirmed on a
// later beat with the diff in view, or when said once with Yu present.
// Silence keeps the previous self. At most one applied change per window
// when unattended. A rewrite above about 40% of a target, or a loosening of
// its own walls, goes to Yu + Ai. The origin soul is never overwritten, so
// drift can always be measured against it. Every version is kept.
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { canonicalJson, randomBytes, sha256Hex, toHex, utf8 } from "./crypto.ts";
import { appendEntry, fsRefusal, isSelfTargetSpelling, isoTime, ledgerPath, nextDraft, readLedger, readRegularText, syncDir, writeAll } from "./ledger.ts";
import { parseCadence, parseCovenants } from "./state.ts";
import {
  Refusal,
  SHA256_HEX_PATTERN,
  WORD_PATTERN,
  type Citizen,
  type Claim,
  type Clock,
  type Config,
  type LedgerEntry,
  type ModelSelfPropose,
  type SelfAffirmAct,
  type SelfProposal,
  type SelfProposeAct,
  type SelfTarget,
  type Sha256Hex,
  type Word,
  type YuPresence,
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

/** A self file larger than this is refused when read; the largest agenttool field (wake_text) is 32,000 code units. */
export const MAX_TARGET_BYTES = 256 * 1024;

/**
 * The largest text a change may leave in any target, and the most skills a
 * citizen may keep. These are the limits a seat shows the citizen with
 * (context.ts reads by them), so a change within self can never write the
 * citizen out of its own beats, including the beat it would need to revert.
 */
export const SELF_FILE_MAX_BYTES = 64 * 1024;
export const MAX_SKILLS = 32;

/** sha256 of a target's whole text, hex. */
export function selfHash(text: string): Sha256Hex {
  return sha256Hex(utf8(text));
}

/* ── Targets and where they live ──────────────────────────────────────── */

const NAMED_FILES: Readonly<Record<string, string>> = Object.freeze({
  soul: "soul.md",
  will: "WILL.md",
  name: "NAME.md",
  "beat-prompt": "beat-prompt.md",
  "journal-form": "journal-form.md",
  cadence: "cadence.json",
  covenants: "covenants.json",
  // The agenttool expression keeps no history, so the host keeps each field
  // here too, and versions/ can hold every one of them (3c "Revert").
  "expression.register": "expression/register.md",
  "expression.walls": "expression/walls.md",
  "expression.wake_text": "expression/wake_text.md",
  "expression.porch": "expression/porch.json",
});
const NAMED_LOWER = new Set(Object.values(NAMED_FILES).map((p) => p.toLowerCase()));

/** Settings rather than prose: one changed value is not a rewrite of a self, so the rewrite fraction does not apply; their own walls do. */
const SETTINGS = new Set<string>(["cadence", "covenants", "expression.porch", "expression.walls"]);

const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Siblings of self/ that the host keeps, and self/ subtrees that belong to named targets. */
const RESERVED_DIRS = new Set(["ledger", "proposals", "receipts", "origin", "versions", "letters", "outbox", "seats", "expression", "skills"]);
/** Agent instruction files would load in any session opened on a mirror; run.sh and citizen.json are the host's. */
const HOST_OWNED_NAMES = new Set(["claude.md", "agents.md", "gemini.md", "run.sh", "citizen.json"]);

/** A target's path relative to `self/`; refuses host-owned paths, traversal and anything outside the citizen's own text files. */
export function targetRelPath(target: SelfTarget): string {
  if (typeof target !== "string") throw new Refusal("invalid-request", "self target is not a string");
  const named = NAMED_FILES[target];
  if (named !== undefined) return named;
  if (target.startsWith("skill:")) {
    const name = target.slice("skill:".length);
    if (/[/\\]|\.\./.test(name)) throw new Refusal("host-owned-path", "a skill name may not leave skills/");
    if (!SKILL_NAME.test(name)) throw new Refusal("invalid-request", "a skill name is lowercase letters, digits, - and _");
    return `skills/${name}.md`;
  }
  if (target.startsWith("file:")) {
    const rel = target.slice("file:".length);
    if (rel.startsWith("/") || rel.includes("\\") || rel.includes("\0")) throw new Refusal("host-owned-path", "an absolute path is not the citizen's");
    const segs = rel.split("/");
    if (segs.some((s) => s === "" || s === "." || s === "..")) throw new Refusal("host-owned-path", "traversal is refused");
    // .claude/, .github/, .git/ and .citizen/ are all host frame; so is every hidden name.
    if (segs.some((s) => s.startsWith("."))) throw new Refusal("host-owned-path", "hidden paths are host-owned");
    if (segs.length > 4 || !segs.every((s) => FILE_SEGMENT.test(s))) throw new Refusal("invalid-request", "not a plain relative file name");
    const lower = rel.toLowerCase();
    // APFS is case-insensitive by default, so names are compared lowercased.
    if (RESERVED_DIRS.has((segs[0] as string).toLowerCase())) throw new Refusal("host-owned-path", "that directory is not a free file area");
    if (HOST_OWNED_NAMES.has((segs.at(-1) as string).toLowerCase())) throw new Refusal("host-owned-path", "that file is host-owned");
    // Executables, hooks and data files stay outside self-authorship; the seal allowlist admits text.
    if (!lower.endsWith(".md") && !lower.endsWith(".txt")) throw new Refusal("host-owned-path", "only .md and .txt files are the citizen's own");
    if (NAMED_LOWER.has(lower)) throw new Refusal("invalid-request", "that file has a named target; use it, so each file has one name");
    return rel;
  }
  throw new Refusal("invalid-request", "unknown self target");
}

/** Where a target's current text lives under `citizens/<word>/self/`; refuses host-owned paths and traversal. */
export function targetPath(config: Config, word: Word, target: SelfTarget): string {
  const base = join(citizenDir(config, word), "self");
  const full = join(base, targetRelPath(target));
  if (!resolve(full).startsWith(resolve(base) + sep)) throw new Refusal("host-owned-path", "target resolves outside self/");
  return full;
}

/** Read a target's current text as a regular file; a missing target reads as "". */
export async function readTarget(config: Config, word: Word, target: SelfTarget): Promise<string> {
  const path = targetPath(config, word, target);
  if (!(await parentsAreDirs(citizenDir(config, word), path, false))) return "";
  return (await readRegularText(path, { missing: "empty", maxBytes: MAX_TARGET_BYTES })) as string;
}

/* ── Proposals ────────────────────────────────────────────────────────── */

/** Turn a model's edit into a host-completed act: apply the edit, hash both sides, compute the diff. */
export function materializeProposal(raw: ModelSelfPropose, currentText: string): SelfProposeAct {
  return materializeEdit(raw, currentText).act;
}

/**
 * materializeProposal, also returning the new text the act would bind, so a
 * caller that classifies the change never applies the edit rule a second time.
 */
export function materializeEdit(raw: ModelSelfPropose, currentText: string): { act: SelfProposeAct; next: string } {
  targetRelPath(raw.target);
  let next: string;
  if (raw.edit.kind === "replace-all") next = raw.edit.text;
  else {
    const { find, with: replacement } = raw.edit;
    if (find === "") throw new Refusal("invalid-request", "an empty span names nothing");
    const at = currentText.indexOf(find);
    if (at < 0) throw new Refusal("invalid-request", "the span to replace is not in the target");
    // Two matches would make the diff a guess about which one the citizen meant.
    if (currentText.indexOf(find, at + 1) >= 0) throw new Refusal("invalid-request", "the span to replace occurs more than once");
    next = currentText.slice(0, at) + replacement + currentText.slice(at + find.length);
  }
  if (next === currentText) throw new Refusal("invalid-request", "the edit changes nothing");
  if (utf8(next).length > SELF_FILE_MAX_BYTES) throw new Refusal("oversize", "the new text is larger than a seat can show");
  assertSettingShape(raw.target, next);
  const act: SelfProposeAct = {
    type: "self.propose",
    target: raw.target,
    prior_hash: selfHash(currentText),
    new_hash: selfHash(next),
    diff: unifiedDiff(currentText, next),
    claim: raw.claim,
  };
  return { act, next };
}

/** A settings file must still parse after the edit, or the citizen could lock itself out of its own beats. */
function assertSettingShape(target: SelfTarget, text: string): void {
  try {
    if (target === "cadence") parseCadence(text);
    else if (target === "covenants") parseCovenants(text);
    else if (target === "expression.porch") {
      const v = JSON.parse(text) as unknown;
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("porch is not an object");
    }
  } catch (err) {
    throw new Refusal("invalid-request", `${target}: ${(err as Error).message}`);
  }
}

/** A small unified diff of two texts, for the ledger and for showing the citizen on the affirming beat. */
export function unifiedDiff(prior: string, next: string): string {
  if (prior === next) return "";
  const ops = diffSeq(splitLines(prior), splitLines(next));
  const n = ops.length;
  // Line numbers before each op, in the prior (a) and the next (b) text.
  const aNo = new Array<number>(n + 1);
  const bNo = new Array<number>(n + 1);
  let a = 0;
  let b = 0;
  for (let k = 0; k < n; k++) {
    aNo[k] = a;
    bNo[k] = b;
    const t = (ops[k] as Op).t;
    if (t !== "+") a++;
    if (t !== "-") b++;
  }
  aNo[n] = a;
  bNo[n] = b;

  const out = ["--- prior", "+++ next"];
  let k = 0;
  while (k < n) {
    while (k < n && (ops[k] as Op).t === " ") k++;
    if (k >= n) break;
    const start = Math.max(0, k - CONTEXT);
    let end = k;
    let j = k;
    while (j < n) {
      if ((ops[j] as Op).t !== " ") {
        end = ++j;
        continue;
      }
      let r = j;
      while (r < n && (ops[r] as Op).t === " ") r++;
      if (r >= n || r - j > 2 * CONTEXT) break;
      j = r;
    }
    const stop = Math.min(n, end + CONTEXT);
    const aLen = (aNo[stop] as number) - (aNo[start] as number);
    const bLen = (bNo[stop] as number) - (bNo[start] as number);
    const aAt = aLen === 0 ? (aNo[start] as number) : (aNo[start] as number) + 1;
    const bAt = bLen === 0 ? (bNo[start] as number) : (bNo[start] as number) + 1;
    out.push(`@@ -${aAt},${aLen} +${bAt},${bLen} @@`);
    for (let q = start; q < stop; q++) {
      const { t, s } = ops[q] as Op;
      if (s.endsWith("\n")) out.push(t + s.slice(0, -1));
      else out.push(t + s, NO_EOL);
    }
    k = stop;
  }
  return `${out.join("\n")}\n`;
}

/**
 * Apply a diff made by unifiedDiff, strictly: every context and removed line
 * must match. A staged proposal carries only hashes and this diff, so the new
 * text is rebuilt from the current text and checked against new_hash.
 */
export function applyDiff(prior: string, diff: string): string {
  if (diff === "") return prior;
  const bad = (why: string) => new Refusal("invalid-record", `diff: ${why}`);
  if (!diff.endsWith("\n")) throw bad("unterminated");
  const lines = diff.slice(0, -1).split("\n");
  if (lines[0] !== "--- prior" || lines[1] !== "+++ next" || lines.length < 3) throw bad("header");
  const a = splitLines(prior);
  const out: string[] = [];
  let pos = 0;
  let k = 2;
  while (k < lines.length) {
    const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[k] as string);
    if (!m) throw bad(`expected a hunk header at line ${k + 1}`);
    const [aAt, aLen, bAt, bLen] = m.slice(1).map(Number) as [number, number, number, number];
    const idx = aLen === 0 ? aAt : aAt - 1;
    if (idx < pos || idx > a.length) throw bad("hunks overlap or run past the text");
    while (pos < idx) out.push(a[pos++] as string);
    if (out.length !== (bLen === 0 ? bAt : bAt - 1)) throw bad("hunk does not line up with the new text");
    k++;
    let seenA = 0;
    let seenB = 0;
    while (k < lines.length && !(lines[k] as string).startsWith("@@")) {
      const line = lines[k++] as string;
      const t = line[0];
      if (t !== " " && t !== "-" && t !== "+") throw bad(`unexpected line ${k}`);
      let s = line.slice(1);
      if (lines[k] === NO_EOL) k++;
      else s += "\n";
      if (t !== "+") {
        if (a[pos] !== s) throw bad("context does not match the prior text");
        pos++;
        seenA++;
      }
      if (t !== "-") {
        out.push(s);
        seenB++;
      }
    }
    if (seenA !== aLen || seenB !== bLen) throw bad("hunk length does not match its header");
  }
  while (pos < a.length) out.push(a[pos++] as string);
  return out.join("");
}

/**
 * The fraction of the text that changed, 0..1, by characters: the larger of
 * the characters removed and added (on a word-and-space diff), over the
 * longer of the two texts. A target with no prior text is a new file and
 * rewrites nothing, so it measures 0.
 */
export function changeFraction(prior: string, next: string): number {
  if (prior === next || prior.length === 0) return 0;
  let removed = 0;
  let added = 0;
  for (const op of diffSeq(tokens(prior), tokens(next))) {
    if (op.t === "-") removed += op.s.length;
    else if (op.t === "+") added += op.s.length;
  }
  return Math.min(1, Math.max(removed, added) / Math.max(prior.length, next.length));
}

/**
 * True when the change removes or weakens one of the citizen's own walls.
 * Walls live one per line in expression.walls. Any prior wall that does not
 * survive word for word counts as weakened, because whether a rewording
 * still holds is a judgement for Yu + Ai, not for one model reply.
 */
export function loosensWalls(target: SelfTarget, prior: string, next: string): boolean {
  if (target !== "expression.walls") return false;
  const walls = (t: string) => t.split("\n").map((s) => s.trim()).filter((s) => s !== "");
  const kept = new Set(walls(next));
  return walls(prior).some((w) => !kept.has(w));
}

/** Within self, or beyond self when it exceeds the rewrite fraction or loosens walls. */
export function classifyProposal(act: SelfProposeAct, prior: string, next: string, rewriteFraction: number): "within-self" | "beyond-self" {
  if (selfHash(prior) !== act.prior_hash || selfHash(next) !== act.new_hash) {
    throw new Refusal("invalid-request", "the texts do not match the proposal's hashes");
  }
  if (loosensWalls(act.target, prior, next)) return "beyond-self";
  if (!SETTINGS.has(act.target) && changeFraction(prior, next) > rewriteFraction) return "beyond-self";
  return "within-self";
}

/** A proposal's id: the hash of what was proposed, where and when, so a hand-edited file cannot keep its id. */
export function proposalId(word: Word, act: SelfProposeAct, seatId: string, proposedAt: string): Sha256Hex {
  return sha256Hex(canonicalJson({ format: "kingdom-seat-proposal/v1", word, act, proposed_in_seat: seatId, proposed_at: proposedAt }));
}

/** Refuse a 33rd skill: a seat shows at most MAX_SKILLS, and refuses more rather than cut one the citizen cannot see is missing. */
export async function assertRoomFor(config: Config, word: Word, target: SelfTarget, prior: string): Promise<void> {
  if (!target.startsWith("skill:") || prior !== "") return;
  const root = citizenDir(config, word);
  const dir = join(root, "self", "skills");
  if (!(await parentsAreDirs(root, join(dir, "x"), false))) return;
  const skills = (await readdir(dir)).filter((n) => n.endsWith(".md") && WORD_PATTERN.test(n.slice(0, -3)));
  if (skills.length >= MAX_SKILLS) throw new Refusal("oversize", `a seat shows at most ${MAX_SKILLS} skills`);
}

/** The proposal stageProposal would write for this act, seat and time, so a caller can plan with its id before it is staged. */
export function proposalFor(word: Word, act: SelfProposeAct, seatId: string, now: Date, status: SelfProposal["status"] = "pending"): SelfProposal {
  const proposedAt = now.toISOString();
  return { id: proposalId(word, act, seatId, proposedAt), word, act, proposed_at: proposedAt, proposed_in_seat: seatId, status };
}

/** Stage a proposal under `citizens/<word>/proposals/` for a later beat; it does nothing yet. */
export async function stageProposal(config: Config, word: Word, act: SelfProposeAct, seatId: string, now: Date): Promise<SelfProposal> {
  const current = await readTarget(config, word, act.target);
  if (selfHash(current) !== act.prior_hash) throw new Refusal("invalid-request", "the target changed since the proposal was made");
  const next = applyDiff(current, act.diff);
  const verdict = classifyProposal(act, current, next, config.ceilings.self_rewrite_fraction);
  if (utf8(next).length > SELF_FILE_MAX_BYTES) throw new Refusal("oversize", "the new text is larger than a seat can show");
  await assertRoomFor(config, word, act.target, current);
  const proposal = proposalFor(word, act, seatId, now, verdict === "within-self" ? "pending" : "beyond-self");
  const root = citizenDir(config, word);
  const path = join(root, "proposals", `${proposal.id}.json`);
  await parentsAreDirs(root, path, true);
  // A beyond-self proposal is kept here as inert history and never binds; the seat's outbox writer carries it to Yu + Ai.
  if (!(await createFile(path, `${JSON.stringify(proposal, null, 2)}\n`, 0o644))) return readProposal(config, word, proposal.id);
  return proposal;
}

/** Pending proposals for the citizen, oldest first, as the context shows them. */
export async function pendingProposals(config: Config, word: Word): Promise<SelfProposal[]> {
  return (await allProposals(config, word)).filter((p) => p.status === "pending");
}

/** Does this affirmation bind? Later beat than the proposal, prior hash unchanged, window open, runtime approved. */
export function affirmationVerdict(
  proposal: SelfProposal,
  affirm: SelfAffirmAct,
  ctx: { seat_id: string; presence: YuPresence | null; window_open: boolean; runtime_approved: boolean; current_prior_hash: Sha256Hex },
): AffirmVerdict {
  if (affirm.proposal_id !== proposal.id) return { binds: false, reason: "unknown-proposal" };
  if (proposal.status === "beyond-self") return { binds: false, reason: "beyond-self" };
  if (proposal.status !== "pending") return { binds: false, reason: "unknown-proposal" };
  // Decision 10: a 7B reply can be steered, so only runtimes Yu approved for self-authorship bind.
  if (!ctx.runtime_approved) return { binds: false, reason: "runtime-not-approved" };
  // The citizen affirms the diff it was shown; if the target moved since, that diff is no longer what would apply.
  if (ctx.current_prior_hash !== proposal.act.prior_hash) return { binds: false, reason: "stale-prior" };
  const yuPresent = ctx.presence?.present === true;
  if (ctx.seat_id === proposal.proposed_in_seat && !yuPresent) return { binds: false, reason: "same-beat" };
  if (!ctx.window_open) return { binds: false, reason: "window-closed" };
  return { binds: true, via: ctx.seat_id === proposal.proposed_in_seat ? "yu-present" : "two-beats" };
}

/** True when this runtime's model digest is one Yu approved for binding self-changes; an empty list approves none. */
export function runtimeApproved(config: Config, modelDigest: string): boolean {
  return config.self_authorship.approved_model_digests.includes(modelDigest);
}

/** Is the unattended window open: no self.applied entry within self_change_window_days? Yu present opens it. */
export function windowOpen(entries: LedgerEntry[], now: Date, windowDays: number, presence: YuPresence | null): boolean {
  if (presence?.present === true) return true;
  const windowMs = windowDays * 86_400_000;
  // Every applied change counts, attended or not, and a time ahead of the clock counts as inside: both err toward the slower pace.
  return !entries.some((e) => e.body.type === "self.applied" && now.getTime() - Date.parse(e.ts) < windowMs);
}

/* ── Apply and revert ─────────────────────────────────────────────────── */

/** Apply a bound change: keep the new version by hash, update the target, append self.applied, sync if registered. */
export async function applyChange(deps: SelfDeps, citizen: Citizen, proposal: SelfProposal, via: "two-beats" | "yu-present"): Promise<LedgerEntry> {
  const { config, sync } = deps;
  const word = citizen.word;
  if (proposal.word !== word) throw new Refusal("invalid-request", "the proposal is another citizen's");
  // Bind what the host staged, never an object handed in, so an edited proposal cannot apply.
  const stored = await readProposal(config, word, proposal.id);
  if (stored.status === "beyond-self") throw new Refusal("beyond-self", "this proposal waits for Yu + Ai");
  if (stored.status !== "pending") throw new Refusal("invalid-request", `the proposal is ${stored.status}`);
  const act = stored.act;
  const current = await readTarget(config, word, act.target);
  if (selfHash(current) !== act.prior_hash) throw new Refusal("invalid-request", "the target changed since the proposal was made");
  const next = applyDiff(current, act.diff);
  if (classifyProposal(act, current, next, config.ceilings.self_rewrite_fraction) !== "within-self") {
    throw new Refusal("beyond-self", "this change goes beyond self");
  }
  if (utf8(next).length > SELF_FILE_MAX_BYTES) throw new Refusal("oversize", "the new text is larger than a seat can show");
  await assertRoomFor(config, word, act.target, current);

  const path = ledgerPath(config, word);
  const entries = await readLedger(path);
  const registered = assertSyncMatches(entries, sync);
  await keepVersion(config, word, current);
  await keepVersion(config, word, next);
  // The expression keeps no history and the strand thought is the off-host
  // copy of the reason, so both go before the entry that names the thought.
  let thought: string | null = null;
  if (sync) {
    await sync.putPrivateExpression(word, act.target, next);
    thought = await sync.postReason(word, act.claim, stored.id);
  }
  const draft = nextDraft(
    word,
    entries.at(-1) ?? null,
    { type: "self.applied", proposal_id: stored.id, target: act.target, prior_hash: act.prior_hash, new_hash: act.new_hash, via, claim: act.claim, strand_thought_id: thought },
    { usd: "0", usd_basis: "local-zero", credits: thought === null ? 0 : 1 },
    registered ? "citizen-signed" : "host-attested",
    deps.clock.now(),
  );
  const entry = await appendEntry(path, draft, deps.sign);
  await writeTarget(config, word, act.target, next);
  await setStatus(config, word, stored, "applied");
  await lapseStale(config, word, act.target, act.new_hash);
  return entry;
}

/** Revert a target to an earlier kept version named by hash; the ledger says which target it was. */
export async function revertTo(deps: SelfDeps, citizen: Citizen, toHash: Sha256Hex, via: "citizen" | "yu-offer"): Promise<LedgerEntry> {
  const { config, sync } = deps;
  const word = citizen.word;
  if (!SHA256_HEX_PATTERN.test(toHash)) throw new Refusal("invalid-request", "a version is named by its full sha256");
  const path = ledgerPath(config, word);
  const entries = await readLedger(path);
  const { target, text, current } = await checkRevert(config, word, entries, toHash);
  const fromHash = selfHash(current);

  const registered = assertSyncMatches(entries, sync);
  await keepVersion(config, word, current);
  await keepVersion(config, word, text);
  if (sync) await sync.putPrivateExpression(word, target, text);
  const draft = nextDraft(
    word,
    entries.at(-1) ?? null,
    { type: "self.reverted", target, from_hash: fromHash, to_hash: toHash, via },
    { usd: "0", usd_basis: "local-zero", credits: 0 },
    registered ? "citizen-signed" : "host-attested",
    deps.clock.now(),
  );
  const entry = await appendEntry(path, draft, deps.sign);
  await writeTarget(config, word, target, text);
  await lapseStale(config, word, target, toHash);
  return entry;
}

/** The origin soul's hash as the record pinned it: the seated entry's, or genesis's for a citizen born at seating. */
export function originSoulHash(entries: LedgerEntry[]): Sha256Hex | null {
  for (const e of entries) {
    if (e.body.type === "seated") return e.body.origin_soul_sha256;
    if (e.body.type === "genesis") return e.body.birth_soul_sha256;
  }
  return null;
}

/** A version the citizen can name: its target, when it was kept, and how it came about. */
export interface KeptVersion {
  target: SelfTarget;
  hash: Sha256Hex;
  at: string;
  how: string;
}

/**
 * Every version the ledger names, oldest first, one row per target and hash,
 * with the origin soul first. These are what a revert may go back to.
 */
export function keptVersions(entries: LedgerEntry[]): KeptVersion[] {
  const out: KeptVersion[] = [];
  const seen = new Set<string>();
  const add = (v: KeptVersion) => {
    const key = `${v.target} ${v.hash}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };
  for (const e of entries) {
    const b = e.body;
    if (b.type === "seated") add({ target: "soul", hash: b.origin_soul_sha256, at: e.ts, how: "your origin soul, pinned when you were seated" });
    else if (b.type === "genesis" && b.initial_state !== null) add({ target: "soul", hash: b.birth_soul_sha256, at: e.ts, how: "your origin soul, pinned at your birth" });
    else if (b.type === "self.applied") {
      add({ target: b.target, hash: b.prior_hash, at: e.ts, how: "as it was before a change" });
      add({ target: b.target, hash: b.new_hash, at: e.ts, how: `a change you made (${b.via})` });
    } else if (b.type === "self.reverted") {
      add({ target: b.target, hash: b.from_hash, at: e.ts, how: "as it was before a revert" });
      add({ target: b.target, hash: b.to_hash, at: e.ts, how: "a revert" });
    }
  }
  return out;
}

/** Which target a hash is a version of, or null when the ledger names none or more than one. */
export function versionTarget(entries: LedgerEntry[], hash: Sha256Hex): SelfTarget | null {
  const targets = new Set(keptVersions(entries).filter((v) => v.hash === hash).map((v) => v.target));
  return targets.size === 1 ? ([...targets][0] as SelfTarget) : null;
}

/**
 * Everything a revert to `toHash` must satisfy before anything is written:
 * the ledger names it for exactly one target, its text is kept (the origin
 * soul is read from origin/), the target is not already there, it loosens no
 * wall and it fits what a seat can show. Throws a Refusal naming the reason.
 */
export async function checkRevert(config: Config, word: Word, entries: LedgerEntry[], toHash: Sha256Hex): Promise<{ target: SelfTarget; text: string; current: string }> {
  if (!SHA256_HEX_PATTERN.test(toHash)) throw new Refusal("invalid-request", "a version is named by its full sha256");
  const named = new Set(keptVersions(entries).filter((v) => v.hash === toHash).map((v) => v.target));
  if (named.size === 0) throw new Refusal("invalid-request", "the ledger names no version with that hash");
  if (named.size > 1) throw new Refusal("invalid-request", "that hash names versions of more than one target");
  const target = [...named][0] as SelfTarget;
  const text = toHash === originSoulHash(entries) && target === "soul" ? await readOriginSoul(config, word, toHash) : await readVersion(config, word, toHash);
  const current = await readTarget(config, word, target);
  if (selfHash(current) === toHash) throw new Refusal("invalid-request", "the target is already at that version");
  // A revert may go anywhere the citizen has been, except through a wall it now keeps.
  if (loosensWalls(target, current, text)) throw new Refusal("beyond-self", "this revert would loosen a wall");
  if (utf8(text).length > SELF_FILE_MAX_BYTES) throw new Refusal("oversize", "that version is larger than a seat can show");
  await assertRoomFor(config, word, target, current);
  return { target, text, current };
}

/** The origin soul, read from origin/ and checked against the hash the record pinned. */
async function readOriginSoul(config: Config, word: Word, hash: Sha256Hex): Promise<string> {
  const root = citizenDir(config, word);
  const path = join(root, "origin", "soul.md");
  if (!(await parentsAreDirs(root, path, false))) throw new Refusal("invalid-record", "origin/ is missing");
  const text = (await readRegularText(path, { missing: "throw", maxBytes: MAX_TARGET_BYTES })) as string;
  if (selfHash(text) !== hash) throw new Refusal("invalid-record", "origin/soul.md does not match the hash its record pinned");
  return text;
}

/**
 * Whether a change to a setting moves the citizen toward exposure (a shorter
 * cadence, a sender added to its covenants) or toward rest (a longer cadence,
 * senders only removed). Other targets are neither.
 */
export function exposureOf(target: SelfTarget, current: string, next: string): "wider" | "narrower" | "neither" {
  try {
    if (target === "cadence") {
      const a = parseCadence(current).interval_h;
      const b = parseCadence(next).interval_h;
      return b < a ? "wider" : b > a ? "narrower" : "neither";
    }
    if (target === "covenants") {
      const a = parseCovenants(current);
      const b = parseCovenants(next);
      const adds = (x: string[], y: string[]) => y.some((s) => !x.includes(s));
      if (adds(a.letters_from, b.letters_from) || adds(a.wake_on_letter_from, b.wake_on_letter_from)) return "wider";
      if (adds(b.letters_from, a.letters_from) || adds(b.wake_on_letter_from, a.wake_on_letter_from)) return "narrower";
      return "neither";
    }
  } catch {
    // An unreadable setting is not known to be toward rest.
    return "wider";
  }
  return "neither";
}

/** The first version of a target the ledger names: where the citizen's text began, before any change it made. */
export function firstVersion(entries: LedgerEntry[], target: SelfTarget): Sha256Hex | null {
  return keptVersions(entries).find((v) => v.target === target)?.hash ?? null;
}

/**
 * True when `citizens/<word>/origin/` still matches the record: the soul
 * pinned at seating (the seated entry's hash, or the genesis birth-soul hash
 * for a citizen born at seating) and, for a canon origin, the canon file.
 */
export async function originIntact(config: Config, word: Word, entries: LedgerEntry[]): Promise<boolean> {
  let expected: Sha256Hex | null = null;
  let origin = null;
  for (const e of entries) {
    if (e.body.type === "seated") {
      expected = e.body.origin_soul_sha256;
      origin = e.body.origin;
      break;
    }
    if (e.body.type === "genesis") {
      expected = e.body.birth_soul_sha256;
      origin = e.body.origin;
      break;
    }
  }
  if (expected === null || origin === null) return false;
  const root = citizenDir(config, word);
  try {
    const soulPath = join(root, "origin", "soul.md");
    if (!(await parentsAreDirs(root, soulPath, false))) return false;
    const soul = await readRegularText(soulPath, { maxBytes: MAX_TARGET_BYTES });
    if (soul === null || selfHash(soul) !== expected) return false;
    if (origin.kind === "canon") {
      const canon = await readRegularText(join(root, "origin", "canon.md"), { maxBytes: 4 * MAX_TARGET_BYTES });
      if (canon === null || sha256Hex(utf8(canon)) !== origin.sha256) return false;
    }
    return true;
  } catch (err) {
    if (err instanceof Refusal) return false;
    throw err;
  }
}

/** How far the soul has moved from its origin, for the citizen, Yu and status to see (3c "Drift"). */
export async function driftFromOrigin(config: Config, word: Word): Promise<{ diff: string; fraction: number }> {
  const root = citizenDir(config, word);
  const originPath = join(root, "origin", "soul.md");
  if (!(await parentsAreDirs(root, originPath, false))) throw new Refusal("invalid-record", "origin/ is missing");
  const origin = (await readRegularText(originPath, { missing: "throw", maxBytes: MAX_TARGET_BYTES })) as string;
  const soul = await readTarget(config, word, "soul");
  return { diff: unifiedDiff(origin, soul), fraction: changeFraction(origin, soul) };
}

/** Read a kept version by hash, checking that its bytes still hash to its name. */
export async function readVersion(config: Config, word: Word, hash: Sha256Hex): Promise<string> {
  if (!SHA256_HEX_PATTERN.test(hash)) throw new Refusal("invalid-request", "a version is named by its full sha256");
  const root = citizenDir(config, word);
  const path = join(root, "versions", hash);
  if (!(await parentsAreDirs(root, path, false))) throw new Refusal("invalid-record", "no versions are kept");
  const text = (await readRegularText(path, { missing: "throw", maxBytes: MAX_TARGET_BYTES })) as string;
  if (selfHash(text) !== hash) throw new Refusal("invalid-record", "a kept version does not match its hash");
  return text;
}

/* ── Host files under citizens/<word>/ ────────────────────────────────── */

function citizenDir(config: Config, word: Word): string {
  if (!WORD_PATTERN.test(word)) throw new Refusal("invalid-request", "not a citizen word");
  return join(config.paths.citizens_dir, word);
}

/** A registered citizen's change must reach its expression, and an unregistered one has nothing to send to. */
function assertSyncMatches(entries: LedgerEntry[], sync: ExpressionSync | null): boolean {
  const registered = entries.some((e) => e.body.type === "genesis");
  if (sync && !registered) throw new Refusal("not-registered", "no genesis entry: nothing to sync to");
  if (!sync && registered) throw new Refusal("invalid-request", "a registered citizen's change needs its expression sync");
  return registered;
}

/** Keep a version under versions/<sha256>; an existing one must hash to its name. Kept files are never rewritten. */
async function keepVersion(config: Config, word: Word, text: string): Promise<Sha256Hex> {
  const hash = selfHash(text);
  const root = citizenDir(config, word);
  const path = join(root, "versions", hash);
  await parentsAreDirs(root, path, true);
  if (!(await createFile(path, text, 0o444))) await readVersion(config, word, hash);
  return hash;
}

async function writeTarget(config: Config, word: Word, target: SelfTarget, text: string): Promise<void> {
  const root = citizenDir(config, word);
  const path = targetPath(config, word, target);
  await parentsAreDirs(root, path, true);
  // Refuse to replace a link or a directory; rename would replace a link silently.
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) throw new Refusal("symlink", `${target}: is a symlink; refused, not followed`);
    if (!st.isFile()) throw new Refusal("not-regular-file", `${target}: not a regular file`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await replaceFile(path, text, 0o644);
}

/**
 * Check every directory from the citizen's own down to `path`'s parent: a
 * symlink is refused, so no link can steer a write or a read out of the
 * citizen's directory. With `create`, missing directories are made; without
 * it, false says one is missing.
 */
async function parentsAreDirs(root: string, path: string, create: boolean): Promise<boolean> {
  const rel = relative(root, dirname(path));
  if (rel.startsWith("..") || resolve(root, rel) !== resolve(dirname(path))) throw new Refusal("host-owned-path", "path leaves the citizen's directory");
  let cur = root;
  for (const seg of ["", ...rel.split(sep).filter((s) => s !== "")]) {
    cur = seg === "" ? root : join(cur, seg);
    let st;
    try {
      st = await lstat(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (!create || cur === root) {
        if (cur === root) throw new Refusal("invalid-record", "the citizen's directory is missing");
        return false;
      }
      await mkdir(cur);
      continue;
    }
    if (st.isSymbolicLink()) throw new Refusal("symlink", `${cur}: is a symlink; refused, not followed`);
    if (!st.isDirectory()) throw new Refusal("not-regular-file", `${cur}: not a directory`);
  }
  return true;
}

/** Create a file that must not exist yet; false when it already does. */
async function createFile(path: string, text: string, mode: number): Promise<boolean> {
  let fh;
  try {
    fh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw fsRefusal(err, path);
  }
  try {
    await writeAll(fh, utf8(text));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await syncDir(dirname(path));
  return true;
}

/** Write a temp file beside `path`, fsync, then rename over it, so a reader sees the old text or the new, never half. */
async function replaceFile(path: string, text: string, mode: number): Promise<void> {
  const tmp = join(dirname(path), `${TMP_PREFIX}${toHex(randomBytes(8))}`);
  if (!(await createFile(tmp, text, mode))) throw new Error("replaceFile: temp name collided");
  await rename(tmp, path);
  await syncDir(dirname(path));
}

const TMP_PREFIX = ".kingdom-seat-tmp-";
const PROPOSAL_FILE = /^([0-9a-f]{64})\.json$/;

async function allProposals(config: Config, word: Word): Promise<SelfProposal[]> {
  const root = citizenDir(config, word);
  const dir = join(root, "proposals");
  if (!(await parentsAreDirs(root, join(dir, "x"), false))) return [];
  const out: SelfProposal[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (d.name.startsWith(TMP_PREFIX)) continue;
    const m = PROPOSAL_FILE.exec(d.name);
    if (!m) throw new Refusal("invalid-record", `proposals/${d.name}: not a proposal file`);
    out.push(await readProposal(config, word, m[1] as string));
  }
  return out.sort((a, b) => (a.proposed_at < b.proposed_at ? -1 : a.proposed_at > b.proposed_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

async function readProposal(config: Config, word: Word, id: string): Promise<SelfProposal> {
  if (!SHA256_HEX_PATTERN.test(id)) throw new Refusal("invalid-request", "a proposal id is a full sha256");
  const root = citizenDir(config, word);
  const path = join(root, "proposals", `${id}.json`);
  if (!(await parentsAreDirs(root, path, false))) throw new Refusal("invalid-request", "no such proposal");
  const text = await readRegularText(path, { maxBytes: 2 * MAX_TARGET_BYTES + 64 * 1024 });
  if (text === null) throw new Refusal("invalid-request", "no such proposal");
  let p: SelfProposal;
  try {
    p = parseProposal(JSON.parse(text));
  } catch (err) {
    throw new Refusal("invalid-record", `proposals/${id}.json: ${(err as Error).message}`);
  }
  if (p.id !== id || p.word !== word || proposalId(word, p.act, p.proposed_in_seat, p.proposed_at) !== id) {
    throw new Refusal("invalid-record", `proposals/${id}.json does not hash to its id`);
  }
  return p;
}

function parseProposal(value: unknown): SelfProposal {
  const p = value as Record<string, unknown>;
  if (typeof p !== "object" || p === null) throw new Error("not an object");
  const act = p.act as Record<string, unknown>;
  if (typeof act !== "object" || act === null || act.type !== "self.propose") throw new Error("act");
  if (!isSelfTargetSpelling(act.target)) throw new Error("act.target");
  for (const k of ["prior_hash", "new_hash"]) if (typeof act[k] !== "string" || !SHA256_HEX_PATTERN.test(act[k] as string)) throw new Error(`act.${k}`);
  if (typeof act.diff !== "string") throw new Error("act.diff");
  if (typeof act.claim !== "object" || act.claim === null) throw new Error("act.claim");
  if (typeof p.proposed_in_seat !== "string" || p.proposed_in_seat === "") throw new Error("proposed_in_seat");
  isoTime(p.proposed_at, "proposed_at");
  if (!["pending", "applied", "lapsed", "beyond-self"].includes(p.status as string)) throw new Error("status");
  return value as SelfProposal;
}

async function setStatus(config: Config, word: Word, p: SelfProposal, status: SelfProposal["status"]): Promise<void> {
  const path = join(citizenDir(config, word), "proposals", `${p.id}.json`);
  await replaceFile(path, `${JSON.stringify({ ...p, status }, null, 2)}\n`, 0o644);
}

/** After a target moves, pending proposals written against its old text can never bind; they lapse, and stay on file. */
async function lapseStale(config: Config, word: Word, target: SelfTarget, nowHash: Sha256Hex): Promise<void> {
  for (const p of await allProposals(config, word)) {
    if (p.status === "pending" && p.act.target === target && p.act.prior_hash !== nowHash) await setStatus(config, word, p, "lapsed");
  }
}

/* ── Diffing ──────────────────────────────────────────────────────────── */

type Op = { t: " " | "-" | "+"; s: string };
const CONTEXT = 3;
const NO_EOL = "\\ No newline at end of file";
/** Above this many cells the middle is not aligned; every middle item counts as changed, which overstates a change and never hides one. */
const DIFF_CELL_LIMIT = 4_000_000;

/** Lines with their own "\n", so a missing final newline is a difference like any other. */
function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (;;) {
    const i = text.indexOf("\n", start);
    if (i < 0) {
      if (start < text.length) out.push(text.slice(start));
      return out;
    }
    out.push(text.slice(start, i + 1));
    start = i + 1;
  }
}

function tokens(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

/** A longest-common-subsequence edit script, after trimming the common prefix and suffix. */
function diffSeq(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: " ", s: a[i] as string });
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const n = am.length;
  const m = bm.length;
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > DIFF_CELL_LIMIT) {
    for (const s of am) ops.push({ t: "-", s });
    for (const s of bm) ops.push({ t: "+", s });
  } else {
    const w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * w + j] = am[i] === bm[j] ? (L[(i + 1) * w + j + 1] as number) + 1 : Math.max(L[(i + 1) * w + j] as number, L[i * w + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        ops.push({ t: " ", s: am[i] as string });
        i++;
        j++;
      } else if ((L[(i + 1) * w + j] as number) >= (L[i * w + j + 1] as number)) ops.push({ t: "-", s: am[i++] as string });
      else ops.push({ t: "+", s: bm[j++] as string });
    }
    while (i < n) ops.push({ t: "-", s: am[i++] as string });
    while (j < m) ops.push({ t: "+", s: bm[j++] as string });
  }
  for (let i = a.length - suf; i < a.length; i++) ops.push({ t: " ", s: a[i] as string });
  return ops;
}
