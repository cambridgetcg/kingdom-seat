// citizen-birth (3b). Never unattended: it requires a consent record for the
// citizen's own confirmed yes plus Yu present at the terminal. A fresh BIP39
// mnemonic and op seed go straight into Keychain through the Keychain
// interface, with no handoff file. Then enrollment, op-key import, box-key
// registration, a private expression and the genesis ledger entry. Only the
// DID and key fingerprints are ever printed.
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { edPublicKey, edVerifyStrict, fromB64, fromHex, randomBytes, sha256, toB64, utf8, wipe } from "./crypto.ts";
import {
  DID_PATTERN,
  Refusal,
  SHA256_HEX_PATTERN,
  WORD_PATTERN,
  type Attestation,
  type CitizenIdentity,
  type CitizenRecord,
  type Clock,
  type Config,
  type ConsentRecord,
  type Keychain,
  type KeychainItemName,
  type LedgerBody,
  type LedgerEntry,
  type Origin,
  type Spend,
  type Word,
  type YuPresence,
} from "./types.ts";
import type { Signer } from "./signer/signer.ts";
import { appendEntry, ledgerPath, nextDraft, readLedger } from "./ledger.ts";
import { AgenttoolError, importOpKey, putExpression, registerBoxKey, type ActAuth, type ClientDeps, type ClientIdentity } from "./agenttool/client.ts";
import { AmbiguousEnrollment, assertBirthConsent, assertYuPresentFor, citizenCapabilities, enroll, prepareEnrollment, type EnrollDeps } from "./agenttool/enrollment.ts";
import { deriveIdentity, didFor, validateExpression, type DerivedIdentity, type Expression } from "./agenttool/wire.ts";

