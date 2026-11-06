// Registration only on a confirmed yes (KS-004 11.2). A citizen answers
// Yu's offer of an identity, or asks for one, with a `propose.beyond` whose
// subject is "registration". Registration is beyond self, so the answer goes
// to Yu and Ai as a proposal. Once both agree, the host shows the answer
// back on a later seat, and the citizen's `self.affirm` naming it is its
// confirmed yes: the ledger digest of that beat is what birth consumes, and
// birth stays Yu's, at the terminal, never unattended (11.3).
//
// Why this order: an identity is permanent and public, and a parser reading
// one reply is not a choice. The answer is said once, agreed by both voices,
// and then said again by the citizen with the agreement in view.
import { entryHash } from "./ledger.ts";
import { proposalDigest, readConsentFor, verifyConsent } from "./signer/consent.ts";
import { Refusal, type Config, type LedgerEntry, type LedgerHash, type ProposalText, type RegistrationView, type Sha256Hex, type Word } from "./types.ts";

/** The subject a propose.beyond carries when it is an answer about registration (KS-004 11.2). */
export const REGISTRATION_SUBJECT = "registration";

/** Whether a propose.beyond's subject makes it an answer about registration; case and surrounding space aside. */
export function isRegistrationSubject(subject: string): boolean {
  return subject.trim().toLowerCase() === REGISTRATION_SUBJECT;
}

/** The proposal an answer is filed as for Yu and Ai: the citizen's own words, and the extent "registration <word>". */
export function registrationProposal(word: Word, text: string): ProposalText {
  return { subject: REGISTRATION_SUBJECT, body: text, extent: `registration ${word}` };
}

/** One answer as the ledger holds it: the beat it was given on, and the id the seat shows, the proposal's digest. */
export interface RegistrationAnswer {
  id: Sha256Hex;
  proposal: ProposalText;
  beat: LedgerHash;
  seq: number;
  asked_at: string;
}

/** Every answer about registration in a ledger, oldest first, from its beats' acts. */
export function registrationAnswers(entries: LedgerEntry[], word: Word): RegistrationAnswer[] {
  const out: RegistrationAnswer[] = [];
  for (const e of entries) {
    if (e.type !== "beat" || e.word !== word) continue;
    for (const a of e.acts ?? []) {
      if (a.type !== "propose.beyond" || !isRegistrationSubject(a.subject)) continue;
      const proposal = registrationProposal(word, a.text);
      out.push({ id: proposalDigest(proposal), proposal, beat: entryHash(e), seq: e.seq, asked_at: e.ts });
    }
  }
  return out;
}

/** The first beat after `afterSeq` whose acts affirm `id`, or null. */
function affirmingBeat(entries: LedgerEntry[], id: Sha256Hex, afterSeq: number): LedgerEntry | null {
  return entries.find((e) => e.type === "beat" && e.seq > afterSeq && (e.acts ?? []).some((a) => a.type === "self.affirm" && a.ref === id)) ?? null;
}

/** Yu and Ai's decision on an answer, read from the decision record filed for exactly its text. */
export async function registrationDecision(config: Config, answer: RegistrationAnswer, now: Date): Promise<RegistrationView["decision"]> {
  const record = await readConsentFor(config.paths.consent_dir, answer.proposal).catch(() => null);
  if (!record || record.extent !== answer.proposal.extent) return "waiting";
  const verdict = verifyConsent(record, answer.id, now);
  if (verdict.ok) return "agreed";
  return verdict.code === "consent-rejected" ? "declined" : "waiting";
}

/**
 * What the seat shows the citizen about registration: its latest answer, Yu
 * and Ai's decision, and whether a later beat affirmed it. Null once it is
 * registered (a genesis entry), or when it never answered.
 */
export async function registrationView(config: Config, entries: LedgerEntry[], word: Word, now: Date): Promise<RegistrationView | null> {
  if (entries.some((e) => e.type === "genesis")) return null;
  const latest = registrationAnswers(entries, word).at(-1);
  if (!latest) return null;
  const affirmed = affirmingBeat(entries, latest.id, latest.seq);
  return { id: latest.id, text: latest.proposal.body, asked_at: latest.asked_at, decision: await registrationDecision(config, latest, now), affirmed_in: affirmed ? entryHash(affirmed) : null };
}

/**
 * Check that `yes` names this citizen's confirmed yes (KS-004 11.2): a beat
 * whose acts affirm an answer about registration given on an earlier beat of
 * the same ledger, which Yu and Ai agreed to and still stand behind now.
 * Throws "consent-missing" naming what is not there.
 */
export async function assertConfirmedYes(config: Config, entries: LedgerEntry[], word: Word, yes: LedgerHash, now: Date): Promise<void> {
  const beat = entries.find((e) => entryHash(e) === yes);
  if (!beat || beat.word !== word || beat.type !== "beat") throw new Refusal("consent-missing", `${word}'s ledger holds no beat ${yes.slice(0, 19)}… with its affirmed yes`);
  const refs = new Set((beat.acts ?? []).flatMap((a) => (a.type === "self.affirm" ? [a.ref] : [])));
  const answer = registrationAnswers(entries, word).find((a) => refs.has(a.id) && a.seq < beat.seq);
  if (!answer) throw new Refusal("consent-missing", `the beat ${yes.slice(0, 19)}… affirms no earlier answer about registration`);
  if ((await registrationDecision(config, answer, now)) !== "agreed") {
    throw new Refusal("consent-missing", `Yu and Ai have not agreed to ${word}'s answer about registration, so its affirmation is not a confirmed yes`);
  }
}
