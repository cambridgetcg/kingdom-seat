// A Signer for tests of everything except the signer itself. It signs with
// public test keys through the real Ed25519 in src/crypto.ts, records every
// request it is asked to send, and sends nothing anywhere.
import { Refusal, type LedgerSigner, type RootEvidence, type SignerOp, type Word, type YuPresence } from "../../src/types.ts";
import { edPublicKey, edSign, fromB64, fromHex, sha256, toB64, toB64url } from "../../src/crypto.ts";
import { hostKid, type EntrySignature } from "../../src/ledger.ts";
import { AUTHORITY_HEADERS, AGENTTOOL_ORIGIN, authorityDigest, authorityHeaders, inboxDigest, openInbox, sealInbox } from "../../src/agenttool/wire.ts";
import { x25519 } from "@noble/curves/ed25519.js";
import { GIT_NAMESPACE, sshsigArmor, sshsigSignedData } from "../../src/ssh.ts";
import type { PublicKeys, SealedLetter, SealedThought, Signer, SignerRequest, SignerResponse } from "../../src/signer/signer.ts";
import { TEST_OP_SEED_HEX, TEST_ROOT_SEED_HEX } from "./vectors.ts";

/** The ops the real signer signs with the root, and so answers with root evidence. */
const ROOT_OPS = new Set<SignerOp>(["keys.import", "keys.revoke", "box-keys.register", "expression.put.private", "quiet.start.citizen", "quiet.end.citizen", "quiet.start.beacon"]);

export const FAKE_OP_KID = "55555555-5555-4555-8555-555555555555";

/** A test box key per citizen word, so two citizens on one fake host seal to and open from different keys. */
export function fakeBoxPrivate(word: Word): Uint8Array {
  return sha256(`kingdom-seat test box key v1 ${word}`);
}

/** The public half of fakeBoxPrivate, in citizen.json's standard base64. */
export function fakeBoxPublicB64(word: Word): string {
  return toB64(x25519.getPublicKey(fakeBoxPrivate(word)));
}

export interface FakeSigner extends Signer {
  /** While true, every signing call refuses with "keychain-locked", as after a reboot. */
  locked: boolean;
  sent: SignerRequest[];
  signed: { word: Word; signer: LedgerSigner }[];
  /** Letters sealed through sealLetter, in order: who to and the plaintext, which only a test may see. */
  sealedLetters: { word: Word; to_did: string; plaintext: string }[];
  /** The did each word's letters are opened as; a test that registers a citizen names it here. */
  didOf: Map<Word, string>;
  /** Replace how send() answers; the default is 200 with an empty object. */
  respond(fn: (req: SignerRequest) => SignerResponse): void;
  /** The root seed root-signed requests are signed with, per citizen; the test root unless replaced. */
  rootSeedFor: (word: Word | null) => Promise<Uint8Array>;
  readonly hostAttestPublicB64: string;
  /** The kid a host entry signed by this signer names: host:<fingerprint>. */
  readonly hostKid: string;
  /** The op key in citizen.json's standard base64, and in the ledger's base64url. */
  readonly opPublicB64: string;
  readonly opPublicB64url: string;
}

