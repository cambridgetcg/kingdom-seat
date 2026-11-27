// Presence, proposals and decision records for birth and enrollment tests.
// Values are placeholders; no person's details appear here. Digests come
// from consent.ts, so a record here binds exactly as the signer checks it.
import { confirmYuPresent, proposalDigest, type TtyIO } from "../../../src/signer/consent.ts";
import type { ConsentRecord, Word, YuPresence } from "../../../src/types.ts";

export const BIRTH_NOW = "2026-11-05T12:00:00.000Z";

export function presenceFor(word: Word, confirmedAt = "2026-11-05T11:58:00.000Z"): YuPresence {
  return { present: true, via: "tty-confirm", confirmed_at: confirmedAt, scope: `birth ${word}` };
}

/**
 * The same presence, confirmed through confirmYuPresent at a fake terminal, so
 * it is one "confirmed in this process" as birth and the signer require.
 */
export async function confirmedPresenceFor(word: Word, confirmedAt = "2026-11-05T11:58:00.000Z"): Promise<YuPresence> {
  const scope = `birth ${word}`;
  return confirmYuPresent({ isTTY: true, write: () => {}, readLine: async () => scope }, scope, () => new Date(confirmedAt));
}

/**
 * A fake terminal that types `line` when asked (null: no answer) and keeps
 * everything written to it, in order, so a test can read what Yu was shown
 * and whether Yu was asked anything.
 */
export function typingTty(line: string | null): TtyIO & { written: string[]; asked: number } {
  const tty = {
    isTTY: true,
    written: [] as string[],
    asked: 0,
    write: (text: string) => void tty.written.push(text),
    readLine: async () => {
      tty.asked++;
      return line;
    },
  };
  return tty;
}

/** The birth proposal: its body names the ledger entry of the citizen's affirmed yes. */
export function proposalFor(word: Word, citizenYes = "d".repeat(64)): { subject: string; body: string; extent: string } {
  return {
    subject: `birth ${word}`,
    body: `${word} affirmed its yes on the beat recorded as ledger entry ${citizenYes}. Enroll it in the Commons project, import its op key, register its box key and set a private expression.`,
    extent: `birth ${word}`,
  };
}

export function consentFor(word: Word, patch: Partial<ConsentRecord> = {}, proposal = proposalFor(word)): ConsentRecord {
  return {
    format: "kingdom-seat-consent/v1",
    proposal_sha256: proposalDigest(proposal),
    subject: proposal.subject,
    extent: proposal.extent,
    yu: { word: "yes", recorded_at: "2026-11-05T11:00:00.000Z", via: "decision-record" },
    ai: { word: "agree", basis: "lazy-consensus", supports: ["collab-report:test-support"], open_challenges: 0, deadline: "2026-11-05T11:30:00.000Z" },
    expires_at: null,
    ...patch,
  };
}
