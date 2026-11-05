// The citizen's record: `ledger/<word>.jsonl`, one entry per line,
// hash-chained and signed, on the lease host (3.2 "Ledger"). Append-only:
// nothing is rewritten or deleted, because a record is history even when it
// is no longer present truth (3.1 principle 5). Readers trust only entries
// that verify.
import type { Attestation, Config, Envelope, LedgerBody, LedgerEntry, LedgerSignature, Sha256Hex, Spend, Word } from "./types.ts";

/** Domain tag for entry hashes, so an entry signature can never pass as a thought or authority signature. */
export const LEDGER_DOMAIN = "kingdom-seat-ledger/v1";

/** An entry before it is hashed and signed. */
export type LedgerDraft = Omit<LedgerEntry, "hash" | "signature">;

/** Signs an entry hash; the Signer's signEntry, narrowed so the ledger never sees a key. */
export type EntrySigner = (word: Word, entryHash: Uint8Array, attestation: Attestation) => Promise<LedgerSignature>;

/**
 * The public keys a chain may be signed with: the host attest key for
 * host-attested entries, and for citizen-signed ones the op keys the chain
 * itself pins (genesis, then op-key.rotated). A signature by any other key,
 * including the root, fails verification.
 */
export interface TrustedKeys {
  host_attest_b64: string[];
}

/** Op keys pinned by the chain up to and including `seq`, by kid; used to verify the next citizen-signed entry. */
export function pinnedOpKeys(entries: LedgerEntry[], seq: number): Map<string, string> {
  throw new Error("unimplemented");
}

export interface ChainVerdict {
  ok: boolean;
  entries: number;
  head: Sha256Hex | null;
  host_attested: number;
  /** First problem found, by seq; the chain is not trusted past it. */
  problem: { seq: number; reason: string } | null;
}

/** `<ledger_dir>/<word>.jsonl`; refuses a word that does not match WORD_PATTERN. */
export function ledgerPath(config: Config, word: Word): string {
  throw new Error("unimplemented");
}

/** sha256(LEDGER_DOMAIN ‖ 0x00 ‖ canonicalJson(draft)), hex. */
export function entryHash(draft: LedgerDraft): Sha256Hex {
  throw new Error("unimplemented");
}

/** Build the next draft on top of `prev` (FIRST_PREV_HASH when null): seq, prev_hash and ts filled in. */
export function nextDraft(word: Word, prev: LedgerEntry | null, body: LedgerBody, spend: Spend, attestation: Attestation, now: Date): LedgerDraft {
  throw new Error("unimplemented");
}

/** Read every entry; the file must be a regular file; any unparsable line throws, because a gap in a record fails closed. */
export async function readLedger(path: string): Promise<LedgerEntry[]> {
  throw new Error("unimplemented");
}

/** The last k entries, oldest first, for the seat's context. */
export async function lastEntries(path: string, k: number): Promise<LedgerEntry[]> {
  throw new Error("unimplemented");
}

/** Check seq, prev_hash links, hashes and strict signatures; no host-attested entry may follow genesis. */
export function verifyChain(entries: LedgerEntry[], trusted: TrustedKeys): ChainVerdict {
  throw new Error("unimplemented");
}

/** Hash, sign and append one entry with O_APPEND and fsync; refuses if the file's head moved since `prev` was read. */
export async function appendEntry(path: string, draft: LedgerDraft, sign: EntrySigner): Promise<LedgerEntry> {
  throw new Error("unimplemented");
}

/** The envelope's own words for readers: "<word>, voiced through <model> in seat <seat_id>". */
export function voicedThrough(envelope: Pick<Envelope, "citizen" | "model" | "seat_ref">): string {
  throw new Error("unimplemented");
}
