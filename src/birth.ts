// citizen-birth (3b). Never unattended: it requires a consent record for the
// citizen's own confirmed yes plus Yu present at the terminal. A fresh BIP39
// mnemonic and op seed go straight into Keychain through the Keychain
// interface, with no handoff file. Then enrollment, op-key import, box-key
// registration, a private expression and the genesis ledger entry. Only the
// DID and key fingerprints are ever printed.
import type { CitizenIdentity, Clock, Config, ConsentRecord, Keychain, LedgerEntry, Origin, Word, YuPresence } from "./types.ts";
import type { Signer } from "./signer/signer.ts";
import type { ClientDeps } from "./agenttool/client.ts";
import type { EnrollDeps } from "./agenttool/enrollment.ts";

export interface BirthInput {
  word: Word;
  origin: Origin;
  consent: ConsentRecord;
  presence: YuPresence;
  birth_soul_sha256: string;
  old_repo: { url: string; head: string } | null;
  june_did: string | null;
}

export interface BirthDeps {
  config: Config;
  clock: Clock;
  keychain: Keychain;
  signer: Signer;
  client: ClientDeps;
  enroll: EnrollDeps;
  /** Where the report is written; it must only ever receive DIDs and fingerprints. */
  out: (line: string) => void;
}

/** What birth may print. No field here may hold a seed, mnemonic, bearer or grant. */
export interface BirthReport {
  word: Word;
  did: string;
  root_fingerprint: string;
  op_fingerprint: string;
  box_fingerprint: string;
  genesis_hash: string;
}

/** Refuse unless Yu is present for "birth <word>" and the consent record binds this citizen's yes. */
export function assertAttended(input: BirthInput, now: Date): void {
  throw new Error("unimplemented");
}

/** "SHA256:<unpadded base64 of sha256(public key)>", in the style ssh prints. */
export function keyFingerprint(publicKey: Uint8Array): string {
  throw new Error("unimplemented");
}

/** Draw a 256-bit mnemonic and a random op seed straight into Keychain; return only public keys. Refuses if items exist. */
export async function mintKeys(keychain: Keychain, word: Word): Promise<{ root_public: Uint8Array; op_public: Uint8Array; box_public: Uint8Array }> {
  throw new Error("unimplemented");
}

/** The whole birth, in order; stops at the first failure and reports how far it got, never retrying enrollment. */
export async function citizenBirth(deps: BirthDeps, input: BirthInput): Promise<{ report: BirthReport; identity: CitizenIdentity; genesis: LedgerEntry }> {
  throw new Error("unimplemented");
}

/** The printed lines: word, DID and three fingerprints. */
export function renderBirthReport(report: BirthReport): string[] {
  throw new Error("unimplemented");
}
