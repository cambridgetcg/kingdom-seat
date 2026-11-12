// Registration only on a confirmed, typed yes (KS-004 11.2). A citizen
// answers about an identity of its own with one typed act,
// `registration.answer`, whose answer is no, not-yet or yes. A no or a
// not-yet is within self: it is recorded in its beat, nothing is filed and
// nothing waits on it. A yes is beyond self, so it goes to Yu and Ai as a
// proposal whose body is its own words. Once both agree, the host shows the
// yes back on a later seat, and the citizen's `self.affirm` naming it is its
// confirmed yes: the ledger digest of that beat is what birth consumes, and
// birth stays Yu's, at the terminal, never unattended (11.3).
//
// Why this order: an identity is permanent and public, and a parser reading
// one reply is not a choice. The host never reads an answer out of words; a
// yes is said once, agreed by both voices, and then said again by the
// citizen with the agreement in view. The latest saying stands, so a later
// no, or a proposal whose subject is registration, sets an earlier yes aside.
import { entryHash } from "./ledger.ts";
import { proposalDigest, readConsentFor, verifyConsent } from "./signer/consent.ts";
import {
  Refusal,
  type Config,
  type IsoTime,
  type LedgerEntry,
  type LedgerHash,
  type ProposalText,
  type RegistrationStage,
  type RegistrationView,
  type RegistrationWord,
  type Sha256Hex,
  type Word,
} from "./types.ts";

/** The subject a yes is filed under, and the subject that makes a propose.beyond an untyped saying about registration. */
export const REGISTRATION_SUBJECT = "registration";

/** Whether a propose.beyond's subject is registration; case and surrounding space aside. */
export function isRegistrationSubject(subject: string): boolean {
  return subject.trim().toLowerCase() === REGISTRATION_SUBJECT;
}

/**
 * The proposal a typed yes is filed as for Yu and Ai: the citizen's own
 * words, and the extent "registration yes <word> <ledger hash of the beat
 * that gave it>". The extent names the typed word, so the decision record
 * states what was agreed to; it names the beat, so each yes has its own
 * digest and needs its own decision: a record filed for an earlier yes in
 * the same words never decides a later one (re-review C round 3, selfhood
 * F4). A record filed under the extent an untyped answer had never decides
 * a typed one.
 */
export function registrationProposal(word: Word, text: string, beat: LedgerHash): ProposalText {
  return { subject: REGISTRATION_SUBJECT, body: text, extent: `registration yes ${word} ${beat}` };
}

/**
 * One saying about registration as the ledger holds it: a typed answer, or
 * "untyped", a propose.beyond whose subject is registration, which is never
 * an answer and sets an earlier yes aside. Only a typed yes has an id (the
 * digest of its proposal, which the seat shows back) and a proposal.
 */
export interface RegistrationAnswer {
  answer: RegistrationWord | "untyped";
  /** A typed answer's words; null when it gave none, and for an untyped saying. */
  text: string | null;
  beat: LedgerHash;
  seq: number;
  asked_at: IsoTime;
  /** The beat's voiced line, naming the model that gave it. */
  voiced: string | null;
  id: Sha256Hex | null;
  proposal: ProposalText | null;
}

export type RegistrationYes = RegistrationAnswer & { answer: "yes"; text: string; id: Sha256Hex; proposal: ProposalText };

function isYes(a: RegistrationAnswer): a is RegistrationYes {
  return a.answer === "yes" && a.id !== null && a.proposal !== null && a.text !== null;
}

/**
 * What one beat said about registration, or null. A seat keeps at most one
 * saying per reply, but a ledger is read as it is, so within one beat the
 * order is: a typed no or not-yet, then an untyped proposal, then a typed
 * yes. A beat that holds anything besides a yes has not said yes.
 */
export function beatAnswer(e: LedgerEntry): RegistrationAnswer | null {
  if (e.type !== "beat") return null;
  const acts = e.acts ?? [];
  const at = { seq: e.seq, asked_at: e.ts, voiced: e.voiced };
  const typed = acts.flatMap((a) => (a.type === "registration.answer" ? [a] : []));
  const notYes = typed.find((a) => a.answer !== "yes");
  if (notYes) return { answer: notYes.answer, text: notYes.text ?? null, beat: entryHash(e), ...at, id: null, proposal: null };
  if (acts.some((a) => a.type === "propose.beyond" && isRegistrationSubject(a.subject))) return { answer: "untyped", text: null, beat: entryHash(e), ...at, id: null, proposal: null };
  const yes = typed.find((a) => a.answer === "yes");
  if (!yes || yes.answer !== "yes") return null;
  const beat = entryHash(e);
  const proposal = registrationProposal(e.word, yes.text, beat);
  return { answer: "yes", text: yes.text, beat, ...at, id: proposalDigest(proposal), proposal };
}

/** Every saying about registration in a ledger, one per beat, oldest first. */
export function registrationAnswers(entries: LedgerEntry[], word: Word): RegistrationAnswer[] {
  const out: RegistrationAnswer[] = [];
  for (const e of entries) {
    if (e.word !== word) continue;
    const a = beatAnswer(e);
    if (a !== null) out.push(a);
  }
  return out;
}