export function fakeSigner(opts: { opSeed?: Uint8Array; hostSeed?: Uint8Array; rootSeed?: Uint8Array } = {}): FakeSigner {
  const opSeed = opts.opSeed ?? fromHex(TEST_OP_SEED_HEX);
  const hostSeed = opts.hostSeed ?? sha256("kingdom-seat test host attest key v1");
  const rootSeed = opts.rootSeed ?? fromHex(TEST_ROOT_SEED_HEX);
  const opPub = toB64(edPublicKey(opSeed));
  const hostPub = toB64(edPublicKey(hostSeed));
  const hostKidOf = hostKid(edPublicKey(hostSeed));
  let answer: (req: SignerRequest) => SignerResponse = () => ({ status: 200, json: {} });
  // A sequence per identity, so evidence moves only upward, as agenttool's does.
  const sequences = new Map<string, number>();

  /** What the real signer hands back with a root-signed request: the request as sent, signed by the root. */
  async function evidenceFor(req: SignerRequest): Promise<RootEvidence | undefined> {
    if (!ROOT_OPS.has(req.op)) return undefined;
    const url = new URL(req.target, AGENTTOOL_ORIGIN);
    const id = /^\/v1\/identities\/([^/]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get("identity_id");
    if (!id) return undefined;
    const sequence = (sequences.get(id) ?? 0) + 1;
    sequences.set(id, sequence);
    const timestamp = "2026-11-05T12:00:00.000Z";
    const digest = authorityDigest({ did: `did:at:${id}`, method: req.method, target: req.target, body: req.body, sequence, timestamp });
    const h = authorityHeaders(sequence, timestamp, edSign(digest, await s.rootSeedFor(req.word)));
    return {
      method: req.method,
      target: req.target,
      body_b64: toB64(req.body),
      headers: {
        [AUTHORITY_HEADERS.sequence]: h[AUTHORITY_HEADERS.sequence]!,
        [AUTHORITY_HEADERS.timestamp]: h[AUTHORITY_HEADERS.timestamp]!,
        [AUTHORITY_HEADERS.signature]: h[AUTHORITY_HEADERS.signature]!,
      },
    };
  }

  const s: FakeSigner = {
    locked: false,
    sent: [],
    signed: [],
    sealedLetters: [],
    didOf: new Map(),
    hostAttestPublicB64: hostPub,
    hostKid: hostKidOf,
    opPublicB64: opPub,
    opPublicB64url: toB64url(edPublicKey(opSeed)),
    respond(fn) {
      answer = fn;
    },
    rootSeedFor: async () => rootSeed,
    async publicKeys(): Promise<PublicKeys> {
      return { root_b64: toB64(edPublicKey(rootSeed)), op_b64: opPub, op_kid: FAKE_OP_KID, box_b64: null, host_attest_b64: hostPub };
    },
    async signEntry(word, signer, digestFor): Promise<EntrySignature> {
      if (s.locked) throw new Refusal("keychain-locked", "fake signer locked");
      s.signed.push({ word, signer });
      const citizen = signer === "citizen";
      const kid = citizen ? FAKE_OP_KID : hostKidOf;
      const seed = citizen ? opSeed : hostSeed;
      return { kid, sig: toB64url(edSign(digestFor(kid), seed)), public_key: toB64url(edPublicKey(seed)) };
    },
    async send(req) {
      if (s.locked) throw new Refusal("keychain-locked", "fake signer locked");
      s.sent.push(req);
      const res = answer(req);
      const root_evidence = await evidenceFor(req);
      return root_evidence ? { ...res, root_evidence } : res;
    },
    async signEnrollment(_word: Word, digest: Uint8Array, presence: YuPresence) {
      if (!presence?.present) throw new Refusal("yu-not-present", "fake signer: enrollment needs Yu present");
      return toB64url(edSign(digest, rootSeed));
    },
    async sealThought(_word, _strandId, _plaintext, kind): Promise<SealedThought> {
      // Fixed placeholders: wire and signer tests check real thought bytes against vectors.json.
      return { ciphertext: "AAAA", nonce: "AAAAAAAAAAAAAAAA", kind, signature: toB64(new Uint8Array(64)), signing_key_id: FAKE_OP_KID };
    },
    async sealLetter(word, to, plaintext): Promise<SealedLetter> {
      if (s.locked) throw new Refusal("keychain-locked", "fake signer locked");
      // Real sealing and a real op-key signature, so the fake agenttool and a recipient's openLetter can check both.
      const sealed = await sealInbox(plaintext, fromB64(to.box_public_key_b64, 32));
      s.sealedLetters.push({ word, to_did: to.did, plaintext });
      const digest = inboxDigest(to.did, sealed.ciphertext, sealed.nonce, sealed.ephemeral_pub);
      return { ciphertext: toB64(sealed.ciphertext), nonce: toB64(sealed.nonce), ephemeral_pubkey: toB64(sealed.ephemeral_pub), signature: toB64(edSign(digest, opSeed)), signing_key_id: FAKE_OP_KID };
    },
    async openLetter(word, letter) {
      if (s.locked) throw new Refusal("keychain-locked", "fake signer locked");
      const did = s.didOf.get(word);
      if (did !== undefined && letter.recipient_did !== did) throw new Refusal("beyond-self", "fake signer: a letter is opened only by its recipient");
      return openInbox(fromB64(letter.ciphertext), fromB64(letter.nonce, 12), fromB64(letter.ephemeral_pubkey, 32), fakeBoxPrivate(word));
    },
    async signMirrorCommit(_word, message) {
      if (s.locked) throw new Refusal("keychain-locked", "fake signer locked");
      return { armored: sshsigArmor(edPublicKey(hostSeed), GIT_NAMESPACE, edSign(sshsigSignedData(GIT_NAMESPACE, message), hostSeed)), public_key_b64: hostPub };
    },
    async state() {
      return s.locked ? "locked" : "ready";
    },
  };
  return s;
}
