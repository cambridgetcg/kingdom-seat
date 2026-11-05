// Stand-ins for birth tests. keychainSigner wraps fakeSigner so that it signs
// with the keys birth actually wrote to the fake keychain, as the real signer
// will; testBirthRecord appends JSONL entries under the temp host using
// KS-004 4.5's recipe written out here on its own (prev_hash the ledger digest
// of the whole previous entry, sig over the digest of the entry without sig),
// so birth's entries are checked against the spec and not only against
// ledger.ts. Neither touches a real keychain or the network.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson, domainDigest, edPublicKey, edSign, fromUtf8, toB64, toB64url, toHex, utf8, wipe } from "../../../src/crypto.ts";
import { Refusal, type Clock, type Config, type LedgerEntry, type LedgerFields, type LedgerSigner, type Word } from "../../../src/types.ts";
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
  s.signEntry = async (word, signer, digestFor) => {
    if (signer !== "citizen") return hostSign(word, signer, digestFor);
    if (s.locked) throw new Refusal("keychain-locked", "fake signer locked");
    s.signed.push({ word, signer });
    const op = await kc.read({ kind: "citizen-op-seed", word });
    try {
      const kid = opts.opKid ?? FAKE_OP_KID;
      return { kid, sig: toB64url(edSign(digestFor(kid), op)), public_key: toB64url(edPublicKey(op)) };
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

/** JSONL under the temp host's ledger dir; every digest is sha256(LEDGER_DOMAIN ‖ 0 ‖ JCS(value)), as KS-004 4.5 says. */
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
    async append(word: Word, fields: LedgerFields, opts: { signer: LedgerSigner; did: string | null }) {
      calls.push(`record.append:${fields.type}`);
      const prev = (await entries(word)).at(-1) ?? null;
      const digest = (v: unknown) => domainDigest(LEDGER_DOMAIN, utf8(canonicalJson(v)));
      const draft = {
        format: "kingdom-seat-ledger/v1" as const,
        word,
        did: opts.did,
        seq: prev ? prev.seq + 1 : 0,
        prev_hash: prev ? `sha256:${toHex(digest(prev))}` : null,
        ...fields,
        seat_ref: null,
        runtime: null,
        input_digest: null,
        output_digest: null,
        acts: null,
        voiced: null,
        cost: { usd: "0", credits: 0 },
        ts: clock.now().toISOString(),
        signer: opts.signer,
      };
      const signature = await signer.signEntry(word, opts.signer, (kid) => digest({ ...draft, kid }));
      const entry = { ...draft, kid: signature.kid, sig: signature.sig } as LedgerEntry;
      await mkdir(dirname(path(word)), { recursive: true });
      await appendFile(path(word), JSON.stringify(entry) + "\n");
      return entry;
    },
  };
}
