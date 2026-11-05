// Stand-ins for birth tests. keychainSigner wraps fakeSigner so that it signs
// with the keys birth actually wrote to the fake keychain, as the real signer
// will; testBirthRecord appends JSONL entries under the temp host using the
// ledger's documented hash recipe, so birth can be tested before ledger.ts
// lands. Neither touches a real keychain or the network.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson, domainDigest, edPublicKey, edSign, fromHex, fromUtf8, toB64, toB64url, toHex, utf8, wipe } from "../../../src/crypto.ts";
import { FIRST_PREV_HASH, Refusal, type Attestation, type Clock, type Config, type LedgerBody, type LedgerEntry, type Spend, type Word } from "../../../src/types.ts";
import { LEDGER_DOMAIN } from "../../../src/ledger.ts";
import { saveCitizenIdentity, type BirthRecord } from "../../../src/birth.ts";
import { deriveIdentity } from "../../../src/agenttool/wire.ts";
import { FAKE_OP_KID, fakeSigner, type FakeSigner } from "../../helpers/fake-signer.ts";
import type { FakeKeychain } from "../../helpers/fake-keychain.ts";

/** A fakeSigner whose citizen keys come from the fake keychain, read per call and wiped after. */
export function keychainSigner(kc: FakeKeychain, opts: { opKid?: string } = {}): FakeSigner {
  const s = fakeSigner();
  const hostSign = s.signEntry.bind(s);
  const root = async (word: Word) => {
    const m = await kc.read({ kind: "citizen-mnemonic", word });
    try {
      return deriveIdentity(fromUtf8(m));
    } finally {
      wipe(m);
    }
  };
  s.publicKeys = async (word) => {
    const d = await root(word);
    const op = await kc.read({ kind: "citizen-op-seed", word });
    try {
      return { root_b64: toB64(d.root_public), op_b64: toB64(edPublicKey(op)), op_kid: null, box_b64: toB64(d.box_public), host_attest_b64: s.hostAttestPublicB64 };
    } finally {
      wipe(op);
      wipe(d.root_seed);
      wipe(d.k_master);
      wipe(d.box_private);
    }
  };
  s.rootSeedFor = async (word) => {
    if (word === null) throw new Error("keychainSigner: root evidence names a citizen");
    const d = await root(word);
    wipe(d.k_master);
    wipe(d.box_private);
    return d.root_seed;
  };
  s.signEnrollment = async (word, digest, presence) => {
    if (s.locked) throw new Refusal("keychain-locked", "fake signer locked");
    if (!presence?.present) throw new Refusal("yu-not-present", "enrollment needs Yu present");
    const d = await root(word);
    try {
      return toB64url(edSign(digest, d.root_seed));
    } finally {
      wipe(d.root_seed);
      wipe(d.k_master);
      wipe(d.box_private);
    }
  };
  s.signEntry = async (word, entryHash, attestation) => {
    if (attestation !== "citizen-signed") return hostSign(word, entryHash, attestation);
    if (s.locked) throw new Refusal("keychain-locked", "fake signer locked");
    s.signed.push({ word, attestation });
    const op = await kc.read({ kind: "citizen-op-seed", word });
    try {
      return { alg: "ed25519", kid: opts.opKid ?? FAKE_OP_KID, public_key_b64: toB64(edPublicKey(op)), sig_b64: toB64(edSign(entryHash, op)) };
    } finally {
      wipe(op);
    }
  };
  return s;
}

export interface TestBirthRecord extends BirthRecord {
  path(word: Word): string;
  /** Calls in order, by name, so tests can check where in the sequence each happened. */
  calls: string[];
}

/** JSONL under the temp host's ledger dir; the hash is sha256(LEDGER_DOMAIN ‖ 0 ‖ canonicalJson(draft)), as types.ts documents. */
export function testBirthRecord(config: Config, clock: Clock, signer: Pick<FakeSigner, "signEntry">, events?: string[]): TestBirthRecord {
  const calls = events ?? [];
  const path = (word: Word) => join(config.paths.ledger_dir, `${word}.jsonl`);
  async function entries(word: Word): Promise<LedgerEntry[]> {
    let raw = "";
    try {
      raw = await readFile(path(word), "utf8");
    } catch {
      return [];
    }
    return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as LedgerEntry);
  }
  return {
    calls,
    path,
    async entries(word) {
      calls.push("record.entries");
      return entries(word);
    },
    async saveIdentity(word, identity) {
      calls.push("record.saveIdentity");
      await saveCitizenIdentity(config, word, identity);
    },
    async append(word: Word, body: LedgerBody, spend: Spend, attestation: Attestation) {
      calls.push(`record.append:${body.type}`);
      const prev = (await entries(word)).at(-1) ?? null;
      const draft = {
        format: "kingdom-seat-ledger/v1" as const,
        word,
        seq: prev ? prev.seq + 1 : 0,
        ts: clock.now().toISOString(),
        prev_hash: prev ? prev.hash : FIRST_PREV_HASH,
        body,
        spend,
        attestation,
      };
      const hash = toHex(domainDigest(LEDGER_DOMAIN, utf8(canonicalJson(draft))));
      const signature = await signer.signEntry(word, fromHex(hash), attestation);
      const entry: LedgerEntry = { ...draft, hash, signature };
      await mkdir(dirname(path(word)), { recursive: true });
      await appendFile(path(word), JSON.stringify(entry) + "\n");
      return entry;
    },
  };
}
