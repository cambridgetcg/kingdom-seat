// Owner: record group. Use test/helpers/fake-signer.ts for signatures.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, concatBytes, edPublicKey, edSign, fromHex, sha256, toB64, toHex, utf8 } from "../src/crypto.ts";
import {
  appendEntry,
  entryHash,
  lastEntries,
  LEDGER_DOMAIN,
  ledgerPath,
  nextDraft,
  pinnedOpKeys,
  readLedger,
  verifyChain,
  voicedThrough,
  type EntrySigner,
  type LedgerDraft,
  type TrustedKeys,
} from "../src/ledger.ts";
import { FIRST_PREV_HASH, Refusal, type LedgerBody, type LedgerEntry } from "../src/types.ts";
import { FAKE_OP_KID, fakeSigner, type FakeSigner } from "./helpers/fake-signer.ts";
import { importEvidence, revokeEvidence } from "./helpers/root-evidence.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { TEST_IDS, TEST_OP_SEED_HEX, TEST_ROOT_PUBLIC_B64, TEST_ROOT_SEED_HEX } from "./helpers/vectors.ts";
import { append, beatBody, genesisBody, ROOT_KID, seatedBody, seatedThenBorn, signerFn, testIdentity, ZERO_SPEND } from "./fixtures/record/chain.ts";

let host: TempHost | null = null;
afterEach(async () => {
  await host?.cleanup();
  host = null;
});

const WORD = "glossame";
const T0 = new Date("2026-11-05T02:05:00.000Z");

async function setup(): Promise<{ host: TempHost; signer: FakeSigner; path: string }> {
  host = await makeTempHost();
  return { host, signer: fakeSigner(), path: ledgerPath(host.config, WORD) };
}

function draft(over: Partial<LedgerDraft> = {}): LedgerDraft {
  return { ...nextDraft(WORD, null, seatedBody(WORD, "soul"), ZERO_SPEND, "host-attested", T0), ...over };
}

/** Re-hash and re-sign an entry by hand, as a forger with some key would. */
function forge(e: Omit<LedgerEntry, "hash" | "signature">, seed: Uint8Array, kid: string): LedgerEntry {
  const hash = entryHash(e);
  return { ...e, hash, signature: { alg: "ed25519", kid, public_key_b64: toB64(edPublicKey(seed)), sig_b64: toB64(edSign(fromHex(hash), seed)) } };
}

const HOST_SEED = sha256("kingdom-seat test host attest key v1");

