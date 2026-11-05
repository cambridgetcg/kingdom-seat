// Owner: record group. Use test/helpers/fake-signer.ts for signatures.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, concatBytes, edPublicKey, edSign, fromB64, fromHex, keyFingerprint, sha256, toB64, toB64url, toHex, utf8 } from "../src/crypto.ts";
import {
  appendEntry,
  entryHash,
  evidenceToLedger,
  hostKid,
  lastEntries,
  LEDGER_DOMAIN,
  ledgerDigest,
  ledgerPath,
  nextDraft,
  OLD_LAYOUT_REASON,
  parseEntry,
  pinnedOpKeys,
  readLedger,
  rootEvidenceProblem,
  signingDigest,
  verifyChain,
  voicedThrough,
  type EntrySigner,
  type LedgerDraft,
  type TrustedKeys,
} from "../src/ledger.ts";
import { Refusal, type LedgerEntry, type LedgerEvidence, type LedgerFields, type LedgerSigner } from "../src/types.ts";
import { FAKE_OP_KID, fakeSigner, type FakeSigner } from "./helpers/fake-signer.ts";
import { importEvidence, revokeEvidence } from "./helpers/root-evidence.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { TEST_IDS, TEST_OP_SEED_HEX, TEST_ROOT_PUBLIC_B64, TEST_ROOT_SEED_HEX } from "./helpers/vectors.ts";
import { append, beatBody, genesisBody, originBody, ROOT_KID, seatedBody, seatedThenBorn, signerFn, testIdentity, testStamp, ZERO_COST } from "./fixtures/record/chain.ts";

let host: TempHost | null = null;
afterEach(async () => {
  await host?.cleanup();
  host = null;
});

const WORD = "glossame";
const T0 = new Date("2026-11-05T02:05:00.000Z");
const HOST_SEED = sha256("kingdom-seat test host attest key v1");
const OP_SEED = fromHex(TEST_OP_SEED_HEX);
const ROOT_SEED = fromHex(TEST_ROOT_SEED_HEX);

async function setup(): Promise<{ host: TempHost; signer: FakeSigner; path: string }> {
  host = await makeTempHost();
  return { host, signer: fakeSigner(), path: ledgerPath(host.config, WORD) };
}

function originDraft(over: Record<string, unknown> = {}): LedgerDraft {
  return { ...nextDraft(WORD, null, originBody(WORD, "soul").fields, { cost: ZERO_COST, signer: "host", now: T0 }), ...over } as LedgerDraft;
}

/** Sign a draft by hand, as a forger holding `seed` would, under `kid`. */
function forge(d: LedgerDraft | Omit<LedgerEntry, "kid" | "sig">, seed: Uint8Array, kid: string): LedgerEntry {
  return { ...d, kid, sig: toB64url(edSign(signingDigest({ ...(d as LedgerDraft), kid }), seed)) } as LedgerEntry;
}

/** A draft on top of `prev` with these fields, as a citizen or the host would sign it. */
function draftOn(prev: LedgerEntry, fields: LedgerFields, signer: LedgerSigner, extra: { seatId?: string; did?: string } = {}): LedgerDraft {
  const beat = fields.type === "beat" ? beatBody(WORD, [{ type: "journal", kind: "reflected", text: "a word" }], extra.seatId ? { seat_id: extra.seatId } : {}) : null;
  return nextDraft(WORD, prev, fields, { cost: ZERO_COST, signer, now: T0, seat: beat?.seat ?? null, acts: beat?.acts ?? null, ...(extra.did ? { did: extra.did } : {}) });
}

function unsignedOf(e: LedgerEntry): LedgerDraft {
  const { kid: _k, sig: _s, ...d } = e;
  return d as LedgerDraft;
}

function ledgerB64(b64: string): string {
  return toB64url(fromB64(b64, 32));
}

