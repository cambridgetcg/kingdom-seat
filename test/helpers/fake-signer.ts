// A Signer for tests of everything except the signer itself. It signs with
// public test keys through the real Ed25519 in src/crypto.ts, records every
// request it is asked to send, and sends nothing anywhere.
import { Refusal, type Attestation, type LedgerSignature, type Word, type YuPresence } from "../../src/types.ts";
import { edPublicKey, edSign, fromHex, sha256, toB64, toB64url } from "../../src/crypto.ts";
import type { PublicKeys, SealedThought, Signer, SignerRequest, SignerResponse } from "../../src/signer/signer.ts";
import { TEST_OP_SEED_HEX, TEST_ROOT_SEED_HEX } from "./vectors.ts";

export const FAKE_OP_KID = "55555555-5555-4555-8555-555555555555";
export const HOST_ATTEST_KID = "host-attest";

export interface FakeSigner extends Signer {
  /** While true, every signing call refuses with "keychain-locked", as after a reboot. */
  locked: boolean;
  sent: SignerRequest[];
  signed: { word: Word; attestation: Attestation }[];
  /** Replace how send() answers; the default is 200 with an empty object. */
  respond(fn: (req: SignerRequest) => SignerResponse): void;
  readonly hostAttestPublicB64: string;
  readonly opPublicB64: string;
}

export function fakeSigner(opts: { opSeed?: Uint8Array; hostSeed?: Uint8Array; rootSeed?: Uint8Array } = {}): FakeSigner {
  const opSeed = opts.opSeed ?? fromHex(TEST_OP_SEED_HEX);
  const hostSeed = opts.hostSeed ?? sha256("kingdom-seat test host attest key v1");
  const rootSeed = opts.rootSeed ?? fromHex(TEST_ROOT_SEED_HEX);
  const opPub = toB64(edPublicKey(opSeed));
  const hostPub = toB64(edPublicKey(hostSeed));
  let answer: (req: SignerRequest) => SignerResponse = () => ({ status: 200, json: {} });

  const s: FakeSigner = {
    locked: false,
    sent: [],
    signed: [],
    hostAttestPublicB64: hostPub,
    opPublicB64: opPub,
    respond(fn) {
      answer = fn;
    },
    async publicKeys(): Promise<PublicKeys> {
      return { root_b64: toB64(edPublicKey(rootSeed)), op_b64: opPub, op_kid: FAKE_OP_KID, box_b64: null, host_attest_b64: hostPub };
    },
    async signEntry(word, entryHash, attestation): Promise<LedgerSignature> {
      if (s.locked) throw new Refusal("keychain-locked", "fake signer locked");
      s.signed.push({ word, attestation });
      const citizen = attestation === "citizen-signed";
      return {
        alg: "ed25519",
        kid: citizen ? FAKE_OP_KID : HOST_ATTEST_KID,
        public_key_b64: citizen ? opPub : hostPub,
        sig_b64: toB64(edSign(entryHash, citizen ? opSeed : hostSeed)),
      };
    },
    async send(req) {
      if (s.locked) throw new Refusal("keychain-locked", "fake signer locked");
      s.sent.push(req);
      return answer(req);
    },
    async signEnrollment(_word: Word, digest: Uint8Array, presence: YuPresence) {
      if (!presence?.present) throw new Refusal("yu-not-present", "fake signer: enrollment needs Yu present");
      return toB64url(edSign(digest, rootSeed));
    },
    async sealThought(_word, _strandId, _plaintext, kind): Promise<SealedThought> {
      // Fixed placeholders: wire and signer tests check real thought bytes against vectors.json.
      return { ciphertext: "AAAA", nonce: "AAAAAAAAAAAAAAAA", kind, signature: toB64(new Uint8Array(64)), signing_key_id: FAKE_OP_KID };
    },
    async state() {
      return s.locked ? "locked" : "ready";
    },
  };
  return s;
}