describe("ledger", () => {
  test("entryHash is domain-tagged canonical JSON and changes when any field changes", () => {
    const d = draft();
    const expected = toHex(sha256(concatBytes(utf8(LEDGER_DOMAIN), new Uint8Array([0]), utf8(canonicalJson(d)))));
    expect(entryHash(d)).toBe(expected);
    // Untagged, the same bytes hash differently: an entry signature cannot pass as another kind.
    expect(entryHash(d)).not.toBe(toHex(sha256(canonicalJson(d))));
    // Key order does not matter; hash and signature are never part of what is hashed.
    const reordered = Object.fromEntries(Object.entries(d).reverse()) as LedgerDraft;
    expect(entryHash(reordered)).toBe(expected);
    const withSig = { ...d, hash: "f".repeat(64), signature: { alg: "ed25519", kid: "x", public_key_b64: "y", sig_b64: "z" } } as LedgerDraft;
    expect(entryHash(withSig)).toBe(expected);

    const changed: LedgerDraft[] = [
      draft({ seq: 1 }),
      draft({ ts: "2026-11-05T02:05:00.001Z" }),
      draft({ word: "shemme" }),
      draft({ prev_hash: "1".repeat(64) }),
      draft({ attestation: "citizen-signed" }),
      draft({ spend: { ...ZERO_SPEND, credits: 1 } }),
      draft({ body: seatedBody(WORD, "soul", "asleep") }),
    ];
    for (const c of changed) expect(entryHash(c)).not.toBe(expected);
    // An optional field can never silently vanish from a hash.
    expect(() => entryHash({ ...d, body: { ...d.body, note: undefined } } as unknown as LedgerDraft)).toThrow();
  });

  test("nextDraft fills seq, prev_hash and ts from the previous entry", async () => {
    const { host, signer, path } = await setup();
    const first = nextDraft(WORD, null, seatedBody(WORD, "soul"), ZERO_SPEND, "host-attested", T0);
    expect(first).toMatchObject({ seq: 0, prev_hash: FIRST_PREV_HASH, ts: T0.toISOString(), word: WORD });
    const e0 = await appendEntry(path, first, signerFn(signer));
    const second = nextDraft(WORD, e0, beatBody(WORD, []), ZERO_SPEND, "host-attested", T0);
    expect(second).toMatchObject({ seq: 1, prev_hash: e0.hash });
    expect(() => nextDraft("shemme", e0, beatBody("shemme", []), ZERO_SPEND, "host-attested", T0)).toThrow(Refusal);
    expect(() => ledgerPath(host.config, "../etc")).toThrow(Refusal);
  });

  test("appendEntry appends one line, never rewrites, and refuses when the file head moved since prev was read", async () => {
    const { signer, path } = await setup();
    const e0 = await appendEntry(path, nextDraft(WORD, null, seatedBody(WORD, "soul"), ZERO_SPEND, "host-attested", T0), signerFn(signer));
    const afterOne = await readFile(path, "utf8");
    expect(afterOne.endsWith("\n")).toBe(true);
    expect(afterOne.split("\n").length).toBe(2);
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");

    const e1 = await appendEntry(path, nextDraft(WORD, e0, beatBody(WORD, []), ZERO_SPEND, "host-attested", T0), signerFn(signer));
    const afterTwo = await readFile(path, "utf8");
    // The first line is byte-for-byte what it was: append-only.
    expect(afterTwo.startsWith(afterOne)).toBe(true);
    expect((await readLedger(path)).map((e) => e.hash)).toEqual([e0.hash, e1.hash]);

    // A draft built on a stale head (prev = e0 again, or no prev at all) is refused and writes nothing.
    const stale = nextDraft(WORD, e0, beatBody(WORD, []), ZERO_SPEND, "host-attested", T0);
    await expect(appendEntry(path, stale, signerFn(signer))).rejects.toMatchObject({ code: "head-moved" });
    const fresh = nextDraft(WORD, null, seatedBody(WORD, "soul"), ZERO_SPEND, "host-attested", T0);
    await expect(appendEntry(path, fresh, signerFn(signer))).rejects.toBeInstanceOf(Refusal);
    expect(await readFile(path, "utf8")).toBe(afterTwo);
  });

  test("appendEntry refuses a draft that breaks the chain's rules before anything is written", async () => {
    const { host, signer, path } = await setup();
    const entries = await seatedThenBorn(host.config, WORD, "soul", signer);
    const before = await readFile(path, "utf8");
    const head = entries.at(-1) as LedgerEntry;
    // No host-attested entry after genesis.
    await expect(appendEntry(path, nextDraft(WORD, head, beatBody(WORD, []), ZERO_SPEND, "host-attested", T0), signerFn(signer))).rejects.toMatchObject({
      code: "invalid-record",
    });
    // A signer that answers with the root key is refused: the root signs only authority acts.
    const rootSeed = fromHex(TEST_ROOT_SEED_HEX);
    const rootSigner: EntrySigner = async (_w, hash) => ({ alg: "ed25519", kid: ROOT_KID, public_key_b64: TEST_ROOT_PUBLIC_B64, sig_b64: toB64(edSign(hash, rootSeed)) });
    await expect(appendEntry(path, nextDraft(WORD, head, beatBody(WORD, []), ZERO_SPEND, "citizen-signed", T0), rootSigner)).rejects.toMatchObject({
      code: "invalid-record",
    });
    // A second seated, or a seated anywhere but first, is refused.
    await expect(appendEntry(path, nextDraft(WORD, head, seatedBody(WORD, "soul"), ZERO_SPEND, "citizen-signed", T0), signerFn(signer))).rejects.toBeInstanceOf(Refusal);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("appendEntry refuses to extend a chain whose existing entries no longer verify", async () => {
    const { host, signer, path } = await setup();
    const entries = await seatedThenBorn(host.config, WORD, "soul", signer);
    const lines = (await readFile(path, "utf8")).split("\n");
    const tampered = JSON.parse(lines[1] as string);
    tampered.body.envelope.model = "another-model";
    lines[1] = JSON.stringify(tampered);
    await writeFile(path, lines.join("\n"));
    await expect(
      appendEntry(path, nextDraft(WORD, entries.at(-1) as LedgerEntry, beatBody(WORD, []), ZERO_SPEND, "citizen-signed", T0), signerFn(signer)),
    ).rejects.toMatchObject({ code: "invalid-record" });
  });

  test("readLedger refuses a symlinked ledger and throws on any unparsable line (fail closed)", async () => {
    const { host, signer, path } = await setup();
    // No ledger yet is an empty record.
    expect(await readLedger(path)).toEqual([]);
    await seatedThenBorn(host.config, WORD, "soul", signer);
    const good = await readFile(path, "utf8");
    expect((await readLedger(path)).length).toBe(4);

    const linked = join(host.config.paths.ledger_dir, "linked.jsonl");
    await symlink(path, linked);
    await expect(readLedger(linked)).rejects.toMatchObject({ code: "symlink" });

    const dir = join(host.config.paths.ledger_dir, "dir.jsonl");
    await mkdir(dir);
    await expect(readLedger(dir)).rejects.toMatchObject({ code: "not-regular-file" });

    const bad = join(host.config.paths.ledger_dir, "bad.jsonl");
    const cases = [
      good.replace("\n", "\nnot json\n"), // a garbage line in the middle
      `${good}\n`, // a blank line
      good.slice(0, -1), // a torn last line
      good.slice(0, -40) + "\n", // a truncated entry
      good.replace('"format":"kingdom-seat-ledger/v1"', '"format":"kingdom-seat-ledger/v1","extra":1'), // a field outside the hash's format
      good.replace('"attestation":"host-attested"', '"attestation":"maybe"'),
      good.replace('"usd":"0"', '"usd":0'), // money as a float, not a decimal string
      good.replace('"usd":"0"', '"usd":"0.0"'), // nor any spelling but the one
      good.replace('"citizen":{"did":null,"kid":null,"word":"glossame"}', '"citizen":{"did":null,"kid":null,"word":"shemme"}'), // a beat voiced as another citizen
    ];
    expect(good).toContain('"citizen":{"did":null,"kid":null,"word":"glossame"}');
    for (const text of cases) {
      await writeFile(bad, text);
      await expect(readLedger(bad)).rejects.toMatchObject({ code: "invalid-record" });
    }
    // Malformed UTF-8 throws rather than becoming U+FFFD.
    await writeFile(bad, Buffer.concat([Buffer.from(good), Buffer.from([0xff, 0x0a])]));
    await expect(readLedger(bad)).rejects.toThrow();
  });

  test("verifyChain accepts a seated → beat → genesis → beat chain and counts host-attested entries", async () => {
    const { host, signer } = await setup();
    const entries = await seatedThenBorn(host.config, WORD, "soul", signer);
    expect(entries.map((e) => e.body.type)).toEqual(["seated", "beat", "genesis", "beat"]);
    expect(entries.map((e) => e.attestation)).toEqual(["host-attested", "host-attested", "citizen-signed", "citizen-signed"]);
    const v = verifyChain(entries, { host_attest_b64: [signer.hostAttestPublicB64] });
    expect(v).toEqual({ ok: true, entries: 4, head: (entries[3] as LedgerEntry).hash, host_attested: 2, problem: null });
    // The host's own record of the identity agrees with genesis.
    expect(verifyChain(entries, { host_attest_b64: [signer.hostAttestPublicB64], identity: testIdentity(signer) }).ok).toBe(true);
    // An empty chain is trivially whole.
    expect(verifyChain([], { host_attest_b64: [] })).toMatchObject({ ok: true, entries: 0, head: null });
  });

  test("verifyChain flags a broken prev link, a bad hash, a bad signature, a root-kid signature, and a host-attested entry after genesis", async () => {
    const { host, signer } = await setup();
    const good = await seatedThenBorn(host.config, WORD, "soul", signer);
    const trusted: TrustedKeys = { host_attest_b64: [signer.hostAttestPublicB64] };
    const clone = () => structuredClone(good);
    const problem = (entries: LedgerEntry[], t: TrustedKeys = trusted) => verifyChain(entries, t);

    const broken = clone();
    (broken[2] as LedgerEntry).prev_hash = "f".repeat(64);
    expect(problem(broken)).toMatchObject({ ok: false, head: (good[1] as LedgerEntry).hash, host_attested: 2, problem: { seq: 2, reason: expect.stringContaining("prev_hash") } });

    const badHash = clone();
    ((badHash[1] as LedgerEntry).body as { envelope: { model: string } }).envelope.model = "another-model";
    expect(problem(badHash).problem).toEqual({ seq: 1, reason: expect.stringContaining("hash does not match") });

    const badSig = clone();
    const e3 = badSig[3] as LedgerEntry;
    e3.signature = { ...e3.signature, sig_b64: toB64(edSign(fromHex(e3.hash), sha256("some other key"))) };
    expect(problem(badSig).problem).toEqual({ seq: 3, reason: expect.stringContaining("does not verify") });

    const rootSigned = clone();
    const { hash: _h, signature: _s, ...d3 } = good[3] as LedgerEntry;
    rootSigned[3] = forge(d3, fromHex(TEST_ROOT_SEED_HEX), ROOT_KID);
    expect(problem(rootSigned).problem).toEqual({ seq: 3, reason: expect.stringContaining("root") });
    // Even under an op kid, a root public key is refused.
    rootSigned[3] = forge(d3, fromHex(TEST_ROOT_SEED_HEX), FAKE_OP_KID);
    expect(problem(rootSigned).problem?.seq).toBe(3);

    const hostAfter = [...good, forge(nextDraft(WORD, good[3] as LedgerEntry, beatBody(WORD, []), ZERO_SPEND, "host-attested", T0), HOST_SEED, "host-attest")];
    expect(problem(hostAfter).problem).toEqual({ seq: 4, reason: "host-attested entry after genesis" });

    // A host attest key the verifier does not trust, and a genesis naming another identity.
    expect(problem(good, { host_attest_b64: [] }).problem).toEqual({ seq: 0, reason: "host attest key is not trusted" });
    const otherRoot = toB64(edPublicKey(sha256("another root")));
    expect(problem(good, { ...trusted, identity: { did: testIdentity(signer).did, root_public_key_b64: otherRoot } }).problem?.seq).toBe(2);

    // A citizen-signed entry before genesis has no pinned key to answer to.
    const early = clone();
    const { hash: _h1, signature: _s1, ...d1 } = good[1] as LedgerEntry;
    early[1] = forge({ ...d1, attestation: "citizen-signed" }, fromHex(TEST_ROOT_SEED_HEX), FAKE_OP_KID);
    expect(problem(early).problem).toEqual({ seq: 1, reason: "citizen-signed entry before genesis" });
  });

  test("genesis carries the root's keys/import of its op key, and verify checks it without agenttool", async () => {
    const { host, signer, path } = await setup();
    const good = await seatedThenBorn(host.config, WORD, "soul", signer);
    const trusted: TrustedKeys = { host_attest_b64: [signer.hostAttestPublicB64] };
    expect(verifyChain(good, trusted).ok).toBe(true);
    const id = testIdentity(signer);
    const opSeed = fromHex(TEST_OP_SEED_HEX);

    // Re-hashed and re-signed by the op key, so only the evidence is wrong.
    const withEvidence = (ev: unknown): LedgerEntry[] => {
      const { hash: _h, signature: _s, ...d } = good[2] as LedgerEntry;
      const { op_key_evidence: _e, ...rest } = d.body as Extract<LedgerBody, { type: "genesis" }>;
      const body = (ev === undefined ? rest : { ...rest, op_key_evidence: ev }) as LedgerBody;
      return [good[0]!, good[1]!, forge({ ...d, body }, opSeed, FAKE_OP_KID)];
    };
    const reasonFor = (ev: unknown) => verifyChain(withEvidence(ev), trusted).problem;
    const genuine = importEvidence(id, id.op_public_key_b64);
    expect(reasonFor(genuine)).toBeNull();
    // Signed by anything but the root, the op key itself included: the op key never vouches for itself.
    expect(reasonFor(importEvidence(id, id.op_public_key_b64, { rootSeed: opSeed }))).toEqual({ seq: 2, reason: "genesis: root evidence is not signed by the root" });
    expect(reasonFor(importEvidence(id, toB64(edPublicKey(sha256("another op key")))))?.reason).toBe("genesis: root evidence imports another key");
    expect(reasonFor(importEvidence({ ...id, identity_id: TEST_IDS.project_id }, id.op_public_key_b64))?.reason).toBe("genesis: root evidence is not this identity's keys/import");
    expect(reasonFor({ ...genuine, method: "PUT" })?.reason).toBe("genesis: root evidence is not this identity's keys/import");
    // One changed byte of what was sent, or of a header, and the root's signature no longer covers it.
    expect(reasonFor({ ...genuine, body_b64: toB64(utf8(`{"public_key":"${id.op_public_key_b64}","label":"other"}`)) })?.reason).toBe("genesis: root evidence is not signed by the root");
    expect(reasonFor({ ...genuine, headers: { ...genuine.headers, "X-Agenttool-Authority-Sequence": "2" } })?.reason).toBe("genesis: root evidence is not signed by the root");
    expect(reasonFor({ ...genuine, headers: { ...genuine.headers, "X-Agenttool-Authority-Sequence": "01" } })?.reason).toBe("genesis: root evidence does not rebuild an identity-authority/v1 digest");
    // Missing, or carrying anything else, does not parse.
    expect(reasonFor(undefined)?.reason).toContain("malformed entry");
    expect(reasonFor({ ...genuine, note: "extra" })?.reason).toContain("malformed entry");

    // appendEntry holds a new genesis to the same rule and writes nothing.
    const other = ledgerPath(host.config, "shemme");
    const bad = { ...genesisBody("shemme", "soul", id, "awake"), op_key_evidence: importEvidence(id, id.op_public_key_b64, { rootSeed: opSeed }) } as LedgerBody;
    await expect(appendEntry(other, nextDraft("shemme", null, bad, ZERO_SPEND, "citizen-signed", T0), signerFn(signer))).rejects.toMatchObject({ code: "invalid-record" });
    expect(await readLedger(other)).toEqual([]);
    expect((await readLedger(path)).length).toBe(4);
  });

  test("an op-key entry is authorised by the root's evidence and signed by the key it installs; the old op key alone never rotates", async () => {
    const { host, signer, path } = await setup();
    const entries = await seatedThenBorn(host.config, WORD, "soul", signer);
    const trusted: TrustedKeys = { host_attest_b64: [signer.hostAttestPublicB64] };
    const id = testIdentity(signer);
    const opSeed = fromHex(TEST_OP_SEED_HEX);
    expect(pinnedOpKeys(entries, 1).size).toBe(0);
    expect([...pinnedOpKeys(entries, 2)]).toEqual([[FAKE_OP_KID, signer.opPublicB64]]);

    const newSeed = sha256("kingdom-seat test op key v2");
    const newKid = "77777777-7777-4777-8777-777777777777";
    const newPub = toB64(edPublicKey(newSeed));
    const newSigner: EntrySigner = async (_w, hash) => ({ alg: "ed25519", kid: newKid, public_key_b64: newPub, sig_b64: toB64(edSign(hash, newSeed)) });
    // Genesis spent sequence 1; agenttool's next are 2 (import) and 3 (revoke).
    const install = { op_kid: newKid, op_public_key_b64: newPub, evidence: importEvidence(id, newPub, { sequence: 2 }) };
    const revokeOld = { op_kid: FAKE_OP_KID, evidence: revokeEvidence(id, FAKE_OP_KID, { sequence: 3 }) };
    const rotation: LedgerBody = { type: "op-key", installed: [install], revoked: [revokeOld] };
    const head = entries.at(-1) as LedgerEntry;
    const reasonOf = (body: LedgerBody, seed = newSeed, kid = newKid, chain = entries) =>
      verifyChain([...chain, forge(nextDraft(WORD, chain.at(-1) as LedgerEntry, body, ZERO_SPEND, "citizen-signed", T0), seed, kid)], trusted).problem?.reason ?? null;

    // The old op key alone: it can sign, but it cannot make root evidence, and it does not sign a rotation.
    expect(reasonOf({ ...rotation, installed: [{ ...install, evidence: importEvidence(id, newPub, { sequence: 2, rootSeed: opSeed }) }] })).toBe("op-key: root evidence is not signed by the root");
    expect(reasonOf(rotation, opSeed, FAKE_OP_KID)).toBe("op-key is not signed by a key it installs");
    await expect(appendEntry(path, nextDraft(WORD, head, rotation, ZERO_SPEND, "citizen-signed", T0), signerFn(signer))).rejects.toMatchObject({ code: "invalid-record" });
    // Evidence for one key cannot install another, nor revoke a key it does not name.
    expect(reasonOf({ ...rotation, installed: [{ ...install, op_public_key_b64: toB64(edPublicKey(sha256("x"))) }] }, sha256("x"))).toBe("op-key: root evidence imports another key");
    expect(reasonOf({ ...rotation, revoked: [{ ...revokeOld, evidence: revokeEvidence(id, newKid, { sequence: 3 }) }] })).toBe("op-key: root evidence is not this identity's revoke of that key");
    // A replayed proof: the import genesis spent cannot install anything again.
    const genesisEvidence = ((entries[2] as LedgerEntry).body as Extract<LedgerBody, { type: "genesis" }>).op_key_evidence;
    expect(reasonOf({ ...rotation, installed: [{ ...install, evidence: { ...genesisEvidence } }] })).toBe("op-key: root evidence imports another key");
    expect(reasonOf({ type: "op-key", installed: [install], revoked: [{ ...revokeOld, evidence: revokeEvidence(id, FAKE_OP_KID, { sequence: 1 }) }] })).toBe(
      "op-key: root evidence reuses an authority sequence already spent",
    );
    // The root is never an op key; nor may the last key go without a new one.
    expect(reasonOf({ ...rotation, installed: [{ op_kid: ROOT_KID, op_public_key_b64: TEST_ROOT_PUBLIC_B64, evidence: importEvidence(id, TEST_ROOT_PUBLIC_B64, { sequence: 2 }) }] })).toBe(
      "op-key: pins the root as an op key",
    );
    expect(reasonOf({ type: "op-key", installed: [], revoked: [revokeOld] }, opSeed, FAKE_OP_KID)).toBe("op-key: revokes the last op key without installing a new one");
    expect(reasonOf({ type: "op-key", installed: [], revoked: [] }, opSeed, FAKE_OP_KID)).toBe("op-key: changes no key");

    // The real rotation: root evidence for both acts, signed by the new key.
    const rotated = await appendEntry(path, nextDraft(WORD, head, rotation, ZERO_SPEND, "citizen-signed", T0), newSigner);
    const beat = await appendEntry(path, nextDraft(WORD, rotated, beatBody(WORD, []), ZERO_SPEND, "citizen-signed", T0), newSigner);
    const after = await readLedger(path);
    expect([...pinnedOpKeys(after, rotated.seq)]).toEqual([[newKid, newPub]]);
    expect(verifyChain(after, trusted)).toMatchObject({ ok: true, head: beat.hash });

    // The retired op key signs nothing after its rotation.
    await expect(appendEntry(path, nextDraft(WORD, beat, beatBody(WORD, []), ZERO_SPEND, "citizen-signed", T0), signerFn(signer))).rejects.toMatchObject({ code: "invalid-record" });
    expect(reasonOf(beatBody(WORD, []), opSeed, FAKE_OP_KID, after)).toBe("signing key is not a pinned op key");
    // Nor can it come back on its old proofs: genesis's import, or any sequence already spent.
    const reinstall = (seq: number): LedgerBody => ({
      type: "op-key",
      installed: [{ op_kid: FAKE_OP_KID, op_public_key_b64: signer.opPublicB64, evidence: seq === 1 ? genesisEvidence : importEvidence(id, signer.opPublicB64, { sequence: seq }) }],
      revoked: [],
    });
    expect(reasonOf(reinstall(1), opSeed, FAKE_OP_KID, after)).toBe("op-key: root evidence reuses an authority sequence already spent");
    expect(reasonOf(reinstall(3), opSeed, FAKE_OP_KID, after)).toBe("op-key: root evidence reuses an authority sequence already spent");
    expect(reasonOf(reinstall(4), opSeed, FAKE_OP_KID, after)).toBeNull();
  });

  test("an op-key entry that only revokes is root-evidenced and signed by a key that stays", async () => {
    const { host, signer, path } = await setup();
    const entries = await seatedThenBorn(host.config, WORD, "soul", signer);
    const trusted: TrustedKeys = { host_attest_b64: [signer.hostAttestPublicB64] };
    const id = testIdentity(signer);
    const opSeed = fromHex(TEST_OP_SEED_HEX);
    const secondSeed = sha256("kingdom-seat test op key v2");
    const secondKid = "77777777-7777-4777-8777-777777777777";
    const secondPub = toB64(edPublicKey(secondSeed));
    const secondSigner: EntrySigner = async (_w, hash) => ({ alg: "ed25519", kid: secondKid, public_key_b64: secondPub, sig_b64: toB64(edSign(hash, secondSeed)) });
    // A second key, installed without revoking the first: both are pinned.
    const added = await appendEntry(
      path,
      nextDraft(WORD, entries.at(-1) as LedgerEntry, { type: "op-key", installed: [{ op_kid: secondKid, op_public_key_b64: secondPub, evidence: importEvidence(id, secondPub, { sequence: 2 }) }], revoked: [] }, ZERO_SPEND, "citizen-signed", T0),
      secondSigner,
    );
    const both = await readLedger(path);
    expect([...pinnedOpKeys(both, added.seq)].map(([k]) => k).sort()).toEqual([FAKE_OP_KID, secondKid].sort());

    const revokeSecond: LedgerBody = { type: "op-key", installed: [], revoked: [{ op_kid: secondKid, evidence: revokeEvidence(id, secondKid, { sequence: 3 }) }] };
    const reasonOf = (body: LedgerBody, seed: Uint8Array, kid: string) =>
      verifyChain([...both, forge(nextDraft(WORD, added, body, ZERO_SPEND, "citizen-signed", T0), seed, kid)], trusted).problem?.reason ?? null;
    // The key being revoked does not sign its own revocation, and no revocation stands without the root.
    expect(reasonOf(revokeSecond, secondSeed, secondKid)).toBe("op-key is not signed by a key that stays");
    expect(reasonOf({ ...revokeSecond, revoked: [{ op_kid: secondKid, evidence: revokeEvidence(id, secondKid, { sequence: 3, rootSeed: opSeed }) }] }, opSeed, FAKE_OP_KID)).toBe(
      "op-key: root evidence is not signed by the root",
    );
    const withBody = { ...revokeEvidence(id, secondKid, { sequence: 3 }), body_b64: toB64(utf8("{}")) };
    expect(reasonOf({ ...revokeSecond, revoked: [{ op_kid: secondKid, evidence: withBody }] }, opSeed, FAKE_OP_KID)).toBe("op-key: root evidence revoke carries a body");
    expect(reasonOf({ ...revokeSecond, revoked: [{ op_kid: "99999999-9999-4999-8999-999999999999", evidence: revokeEvidence(id, "99999999-9999-4999-8999-999999999999", { sequence: 3 }) }] }, opSeed, FAKE_OP_KID)).toBe(
      "op-key: revokes a key that is not pinned",
    );

    await appendEntry(path, nextDraft(WORD, added, revokeSecond, ZERO_SPEND, "citizen-signed", T0), signerFn(signer));
    const after = await readLedger(path);
    expect([...pinnedOpKeys(after, after.length - 1)]).toEqual([[FAKE_OP_KID, signer.opPublicB64]]);
    expect(verifyChain(after, trusted).ok).toBe(true);
  });

  test("an op-key entry needs genesis before it", async () => {
    const { host, signer, path } = await setup();
    const e0 = await append(host.config, WORD, seatedBody(WORD, "soul"), "host-attested", signer, T0);
    const id = testIdentity(signer);
    const body: LedgerBody = { type: "op-key", installed: [{ op_kid: FAKE_OP_KID, op_public_key_b64: signer.opPublicB64, evidence: importEvidence(id, signer.opPublicB64) }], revoked: [] };
    await expect(appendEntry(path, nextDraft(WORD, e0, body, ZERO_SPEND, "citizen-signed", T0), signerFn(signer))).rejects.toMatchObject({ code: "invalid-record" });
    const forged = forge(nextDraft(WORD, e0, body, ZERO_SPEND, "citizen-signed", T0), fromHex(TEST_OP_SEED_HEX), FAKE_OP_KID);
    expect(verifyChain([e0, forged], { host_attest_b64: [signer.hostAttestPublicB64] }).problem).toEqual({ seq: 1, reason: "op-key: before genesis" });
  });

  test("a citizen born at seating starts with genesis carrying its initial state", async () => {
    const { host, signer, path } = await setup();
    await append(host.config, WORD, genesisBody(WORD, "soul", testIdentity(signer), "asleep"), "citizen-signed", signer, T0);
    expect(verifyChain(await readLedger(path), { host_attest_b64: [] }).ok).toBe(true);
    // A first genesis without an initial state is refused.
    const other = ledgerPath(host.config, "shemme");
    await expect(appendEntry(other, nextDraft("shemme", null, genesisBody("shemme", "soul", testIdentity(signer)), ZERO_SPEND, "citizen-signed", T0), signerFn(signer))).rejects.toBeInstanceOf(
      Refusal,
    );
  });

  test("lastEntries returns the last k oldest-first", async () => {
    const { host, signer, path } = await setup();
    const all = await seatedThenBorn(host.config, WORD, "soul", signer);
    expect((await lastEntries(path, 3)).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((await lastEntries(path, 1)).map((e) => e.hash)).toEqual([(all[3] as LedgerEntry).hash]);
    expect((await lastEntries(path, 10)).length).toBe(4);
    expect(await lastEntries(path, 0)).toEqual([]);
    expect(await lastEntries(ledgerPath(host.config, "nobody"), 3)).toEqual([]);
  });

  test("voicedThrough reads '<word>, voiced through <model> in seat <id>'", () => {
    const body = beatBody(WORD, [], { seat_id: "9f1c2b3a-0000-4000-8000-000000000001" });
    if (body.type !== "beat") throw new Error("fixture");
    expect(voicedThrough(body.envelope)).toBe("glossame, voiced through qwen2.5:7b in seat 9f1c2b3a-0000-4000-8000-000000000001");
  });
});