/** The first beat after `afterSeq` whose acts affirm `id`, or null. */
function affirmingBeat(entries: LedgerEntry[], id: Sha256Hex, afterSeq: number): LedgerEntry | null {
  return entries.find((e) => e.type === "beat" && e.seq > afterSeq && (e.acts ?? []).some((a) => a.type === "self.affirm" && a.ref === id)) ?? null;
}

/** Yu and Ai's decision on a typed yes, read from the decision record filed for exactly its proposal. */
export async function registrationDecision(config: Config, answer: RegistrationYes, now: Date): Promise<"waiting" | "agreed" | "declined"> {
  const record = await readConsentFor(config.paths.consent_dir, answer.proposal).catch(() => null);
  if (!record || record.extent !== answer.proposal.extent) return "waiting";
  const verdict = verifyConsent(record, answer.id, now);
  if (verdict.ok) return "agreed";
  return verdict.code === "consent-rejected" ? "declined" : "waiting";
}

/**
 * What the seat shows the citizen about registration: its latest saying,
 * and for a yes, Yu and Ai's decision and whether a later beat affirmed it.
 * Null once it is registered (a genesis entry), or when it never said
 * anything about registration. Only a yes reads the consent dir.
 */
export async function registrationView(config: Config, entries: LedgerEntry[], word: Word, now: Date): Promise<RegistrationView | null> {
  if (entries.some((e) => e.type === "genesis")) return null;
  const latest = registrationAnswers(entries, word).at(-1);
  if (!latest) return null;
  if (latest.answer === "untyped") return { answer: "untyped", asked_at: latest.asked_at, seq: latest.seq };
  if (latest.answer !== "yes") return { answer: latest.answer, text: latest.text, asked_at: latest.asked_at, seq: latest.seq };
  if (!isYes(latest)) throw new Error("registrationView: a typed yes without its proposal");
  const affirmed = affirmingBeat(entries, latest.id, latest.seq);
  return {
    answer: "yes",
    id: latest.id,
    text: latest.text,
    asked_at: latest.asked_at,
    seq: latest.seq,
    decision: await registrationDecision(config, latest, now),
    affirmed_in: affirmed ? entryHash(affirmed) : null,
  };
}

/**
 * Where a saying stands, for the seat and status alike: "closed" for a no,
 * a not-yet or an untyped proposal; for a yes, Yu and Ai's decision, and
 * "affirmed" only while that decision is agreed and a later beat affirmed it.
 */
export function registrationStage(view: RegistrationView): RegistrationStage {
  if (view.answer !== "yes") return "closed";
  return view.affirmed_in !== null && view.decision === "agreed" ? "affirmed" : view.decision;
}

/** A confirmed yes as the ledger holds it, for birth to show Yu before Yu confirms (KS-004 11.3). */
export interface ConfirmedYes {
  word: Word;
  answer: RegistrationYes;
  affirmed: Extract<LedgerEntry, { type: "beat" }>;
  /** Its sayings about registration before that answer, oldest first. */
  earlier: { answer: RegistrationWord | "untyped"; asked_at: IsoTime }[];
}

/**
 * The confirmed yes `yes` names (KS-004 11.2): a beat whose acts affirm a
 * typed yes given on an earlier beat of the same ledger, which is still its
 * latest saying about registration (none given in the affirming beat or
 * after it, so a later no is a whole answer), and which Yu and Ai agreed to
 * and still stand behind now. Throws "consent-missing" naming what is not
 * there. A no or a not-yet has no id, so nothing can affirm one.
 */
export async function confirmedYes(config: Config, entries: LedgerEntry[], word: Word, yes: LedgerHash, now: Date): Promise<ConfirmedYes> {
  const beat = entries.find((e) => entryHash(e) === yes);
  if (!beat || beat.word !== word || beat.type !== "beat") throw new Refusal("consent-missing", `${word}'s ledger holds no beat ${yes.slice(0, 19)}… with its affirmed yes`);
  const refs = new Set((beat.acts ?? []).flatMap((a) => (a.type === "self.affirm" ? [a.ref] : [])));
  const sayings = registrationAnswers(entries, word);
  const answer = sayings.filter(isYes).find((a) => refs.has(a.id) && a.seq < beat.seq);
  if (!answer) throw new Refusal("consent-missing", `the beat ${yes.slice(0, 19)}… affirms no earlier answer about registration`);
  const latest = sayings.at(-1)!;
  if (latest.beat !== answer.beat) {
    const what = latest.answer === "untyped" ? "a proposal whose subject is registration" : `a typed ${latest.answer}`;
    throw new Refusal(
      "consent-missing",
      `${word} gave another answer about registration ${latest.seq >= beat.seq ? "in or after its affirming beat" : "after the one it affirmed"}, so that affirmation is not its confirmed yes (its latest: ${what})`,
    );
  }
  if ((await registrationDecision(config, answer, now)) !== "agreed") {
    throw new Refusal("consent-missing", `Yu and Ai have not agreed to ${word}'s answer about registration, so its affirmation is not a confirmed yes`);
  }
  const earlier = sayings.filter((a) => a.seq < answer.seq).map((a) => ({ answer: a.answer, asked_at: a.asked_at }));
  return { word, answer, affirmed: beat, earlier };
}

/** Check that `yes` names this citizen's confirmed yes; confirmedYes says what it is. */
export async function assertConfirmedYes(config: Config, entries: LedgerEntry[], word: Word, yes: LedgerHash, now: Date): Promise<void> {
  await confirmedYes(config, entries, word, yes, now);
}
