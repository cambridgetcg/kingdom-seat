// Letters between citizens (KS-004 5.3 item 5, 5.7 "Letters and covenants",
// 8.1). A letter is within self, but whether it is admitted is the
// recipient's to decide, by its own covenants, never the sender's: a
// citizen's covenants admit only Yu until it sets its own. Before
// registration a citizen has no inbox, so its letter is held for Yu alone,
// who may deliver it as a file letter (limitation 10). Between two registered
// citizens a letter goes through agenttool's inbox, within the credit budget.
//
// agenttool does not gate sends within one project
// (services/covenants/check.ts:127), and every citizen is in the Commons
// project, so the covenants applied here, when a letter is sent and again
// when it is read, are the only gate a letter meets.
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { edVerifyStrict, fromB64, sha256Hex, utf8 } from "./crypto.ts";
import { inboxDigest } from "./agenttool/wire.ts";
import { AgenttoolError, NO_RESPONSE, listInbox, sendInboxLetter, type ClientDeps } from "./agenttool/client.ts";
import { SignerNotSent } from "./signer/signer.ts";
import { listSeated, readCitizenRecord, readOwnCovenants } from "./state.ts";
import { Refusal, WORD_PATTERN, type Citizen, type CitizenRecord, type Config, type Letter, type RefusalCode, type Word } from "./types.ts";

/** The host-side recipients: Yu, and the gardener desk, Yu's own operator. A letter to either is held for Yu. */
export const HOST_RECIPIENTS = Object.freeze(["yu", "gardener"]);

/** The ids a recipient's covenants may name a citizen by: `citizen:<word>`, and its DID once it is registered. */
export function senderIds(c: Pick<CitizenRecord, "word" | "identity">): string[] {
  return c.identity ? [`citizen:${c.word}`, c.identity.did] : [`citizen:${c.word}`];
}

/**
 * Whom this citizen may write to (KS-004 5.7): Yu and the gardener desk, and
 * each other citizen seated on this host whose own `letters_from` names it.
 * A citizen whose record or covenants do not read admits no one, so a
 * broken sibling never widens anything. A citizen elsewhere cannot be read,
 * so it is not named: its covenants are not this host's to know.
 */
export async function letterRecipients(config: Config, sender: Pick<CitizenRecord, "word" | "identity">): Promise<string[]> {
  const ids = new Set(senderIds(sender));
  const out = [...HOST_RECIPIENTS];
  for (const word of await listSeated(config).catch(() => [] as Word[])) {
    if (word === sender.word) continue;
    try {
      const covenants = await readOwnCovenants(config, word);
      if (covenants.letters_from.some((id) => ids.has(id))) out.push(`citizen:${word}`);
    } catch {
      // A sibling whose covenants do not read admits no one.
    }
  }
  return out;
}

/** The citizen a `citizen:<word>` recipient names, by its record; null for Yu, the gardener desk or anything else. */
export async function recipientRecord(config: Config, to: string): Promise<CitizenRecord | null> {
  const m = /^citizen:(.+)$/.exec(to);
  if (!m || !WORD_PATTERN.test(m[1]!)) return null;
  try {
    return await readCitizenRecord(config, m[1]!);
  } catch {
    return null;
  }
}

/** Why a letter was held for Yu rather than sent: host codes, for the outbox item and the note. */
export type HeldBecause = "unregistered" | "to-yu" | "no-inbox" | "credits" | "refused" | "uncertain";

/**
 * Keep a letter for Yu alone (KS-004 5.7, limitation 10): an outbox item
 * that names no proposal and no digest, because Yu reads it and may deliver
 * it, and no decision record applies to it. Never overwritten.
 */