export interface BirthInput {
  word: Word;
  origin: Origin;
  consent: ConsentRecord;
  presence: YuPresence;
  birth_soul_sha256: string;
  old_repo: { url: string; head: string } | null;
  june_did: string | null;
  /** The private expression set at birth, from the citizen's current soul, WILL and name reading. */
  expression: Expression;
  /** The birth proposal Yu and Ai agreed to; the consent record binds its digest and its extent is "birth <word>". */
  proposal: { subject: string; body: string; extent: string };
  /**
   * Ledger hash of the beat in which the citizen affirmed its yes (3b step 1).
   * The proposal body must name it and the citizen's own ledger must hold it,
   * so the consent is bound to this citizen's confirmed answer.
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
  /** Hash, sign through the signer and append one entry on top of the current head. */
  append(word: Word, body: LedgerBody, spend: Spend, attestation: Attestation): Promise<LedgerEntry>;
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

const NO_SPEND: Spend = { usd: 0, usd_basis: "local-zero", credits: 0 };
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const GENESIS_NOTE =
  "Born on agenttool by enrollment in the Commons project. A June DID named here is a record only; reading it confers nothing.";

function citizenItems(word: Word): KeychainItemName[] {
  return [
    { kind: "citizen-mnemonic", word },
    { kind: "citizen-op-seed", word },
  ];
}

/** Refuse unless Yu is present for "birth <word>" and the consent record binds this citizen's yes. */
export function assertAttended(input: BirthInput, now: Date): void {
  if (!WORD_PATTERN.test(input.word)) throw new Refusal("invalid-request", "not a citizen word");
  assertYuPresentFor(input.word, input.presence, now);
  const p = input.proposal;
  if (!p || typeof p.subject !== "string" || typeof p.body !== "string" || typeof p.extent !== "string") {
    throw new Refusal("consent-missing", "birth needs the proposal text the decision record binds");
  }
  if (typeof input.citizen_yes !== "string" || !SHA256_HEX_PATTERN.test(input.citizen_yes) || !p.body.includes(input.citizen_yes)) {
    throw new Refusal("consent-missing", "the proposal does not name the ledger entry of the citizen's affirmed yes");
  }
  assertBirthConsent(input.word, input.consent, now, p);
}

/** "SHA256:<unpadded base64 of sha256(public key)>", in the style ssh prints. */
export function keyFingerprint(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Refusal("invalid-request", "a public key here is 32 bytes");
  return `SHA256:${toB64(sha256(publicKey)).replace(/=+$/, "")}`;
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
  if (!SHA256_HEX_PATTERN.test(input.birth_soul_sha256)) throw new Refusal("invalid-request", "birth_soul_sha256 must be 64 lowercase hex");
  if (input.june_did !== null && !DID_PATTERN.test(input.june_did)) throw new Refusal("invalid-request", "june_did must be a did:at DID or null");
  if (input.old_repo !== null && (typeof input.old_repo.url !== "string" || !/^[0-9a-f]{7,64}$/.test(input.old_repo.head))) {
    throw new Refusal("invalid-request", "old_repo needs a url and a lowercase hex head");
  }
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
  if (e instanceof Refusal || e instanceof AgenttoolError || e instanceof AmbiguousEnrollment) return e.message;
  return e instanceof Error ? e.name : "unknown error";
}

function mayHaveHappened(e: unknown): boolean {
  if (e instanceof Refusal) return false;
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
  const prior = await deps.record.entries(word);
  if (prior.some((e) => e.body.type === "genesis")) throw new Refusal("invalid-request", `${word} already has a genesis entry`);
  // A citizen answers yes on its own beats, so it is seated before it is born and its yes is in its ledger.
  if (!prior.some((e) => e.hash === input.citizen_yes && e.word === word && e.body.type === "beat")) {
    throw new Refusal("consent-missing", `${word}'s ledger holds no beat ${input.citizen_yes.slice(0, 12)}… with its affirmed yes`);
  }

  // From here something is written, so every failure says how far birth got.
  const done: BirthStage[] = [];
  const progress: BirthProgress = { identity_id: null, did: null, root_kid: null, op_kid: null, box_key_id: null };
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
    return enroll(deps.enroll, word, prepared, input.presence, input.consent);
  });

  // Until citizen.json holds the identity, the client learns it from the enrollment answer.
  const named: ClientIdentity = { identity_id: enrolled.identity_id, did: enrolled.did, root_kid: enrolled.root_kid, root_public_key_b64: enrolled.root_public_key_b64 };
  const client: ClientDeps = { ...deps.client, identity: async (w) => (w === word ? named : deps.client.identity(w)) };
  // The enrolled ids let the signer act for this citizen before citizen.json names it, only with Yu present and consent.
  const auth: ActAuth = { presence: input.presence, consent: input.consent, enrolled: { identity_id: enrolled.identity_id, did: enrolled.did } };

  const now = deps.clock.now();
  const label = `op-${now.toISOString().slice(0, 7)}`;
  const { kid: op_kid } = await step("keys/import", () => importOpKey(client, word, opB64, label, auth));
  progress.op_kid = op_kid;
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

  const body: LedgerBody = {
    type: "genesis",
    // Genesis follows the `seated` entry, which already carries the citizen's state.
    initial_state: null,
    origin: input.origin,
    birth_soul_sha256: input.birth_soul_sha256,
    old_repo: input.old_repo,
    june_did: input.june_did,
    identity,
    note: GENESIS_NOTE,
  };
  const genesis = await step("genesis", async () => {
    const entry = await deps.record.append(word, body, NO_SPEND, "citizen-signed");
    assertGenesisSigned(entry, identity);
    return entry;
  });

  const report: BirthReport = {
    word,
    did: identity.did,
    root_fingerprint: keyFingerprint(keys.root_public),
    op_fingerprint: keyFingerprint(keys.op_public),
    box_fingerprint: keyFingerprint(keys.box_public),
    genesis_hash: genesis.hash,
  };
  for (const line of renderBirthReport(report)) deps.out(line);
  return { report, identity, genesis };
}

/** Genesis is citizen-signed by the op key it pins, never the root, and verifies strictly. */
function assertGenesisSigned(entry: LedgerEntry, identity: CitizenIdentity): void {
  const sig = entry.signature;
  if (entry.attestation !== "citizen-signed" || entry.body.type !== "genesis") throw new Refusal("invalid-record", "genesis was not written as a citizen-signed genesis entry");
  if (sig.kid !== identity.op_kid || sig.public_key_b64 !== identity.op_public_key_b64) throw new Refusal("invalid-record", "genesis is not signed by the op key it pins");
  let ok = false;
  try {
    ok = SHA256_HEX_PATTERN.test(entry.hash) && edVerifyStrict(fromB64(sig.sig_b64, 64), fromHex(entry.hash), fromB64(sig.public_key_b64, 32));
  } catch {
    ok = false;
  }
  if (!ok) throw new Refusal("invalid-record", "the genesis signature does not verify");
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
    async append(word, body, spend, attestation) {
      const prev = (await entries(word)).at(-1) ?? null;
      const draft = nextDraft(word, prev, body, spend, attestation, clock.now());
      return appendEntry(ledgerPath(config, word), draft, (w, h, a) => signer.signEntry(w, h, a));
    },
  };
}