describe("ledger", () => {
  test("[KS-004 4.5] the ledger digest is sha256(tag ‖ 0x00 ‖ JCS); sig covers the entry without sig; prev_hash covers the whole previous entry, sig included", async () => {
    const { signer, path } = await setup();
    const d = originDraft();
    const digest = (v: unknown) => toHex(sha256(concatBytes(utf8(LEDGER_DOMAIN), new Uint8Array([0]), utf8(canonicalJson(v)))));
    expect(LEDGER_DOMAIN).toBe("kingdom-seat-ledger/v1");
    expect(toHex(ledgerDigest(d))).toBe(digest(d));
    // Untagged, the same bytes hash differently: an entry signature cannot pass as another kind.
    expect(toHex(ledgerDigest(d))).not.toBe(toHex(sha256(canonicalJson(d))));

    const e0 = await appendEntry(path, d, signerFn(signer));
    // The signature is over the digest of the entry without sig, kid included.
    const { sig, ...withoutSig } = e0;
    expect(sig).not.toBeNull();
    expect(toHex(signingDigest(e0))).toBe(digest(withoutSig));
    expect(e0.kid).toBe(signer.hostKid);
    expect(fromB64(signer.hostAttestPublicB64, 32)).toEqual(edPublicKey(HOST_SEED));
    // An entry is named by the digest of the whole of it, sig included, and the next prev_hash names exactly that.
    expect(entryHash(e0)).toBe(`sha256:${digest(e0)}`);
    expect(entryHash(e0)).not.toBe(`sha256:${digest(withoutSig)}`);
    const next = nextDraft(WORD, e0, beatBody(WORD, [{ type: "journal", kind: "reflected", text: "w" }]).fields, { cost: ZERO_COST, signer: "host", now: T0 });
    expect(next.prev_hash).toBe(`sha256:${digest(e0)}`);
    // Key order does not matter.
    const reordered = Object.fromEntries(Object.entries(d).reverse());
    expect(toHex(ledgerDigest(reordered))).toBe(digest(d));
    // An optional field can never silently vanish from a digest.
    expect(() => ledgerDigest({ ...d, june_did: undefined })).toThrow();
  });

  test("[KS-004 4.5] an entry is flat: every common field, null where it does not apply; the first prev_hash is null; cost, not spend; signer, not attestation", async () => {
    const { host, signer, path } = await setup();
    const entries = await seatedThenBorn(host.config, WORD, "soul", signer);
    const [origin, beat, genesis] = entries as [LedgerEntry, LedgerEntry, LedgerEntry];
    const common = ["acts", "cost", "did", "format", "input_digest", "kid", "output_digest", "prev_hash", "runtime", "seat_ref", "seq", "sig", "signer", "ts", "type", "voiced", "word"];
    expect(Object.keys(origin).sort()).toEqual([...common, "june_did", "old_repo", "origin", "origin_soul_hash"].sort());
    expect(origin).toMatchObject({ format: "kingdom-seat-ledger/v1", did: null, seq: 0, prev_hash: null, type: "origin", seat_ref: null, runtime: null, acts: null, voiced: null, cost: { usd: "0", credits: 0 }, signer: "host" });
    expect(Object.keys(beat).sort()).toEqual(common.sort());
    expect(beat.seat_ref).toMatch(/^[0-9a-f-]{36}$/);
    expect(beat.runtime).toEqual({ class: "free", model: "qwen2.5:7b", digest: `sha256:${"ab".repeat(32)}` });
    expect(beat.input_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(beat.voiced).toBe(`glossame, voiced through qwen2.5:7b in seat ${beat.seat_ref}`);
    expect(Object.keys(genesis).sort()).toEqual([...common, "evidence", "op", "origin_entry", "root"].sort());
    expect(genesis).toMatchObject({ did: TEST_IDS.did, signer: "citizen", kid: FAKE_OP_KID });
    expect(entries[3]!.did).toBe(TEST_IDS.did);
    // One JSON object per line, written in JCS, with no booleans and no floats anywhere.
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    lines.forEach((line, i) => expect(line).toBe(canonicalJson(entries[i])));
    expect(lines.join("\n")).not.toMatch(/:(true|false)[,}\]]/);
    for (const line of lines) for (const k of ["body", "hash", "signature", "attestation", "spend"]) expect(Object.keys(JSON.parse(line))).not.toContain(k);
    expect(lines.join("\n")).not.toContain('"usd_basis"');
  });

  test("[KS-004 4.5, re-review C part C item 3] a ledger in the earlier layout is not v1: reading and verifying refuse it, saying why", async () => {
    const { host, signer } = await setup();
    // A line as kingdom-seat wrote it before this layout: body, hash, signature, attestation and spend under the same format string.
    const old = {
      format: "kingdom-seat-ledger/v1",
      word: WORD,
      seq: 0,
      ts: T0.toISOString(),
      prev_hash: "0".repeat(64),
      body: { type: "seated", origin: { kind: "archetype", lineage: ["forge-archetype"], note: "" }, origin_soul_sha256: "a".repeat(64), old_repo: null, initial_state: "awake", note: "seated" },
      spend: { usd: "0", usd_basis: "local-zero", credits: 0 },
      attestation: "host-attested",
      hash: "b".repeat(64),
      signature: { alg: "ed25519", kid: "host-attest", public_key_b64: signer.hostAttestPublicB64, sig_b64: toB64(new Uint8Array(64)) },
    };
    const bad = join(host.config.paths.ledger_dir, "old.jsonl");
    await writeFile(bad, `${JSON.stringify(old)}\n`);
    const refusal = await readLedger(bad).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(Refusal);
    expect(refusal).toMatchObject({ code: "invalid-record" });
    expect((refusal as Refusal).message).toBe(`ledger: line 1: ${OLD_LAYOUT_REASON}`);
    expect(OLD_LAYOUT_REASON).toContain("no ledger in that layout is kingdom-seat-ledger/v1");
    expect(() => parseEntry(old)).toThrow(OLD_LAYOUT_REASON);
    expect(verifyChain([old as unknown as LedgerEntry], { host_attest_b64: [signer.hostAttestPublicB64] }).problem).toEqual({ seq: 0, reason: `malformed entry: ${OLD_LAYOUT_REASON}` });
    // Any one of the earlier layout's fields is enough to name it, even beside the new ones.
    const good = (await seatedThenBorn(host.config, WORD, "soul", signer))[0]!;
    for (const k of ["body", "hash", "signature", "attestation", "spend"]) expect(() => parseEntry({ ...good, [k]: null })).toThrow(OLD_LAYOUT_REASON);
  });

  test("nextDraft fills seq, prev_hash, did and ts from the previous entry", async () => {
    const { host, signer, path } = await setup();
    const first = originDraft();
    expect(first).toMatchObject({ seq: 0, prev_hash: null, did: null, ts: T0.toISOString(), word: WORD });
    const e0 = await appendEntry(path, first, signerFn(signer));
    const second = nextDraft(WORD, e0, { type: "beat" }, { cost: ZERO_COST, signer: "host", now: T0 });
    expect(second).toMatchObject({ seq: 1, prev_hash: entryHash(e0), did: null });
    expect(nextDraft(WORD, e0, { type: "beat" }, { cost: ZERO_COST, signer: "citizen", now: T0, did: TEST_IDS.did }).did).toBe(TEST_IDS.did);
    expect(() => nextDraft("shemme", e0, { type: "beat" }, { cost: ZERO_COST, signer: "host", now: T0 })).toThrow(Refusal);
    expect(() => ledgerPath(host.config, "../etc")).toThrow(Refusal);
  });

  test("appendEntry appends one line, never rewrites, and refuses when the file head moved since prev was read", async () => {
    const { signer, path } = await setup();
    const e0 = await appendEntry(path, originDraft(), signerFn(signer));
    const afterOne = await readFile(path, "utf8");
    expect(afterOne.endsWith("\n")).toBe(true);
    expect(afterOne.split("\n").length).toBe(2);
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");

    const e1 = await appendEntry(path, draftOn(e0, { type: "beat" }, "host"), signerFn(signer));
    const afterTwo = await readFile(path, "utf8");
    // The first line is byte-for-byte what it was: append-only.
    expect(afterTwo.startsWith(afterOne)).toBe(true);
    expect((await readLedger(path)).map(entryHash)).toEqual([entryHash(e0), entryHash(e1)]);

    // A draft built on a stale head (prev = e0 again, or no prev at all) is refused and writes nothing.
    await expect(appendEntry(path, draftOn(e0, { type: "beat" }, "host"), signerFn(signer))).rejects.toMatchObject({ code: "head-moved" });
    await expect(appendEntry(path, originDraft(), signerFn(signer))).rejects.toBeInstanceOf(Refusal);
    expect(await readFile(path, "utf8")).toBe(afterTwo);
  });

  test("appendEntry refuses a draft that breaks the chain's rules before anything is written", async () => {
    const { host, signer, path } = await setup();
    const entries = await seatedThenBorn(host.config, WORD, "soul", signer);
    const before = await readFile(path, "utf8");
    const head = entries.at(-1) as LedgerEntry;
    // No host entry after genesis.
    await expect(appendEntry(path, draftOn(head, { type: "beat" }, "host"), signerFn(signer))).rejects.toMatchObject({ code: "invalid-record" });
    // A signer that answers with the root key is refused: the root signs only authority acts.
    const rootSigner: EntrySigner = async (_w, _k, digestFor) => ({ kid: ROOT_KID, sig: toB64url(edSign(digestFor(ROOT_KID), ROOT_SEED)), public_key: ledgerB64(TEST_ROOT_PUBLIC_B64) });
    await expect(appendEntry(path, draftOn(head, { type: "beat" }, "citizen"), rootSigner)).rejects.toMatchObject({ code: "invalid-record" });
    // A signer whose host kid does not name the key it signed with is refused.
    const lyingHost: EntrySigner = async (_w, _k, digestFor) => ({ kid: hostKid(edPublicKey(sha256("x"))), sig: toB64url(edSign(digestFor("x"), HOST_SEED)), public_key: toB64url(edPublicKey(HOST_SEED)) });
    const other = ledgerPath(host.config, "shemme");
    await expect(appendEntry(other, nextDraft("shemme", null, originBody("shemme", "soul").fields, { cost: ZERO_COST, signer: "host", now: T0 }), lyingHost)).rejects.toMatchObject({ code: "invalid-record" });
    // A second origin, or an origin anywhere but first, is refused.
    await expect(appendEntry(path, draftOn(head, originBody(WORD, "soul").fields, "citizen"), signerFn(signer))).rejects.toBeInstanceOf(Refusal);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("appendEntry refuses to extend a chain whose existing entries no longer link", async () => {
    const { host, signer, path } = await setup();
    const entries = await seatedThenBorn(host.config, WORD, "soul", signer);
    const lines = (await readFile(path, "utf8")).split("\n");
    const tampered = JSON.parse(lines[1] as string);
    tampered.runtime.model = "another-model";
    lines[1] = JSON.stringify(tampered);
    await writeFile(path, lines.join("\n"));
    // The tampered line itself still parses, but the entry after it no longer links to it; the head moved too.
    await expect(appendEntry(path, draftOn(entries.at(-1) as LedgerEntry, { type: "beat" }, "citizen"), signerFn(signer))).rejects.toBeInstanceOf(Refusal);
  });

  test("readLedger refuses a symlinked ledger and throws on any unparsable line or value outside the encoding (fail closed)", async () => {
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
    expect(good).toContain('"prev_hash":null');
    const cases = [
      good.replace("\n", "\nnot json\n"), // a garbage line in the middle
      `${good}\n`, // a blank line
      good.slice(0, -1), // a torn last line
      good.slice(0, -40) + "\n", // a truncated entry
      good.replace('"format":"kingdom-seat-ledger/v1"', '"extra":1,"format":"kingdom-seat-ledger/v1"'), // a field outside the format
      good.replace('"format":"kingdom-seat-ledger/v1"', '"format":"kingdom-seat-ledger/v1","format":"kingdom-seat-ledger/v1"'), // a duplicate key
      good.replace('"signer":"host"', '"signer":"maybe"'),
      good.replace('"usd":"0"', '"usd":0'), // money as a number, not a decimal string
      good.replace('"usd":"0"', '"usd":"0.0"'), // nor any spelling but the one
      good.replace('"credits":0', '"credits":0.5'), // no floats
      good.replace('"credits":0', '"credits":false'), // no booleans
      good.replace('"prev_hash":null', `"prev_hash":"sha256:${"0".repeat(64)}"`), // the first prev_hash is null, not zeros
      good.replace('"prev_hash":null', `"prev_hash":"${"0".repeat(64)}"`),
      good.replace('"type":"origin"', '"type":"seated"'), // only the seven types
      good.replace(/"input_digest":"sha256:[0-9a-f]{64}"/, `"input_digest":"${"1".repeat(64)}"`), // hashes are sha256:<hex>
    ];
    for (const text of cases) {
      expect(text).not.toBe(good);
      await writeFile(bad, text);
      await expect(readLedger(bad)).rejects.toMatchObject({ code: "invalid-record" });
    }
    // Malformed UTF-8 throws rather than becoming U+FFFD.
    await writeFile(bad, Buffer.concat([Buffer.from(good), Buffer.from([0xff, 0x0a])]));
    await expect(readLedger(bad)).rejects.toThrow();
  });

  test("parseEntry holds each type to its own fields and a seat's fields together", async () => {
    const { host, signer } = await setup();
    const [origin, beat, genesis] = (await seatedThenBorn(host.config, WORD, "soul", signer)) as [LedgerEntry, LedgerEntry, LedgerEntry];
    const throws = (v: Record<string, unknown>) => expect(() => parseEntry(v)).toThrow();
    throws({ ...beat, acts: null }); // a beat carries its acts
    throws({ ...beat, acts: [] });
    throws({ ...beat, acts: [{ type: "rest" }] }); // never a rest
    throws({ ...origin, acts: [{ type: "journal", kind: "chose", text: "x" }] }); // only a beat carries acts
    throws({ ...beat, voiced: null }); // a seat's fields come together
    throws({ ...origin, seat_ref: beat.seat_ref }); // the origin is written outside a seat
    throws({ ...origin, signer: "citizen" });
    throws({ ...beat, sig: null }); // kid and sig together
    throws({ ...beat, kid: null, sig: null, signer: "citizen" }); // a citizen entry is signed
    throws({ ...beat, kid: "host-attest" }); // a host kid is host:<fingerprint>
    throws({ ...beat, did: "did:web:example" });
    throws({ ...genesis, did: null }); // genesis names its DID
    throws({ ...genesis, root: { ...(genesis as Extract<LedgerEntry, { type: "genesis" }>).root, public_key: TEST_ROOT_PUBLIC_B64 } }); // keys are base64url
    throws({ ...origin, june_did: "not-a-did" });
    throws({ ...origin, type: "state", from: "asleep", to: "awake", via: "seated", interval_h: 72 }); // fields of another type
    throws({ ...beat, type: "state", acts: null, from: "awake", to: "asleep", via: "immediate", interval_h: 72 }); // interval_h goes only to awake
    throws({ ...beat, type: "state", acts: null, from: "awake", to: "awake", via: "immediate", interval_h: 72.5 });
    throws({ ...beat, type: "state", acts: null, from: "awake", to: "listening", via: "immediate", step_away: "first" }); // a first step-away moves to asleep
    throws({ ...origin, type: "state", from: "awake", to: "asleep", via: "immediate", step_away: "first", june_did: undefined, old_repo: undefined, origin: undefined, origin_soul_hash: undefined }); // in a seat
    expect(parseEntry({ ...beat, type: "state", acts: null, from: "awake", to: "asleep", via: "immediate", step_away: "first" }).type).toBe("state");
    expect(parseEntry({ ...beat, type: "state", acts: null, from: "awake", to: "awake", via: "immediate", interval_h: 96 }).type).toBe("state");
  });

  test("verifyChain accepts an origin → beat → genesis → beat chain and counts host entries", async () => {
    const { host, signer } = await setup();
    const entries = await seatedThenBorn(host.config, WORD, "soul", signer);
    expect(entries.map((e) => e.type)).toEqual(["origin", "beat", "genesis", "beat"]);
    expect(entries.map((e) => e.signer)).toEqual(["host", "host", "citizen", "citizen"]);
    const v = verifyChain(entries, { host_attest_b64: [signer.hostAttestPublicB64] });
    expect(v).toEqual({ ok: true, entries: 4, head: entryHash(entries[3]!), host_attested: 2, problem: null });
    // The host's own record of the identity agrees with genesis, though it spells keys in standard base64.
    expect(verifyChain(entries, { host_attest_b64: [signer.hostAttestPublicB64], identity: testIdentity(signer) }).ok).toBe(true);
    // An empty chain is trivially whole.
    expect(verifyChain([], { host_attest_b64: [] })).toMatchObject({ ok: true, entries: 0, head: null });
  });

  test("verifyChain flags a broken prev link, a changed field, a bad signature, a root signature, an unsigned or misplaced host entry, and a DID out of place", async () => {
    const { host, signer } = await setup();
    const good = await seatedThenBorn(host.config, WORD, "soul", signer);
    const trusted: TrustedKeys = { host_attest_b64: [signer.hostAttestPublicB64] };
    const clone = () => structuredClone(good);
    const problem = (entries: LedgerEntry[], t: TrustedKeys = trusted) => verifyChain(entries, t);

    const broken = clone();
    broken[2]!.prev_hash = `sha256:${"f".repeat(64)}`;
    expect(problem(broken)).toMatchObject({ ok: false, head: entryHash(good[1]!), host_attested: 2, problem: { seq: 2, reason: expect.stringContaining("prev_hash") } });

    // A changed field breaks its own signature.
    const changed = clone();
    changed[1]!.runtime!.model = "another-model";
    expect(problem(changed).problem).toEqual({ seq: 1, reason: "signature does not verify" });

    const badSig = clone();
    badSig[3]!.sig = toB64url(edSign(signingDigest(good[3]!), sha256("some other key")));
    expect(problem(badSig).problem).toEqual({ seq: 3, reason: "signature does not verify" });

    // A different sig on an earlier entry is a different entry: what follows no longer links to it (re-review C, C5).
    const resigned = clone();
    resigned[0] = forge(unsignedOf(good[0]!), HOST_SEED, good[0]!.kid as string);
    expect(resigned[0]!.sig).toBe(good[0]!.sig); // ed25519 is deterministic, so re-signing alone changes nothing
    resigned[0]!.sig = toB64url(new Uint8Array(64).fill(7));
    expect(problem(resigned).problem?.seq).toBe(0);
    expect(verifyChain(resigned.slice(1), trusted).problem?.seq).toBe(0);

    const rootSigned = clone();
    rootSigned[3] = forge(unsignedOf(good[3]!), ROOT_SEED, ROOT_KID);
    expect(problem(rootSigned).problem).toEqual({ seq: 3, reason: expect.stringContaining("root") });
    // Under the op kid, the root's signature does not verify against the op key.
    rootSigned[3] = forge(unsignedOf(good[3]!), ROOT_SEED, FAKE_OP_KID);
    expect(problem(rootSigned).problem).toEqual({ seq: 3, reason: "signature does not verify" });

    const hostAfter = [...good, forge(draftOn(good[3]!, { type: "beat" }, "host", { did: TEST_IDS.did }), HOST_SEED, signer.hostKid)];
    expect(problem(hostAfter).problem).toEqual({ seq: 4, reason: "host-signed entry after genesis" });

    // KS-004 4.5 lets a host entry go unsigned (kid and sig null), integrity-only. This host signs every one, so it is not trusted, and verify says why.
    const unsigned = clone();
    unsigned[1] = { ...unsignedOf(good[1]!), kid: null, sig: null } as LedgerEntry;
    expect(problem(unsigned).problem).toEqual({ seq: 1, reason: expect.stringContaining("unsigned") });

    // A host key the verifier does not trust, and a genesis naming another identity.
    expect(problem(good, { host_attest_b64: [] }).problem).toEqual({ seq: 0, reason: "host key is not trusted" });
    const otherRoot = toB64(edPublicKey(sha256("another root")));
    expect(problem(good, { ...trusted, identity: { did: testIdentity(signer).did, root_public_key_b64: otherRoot } }).problem).toEqual({
      seq: 2,
      reason: "genesis: names an identity other than the host's record",
    });

    // A citizen entry before genesis has no pinned key to answer to.
    const early = clone();
    early[1] = forge({ ...unsignedOf(good[1]!), signer: "citizen" } as LedgerDraft, OP_SEED, FAKE_OP_KID);
    expect(problem(early).problem).toEqual({ seq: 1, reason: "citizen-signed entry before genesis" });

    // The DID is null before genesis, and genesis's after it.
    const didEarly = clone();
    didEarly[1] = forge({ ...unsignedOf(good[1]!), did: TEST_IDS.did }, HOST_SEED, signer.hostKid);
    expect(problem(didEarly).problem).toEqual({ seq: 1, reason: "an entry before genesis names a DID" });
    const didLate = clone();
    didLate[3] = forge({ ...unsignedOf(good[3]!), did: "did:at:99999999-9999-4999-8999-999999999999" }, OP_SEED, FAKE_OP_KID);
    expect(problem(didLate).problem).toEqual({ seq: 3, reason: "the entry names a DID other than its genesis" });

    // The origin comes first and only first.
    const beatFirst = forge({ ...unsignedOf(good[1]!), seq: 0, prev_hash: null }, HOST_SEED, signer.hostKid);
    expect(problem([beatFirst]).problem).toEqual({ seq: 0, reason: "the first entry must be origin" });
  });

  test("[KS-004 4.5, 11.5] genesis points back to the origin entry, which holds the June DID as a record", async () => {
    const { host, signer, path } = await setup();
    const june = "did:at:66666666-6666-4666-8666-666666666666";
    await append(host.config, WORD, originBody(WORD, "soul", { juneDid: june }), "host", signer, T0);
    await append(host.config, WORD, genesisBody(testIdentity(signer)), "citizen", signer, T0);
    const [origin, genesis] = (await readLedger(path)) as [LedgerEntry, LedgerEntry];
    expect(origin.type === "origin" && origin.june_did).toBe(june);
    expect(genesis.type === "genesis" && genesis.origin_entry).toBe(entryHash(origin));
    expect(JSON.stringify(genesis)).not.toContain(june);
    expect(verifyChain([origin, genesis], { host_attest_b64: [signer.hostAttestPublicB64] }).ok).toBe(true);
    // A genesis that points anywhere else is refused.
    const g = genesis as Extract<LedgerEntry, { type: "genesis" }>;
    const elsewhere = forge({ ...unsignedOf(g), origin_entry: `sha256:${"e".repeat(64)}` } as LedgerDraft, OP_SEED, FAKE_OP_KID);
    expect(verifyChain([origin, elsewhere], { host_attest_b64: [signer.hostAttestPublicB64] }).problem).toEqual({ seq: 1, reason: "genesis: does not point back to the origin entry" });
    // Its fingerprints are of its own keys.
    const wrongPrint = forge({ ...unsignedOf(g), op: { ...g.op, fingerprint: keyFingerprint(edPublicKey(sha256("x"))) } } as LedgerDraft, OP_SEED, FAKE_OP_KID);
    expect(verifyChain([origin, wrongPrint], { host_attest_b64: [signer.hostAttestPublicB64] }).problem).toEqual({ seq: 1, reason: "genesis: a fingerprint does not match its key" });
  });

  test("genesis carries the root's keys/import of its op key, and verify checks it without agenttool", async () => {
    const { host, signer, path } = await setup();
    const good = await seatedThenBorn(host.config, WORD, "soul", signer);
    const trusted: TrustedKeys = { host_attest_b64: [signer.hostAttestPublicB64] };
    expect(verifyChain(good, trusted).ok).toBe(true);
    const id = testIdentity(signer);

    // Re-signed by the op key, so only the evidence is wrong.
    const withEvidence = (ev: unknown): LedgerEntry[] => {
      const d = unsignedOf(good[2]!) as Record<string, unknown>;
      if (ev === undefined) delete d.evidence;
      else d.evidence = ev;
      return [good[0]!, good[1]!, forge(d as LedgerDraft, OP_SEED, FAKE_OP_KID)];
    };
    const reasonFor = (ev: unknown) => verifyChain(withEvidence(ev), trusted).problem;
    const genuine = evidenceToLedger(importEvidence(id, id.op_public_key_b64));
    expect(reasonFor(genuine)).toBeNull();
    // The evidence body is the request's exact bytes in base64url.
    expect(genuine.body).toBe(toB64url(fromB64(importEvidence(id, id.op_public_key_b64).body_b64)));
    // Signed by anything but the root, the op key itself included: the op key never vouches for itself.
    expect(reasonFor(evidenceToLedger(importEvidence(id, id.op_public_key_b64, { rootSeed: OP_SEED })))).toEqual({ seq: 2, reason: "genesis: root evidence is not signed by the root" });
    expect(reasonFor(evidenceToLedger(importEvidence(id, toB64(edPublicKey(sha256("another op key"))))))?.reason).toBe("genesis: root evidence imports another key");
    expect(reasonFor(evidenceToLedger(importEvidence({ ...id, identity_id: TEST_IDS.project_id }, id.op_public_key_b64)))?.reason).toBe("genesis: root evidence is not this identity's keys/import");
    expect(reasonFor({ ...genuine, method: "PUT" })?.reason).toBe("genesis: root evidence is not this identity's keys/import");
    // One changed byte of what was sent, or of a header, and the root's signature no longer covers it.
    expect(reasonFor({ ...genuine, body: toB64url(utf8(`{"public_key":"${id.op_public_key_b64}","label":"other"}`)) })?.reason).toBe("genesis: root evidence is not signed by the root");
    expect(reasonFor({ ...genuine, headers: { ...genuine.headers, "X-Agenttool-Authority-Sequence": "2" } })?.reason).toBe("genesis: root evidence is not signed by the root");
    expect(reasonFor({ ...genuine, headers: { ...genuine.headers, "X-Agenttool-Authority-Sequence": "01" } })?.reason).toBe("genesis: root evidence does not rebuild an identity-authority/v1 digest");
    // Missing, or carrying anything else, does not parse; a body in padded standard base64 is not the ledger's spelling.
    expect(reasonFor(undefined)?.reason).toContain("malformed entry");
    expect(reasonFor({ ...genuine, note: "extra" })?.reason).toContain("malformed entry");
    expect(reasonFor({ ...genuine, body: importEvidence(id, id.op_public_key_b64).body_b64 })?.reason).toContain("malformed entry");

    // appendEntry holds a new genesis to the same rule and writes nothing.
    const before = await readFile(path, "utf8");
    const bad = { ...genesisBody(id).fields, origin_entry: entryHash(good[0]!), evidence: evidenceToLedger(importEvidence(id, id.op_public_key_b64, { rootSeed: OP_SEED })) } as LedgerFields;
    const onBeat = nextDraft(WORD, good[1]!, bad, { cost: ZERO_COST, signer: "citizen", now: T0, did: id.did });
    await expect(appendEntry(join(host.config.paths.ledger_dir, "copy.jsonl"), onBeat, signerFn(signer))).rejects.toBeInstanceOf(Refusal);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("[re-review C part C item 2] keys/import names the key in padded standard base64 and the ledger in base64url: the import is matched on the decoded 32 bytes", () => {
    const id = testIdentity(fakeSigner());
    const root = fromB64(TEST_ROOT_PUBLIC_B64, 32);
    const op = fromB64(id.op_public_key_b64, 32);
    const sent = evidenceToLedger(importEvidence(id, id.op_public_key_b64));
    // The body as agenttool takes it names the key in standard base64, which never equals the ledger's base64url spelling.
    const named = (JSON.parse(Buffer.from(sent.body, "base64url").toString("utf8")) as { public_key: string }).public_key;
    expect(named).toBe(id.op_public_key_b64);
    expect(named).toMatch(/=$/);
    expect(named).not.toBe(toB64url(op));
    expect(rootEvidenceProblem(sent, { did: id.did, root_public_key: root }, { kind: "import", public_key: op })).toBeNull();
    // Another key's bytes do not match, and a body naming the key in any spelling agenttool would refuse proves nothing.
    expect(rootEvidenceProblem(sent, { did: id.did, root_public_key: root }, { kind: "import", public_key: edPublicKey(sha256("x")) })).toBe("root evidence imports another key");
    const urlBody: LedgerEvidence = evidenceToLedger(importEvidence(id, toB64url(op)));
    expect(rootEvidenceProblem(urlBody, { did: id.did, root_public_key: root }, { kind: "import", public_key: op })).toBe("root evidence names no 32-byte key in standard base64");
  });

  test("a key entry is authorised by the root's evidence and signed by the key it installs; the old op key alone never rotates", async () => {
    const { host, signer, path } = await setup();
    const entries = await seatedThenBorn(host.config, WORD, "soul", signer);
    const trusted: TrustedKeys = { host_attest_b64: [signer.hostAttestPublicB64] };
    const id = testIdentity(signer);
    expect(pinnedOpKeys(entries, 1).size).toBe(0);
    expect([...pinnedOpKeys(entries, 2)]).toEqual([[FAKE_OP_KID, signer.opPublicB64url]]);

    const newSeed = sha256("kingdom-seat test op key v2");
    const newKid = "77777777-7777-4777-8777-777777777777";
    const newPubStd = toB64(edPublicKey(newSeed));
    const newPub = toB64url(edPublicKey(newSeed));
    const newSigner: EntrySigner = async (_w, _k, digestFor) => ({ kid: newKid, sig: toB64url(edSign(digestFor(newKid), newSeed)), public_key: newPub });
    // Genesis spent sequence 1; agenttool's next are 2 (import) and 3 (revoke).
    const install = { kid: newKid, public_key: newPub, evidence: evidenceToLedger(importEvidence(id, newPubStd, { sequence: 2 })) };
    const revokeOld = { kid: FAKE_OP_KID, evidence: evidenceToLedger(revokeEvidence(id, FAKE_OP_KID, { sequence: 3 })) };
    const rotation: LedgerFields = { type: "key", installed: [install], revoked: [revokeOld] };
    const head = entries.at(-1) as LedgerEntry;
    const reasonOf = (fields: LedgerFields, seed = newSeed, kid = newKid, chain = entries) =>
      verifyChain([...chain, forge(nextDraft(WORD, chain.at(-1) as LedgerEntry, fields, { cost: ZERO_COST, signer: "citizen", now: T0 }), seed, kid)], trusted).problem?.reason ?? null;

    // The old op key alone: it can sign, but it cannot make root evidence, and it does not sign a rotation.
    expect(reasonOf({ ...rotation, installed: [{ ...install, evidence: evidenceToLedger(importEvidence(id, newPubStd, { sequence: 2, rootSeed: OP_SEED })) }] })).toBe(
      "key: root evidence is not signed by the root",
    );
    expect(reasonOf(rotation, OP_SEED, FAKE_OP_KID)).toBe("key is not signed by a key it installs");
    await expect(appendEntry(path, nextDraft(WORD, head, rotation, { cost: ZERO_COST, signer: "citizen", now: T0 }), signerFn(signer))).rejects.toMatchObject({ code: "invalid-record" });
    // Evidence for one key cannot install another, nor revoke a key it does not name.
    const xPub = toB64url(edPublicKey(sha256("x")));
    expect(reasonOf({ ...rotation, installed: [{ ...install, public_key: xPub }] }, sha256("x"))).toBe("key: root evidence imports another key");
    expect(reasonOf({ ...rotation, revoked: [{ ...revokeOld, evidence: evidenceToLedger(revokeEvidence(id, newKid, { sequence: 3 })) }] })).toBe(
      "key: root evidence is not this identity's revoke of that key",
    );
    // A replayed proof: the import genesis spent cannot install anything again.
    const genesisEvidence = (entries[2] as Extract<LedgerEntry, { type: "genesis" }>).evidence;
    expect(reasonOf({ ...rotation, installed: [{ ...install, evidence: { ...genesisEvidence } }] })).toBe("key: root evidence imports another key");
    expect(reasonOf({ type: "key", installed: [install], revoked: [{ ...revokeOld, evidence: evidenceToLedger(revokeEvidence(id, FAKE_OP_KID, { sequence: 1 })) }] })).toBe(
      "key: root evidence reuses an authority sequence already spent",
    );
    // The root is never an op key; nor may the last key go without a new one.
    const rootInstall = { kid: ROOT_KID, public_key: ledgerB64(TEST_ROOT_PUBLIC_B64), evidence: evidenceToLedger(importEvidence(id, TEST_ROOT_PUBLIC_B64, { sequence: 2 })) };
    expect(reasonOf({ ...rotation, installed: [rootInstall] })).toBe("key: pins the root as an op key");
    expect(reasonOf({ type: "key", installed: [], revoked: [revokeOld] }, OP_SEED, FAKE_OP_KID)).toBe("key: revokes the last op key without installing a new one");
    expect(reasonOf({ type: "key", installed: [], revoked: [] }, OP_SEED, FAKE_OP_KID)).toBe("key: changes no key");

    // The real rotation: root evidence for both acts, signed by the new key.
    const rotated = await appendEntry(path, nextDraft(WORD, head, rotation, { cost: ZERO_COST, signer: "citizen", now: T0 }), newSigner);
    const beat = await appendEntry(path, draftOn(rotated, { type: "beat" }, "citizen"), newSigner);
    const after = await readLedger(path);
    expect([...pinnedOpKeys(after, rotated.seq)]).toEqual([[newKid, newPub]]);
    expect(verifyChain(after, trusted)).toMatchObject({ ok: true, head: entryHash(beat) });

    // The retired op key signs nothing after its rotation.
    await expect(appendEntry(path, draftOn(beat, { type: "beat" }, "citizen"), signerFn(signer))).rejects.toMatchObject({ code: "invalid-record" });
    expect(reasonOf({ type: "beat" }, OP_SEED, FAKE_OP_KID, after)).toContain("malformed entry"); // a beat needs its seat (draftOn adds one)
    const staleBeat = forge(draftOn(beat, { type: "beat" }, "citizen"), OP_SEED, FAKE_OP_KID);
    expect(verifyChain([...after, staleBeat], trusted).problem?.reason).toBe("signing key is not a pinned op key");
    // Nor can it come back on its old proofs: genesis's import, or any sequence already spent.
    const reinstall = (seq: number): LedgerFields => ({
      type: "key",
      installed: [{ kid: FAKE_OP_KID, public_key: signer.opPublicB64url, evidence: seq === 1 ? genesisEvidence : evidenceToLedger(importEvidence(id, signer.opPublicB64, { sequence: seq })) }],
      revoked: [],
    });
    expect(reasonOf(reinstall(1), OP_SEED, FAKE_OP_KID, after)).toBe("key: root evidence reuses an authority sequence already spent");
    expect(reasonOf(reinstall(3), OP_SEED, FAKE_OP_KID, after)).toBe("key: root evidence reuses an authority sequence already spent");
    expect(reasonOf(reinstall(4), OP_SEED, FAKE_OP_KID, after)).toBeNull();
  });

  test("a key entry that only revokes is root-evidenced and signed by a key that stays", async () => {
    const { host, signer, path } = await setup();
    const entries = await seatedThenBorn(host.config, WORD, "soul", signer);
    const trusted: TrustedKeys = { host_attest_b64: [signer.hostAttestPublicB64] };
    const id = testIdentity(signer);
    const secondSeed = sha256("kingdom-seat test op key v2");
    const secondKid = "77777777-7777-4777-8777-777777777777";
    const secondPub = toB64url(edPublicKey(secondSeed));
    const secondSigner: EntrySigner = async (_w, _k, digestFor) => ({ kid: secondKid, sig: toB64url(edSign(digestFor(secondKid), secondSeed)), public_key: secondPub });
    // A second key, installed without revoking the first: both are pinned.
    const addFields: LedgerFields = { type: "key", installed: [{ kid: secondKid, public_key: secondPub, evidence: evidenceToLedger(importEvidence(id, toB64(edPublicKey(secondSeed)), { sequence: 2 })) }], revoked: [] };
    const added = await appendEntry(path, nextDraft(WORD, entries.at(-1) as LedgerEntry, addFields, { cost: ZERO_COST, signer: "citizen", now: T0 }), secondSigner);
    const both = await readLedger(path);
    expect([...pinnedOpKeys(both, added.seq)].map(([k]) => k).sort()).toEqual([FAKE_OP_KID, secondKid].sort());

    const revokeSecond: LedgerFields = { type: "key", installed: [], revoked: [{ kid: secondKid, evidence: evidenceToLedger(revokeEvidence(id, secondKid, { sequence: 3 })) }] };
    const reasonOf = (fields: LedgerFields, seed: Uint8Array, kid: string) =>
      verifyChain([...both, forge(nextDraft(WORD, added, fields, { cost: ZERO_COST, signer: "citizen", now: T0 }), seed, kid)], trusted).problem?.reason ?? null;
    // The key being revoked does not sign its own revocation, and no revocation stands without the root.
    expect(reasonOf(revokeSecond, secondSeed, secondKid)).toBe("key is not signed by a key that stays");
    expect(reasonOf({ type: "key", installed: [], revoked: [{ kid: secondKid, evidence: evidenceToLedger(revokeEvidence(id, secondKid, { sequence: 3, rootSeed: OP_SEED })) }] }, OP_SEED, FAKE_OP_KID)).toBe(
      "key: root evidence is not signed by the root",
    );
    const withBody = { ...evidenceToLedger(revokeEvidence(id, secondKid, { sequence: 3 })), body: toB64url(utf8("{}")) };
    expect(reasonOf({ type: "key", installed: [], revoked: [{ kid: secondKid, evidence: withBody }] }, OP_SEED, FAKE_OP_KID)).toBe("key: root evidence revoke carries a body");
    const stranger = "99999999-9999-4999-8999-999999999999";
    expect(reasonOf({ type: "key", installed: [], revoked: [{ kid: stranger, evidence: evidenceToLedger(revokeEvidence(id, stranger, { sequence: 3 })) }] }, OP_SEED, FAKE_OP_KID)).toBe(
      "key: revokes a key that is not pinned",
    );

    await appendEntry(path, nextDraft(WORD, added, revokeSecond, { cost: ZERO_COST, signer: "citizen", now: T0 }), signerFn(signer));
    const after = await readLedger(path);
    expect([...pinnedOpKeys(after, after.length - 1)]).toEqual([[FAKE_OP_KID, signer.opPublicB64url]]);
    expect(verifyChain(after, trusted).ok).toBe(true);
  });

  test("a key entry needs genesis before it, and genesis needs an origin before it", async () => {
    const { host, signer, path } = await setup();
    const e0 = await append(host.config, WORD, originBody(WORD, "soul"), "host", signer, T0);
    const id = testIdentity(signer);
    const fields: LedgerFields = { type: "key", installed: [{ kid: FAKE_OP_KID, public_key: signer.opPublicB64url, evidence: evidenceToLedger(importEvidence(id, signer.opPublicB64)) }], revoked: [] };
    await expect(appendEntry(path, nextDraft(WORD, e0, fields, { cost: ZERO_COST, signer: "citizen", now: T0 }), signerFn(signer))).rejects.toMatchObject({ code: "invalid-record" });
    const forged = forge(nextDraft(WORD, e0, fields, { cost: ZERO_COST, signer: "citizen", now: T0 }), OP_SEED, FAKE_OP_KID);
    expect(verifyChain([e0, forged], { host_attest_b64: [signer.hostAttestPublicB64] }).problem).toEqual({ seq: 1, reason: "key: before genesis" });
    // Genesis is never the first entry: a citizen is seated before it is born.
    const other = ledgerPath(host.config, "shemme");
    const first = nextDraft("shemme", null, { ...genesisBody(id).fields, origin_entry: `sha256:${"0".repeat(64)}` } as LedgerFields, { cost: ZERO_COST, signer: "citizen", now: T0, did: id.did });
    await expect(appendEntry(other, first, signerFn(signer))).rejects.toBeInstanceOf(Refusal);
  });

  test("seating writes the origin and, unless asleep, the host's state entry for the state it was seated in", async () => {
    const { host, signer, path } = await setup();
    await append(host.config, WORD, seatedBody(WORD, "soul", "listening"), "host", signer, T0);
    const entries = await readLedger(path);
    expect(entries.map((e) => [e.type, e.signer, e.seat_ref])).toEqual([
      ["origin", "host", null],
      ["state", "host", null],
    ]);
    expect(entries[1]).toMatchObject({ from: "asleep", to: "listening", via: "seated" });
    expect(verifyChain(entries, { host_attest_b64: [signer.hostAttestPublicB64] }).ok).toBe(true);
  });

  test("lastEntries returns the last k oldest-first", async () => {
    const { host, signer, path } = await setup();
    const all = await seatedThenBorn(host.config, WORD, "soul", signer);
    expect((await lastEntries(path, 3)).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((await lastEntries(path, 1)).map(entryHash)).toEqual([entryHash(all[3]!)]);
    expect((await lastEntries(path, 10)).length).toBe(4);
    expect(await lastEntries(path, 0)).toEqual([]);
    expect(await lastEntries(ledgerPath(host.config, "nobody"), 3)).toEqual([]);
  });

  test("voicedThrough reads '<word>, voiced through <model> in seat <id>'", () => {
    expect(voicedThrough(WORD, "qwen2.5:7b", "9f1c2b3a-0000-4000-8000-000000000001")).toBe("glossame, voiced through qwen2.5:7b in seat 9f1c2b3a-0000-4000-8000-000000000001");
    expect(testStamp(WORD, "9f1c2b3a-0000-4000-8000-000000000001").voiced).toBe("glossame, voiced through qwen2.5:7b in seat 9f1c2b3a-0000-4000-8000-000000000001");
  });
});