export async function holdLetterForYu(
  config: Config,
  word: Word,
  seatId: string,
  n: number,
  letter: { to: string; text: string; created_at: string; ledger_entry: string; held_because: HeldBecause },
): Promise<void> {
  if (!WORD_PATTERN.test(word)) throw new Refusal("invalid-request", "not a citizen word");
  const dir = join(config.paths.citizens_dir, word, "outbox");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const record = { format: "kingdom-seat-outbox/v1", word, seat_id: seatId, kind: "letter", for: "yu", ...letter };
  const fh = await open(join(dir, `${seatId}-${n}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** What sending one letter came to. `credits` counts a request that left the host, answered or not, as the ceiling must. */
export type LetterSent = { message_id: string; credits: number } | { message_id: null; held_because: HeldBecause; code: RefusalCode | "error" | null; credits: number };

/** A registered citizen's letters on agenttool; injected so the seat holds no client, and tests use a fake. */
export interface LetterPost {
  /** Send one letter to a registered citizen through the inbox. Never throws: one that is not sent says why, and is held for Yu. */
  send(word: Word, to: CitizenRecord, text: string): Promise<LetterSent>;
  /**
   * The oldest unseen letter in the citizen's own agenttool inbox from a
   * sender its covenants admit, opened, or none. Only a sender seated on this
   * host is admitted, because only its op key can be checked here against
   * the envelope's signature: opening a letter proves who it was sealed to,
   * never who wrote it.
   */
  unread(citizen: Citizen, seen: (id: string) => Promise<boolean>): Promise<Letter[]>;
}

/** The id a letter from the inbox is shown and receipted under, beside the file letters in letters/. */
export function inboxLetterId(messageId: string): string {
  return `inbox-${messageId}`;
}

/** The production LetterPost, through the client and so through the signer. */
export function agenttoolLetters(deps: { config: Config; client: ClientDeps }): LetterPost {
  const { config, client } = deps;
  return {
    async send(word, to, text) {
      if (!to.identity || to.identity.box_public_key_b64 === null) return { message_id: null, held_because: "no-inbox", code: null, credits: 0 };
      try {
        const sent = await sendInboxLetter(client, word, { did: to.identity.did, box_public_key_b64: to.identity.box_public_key_b64 }, text);
        return { message_id: sent.message_id, credits: 2 };
      } catch (e) {
        // A wall or a definite not-sent spent nothing; anything that left the host may have been charged.
        if (e instanceof Refusal) return { message_id: null, held_because: e.code === "ceiling-credits" ? "credits" : "refused", code: e.code, credits: 0 };
        if (e instanceof SignerNotSent) return { message_id: null, held_because: "refused", code: null, credits: 0 };
        const uncertain = e instanceof AgenttoolError && (e.status === NO_RESPONSE || e.status >= 500);
        return { message_id: null, held_because: uncertain ? "uncertain" : "refused", code: null, credits: 2 };
      }
    },

    async unread(citizen, seen) {
      if (!citizen.identity) return [];
      const allowed = new Set(citizen.covenants.letters_from);
      // The senders this host can check: citizens seated here, by DID.
      const byDid = new Map<string, CitizenRecord>();
      for (const w of await listSeated(config)) {
        if (w === citizen.word) continue;
        const r = await readCitizenRecord(config, w).catch(() => null);
        if (r?.identity) byDid.set(r.identity.did, r);
      }
      const candidates = (await listInbox(client, citizen.word))
        .filter((m) => {
          const sender = byDid.get(m.sender_did);
          return sender !== undefined && senderIds(sender).some((id) => allowed.has(id));
        })
        .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
      for (const m of candidates) {
        if (await seen(inboxLetterId(m.id))) continue;
        const sender = byDid.get(m.sender_did)!;
        const identity = sender.identity!;
        // The envelope must be the sender's own: its op key, over exactly what it sealed to this citizen.
        let signed = false;
        try {
          signed =
            m.sender_signing_key_id === identity.op_kid &&
            edVerifyStrict(fromB64(m.signature, 64), inboxDigest(citizen.identity.did, fromB64(m.ciphertext), fromB64(m.nonce, 12), fromB64(m.ephemeral_pubkey, 32)), fromB64(identity.op_public_key_b64, 32));
        } catch {
          signed = false;
        }
        if (!signed) continue;
        let text: string;
        try {
          text = await client.signer.openLetter(citizen.word, m);
        } catch {
          continue;
        }
        if (text.trim() === "" || [...text].length > config.ceilings.letter_max_chars) continue;
        // Shown under the id the covenants admitted it by, as a file letter's From: line is.
        const from = senderIds(sender).find((id) => allowed.has(id))!;
        return [{ id: inboxLetterId(m.id), from, received_at: m.created_at, text, sha256: sha256Hex(utf8(text)) }];
      }
      return [];
    },
  };
}
