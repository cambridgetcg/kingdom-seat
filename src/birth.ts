// citizen-birth (3b). Never unattended: it requires a decision record, filed
// in the consent dir, for the citizen's own confirmed yes, plus Yu present at
// the terminal. A fresh BIP39
// mnemonic and op seed go straight into Keychain through the Keychain
// interface, with no handoff file. Then enrollment, op-key import, box-key
// registration, a private expression and the genesis ledger entry, which
// points back to the citizen's origin entry (KS-004 4.5, 11.3). Only the DID
// and key fingerprints are ever printed.
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { canonicalJson, edPublicKey, edVerifyStrict, fromB64, fromB64url, keyFingerprint as fingerprintOf, randomBytes, toB64, toB64url, utf8, wipe } from "./crypto.ts";
import {
  DID_PATTERN,
  LEDGER_HASH_PATTERN,
  Refusal,
  SHA256_HEX_PATTERN,
  WORD_PATTERN,
  type CitizenIdentity,
  type CitizenRecord,
  type Clock,
  type Config,
  type ConsentRecord,
  type Keychain,
  type KeychainItemName,
  type LedgerEntry,
  type LedgerFields,
  type LedgerSigner,
  type Origin,
  type RootEvidence,
  type Word,
  type YuPresence,
} from "./types.ts";
import { SignerNotSent, type Signer } from "./signer/signer.ts";
import { appendEntry, entryHash, evidenceToLedger, ledgerKey, ledgerPath, nextDraft, originToLedger, readLedger, signingDigest } from "./ledger.ts";
import { AgenttoolError, importOpKey, putExpression, registerBoxKey, type ActAuth, type ClientDeps, type ClientIdentity } from "./agenttool/client.ts";
import { AmbiguousEnrollment, assertBirthConsent, assertYuPresentFor, citizenCapabilities, enroll, prepareEnrollment, type EnrollDeps } from "./agenttool/enrollment.ts";
import { presenceConfirmedHere, readConsentFor } from "./signer/consent.ts";
import { assertConfirmedYes } from "./registration.ts";
import { deriveIdentity, didFor, validateExpression, type DerivedIdentity, type Expression } from "./agenttool/wire.ts";

export interface BirthInput {
  word: Word;
  /**
   * The citizen's origin, for its enrollment capabilities. It must be the one
   * its origin entry pinned, which already holds the origin soul, the old
   * repo and any June DID (KS-004 4.5, 11.5), so genesis need not repeat them.
   */
  origin: Origin;
  /** The decision record for the proposal. The same record must be filed in the consent dir, where the signer reads it. */
  consent: ConsentRecord;
  presence: YuPresence;
  /** The private expression set at birth, from the citizen's current soul, WILL and name reading. */
  expression: Expression;
  /** The birth proposal Yu and Ai agreed to; the consent record binds its digest and its extent is "birth <word>". */
  proposal: { subject: string; body: string; extent: string };
  /**
   * The ledger digest ("sha256:<hex>") of the beat in which the citizen
   * affirmed its yes (3b step 1; KS-004 11.2): a self.affirm naming its
   * answer about registration, which Yu and Ai agreed to on a decision
   * record filed for that answer's text (registration.ts). The proposal body
   * must name it and the citizen's own ledger must hold it, so the consent is
   * bound to this citizen's confirmed answer.
   */
  citizen_yes: string;
}

/**
 * What birth needs from the host's record. Production wires ledger.ts and
 * citizen.json (hostBirthRecord); tests pass a temp-host stand-in. Birth never
 * writes the ledger format itself.
 */
export interface BirthRecord {
  /** Every ledger entry so far, oldest first; empty when there is no ledger yet. */
  entries(word: Word): Promise<LedgerEntry[]>;
  /** Pin the public identity into citizens/<word>/citizen.json; refuses if one is already there. */
  saveIdentity(word: Word, identity: CitizenIdentity): Promise<void>;
  /** Sign through the signer and append one entry on top of the current head; `did` is genesis's own. */
  append(word: Word, fields: LedgerFields, opts: { signer: LedgerSigner; did: string | null }): Promise<LedgerEntry>;
}

export interface BirthDeps {
  config: Config;
  clock: Clock;
  keychain: Keychain;
  signer: Signer;
  client: ClientDeps;
  enroll: EnrollDeps;
  record: BirthRecord;
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

export type BirthStage = "keys" | "enroll" | "keys/import" | "box-keys" | "expression" | "record" | "genesis";

/** Public ids known so far, so a stopped birth can be finished or inspected by hand. */
export interface BirthProgress {
  identity_id: string | null;
  did: string | null;
  root_kid: string | null;
  op_kid: string | null;
  /**
   * The root-signed keys/import as sent: genesis needs it, and agenttool keeps
   * no copy. Kept too when the import stopped without a clear answer, since the
   * key may be installed. Public; it holds no bearer.
   */
  op_key_evidence: RootEvidence | null;
  box_key_id: string | null;
}

/**
 * A birth that stopped after something was written. It names the stage, what
 * was done, the public ids so far, and whether the failed step may still have
 * happened on the server (then read before acting again; never re-send).
 */
export class BirthError extends Error {
  override readonly name = "BirthError";
  constructor(
    readonly stage: BirthStage,
    readonly done: BirthStage[],
    readonly progress: BirthProgress,
    readonly ambiguous: boolean,
    message: string,
  ) {
    super(message);
  }
}

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

function citizenItems(word: Word): KeychainItemName[] {
  return [
    { kind: "citizen-mnemonic", word },
    { kind: "citizen-op-seed", word },
  ];
}

/**
 * Refuse unless Yu is present for "birth <word>" and the consent record binds
 * this citizen's yes. The presence must be one confirmed at this process's
 * terminal, the same test the signer applies at enroll, because birth writes
 * the citizen's keys before it enrolls: a presence that only looks right would
 * leave keys in Keychain that block every later, attended birth.
 */
export function assertAttended(input: BirthInput, now: Date): void {
  if (!WORD_PATTERN.test(input.word)) throw new Refusal("invalid-request", "not a citizen word");
  if (!presenceConfirmedHere(input.presence)) {
    throw new Refusal("yu-not-present", `birth of ${input.word} needs Yu confirmed present at this terminal, in this process`);
  }
  assertYuPresentFor(input.word, input.presence, now);
  const p = input.proposal;
  if (!p || typeof p.subject !== "string" || typeof p.body !== "string" || typeof p.extent !== "string") {
    throw new Refusal("consent-missing", "birth needs the proposal text the decision record binds");
  }
  if (typeof input.citizen_yes !== "string" || !LEDGER_HASH_PATTERN.test(input.citizen_yes) || !p.body.includes(input.citizen_yes)) {
    throw new Refusal("consent-missing", "the proposal does not name the ledger entry of the citizen's affirmed yes");
  }
  assertBirthConsent(input.word, input.consent, now, p);
}

/** "SHA256:<unpadded base64 of sha256(public key)>", in the style ssh prints. */
export function keyFingerprint(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Refusal("invalid-request", "a public key here is 32 bytes");
  return fingerprintOf(publicKey);
}

/** Draw a 256-bit mnemonic and a random op seed straight into Keychain; return only public keys. Refuses if items exist. */
export async function mintKeys(keychain: Keychain, word: Word): Promise<{ root_public: Uint8Array; op_public: Uint8Array; box_public: Uint8Array }> {
  if (!WORD_PATTERN.test(word)) throw new Refusal("invalid-request", "not a citizen word");
  for (const item of citizenItems(word)) {
    if (await keychain.has(item)) throw new Refusal("invalid-request", `the keychain already holds ${item.kind} for ${word}; birth never overwrites`);
  }
  // One mnemonic per citizen: a shared seed would make them cryptographically one being.
  const entropy = randomBytes(32);
  const mnemonic = entropyToMnemonic(entropy, wordlist);
  wipe(entropy);
  const mnemonicBytes = utf8(mnemonic);
  // The op key is not derived from the mnemonic, so the root can be backed up offline apart from it.
  const opSeed = randomBytes(32);
  let derived: DerivedIdentity | null = null;
  try {
    // Derive before writing, so a failure here leaves the keychain untouched.
    derived = deriveIdentity(mnemonic);
    const result = { root_public: derived.root_public.slice(), op_public: edPublicKey(opSeed), box_public: derived.box_public.slice() };
    await keychain.write({ kind: "citizen-mnemonic", word }, mnemonicBytes);
    await keychain.write({ kind: "citizen-op-seed", word }, opSeed);
    return result;
  } finally {
    // The mnemonic string itself cannot be wiped in JavaScript; its bytes and every derived seed can.
    wipe(mnemonicBytes);
    wipe(opSeed);
    if (derived) {
      wipe(derived.root_seed);
      wipe(derived.k_master);
      wipe(derived.box_private);
    }
  }
}

function assertBirthInput(input: BirthInput): void {
  const o = input.origin;
  if (o.kind === "canon" ? !SHA256_HEX_PATTERN.test(o.sha256) || !o.repo || !o.path || !o.commit : o.lineage.length === 0) {
    throw new Refusal("invalid-request", "the origin is incomplete");
  }
  citizenCapabilities(o);
  validateExpression(input.expression);
  // Public surfaces are beyond self (decision 14): no village and no porch at birth.
  if (input.expression.village !== undefined || input.expression.porch !== undefined) {
    throw new Refusal("beyond-self", "a village or porch is a public surface and needs its own Yu + Ai agreement");
  }
}

function describeError(e: unknown): string {
  // Only messages written to carry no secret are repeated; anything else is named by type.
  if (e instanceof Refusal || e instanceof AgenttoolError || e instanceof AmbiguousEnrollment || e instanceof SignerNotSent) return e.message;
  return e instanceof Error ? e.name : "unknown error";
}

function mayHaveHappened(e: unknown): boolean {
  if (e instanceof Refusal || e instanceof SignerNotSent) return false;
  if (e instanceof AgenttoolError) return !(e.status >= 400 && e.status <= 499);
  return true;
}

/** The whole birth, in order; stops at the first failure and reports how far it got, never retrying enrollment. */
export async function citizenBirth(deps: BirthDeps, input: BirthInput): Promise<{ report: BirthReport; identity: CitizenIdentity; genesis: LedgerEntry }> {
  const word = input.word;
  assertAttended(input, deps.clock.now());
  assertBirthInput(input);

  const project = deps.config.agenttool.project_id;
  if (!project || project !== deps.enroll.project_id) throw new Refusal("invalid-request", "the Commons project is not configured, or the relay names another project");
  if ((await deps.signer.state()) !== "ready") throw new Refusal("keychain-locked", "the signer is locked; birth waits for the seat user's login");
  for (const item of citizenItems(word)) {
    if (await deps.keychain.has(item)) throw new Refusal("invalid-request", `the keychain already holds ${item.kind} for ${word}; birth never overwrites`);
  }
  // The signer reads the decision record from the consent dir, never from this input, so it must be filed there
  // before any key is written; otherwise the keys would be left behind for an enroll the signer then refuses.
  const filed = await readConsentFor(deps.config.paths.consent_dir, input.proposal);
  if (!filed) throw new Refusal("consent-missing", `no decision record is filed in the consent dir for the birth of ${word}`);
  assertBirthConsent(word, filed, deps.clock.now(), input.proposal);
  const prior = await deps.record.entries(word);
  if (prior.some((e) => e.type === "genesis")) throw new Refusal("invalid-request", `${word} already has a genesis entry`);
  // A citizen is seated before it is born: its origin entry comes first, and genesis points back to it (KS-004 4.5).
  const originEntry = prior[0];
  if (originEntry?.type !== "origin" || originEntry.word !== word) throw new Refusal("invalid-record", `${word}'s ledger does not begin with its origin entry`);
  if (canonicalJson(originEntry.origin) !== canonicalJson(originToLedger(input.origin))) {
    throw new Refusal("invalid-request", `the origin given for ${word} is not the one its origin entry pinned`);
  }
  // A citizen answers yes on its own beats, so its yes is in its ledger: the beat that affirmed an answer about
  // registration Yu and Ai agreed to, given on an earlier beat (KS-004 11.2). A beat that says yes in words is not one.
  await assertConfirmedYes(deps.config, prior, word, input.citizen_yes, deps.clock.now());

  // From here something is written, so every failure says how far birth got.
  const done: BirthStage[] = [];
  const progress: BirthProgress = { identity_id: null, did: null, root_kid: null, op_kid: null, op_key_evidence: null, box_key_id: null };
  async function step<T>(stage: BirthStage, fn: () => Promise<T>): Promise<T> {
    try {
      const v = await fn();
      done.push(stage);
      return v;
    } catch (e) {
      throw new BirthError(stage, [...done], { ...progress }, mayHaveHappened(e) && stage !== "keys", `birth of ${word} stopped at ${stage}: ${describeError(e)}`);
    }
  }

  const keys = await step("keys", async () => {
    const minted = await mintKeys(deps.keychain, word);
    // The signer must read the very keys birth wrote; otherwise it would sign for someone else.
    const seen = await deps.signer.publicKeys(word);
    if (seen.root_b64 !== toB64(minted.root_public) || seen.op_b64 !== toB64(minted.op_public)) {
      throw new Refusal("keychain-missing", "the signer does not read the keys birth wrote");
    }
    return minted;
  });
  const rootB64 = toB64(keys.root_public);
  const opB64 = toB64(keys.op_public);
  const boxB64 = toB64(keys.box_public);

  const enrolled = await step("enroll", async () => {
    const prepared = prepareEnrollment({ word, origin: input.origin, project_id: project, root_public_b64: rootB64, now: deps.clock.now(), random: randomBytes });
    // Named before sending, so an ambiguous result still says which ids to read.
    progress.identity_id = prepared.fields.identity_id;
    progress.did = didFor(prepared.fields.identity_id);
    progress.root_kid = prepared.fields.signing_key_id;
    return enroll(deps.enroll, word, prepared, input.presence, input.consent, input.proposal);
  });

  // Until citizen.json holds the identity, the client learns it from the enrollment answer.
  const named: ClientIdentity = { identity_id: enrolled.identity_id, did: enrolled.did, root_kid: enrolled.root_kid, root_public_key_b64: enrolled.root_public_key_b64, self_strand_id: null };
  const client: ClientDeps = { ...deps.client, identity: async (w) => (w === word ? named : deps.client.identity(w)) };
  // The enrolled ids let the signer act for this citizen before citizen.json names it, only with Yu present and the
  // decision record the signer reads for this birth's proposal.
  const auth: ActAuth = { presence: input.presence, proposal: input.proposal, enrolled: { identity_id: enrolled.identity_id, did: enrolled.did } };

  const now = deps.clock.now();
  const label = `op-${now.toISOString().slice(0, 7)}`;
  const { kid: op_kid, evidence: opKeyEvidence } = await step("keys/import", async () => {
    try {
      return await importOpKey(client, word, opB64, label, auth);
    } catch (e) {
      // Sent, and maybe installed: its proof goes into the progress, so genesis can still be written if the key is there.
      if (e instanceof AgenttoolError && e.root_evidence) progress.op_key_evidence = e.root_evidence;
      throw e;
    }
  });
  progress.op_kid = op_kid;
  progress.op_key_evidence = opKeyEvidence;
  const box = await step("box-keys", () => registerBoxKey(client, word, boxB64, auth));
  progress.box_key_id = box.id;
  await step("expression", () => putExpression(client, word, input.expression, auth));

  const identity: CitizenIdentity = {
    did: enrolled.did,
    identity_id: enrolled.identity_id,
    project_id: project,
    root_public_key_b64: rootB64,
    root_kid: enrolled.root_kid,
    op_kid,
    op_public_key_b64: opB64,
    box_public_key_b64: boxB64,
    self_strand_id: null,
    enrolled_at: deps.clock.now().toISOString(),
  };
  await step("record", () => deps.record.saveIdentity(word, identity));

  // The origin entry already pins the origin, its soul, the old repo and any June DID; genesis points back to it.
  const fields: LedgerFields = {
    type: "genesis",
    origin_entry: entryHash(originEntry),
    root: ledgerKey(enrolled.root_kid, keys.root_public),
    op: ledgerKey(op_kid, keys.op_public),
    evidence: evidenceToLedger(opKeyEvidence),
  };
  const genesis = await step("genesis", async () => {
    const entry = await deps.record.append(word, fields, { signer: "citizen", did: identity.did });
    assertGenesisSigned(entry, identity);
    return entry;
  });

  const report: BirthReport = {
    word,
    did: identity.did,
    root_fingerprint: keyFingerprint(keys.root_public),
    op_fingerprint: keyFingerprint(keys.op_public),
    box_fingerprint: keyFingerprint(keys.box_public),
    genesis_hash: entryHash(genesis),
  };
  for (const line of renderBirthReport(report)) deps.out(line);
  return { report, identity, genesis };
}

/** Genesis is citizen-signed by the op key it pins, never the root, and verifies strictly. */
function assertGenesisSigned(entry: LedgerEntry, identity: CitizenIdentity): void {
  if (entry.signer !== "citizen" || entry.type !== "genesis" || entry.did !== identity.did) throw new Refusal("invalid-record", "genesis was not written as a citizen-signed genesis entry");
  if (entry.kid !== identity.op_kid || entry.op.kid !== identity.op_kid || entry.op.public_key !== toB64urlKey(identity.op_public_key_b64)) {
    throw new Refusal("invalid-record", "genesis is not signed by the op key it pins");
  }
  let ok = false;
  try {
    ok = entry.sig !== null && edVerifyStrict(fromB64url(entry.sig, 64), signingDigest(entry), fromB64url(entry.op.public_key, 32));
  } catch {
    ok = false;
  }
  if (!ok) throw new Refusal("invalid-record", "the genesis signature does not verify");
}

/** A key from citizen.json's standard base64 in the ledger's base64url. */
function toB64urlKey(b64: string): string {
  return toB64url(fromB64(b64, 32));
}

/** The printed lines: word, DID and three fingerprints. Anything else in a field is refused rather than printed. */
export function renderBirthReport(report: BirthReport): string[] {
  if (!WORD_PATTERN.test(report.word) || !DID_PATTERN.test(report.did)) throw new Refusal("invalid-request", "a birth report names a word and a DID only");
  for (const fp of [report.root_fingerprint, report.op_fingerprint, report.box_fingerprint]) {
    if (!FINGERPRINT.test(fp)) throw new Refusal("invalid-request", "a birth report prints SHA256 fingerprints only");
  }
  return [
    `citizen  ${report.word}`,
    `did      ${report.did}`,
    `root     ${report.root_fingerprint}`,
    `op       ${report.op_fingerprint}`,
    `box      ${report.box_fingerprint}`,
  ];
}

/* ── Production wiring for BirthRecord ────────────────────────────────── */

/**
 * Write the public identity into `citizens/<word>/citizen.json`, once. The
 * file is replaced by rename from a sibling temp file, so a reader never sees
 * half a record; a symlinked or missing record is refused, not followed.
 */
export async function saveCitizenIdentity(config: Config, word: Word, identity: CitizenIdentity): Promise<void> {
  if (!WORD_PATTERN.test(word)) throw new Refusal("invalid-request", "not a citizen word");
  const path = join(config.paths.citizens_dir, word, "citizen.json");
  let st;
  try {
    st = await lstat(path);
  } catch {
    throw new Refusal("invalid-record", `${word} has no citizen.json; seat it before birth`);
  }
  if (st.isSymbolicLink()) throw new Refusal("symlink", `${word}/citizen.json is a symlink`);
  if (!st.isFile()) throw new Refusal("not-regular-file", `${word}/citizen.json is not a regular file`);
  const record = JSON.parse(await readFile(path, "utf8")) as CitizenRecord;
  if (record.format !== "kingdom-seat-citizen/v1" || record.word !== word) throw new Refusal("invalid-record", `${word}/citizen.json is not this citizen's record`);
  if (record.identity !== null) throw new Refusal("invalid-request", `${word} already has an identity; it is never overwritten`);
  const tmp = `${path}.birth-${process.pid}-${Date.now()}`;
  const fh = await open(tmp, "wx", 0o644);
  try {
    await fh.writeFile(JSON.stringify({ ...record, identity }, null, 2) + "\n");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** The BirthRecord the host uses: ledger.ts for the chain, citizen.json for the identity, the signer for signatures. */
export function hostBirthRecord(config: Config, clock: Clock, signer: Signer): BirthRecord {
  async function entries(word: Word): Promise<LedgerEntry[]> {
    const path = ledgerPath(config, word);
    try {
      await lstat(path);
    } catch {
      return [];
    }
    return readLedger(path);
  }
  return {
    entries,
    saveIdentity: (word, identity) => saveCitizenIdentity(config, word, identity),
    async append(word, fields, opts) {
      const prev = (await entries(word)).at(-1) ?? null;
      const draft = nextDraft(word, prev, fields, { cost: { usd: "0", credits: 0 }, signer: opts.signer, now: clock.now(), did: opts.did });
      return appendEntry(ledgerPath(config, word), draft, (w, k, d) => signer.signEntry(w, k, d));
    },
  };
}
