// Owner: signer group. The signer is the only Keychain reader; it never lets
// a key or bearer reach argv, env, files, logs or a response.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { authorityDigest, deriveIdentity, didFor, inboxDigest, thoughtDigestV2 } from "../../src/agenttool/wire.ts";
import { edPublicKey, edSign, edVerifyStrict, fromB64, fromB64url, fromHex, sha256, toB64, toB64url, toHex, utf8 } from "../../src/crypto.ts";
import { Refusal, type CitizenIdentity, type ConsentRecord, type KeychainItemName, type LedgerSigner, type ProposalText, type StandingAgreement, type YuPresence } from "../../src/types.ts";
import type { SpendSoFar } from "../../src/signer/ceilings.ts";
import { STANDING_DIR, STANDING_FORMAT, confirmYuPresent, proposalDigest, readStandingAgreements } from "../../src/signer/consent.ts";
import { realDeps } from "../../src/cli.ts";
import { AgenttoolError, importOpKey, type ClientDeps } from "../../src/agenttool/client.ts";
import {
  CITIZEN_QUIET_EXTENT,
  SignerNotSent,
  SignerSentUncertain,
  createSigner,
  verifyEntrySignature,
  type Signer,
  type SignerRequest,
} from "../../src/signer/signer.ts";
import { evidenceToLedger, hostKid, nextDraft, rootEvidenceProblem, signingDigest, type LedgerDraft } from "../../src/ledger.ts";
import { DAY_MS, testClock, type TestClock } from "../helpers/clock.ts";
import { assertNoSecretIn, fakeKeychain, type FakeKeychain } from "../helpers/fake-keychain.ts";
import { fetchVia, startFakeServer, type FakeServer, type RecordedRequest } from "../helpers/fake-server.ts";
import { makeTempHost, type TempHost } from "../helpers/temp-home.ts";
import { TEST_IDS, TEST_MNEMONIC, TEST_OP_PUBLIC_B64, TEST_OP_SEED_HEX, TEST_ROOT_PUBLIC_B64, TEST_ROOT_SEED_HEX, vectors } from "../helpers/vectors.ts";

/* ── Fixture ──────────────────────────────────────────────────────────── */

const NOW = "2026-11-05T12:00:00.000Z";
const OP_KID = vectors.op_key.placeholder_kid;
const ROOT_KID = TEST_IDS.root_signing_key_id;
const ID = TEST_IDS.identity_id;
const DID = TEST_IDS.did;
const HERALD_ID = "77777777-7777-4777-8777-777777777777";
const GARDENER_ID = "88888888-8888-4888-8888-888888888888";
const HERALD_MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const COMMONS_BEARER = "at_test_commons_bearer_never_real_01";
const HERALD_BEARER = "at_test_herald_bearer_never_real_02";
const HOST_SEED = sha256("kingdom-seat test host attest key v1");
const BEACON_UNTIL = "2999-12-31T00:00:00.000Z";

const herald = deriveIdentity(HERALD_MNEMONIC);
const HERALD_ROOT_B64 = toB64(herald.root_public);

const GLOSSAME_IDENTITY: CitizenIdentity = {
  did: DID,
  identity_id: ID,
  project_id: TEST_IDS.project_id,
  root_public_key_b64: TEST_ROOT_PUBLIC_B64,
  root_kid: ROOT_KID,
  op_kid: OP_KID,
  op_public_key_b64: TEST_OP_PUBLIC_B64,
  box_public_key_b64: vectors.derivation.box_pub_b64,
  self_strand_id: TEST_IDS.strand_id,
  enrolled_at: "2026-11-05T00:00:00.000Z",
};

/** An unsigned ledger entry for `word`, as appendEntry hands it to the signer: a beat with one journal act. */
function draftOf(word: string, signer: LedgerSigner, text = "an entry"): LedgerDraft {
  return nextDraft(word, null, { type: "beat" }, { cost: { usd: "0", credits: 0 }, signer, now: new Date(NOW), acts: [{ type: "journal", kind: "reflected", text }] });
}

/** Secrets the keychain never stores directly but the signer derives; none may leave either. */
const DERIVED_SECRETS = [
  fromHex(TEST_ROOT_SEED_HEX),
  fromB64(vectors.derivation.k_master_b64),
  fromB64(vectors.derivation.box_priv_b64),
  HOST_SEED,
  herald.root_seed,
  herald.k_master,
];

interface Fixture {
  host: TempHost;
  server: FakeServer;
  clock: TestClock;
  kc: FakeKeychain;
  signer: Signer;
  /** What spendSoFar answers; replace per test. */
  spend: (word: string) => Promise<SpendSoFar>;
  agreements: StandingAgreement[];
  /** Server-side authority sequence per identity id. */
  seq: Map<string, number>;
  /** Every buffer the keychain handed out, to prove each was wiped. */
  handedOut: Uint8Array[];
  thoughtNonce: Uint8Array | null;
}

let fx: Fixture;

async function writeCitizenRecord(host: TempHost, word: string, identity: CitizenIdentity | null): Promise<void> {
  const path = join(host.config.paths.citizens_dir, word, "citizen.json");
  const record = {
    format: "kingdom-seat-citizen/v1",
    word,
    origin: { kind: "archetype", lineage: ["forge-archetype", word], note: "test" },
    runtime: "free",
    identity,
    mirror: null,
    seated_at: "2026-11-05T00:00:00.000Z",
  };
  await writeFile(path, JSON.stringify(record, null, 2));
}

const rootOf = new Map<string, string>([
  [ID, TEST_ROOT_PUBLIC_B64],
  [HERALD_ID, HERALD_ROOT_B64],
]);

/** A stand-in for agenttool's sequence wall: a proof must carry current + 1, and is claimed before the route's own write. */
function serveAgenttool(server: FakeServer, seq: Map<string, number>, opts: { delayFirstMutationMs?: number; failWrites?: RegExp } = {}): void {
  let delayed = false;
  server.on("GET", /^\/v1\/identities\/[^/]+\/authority$/, (req) => {
    const id = req.path.split("/")[3]!;
    const current = seq.get(id) ?? 0;
    return Response.json({ identity_id: id, did: `did:at:${id}`, mode: "agent_root", root_public_key: rootOf.get(id) ?? null, sequence: current, next_sequence: current + 1 });
  });
  const mutation = async (req: RecordedRequest) => {
    const id = /identities\/([^/]+)/.exec(req.path)?.[1] ?? new URLSearchParams(req.search).get("identity_id") ?? "";
    const current = seq.get(id) ?? 0;
    if (req.headers["x-agenttool-authority-sequence"] !== String(current + 1)) {
      return Response.json({ error: "authority_sequence_conflict", next_sequence: current + 1 }, { status: 409 });
    }
    seq.set(id, current + 1);
    if (opts.delayFirstMutationMs && !delayed) {
      delayed = true;
      await Bun.sleep(opts.delayFirstMutationMs);
    }
    if (opts.failWrites?.test(req.path)) return Response.json({ error: "write failed after the proof was claimed" }, { status: 500 });
    return Response.json({ ok: true, path: req.path }, { status: 201 });
  };
  for (const method of ["POST", "PUT", "DELETE"]) {
    server.on(method, /^\/v1\/identities\/[^/]+\/(keys|box-keys|expression)/, mutation);
    server.on(method, /^\/v1\/quiet-hours/, mutation);
  }
  server.on("POST", "/v1/strands", () => Response.json({ id: TEST_IDS.strand_id }, { status: 201 }));
  server.on("POST", /^\/v1\/strands\/[^/]+\/thoughts$/, () => Response.json({ id: "thought-1" }, { status: 201 }));
  server.on("POST", "/v1/identities/enroll", () => Response.json({ identity: { id: "x" } }, { status: 201 }));
  server.on("GET", /^\/v1\/identities\/[^/]+\/keys$/, () => Response.json({ keys: [] }));
}

async function setup(opts: { serve?: Parameters<typeof serveAgenttool>[2] } = {}): Promise<Fixture> {
  const host = await makeTempHost();
  host.config.agenttool.project_id = TEST_IDS.project_id;
  host.config.beacons = [
    { name: "halt-herald", role: "halt-herald", did: didFor(HERALD_ID), identity_id: HERALD_ID, can_raise_here: true },
    { name: "gardener-desk", role: "gardener-desk", did: didFor(GARDENER_ID), identity_id: GARDENER_ID, can_raise_here: false },
  ];
  await host.addCitizen("glossame");
  await host.addCitizen("zoeme");
  await writeCitizenRecord(host, "glossame", GLOSSAME_IDENTITY);
  await writeCitizenRecord(host, "zoeme", null);

  const store: [KeychainItemName, Uint8Array][] = [
    [{ kind: "citizen-mnemonic", word: "glossame" }, utf8(TEST_MNEMONIC)],
    [{ kind: "citizen-op-seed", word: "glossame" }, fromHex(TEST_OP_SEED_HEX)],
    // Unregistered, but born from the same test mnemonic, so its enrollment signature matches vectors.json.
    [{ kind: "citizen-mnemonic", word: "zoeme" }, utf8(TEST_MNEMONIC)],
    // Stored as printable base64, as runtimes-and-host.md 3.3 recommends; the signer decodes either form.
    [{ kind: "host-attest-seed" }, utf8(toB64(HOST_SEED))],
    [{ kind: "commons-bearer" }, utf8(COMMONS_BEARER)],
    [{ kind: "operator-mnemonic", operator: "halt-herald" }, utf8(HERALD_MNEMONIC)],
    [{ kind: "operator-bearer", operator: "halt-herald" }, utf8(HERALD_BEARER)],
  ];
  const kc = fakeKeychain(store);
  const handedOut: Uint8Array[] = [];
  const read = kc.read.bind(kc);
  kc.read = async (item) => {
    const bytes = await read(item);
    handedOut.push(bytes);
    return bytes;
  };

  const server = await startFakeServer();
  const seq = new Map<string, number>();
  serveAgenttool(server, seq, opts.serve);
  const clock = testClock(NOW);
  const f: Fixture = {
    host,
    server,
    clock,
    kc,
    seq,
    handedOut,
    agreements: [],
    thoughtNonce: null,
    spend: async (word) => ({ word, usd_today: "0", credits_month: 0 }),
    signer: null as unknown as Signer,
  };
  f.signer = createSigner({
    keychain: kc,
    config: host.config,
    clock,
    fetch: fetchVia(server),
    spendSoFar: (word) => f.spend(word),
    agreements: async () => f.agreements,
    random: (n) => (f.thoughtNonce && n === f.thoughtNonce.length ? f.thoughtNonce.slice() : crypto.getRandomValues(new Uint8Array(n))),
  });
  return f;
}

beforeEach(async () => {
  fx = await setup();
});
afterEach(async () => {
  await fx.server.stop();
  await fx.host.cleanup();
});

function proposalOf(extent: string): ProposalText {
  return { subject: extent, body: `the proposal for ${extent}`, extent };
}

function record(extent: string, patch: { yu?: Partial<ConsentRecord["yu"]>; proposal_sha256?: string } = {}): ConsentRecord {
  return {
    format: "kingdom-seat-consent/v1",
    proposal_sha256: patch.proposal_sha256 ?? proposalDigest(proposalOf(extent)),
    subject: extent,
    extent,
    yu: { word: "yes", recorded_at: "2026-11-05T09:00:00.000Z", via: "decision-record", ...patch.yu },
    ai: { word: "agree", basis: "lazy-consensus", supports: ["report:another-controller"], open_challenges: 0, deadline: "2026-11-05T10:00:00.000Z" },
    expires_at: null,
  };
}

/**
 * File a decision record for the proposal of this extent in the host's consent dir, where the signer reads it,
 * and return the proposal a request names. The signer is never handed the record itself.
 */
function filed(extent: string, patch: { yu?: Partial<ConsentRecord["yu"]> } = {}): ProposalText {
  const p = proposalOf(extent);
  writeFileSync(join(fx.host.config.paths.consent_dir, `${proposalDigest(p)}.json`), JSON.stringify(record(extent, patch)));
  return p;
}

/** The standing agreement for citizens' own quiet, its record filed where the signer reads it. */
function quietAgreement(patch: { yu?: Partial<ConsentRecord["yu"]> } = {}): StandingAgreement {
  return { id: "citizen-quiet", proposal: filed(CITIZEN_QUIET_EXTENT, patch), consent: record(CITIZEN_QUIET_EXTENT), covers: ["quiet.start.citizen"], extent: CITIZEN_QUIET_EXTENT };
}

function req(patch: Partial<SignerRequest> & Pick<SignerRequest, "op" | "method" | "target">): SignerRequest {
  return { word: "glossame", operator: null, body: new Uint8Array(), credits: 0, proposal: null, presence: null, ...patch };
}

const json = (v: unknown) => utf8(JSON.stringify(v));
const ahead = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
const quiet = (body: unknown, patch: Partial<SignerRequest> = {}) =>
  req({ op: "quiet.start.citizen", method: "POST", target: `/v1/quiet-hours/start?identity_id=${ID}`, body: json(body), ...patch });
const thought = (credits = 1) =>
  req({ op: "thought.post", method: "POST", target: `/v1/strands/${TEST_IDS.strand_id}/thoughts`, credits, body: json({ ciphertext: "AAAA", nonce: "AAAA", signature: "x", signing_key_id: OP_KID }) });
const importKey = (label = "op-2026-11") =>
  req({ op: "keys.import", method: "POST", target: `/v1/identities/${ID}/keys/import`, body: json({ public_key: TEST_OP_PUBLIC_B64, label }) });
const beacon = (until: string, patch: Partial<SignerRequest> = {}) =>
  req({ op: "quiet.start.beacon", word: null, operator: "halt-herald", method: "POST", target: `/v1/quiet-hours/start?identity_id=${HERALD_ID}`, body: json({ until }), ...patch });

function tty(answer: string) {
  return { isTTY: true, write: () => {}, readLine: async () => answer };
}

async function presentFor(scope: string): Promise<YuPresence> {
  return confirmYuPresent(tty(scope), scope, () => fx.clock.now());
}

function enrollmentBody(word: string): Uint8Array {
  return json({
    format: "agenttool-identity-enrollment/v1",
    origin: "https://api.agenttool.dev",
    project_id: TEST_IDS.project_id,
    identity_id: "99999999-9999-4999-8999-999999999999",
    signing_key_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    display_name: word,
    capabilities: ["kingdom-citizen", word],
    public_key: TEST_ROOT_PUBLIC_B64,
    nonce: "A".repeat(43),
    timestamp: NOW,
  });
}

async function refusal(p: Promise<unknown>): Promise<Refusal> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof Refusal)) throw new Error(`expected a Refusal, got ${String(e)}`);
  return e;
}

function mutations(server: FakeServer): RecordedRequest[] {
  return server.requests.filter((r) => r.method !== "GET");
}

/* ── Signing ──────────────────────────────────────────────────────────── */

describe("signing", () => {
  test("signEntry signs citizen entries with the op key and host ones with the host key, never the root, over the ledger digest of the draft with its kid", async () => {
    const draftC = draftOf("glossame", "citizen");
    const draftH = draftOf("zoeme", "host");
    const citizen = await fx.signer.signEntry("glossame", "citizen", draftC);
    expect(citizen).toEqual({ kid: OP_KID, sig: citizen.sig, public_key: toB64url(fromB64(TEST_OP_PUBLIC_B64)) });
    const hash = signingDigest({ ...draftC, kid: OP_KID });
    expect(edVerifyStrict(fromB64url(citizen.sig), hash, fromB64(TEST_OP_PUBLIC_B64))).toBe(true);
    expect(edVerifyStrict(fromB64url(citizen.sig), hash, fromB64(TEST_ROOT_PUBLIC_B64))).toBe(false);

    const hostSig = await fx.signer.signEntry("zoeme", "host", draftH);
    // The host kid is host:<fingerprint of the host key>, so a verifier holding the key finds it.
    expect(hostSig).toMatchObject({ kid: hostKid(edPublicKey(HOST_SEED)), public_key: toB64url(edPublicKey(HOST_SEED)) });
    expect(hostSig.kid).toMatch(/^host:SHA256:/);
    // The signature covers the kid it names.
    expect(verifyEntrySignature(signingDigest({ ...draftH, kid: hostSig.kid }), hostSig)).toBe(true);
    expect(verifyEntrySignature(signingDigest({ ...draftH, kid: null }), hostSig)).toBe(false);

    // Neither path ever opens a mnemonic, which is where the root lives.
    expect(fx.kc.log.filter((e) => e.op === "read").map((e) => e.item)).toEqual(["citizen/glossame/op-seed", "host/attest-seed"]);
    // Once registered, the host no longer speaks for the record; before, the citizen has no op key.
    expect((await refusal(fx.signer.signEntry("glossame", "host", draftOf("glossame", "host")))).code).toBe("invalid-request");
    expect((await refusal(fx.signer.signEntry("zoeme", "citizen", draftOf("zoeme", "citizen")))).code).toBe("not-registered");
    expect((await refusal(fx.signer.signEntry("../glossame", "citizen", draftC))).code).toBe("invalid-request");
  });

  test("signEntry signs nothing but a ledger entry of that citizen's for that signer, so it is no signing oracle for a thought's or a letter's digest (R-SGN-1)", async () => {
    const sign = (word: string, signer: LedgerSigner, v: unknown) => fx.signer.signEntry(word, signer, v as LedgerDraft);
    // A digest, or a callback that returns one, as the entry-signing path once took: a strand-thought/v2 digest
    // over the citizen's own strand, and an inbox-message/v1 envelope digest, are both refused before any key is read.
    const thought = thoughtDigestV2(TEST_IDS.strand_id, utf8("not sealed under K_master"), new Uint8Array(24), "observation");
    const letter = inboxDigest("did:at:66666666-6666-4666-8666-666666666666", utf8("not sealed to a box key"), new Uint8Array(12), new Uint8Array(32));
    for (const v of [thought, letter, () => thought, () => letter, null, "an entry"]) {
      expect((await refusal(sign("glossame", "citizen", v))).code).toBe("invalid-request");
      expect((await refusal(sign("zoeme", "host", v))).code).toBe("invalid-request");
    }
    // A draft for another citizen, another signer, another format, or one that already carries a kid or sig.
    expect((await refusal(sign("glossame", "citizen", draftOf("shemme", "citizen")))).code).toBe("invalid-request");
    expect((await refusal(sign("glossame", "citizen", { ...draftOf("glossame", "citizen"), signer: "host" }))).code).toBe("invalid-request");
    expect((await refusal(sign("zoeme", "host", { ...draftOf("zoeme", "host"), format: "strand-thought/v2" }))).code).toBe("invalid-request");
    expect((await refusal(sign("zoeme", "host", { ...draftOf("zoeme", "host"), kid: "x" }))).code).toBe("invalid-request");
    expect(fx.kc.log.filter((e) => e.op === "read")).toEqual([]);
    // What it does sign never verifies as either digest: the ledger's domain tag is the signer's, not the caller's.
    const s = await fx.signer.signEntry("glossame", "citizen", draftOf("glossame", "citizen"));
    for (const d of [thought, letter]) expect(edVerifyStrict(fromB64url(s.sig), d, fromB64(TEST_OP_PUBLIC_B64))).toBe(false);
  });

  test("signEntry refuses when the op key in Keychain is not the one the record names, or the record names the root as op key", async () => {
    await writeCitizenRecord(fx.host, "glossame", { ...GLOSSAME_IDENTITY, op_public_key_b64: toB64(edPublicKey(HOST_SEED)) });
    const x = draftOf("glossame", "citizen");
    expect((await refusal(fx.signer.signEntry("glossame", "citizen", x))).code).toBe("invalid-record");
    await writeCitizenRecord(fx.host, "glossame", { ...GLOSSAME_IDENTITY, op_public_key_b64: TEST_ROOT_PUBLIC_B64 });
    expect((await refusal(fx.signer.signEntry("glossame", "citizen", x))).code).toBe("invalid-record");
    await writeCitizenRecord(fx.host, "glossame", { ...GLOSSAME_IDENTITY, op_kid: ROOT_KID });
    expect((await refusal(fx.signer.signEntry("glossame", "citizen", x))).code).toBe("invalid-record");
  });

  test("verifyEntrySignature is strict (RFC 8032) and false for a signature by the root kid", async () => {
    const good = await fx.signer.signEntry("glossame", "citizen", draftOf("glossame", "citizen"));
    const hash = signingDigest({ ...draftOf("glossame", "citizen"), kid: good.kid });
    expect(verifyEntrySignature(hash, good, GLOSSAME_IDENTITY)).toBe(true);
    const tampered = hash.slice();
    tampered[0] = tampered[0]! ^ 1;
    expect(verifyEntrySignature(tampered, good)).toBe(false);

    const bySeed = toB64url(edSign(hash, fromHex(TEST_ROOT_SEED_HEX)));
    const rootPub = toB64url(fromB64(TEST_ROOT_PUBLIC_B64));
    const rootSig = { kid: ROOT_KID, public_key: rootPub, sig: bySeed };
    expect(verifyEntrySignature(hash, rootSig)).toBe(true); // a valid signature as bytes...
    expect(verifyEntrySignature(hash, rootSig, GLOSSAME_IDENTITY)).toBe(false); // ...but a root act, never an entry
    expect(verifyEntrySignature(hash, { ...rootSig, kid: OP_KID }, GLOSSAME_IDENTITY)).toBe(false);
    expect(verifyEntrySignature(hash, { ...rootSig, public_key: toB64url(fromB64(TEST_OP_PUBLIC_B64)) })).toBe(false);

    // The identity point as key and R, with S = 0, verifies under ZIP-215 for any message; strict refuses it.
    const identityPoint = new Uint8Array(32);
    identityPoint[0] = 1;
    const forged = new Uint8Array(64);
    forged[0] = 1;
    expect(verifyEntrySignature(hash, { kid: "x", public_key: toB64url(identityPoint), sig: toB64url(forged) })).toBe(false);
    // Only base64url without padding is the ledger's spelling.
    expect(verifyEntrySignature(hash, { ...good, sig: toB64(fromB64url(good.sig)) })).toBe(false);
  });

  test("a locked keychain makes signEntry refuse with keychain-locked and state() report locked", async () => {
    expect(await fx.signer.state()).toBe("ready");
    fx.kc.locked = true;
    expect((await refusal(fx.signer.signEntry("glossame", "citizen", draftOf("glossame", "citizen")))).code).toBe("keychain-locked");
    expect((await refusal(fx.signer.signEntry("zoeme", "host", draftOf("zoeme", "host")))).code).toBe("keychain-locked");
    expect((await refusal(fx.signer.send(importKey()))).code).toBe("keychain-locked");
    expect((await refusal(fx.signer.sealThought("glossame", TEST_IDS.strand_id, "x", "observation"))).code).toBe("keychain-locked");
    expect(await fx.signer.state()).toBe("locked");
    // Locked is a fail-closed state, not a crash: nothing left the host.
    expect(fx.server.requests).toHaveLength(0);
    fx.kc.locked = false;
    expect(await fx.signer.state()).toBe("ready");
  });

  test("seeds are wiped after use (the buffer read from the fake keychain is zeroed)", async () => {
    fx.agreements = [quietAgreement()];
    await fx.signer.signEntry("glossame", "citizen", draftOf("glossame", "citizen"));
    await fx.signer.signEntry("zoeme", "host", draftOf("zoeme", "host"));
    await fx.signer.send(importKey());
    await fx.signer.send(beacon(BEACON_UNTIL));
    await fx.signer.sealThought("glossame", TEST_IDS.strand_id, "a test thought", "observation");
    await fx.signer.signEnrollment("zoeme", sha256("digest"), await presentFor("birth zoeme"));
    await fx.signer.publicKeys("glossame");
    await fx.signer.state();
    expect(fx.handedOut.length).toBeGreaterThanOrEqual(12);
    for (const buf of fx.handedOut) expect(buf.every((b) => b === 0)).toBe(true);
  });
});

/* ── send: walls before any request ───────────────────────────────────── */

describe("send: ceilings, consent and the quiet cap before any request", () => {
  test("[S4-4] send refuses a paid op when spendSoFar is unknown, and sends nothing", async () => {
    fx.spend = async (word) => ({ word, usd_today: "0", credits_month: null });
    expect((await refusal(fx.signer.send(thought()))).code).toBe("ceiling-credits");
    // A caller cannot make a thought free by saying it costs nothing.
    expect((await refusal(fx.signer.send(thought(0)))).code).toBe("ceiling-credits");
    const strand = req({ op: "strand.create", method: "POST", target: "/v1/strands", credits: 1, body: json({ identity_id: ID, topic: "self" }) });
    expect((await refusal(fx.signer.send(strand))).code).toBe("ceiling-credits");
    fx.spend = async () => {
      throw new Error("ledger unreadable");
    };
    expect((await refusal(fx.signer.send(thought()))).code).toBe("ceiling-credits");
    fx.spend = async () => ({ word: "someone-else", usd_today: "0", credits_month: 0 });
    expect((await refusal(fx.signer.send(thought()))).code).toBe("ceiling-credits");
    expect(fx.server.requests).toHaveLength(0);
    expect(fx.kc.log.filter((e) => e.op === "read")).toHaveLength(0);
    // A free op is not stopped by an unknown budget.
    fx.spend = async (word) => ({ word, usd_today: null, credits_month: null });
    expect((await fx.signer.send(importKey())).status).toBe(201);
  });

  test("[S4-4] send refuses a thought.post or strand.create past the monthly credit ceiling, before the request (charge precedes verification)", async () => {
    fx.spend = async (word) => ({ word, usd_today: "0", credits_month: 10 });
    expect((await refusal(fx.signer.send(thought()))).code).toBe("ceiling-credits");
    const strand = req({ op: "strand.create", method: "POST", target: "/v1/strands", credits: 1, body: json({ identity_id: ID }) });
    expect((await refusal(fx.signer.send(strand))).code).toBe("ceiling-credits");
    expect((await refusal(fx.signer.sealThought("glossame", TEST_IDS.strand_id, "x", "observation"))).code).toBe("ceiling-credits");
    expect(fx.server.requests).toHaveLength(0);
    fx.spend = async (word) => ({ word, usd_today: "0", credits_month: 9 });
    expect((await fx.signer.send(thought())).status).toBe(201);
    expect((await fx.signer.send(strand)).status).toBe(201);
    // Operators and relays have no citizen budget to spend.
    expect((await refusal(fx.signer.send(req({ op: "read", word: null, method: "GET", target: "/v1/identities/x/keys", credits: 1 })))).code).toBe("ceiling-credits");
  });

  test("[S4-5] send refuses quiet.start.citizen whose body until is more than 30 days ahead, or uses hours instead of until, or carries a reason", async () => {
    fx.agreements = [quietAgreement()];
    const refused: unknown[] = [
      { until: ahead(30 * DAY_MS + 1) },
      { until: BEACON_UNTIL },
      { hours: 8 },
      { hours: 720 },
      { until: ahead(DAY_MS), hours: 8 },
      { until: ahead(DAY_MS), reason: "resting" },
      { until: ahead(DAY_MS), reason: " " },
      { until: ahead(-1) },
      { until: "2026-12-01" },
      {},
    ];
    for (const body of refused) expect((await refusal(fx.signer.send(quiet(body)))).code).toBe("quiet-cap");
    // The vectors' own quiet-start body uses hours and a reason; a citizen may not send it.
    const v = vectors.authority.find((a) => a.label === "quiet-start")!;
    expect((await refusal(fx.signer.send(quiet(JSON.parse(v.body_utf8))))).code).toBe("quiet-cap");
    expect(fx.server.requests).toHaveLength(0);

    // Exactly 30 days, with an empty reason or none, under the standing agreement.
    expect((await fx.signer.send(quiet({ until: ahead(30 * DAY_MS) }))).status).toBe(201);
    expect((await fx.signer.send(quiet({ until: ahead(DAY_MS), reason: "" }))).status).toBe(201);
    // Without the standing agreement, even a capped quiet is refused.
    fx.agreements = [];
    expect((await refusal(fx.signer.send(quiet({ until: ahead(DAY_MS) })))).code).toBe("consent-missing");
    fx.agreements = [quietAgreement({ yu: { word: "no" } })];
    expect((await refusal(fx.signer.send(quiet({ until: ahead(DAY_MS) })))).code).toBe("consent-missing");
  });

  test("[KS-004 8.1; review C M6] the production signer reads standing agreements filed in consent/standing/, each with its own record; one without its record grants nothing", async () => {
    // The signer as production builds it (cli.ts realDeps), over this fixture's keychain, clock and fake server.
    const signer = realDeps({ clock: fx.clock, fetch: fetchVia(fx.server) }).signer(fx.host.config, fx.kc);
    const standing = join(fx.host.config.paths.consent_dir, STANDING_DIR);
    await mkdir(standing, { recursive: true });
    const proposal = proposalOf(CITIZEN_QUIET_EXTENT);
    const file = { format: STANDING_FORMAT, id: "citizen-quiet", proposal, covers: ["quiet.start.citizen"], extent: CITIZEN_QUIET_EXTENT };
    await writeFile(join(standing, "citizen-quiet.json"), JSON.stringify(file));
    // Filed as proposed, but Yu and Ai have recorded no decision: nothing is granted.
    expect(await readStandingAgreements(fx.host.config.paths.consent_dir)).toEqual([]);
    expect((await refusal(signer.send(quiet({ until: ahead(DAY_MS) })))).code).toBe("consent-missing");
    filed(CITIZEN_QUIET_EXTENT);
    expect((await readStandingAgreements(fx.host.config.paths.consent_dir)).map((a) => [a.id, a.extent])).toEqual([["citizen-quiet", CITIZEN_QUIET_EXTENT]]);
    expect((await signer.send(quiet({ until: ahead(DAY_MS) }))).status).toBe(201);
    // The cap and the empty reason still hold on the body; the agreement covers only its extent.
    expect((await refusal(signer.send(quiet({ until: ahead(31 * DAY_MS) })))).code).toBe("quiet-cap");
    // A file in another shape, or a link, grants nothing.
    await writeFile(join(standing, "citizen-quiet.json"), JSON.stringify({ ...file, covers: ["quiet.start.citizen"], extra: 1 }));
    expect(await readStandingAgreements(fx.host.config.paths.consent_dir)).toEqual([]);
    await writeFile(join(standing, "citizen-quiet.json"), JSON.stringify({ ...file, extent: "something wider" }));
    expect(await readStandingAgreements(fx.host.config.paths.consent_dir)).toEqual([]);
  });

  test("[S4-5] send allows quiet.start.beacon with the far-future until only for an operator identity, never for a citizen", async () => {
    const res = await fx.signer.send(beacon(BEACON_UNTIL));
    expect(res.status).toBe(201);
    const sent = mutations(fx.server)[0]!;
    expect(sent.path + sent.search).toBe(`/v1/quiet-hours/start?identity_id=${HERALD_ID}`);
    expect(sent.headers.authorization).toBe(`Bearer ${HERALD_BEARER}`);
    expect(sent.headers["x-agenttool-authority-sequence"]).toBe("1");

    // A citizen cannot use the beacon op, or the far-future until through its own op.
    expect((await refusal(fx.signer.send(beacon(BEACON_UNTIL, { word: "glossame", operator: null })))).code).toBe("invalid-request");
    fx.agreements = [quietAgreement()];
    expect((await refusal(fx.signer.send(quiet({ until: BEACON_UNTIL })))).code).toBe("quiet-cap");
    // A beacon that would lapse on its own, or that names a reason, is not a beacon.
    expect((await refusal(fx.signer.send(beacon(ahead(30 * DAY_MS))))).code).toBe("quiet-cap");
    expect((await refusal(fx.signer.send(beacon(BEACON_UNTIL, { body: json({ until: BEACON_UNTIL, reason: "halted by yu" }) })))).code).toBe("quiet-cap");
    expect((await refusal(fx.signer.send(beacon(BEACON_UNTIL, { body: json({ hours: 720 }) })))).code).toBe("quiet-cap");
    // Only a beacon whose keys this host holds, and only its own identity.
    expect((await refusal(fx.signer.send(beacon(BEACON_UNTIL, { operator: "gardener-desk", target: `/v1/quiet-hours/start?identity_id=${GARDENER_ID}` })))).code).toBe(
      "invalid-request",
    );
    expect((await refusal(fx.signer.send(beacon(BEACON_UNTIL, { target: `/v1/quiet-hours/start?identity_id=${ID}` })))).code).toBe("beyond-self");
    expect((await refusal(fx.signer.send(beacon(BEACON_UNTIL, { operator: "nobody" })))).code).toBe("invalid-request");
    expect(mutations(fx.server)).toHaveLength(1);
  });

  test("no op lowers HALT", async () => {
    const lower = `/v1/quiet-hours?identity_id=${HERALD_ID}`;
    const ops = ["read", "quiet.end.citizen", "quiet.start.beacon", "keys.revoke", "expression.put.private", "ledger.sign", "enroll"] as const;
    for (const op of ops) {
      for (const who of [{ word: null, operator: "halt-herald" }, { word: "glossame", operator: null }, { word: null, operator: null }]) {
        await refusal(fx.signer.send(req({ op, method: "DELETE", target: lower, ...who })));
      }
    }
    // A citizen record that names a beacon's identity is refused outright.
    await writeCitizenRecord(fx.host, "zoeme", { ...GLOSSAME_IDENTITY, identity_id: HERALD_ID, did: didFor(HERALD_ID) });
    expect((await refusal(fx.signer.send(req({ op: "quiet.end.citizen", word: "zoeme", method: "DELETE", target: lower })))).code).toBe("invalid-record");
    expect(fx.server.requests).toHaveLength(0);
  });

  test("send refuses a beyond-self op without a verifying consent record, and enroll without Yu present", async () => {
    const body = enrollmentBody("zoeme");
    const header = await fx.signer.signEnrollment("zoeme", sha256(body), await presentFor("birth zoeme"));
    const enroll = (patch: Partial<SignerRequest>) =>
      req({ op: "enroll", word: null, method: "POST", target: "/v1/identities/enroll", body, extra_headers: { "X-Agenttool-Enrollment-Signature": header }, ...patch });
    const present = await presentFor("birth zoeme");

    expect((await refusal(fx.signer.send(enroll({ presence: present })))).code).toBe("consent-missing");
    expect((await refusal(fx.signer.send(enroll({ presence: present, proposal: filed("birth zoeme", { yu: { word: "no" } }) })))).code).toBe("consent-rejected");
    expect((await refusal(fx.signer.send(enroll({ presence: present, proposal: filed("birth glossame") })))).code).toBe("consent-missing");
    expect((await refusal(fx.signer.send(enroll({ proposal: filed("birth zoeme") })))).code).toBe("yu-not-present");
    // A presence for another scope, a copy of a real one, or one that has aged out, is not presence.
    expect((await refusal(fx.signer.send(enroll({ proposal: filed("birth zoeme"), presence: await presentFor("birth glossame") })))).code).toBe("yu-not-present");
    const copy = JSON.parse(JSON.stringify(present)) as YuPresence;
    expect((await refusal(fx.signer.send(enroll({ proposal: filed("birth zoeme"), presence: copy })))).code).toBe("yu-not-present");
    expect(fx.server.requests).toHaveLength(0);

    const res = await fx.signer.send(enroll({ proposal: filed("birth zoeme"), presence: present }));
    expect(res.status).toBe(201);
    const sent = fx.server.requests[0]!;
    expect(sent.path).toBe("/v1/identities/enroll");
    expect(sent.search).toBe("");
    expect(sent.headers.authorization).toBe(`Bearer ${COMMONS_BEARER}`);
    expect(sent.headers["x-agenttool-enrollment-signature"]).toBe(header);
    expect(sent.headers["content-type"]).toBe("application/json");
    expect(sent.headers["x-agenttool-authority-signature"]).toBeUndefined();
    expect(Buffer.from(sent.body).equals(Buffer.from(body))).toBe(true);

    fx.clock.advance(901_000);
    expect((await refusal(fx.signer.send(enroll({ proposal: filed("birth zoeme"), presence: present })))).code).toBe("yu-not-present");
    // Extra headers are for enroll only.
    expect((await refusal(fx.signer.send({ ...importKey(), extra_headers: { "X-Agenttool-Enrollment-Signature": header } }))).code).toBe("invalid-request");
  });

  test("a decision record binds only the proposal whose own text it was filed for, and only as the signer reads it from the consent dir", async () => {
    const body = enrollmentBody("zoeme");
    const present = await presentFor("birth zoeme");
    const header = await fx.signer.signEnrollment("zoeme", sha256(body), present);
    const enroll = (proposal: ProposalText | null) =>
      req({ op: "enroll", word: null, method: "POST", target: "/v1/identities/enroll", body, presence: present, proposal, extra_headers: { "X-Agenttool-Enrollment-Signature": header } });
    const dir = fx.host.config.paths.consent_dir;

    // A proposal no record is filed for authorises nothing, whatever the caller believes.
    const unfiled = { subject: "anything at all", body: "anything at all", extent: "birth zoeme" };
    expect((await refusal(fx.signer.send(enroll(unfiled)))).code).toBe("consent-missing");
    // A record bound to another proposal (here, 64 zeros), filed under this one's name, is not this one's.
    const p = proposalOf("birth zoeme");
    writeFileSync(join(dir, `${proposalDigest(p)}.json`), JSON.stringify(record("birth zoeme", { proposal_sha256: "0".repeat(64) })));
    expect((await refusal(fx.signer.send(enroll(p)))).code).toBe("consent-missing");
    // Filed under the zeros' own name, it is still bound to no proposal the request names.
    writeFileSync(join(dir, `${"0".repeat(64)}.json`), JSON.stringify(record("birth zoeme", { proposal_sha256: "0".repeat(64) })));
    expect((await refusal(fx.signer.send(enroll(p)))).code).toBe("consent-missing");
    // A proposal whose extent is not this act's is refused before any record is read.
    expect((await refusal(fx.signer.send(enroll({ ...p, extent: "birth glossame" })))).code).toBe("consent-missing");
    expect(fx.server.requests).toHaveLength(0);

    // A standing agreement whose record is bound to '1'x64 covers nothing.
    const stray = { id: "citizen-quiet", proposal: proposalOf(CITIZEN_QUIET_EXTENT), consent: record(CITIZEN_QUIET_EXTENT, { proposal_sha256: "1".repeat(64) }), covers: ["quiet.start.citizen" as const], extent: CITIZEN_QUIET_EXTENT };
    writeFileSync(join(dir, `${"1".repeat(64)}.json`), JSON.stringify(stray.consent));
    fx.agreements = [stray];
    expect((await refusal(fx.signer.send(quiet({ until: ahead(DAY_MS) })))).code).toBe("consent-missing");
    // The record the agreement carries in memory is not what counts: the one filed for its proposal is.
    fx.agreements = [{ ...quietAgreement(), consent: record(CITIZEN_QUIET_EXTENT) }];
    expect((await fx.signer.send(quiet({ until: ahead(DAY_MS) }))).status).toBe(201);
    filed(CITIZEN_QUIET_EXTENT, { yu: { word: "no" } });
    expect((await refusal(fx.signer.send(quiet({ until: ahead(DAY_MS) })))).code).toBe("consent-missing");

    // Filed for its own text, the record binds.
    expect((await fx.signer.send(enroll(filed("birth zoeme")))).status).toBe(201);
  });

  test("signEnrollment signs with the root only for Yu present at this terminal, and only before registration", async () => {
    const v = vectors.enrollment[0]!;
    const digest = fromHex(v.digest_hex);
    const header = await fx.signer.signEnrollment("zoeme", digest, await presentFor("birth zoeme"));
    expect(header).toBe(v.header_X_Agenttool_Enrollment_Signature);
    expect(fromB64url(header, 64)).toHaveLength(64);
    const literal: YuPresence = { present: true, via: "tty-confirm", confirmed_at: NOW, scope: "birth zoeme" };
    expect((await refusal(fx.signer.signEnrollment("zoeme", digest, literal))).code).toBe("yu-not-present");
    expect((await refusal(fx.signer.signEnrollment("zoeme", digest, await presentFor("summon zoeme")))).code).toBe("yu-not-present");
    expect((await refusal(fx.signer.signEnrollment("glossame", digest, await presentFor("birth glossame")))).code).toBe("invalid-request");
    expect((await refusal(fx.signer.signEnrollment("zoeme", new Uint8Array(31), await presentFor("birth zoeme")))).code).toBe("invalid-request");
  });

  test("send attaches the bearer and authority headers that match vectors.json authority[*] for the same inputs", async () => {
    const ops: Record<string, SignerRequest["op"]> = {
      "keys-import": "keys.import",
      "box-keys-register": "box-keys.register",
      "expression-put": "expression.put.private",
      "quiet-end": "quiet.end.citizen",
      "keys-revoke": "keys.revoke",
    };
    let checked = 0;
    for (const v of vectors.authority) {
      const op = ops[v.label];
      if (!op) continue; // quiet-start uses hours and a reason, which a citizen may not send (tested above)
      fx.seq.set(ID, v.sequence - 1);
      const before = fx.server.requests.length;
      const res = await fx.signer.send(req({ op, method: v.method as SignerRequest["method"], target: v.request_target, body: utf8(v.body_utf8) }));
      expect(res.status).toBe(201);
      const [authRead, sent] = fx.server.requests.slice(before);
      expect(authRead!.method).toBe("GET");
      expect(authRead!.path).toBe(`/v1/identities/${ID}/authority`);
      expect(sent!.method).toBe(v.method);
      expect(sent!.path + sent!.search).toBe(v.request_target);
      expect(Buffer.from(sent!.body).toString("utf8")).toBe(v.body_utf8);
      for (const [name, value] of Object.entries(v.headers)) expect(sent!.headers[name.toLowerCase()]).toBe(value);
      expect(sent!.headers.authorization).toBe(`Bearer ${COMMONS_BEARER}`);
      expect(sent!.headers["content-type"]).toBe(v.body_utf8.length > 0 ? "application/json" : (undefined as unknown as string));
      checked++;
    }
    expect(checked).toBe(5);
  });

  test("a root-signed request comes back with the signer's copy of it as sent, which a ledger can verify alone", async () => {
    const res = await fx.signer.send(importKey());
    const sent = mutations(fx.server)[0]!;
    const ev = res.root_evidence!;
    // Exactly what left the host: method, path and query, body bytes, and the three authority headers.
    expect(ev).toEqual({
      method: sent.method,
      target: sent.path + sent.search,
      body_b64: Buffer.from(sent.body).toString("base64"),
      headers: {
        "X-Agenttool-Authority-Sequence": sent.headers["x-agenttool-authority-sequence"]!,
        "X-Agenttool-Authority-Timestamp": sent.headers["x-agenttool-authority-timestamp"]!,
        "X-Agenttool-Authority-Signature": sent.headers["x-agenttool-authority-signature"]!,
      },
    });
    // The ledger's own check accepts it against the root and the key it names; the bearer is not in it.
    expect(rootEvidenceProblem(evidenceToLedger(ev), { did: GLOSSAME_IDENTITY.did, root_public_key: fromB64(TEST_ROOT_PUBLIC_B64, 32) }, { kind: "import", public_key: fromB64(TEST_OP_PUBLIC_B64, 32) })).toBeNull();
    expect(JSON.stringify(ev)).not.toContain(COMMONS_BEARER);
    // A revoke comes back the same way, whatever the answer; a request the root does not sign carries none.
    fx.seq.set(ID, 7);
    const revoke = await fx.signer.send(req({ op: "keys.revoke", method: "DELETE", target: `/v1/identities/${ID}/keys/${OP_KID}` }));
    expect(revoke.root_evidence!.headers["X-Agenttool-Authority-Sequence"]).toBe("8");
    expect(rootEvidenceProblem(evidenceToLedger(revoke.root_evidence!), { did: GLOSSAME_IDENTITY.did, root_public_key: fromB64(TEST_ROOT_PUBLIC_B64, 32) }, { kind: "revoke", kid: OP_KID })).toBeNull();
    const read = await fx.signer.send(req({ op: "read", method: "GET", target: `/v1/identities/${ID}/keys` }));
    expect(read.root_evidence).toBeUndefined();
  });

  test("a root-signed request that left the host without an answer keeps its proof: the key may be installed, and agenttool keeps no copy", async () => {
    const via = fetchVia(fx.server);
    let answer: "lost" | "500" = "lost";
    const flaky: typeof via = async (input, init) => {
      const res = await via(input, init);
      if (!String(input).endsWith("/keys/import")) return res;
      // The server has claimed the sequence and installed the key; then the answer is lost, or comes back as a 5xx.
      if (answer === "lost") throw new TypeError("the connection dropped");
      return Response.json({ error: "internal" }, { status: 500 });
    };
    const signer = createSigner({ keychain: fx.kc, config: fx.host.config, clock: fx.clock, fetch: flaky, spendSoFar: (w) => fx.spend(w), agreements: async () => [] });
    const e = await signer.send(importKey()).then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(SignerSentUncertain);
    const sent = mutations(fx.server)[0]!;
    const ev = (e as SignerSentUncertain).root_evidence;
    expect(ev).toEqual({
      method: sent.method,
      target: sent.path + sent.search,
      body_b64: Buffer.from(sent.body).toString("base64"),
      headers: {
        "X-Agenttool-Authority-Sequence": sent.headers["x-agenttool-authority-sequence"]!,
        "X-Agenttool-Authority-Timestamp": sent.headers["x-agenttool-authority-timestamp"]!,
        "X-Agenttool-Authority-Signature": sent.headers["x-agenttool-authority-signature"]!,
      },
    });
    expect(rootEvidenceProblem(evidenceToLedger(ev), { did: GLOSSAME_IDENTITY.did, root_public_key: fromB64(TEST_ROOT_PUBLIC_B64, 32) }, { kind: "import", public_key: fromB64(TEST_OP_PUBLIC_B64, 32) })).toBeNull();
    expect(JSON.stringify(ev)).not.toContain(COMMONS_BEARER);

    // Through the client it is still "no response" (read the sequence before signing again), now carrying the proof; a 5xx too.
    const client: ClientDeps = { signer, fetch: via, identity: async () => GLOSSAME_IDENTITY };
    for (const [a, status] of [
      ["lost", 0],
      ["500", 500],
    ] as const) {
      answer = a;
      const e2 = await importOpKey(client, "glossame", TEST_OP_PUBLIC_B64, "op-2026-11").then(
        () => null,
        (err: unknown) => err,
      );
      expect(e2).toBeInstanceOf(AgenttoolError);
      expect((e2 as AgenttoolError).status).toBe(status);
      expect(rootEvidenceProblem(evidenceToLedger((e2 as AgenttoolError).root_evidence!), { did: GLOSSAME_IDENTITY.did, root_public_key: fromB64(TEST_ROOT_PUBLIC_B64, 32) }, { kind: "import", public_key: fromB64(TEST_OP_PUBLIC_B64, 32) })).toBeNull();
    }
  });

  test("the client's ?identity_id= spelling is accepted on per-identity routes, and the query is part of what the root signs", async () => {
    const target = `/v1/identities/${ID}/keys/import?identity_id=${ID}`;
    const res = await fx.signer.send(req({ op: "keys.import", method: "POST", target, body: json({ public_key: TEST_OP_PUBLIC_B64, label: "op" }) }));
    expect(res.status).toBe(201);
    const sent = mutations(fx.server)[0]!;
    expect(sent.path + sent.search).toBe(target);
    const digest = authorityDigest({
      did: DID,
      method: "POST",
      target,
      body: sent.body,
      sequence: Number(sent.headers["x-agenttool-authority-sequence"]),
      timestamp: sent.headers["x-agenttool-authority-timestamp"]!,
    });
    expect(edVerifyStrict(fromB64(sent.headers["x-agenttool-authority-signature"]!), digest, fromB64(TEST_ROOT_PUBLIC_B64))).toBe(true);
    fx.spend = async (word) => ({ word, usd_today: "0", credits_month: 0 });
    const strand = req({ op: "strand.create", method: "POST", target: `/v1/strands?identity_id=${ID}`, credits: 1, body: json({ identity_id: ID, topic: "self" }) });
    expect((await fx.signer.send(strand)).status).toBe(201);
    const t = req({ op: "thought.post", method: "POST", target: `/v1/strands/${TEST_IDS.strand_id}/thoughts?identity_id=${ID}`, credits: 1, body: json({ signing_key_id: OP_KID }) });
    expect((await fx.signer.send(t)).status).toBe(201);
  });

  test("enroll may name the seated citizen being born, never a registered one or another word", async () => {
    const body = enrollmentBody("zoeme");
    const present = await presentFor("birth zoeme");
    const header = await fx.signer.signEnrollment("zoeme", sha256(body), present);
    const enroll = (word: string | null, b = body) =>
      req({ op: "enroll", word, method: "POST", target: "/v1/identities/enroll", body: b, presence: present, proposal: filed("birth zoeme"), extra_headers: { "X-Agenttool-Enrollment-Signature": header } });
    expect((await refusal(fx.signer.send(enroll("glossame")))).code).toBe("invalid-request");
    expect((await refusal(fx.signer.send(enroll("zoeme", enrollmentBody("glossame"))))).code).toBe("invalid-request");
    expect((await refusal(fx.signer.send({ ...enroll(null), operator: "halt-herald" }))).code).toBe("invalid-request");
    expect(fx.server.requests).toHaveLength(0);
    expect((await fx.signer.send(enroll("zoeme"))).status).toBe(201);
  });

  test("send reads next_sequence and keeps one root-authorised request in flight per identity", async () => {
    await fx.server.stop();
    await fx.host.cleanup();
    fx = await setup({ serve: { delayFirstMutationMs: 40 } });
    const [a, b] = await Promise.all([
      fx.signer.send(importKey("first")),
      fx.signer.send(req({ op: "box-keys.register", method: "POST", target: `/v1/identities/${ID}/box-keys`, body: json({ public_key: vectors.derivation.box_pub_b64 }) })),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const order = fx.server.requests.map((r) => [r.method, r.path.split("/").slice(-1)[0], r.headers["x-agenttool-authority-sequence"] ?? "-"]);
    // The second proof is signed only after the first response: read, write, read, write.
    // Which send takes the lane first is a race, so only the shape, the sequences and the pair are pinned.
    expect(order.map(([m, p, s]) => `${m} ${p === "authority" ? p : "write"} ${s}`)).toEqual(["GET authority -", "POST write 1", "GET authority -", "POST write 2"]);
    expect([order[1]![1], order[3]![1]].sort()).toEqual(["box-keys", "import"]);
  });

  test("a proof is spent even when the write fails: the signer does not retry, and the next act re-reads the sequence", async () => {
    await fx.server.stop();
    await fx.host.cleanup();
    fx = await setup({ serve: { failWrites: /keys\/import$/ } });
    expect((await fx.signer.send(importKey())).status).toBe(500);
    expect(fx.server.requests.filter((r) => r.path.endsWith("/keys/import"))).toHaveLength(1);
    const res = await fx.signer.send(req({ op: "expression.put.private", method: "PUT", target: `/v1/identities/${ID}/expression`, body: json({ register: "Plain." }) }));
    expect(res.status).toBe(201);
    expect(mutations(fx.server).map((r) => r.headers["x-agenttool-authority-sequence"])).toEqual(["1", "2"]);
  });

  test("the server's root must be the one this keychain derives, or nothing is signed for it", async () => {
    rootOf.set(ID, toB64(edPublicKey(HOST_SEED)));
    try {
      expect((await refusal(fx.signer.send(importKey()))).code).toBe("invalid-record");
      expect(mutations(fx.server)).toHaveLength(0);
    } finally {
      rootOf.set(ID, TEST_ROOT_PUBLIC_B64);
    }
    // A citizen record whose root does not match the mnemonic is refused before any request.
    await writeCitizenRecord(fx.host, "glossame", { ...GLOSSAME_IDENTITY, root_public_key_b64: HERALD_ROOT_B64 });
    const before = fx.server.requests.length;
    expect((await refusal(fx.signer.send(importKey()))).code).toBe("invalid-record");
    expect(fx.server.requests.length).toBe(before);
  });

  test("each op is bound to its own route and the actor's own identity", async () => {
    const other = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    const cases: [SignerRequest, string][] = [
      // A visibility change is a PATCH, which no within-self op covers.
      [req({ op: "expression.put.private", method: "PATCH", target: `/v1/identities/${ID}`, body: json({ expression_visibility: "public" }) }), "invalid-request"],
      [req({ op: "read", method: "PATCH", target: `/v1/identities/${ID}`, body: json({ expression_visibility: "public" }) }), "invalid-request"],
      [req({ op: "read", method: "POST", target: "/v1/strands", body: json({}) }), "invalid-request"],
      [req({ op: "keys.import", method: "POST", target: `/v1/identities/${other}/keys/import`, body: json({ public_key: TEST_OP_PUBLIC_B64 }) }), "beyond-self"],
      [req({ op: "read", method: "GET", target: `/v1/identities/${other}/keys` }), "beyond-self"],
      [req({ op: "read", method: "GET", target: `/v1/quiet-hours?identity_id=${other}` }), "beyond-self"],
      [req({ op: "keys.revoke", method: "DELETE", target: `/v1/identities/${ID}/keys/${ROOT_KID}` }), "invalid-request"],
      [req({ op: "keys.import", method: "POST", target: `/v1/identities/${ID}/keys/import?identity_id=${other}`, body: json({ public_key: TEST_OP_PUBLIC_B64 }) }), "beyond-self"],
      [req({ op: "keys.import", method: "POST", target: `/v1/identities/${ID}/keys/import?label=x`, body: json({ public_key: TEST_OP_PUBLIC_B64 }) }), "invalid-request"],
      [req({ op: "strand.create", method: "POST", target: `/v1/strands?identity_id=${other}`, credits: 1, body: json({ identity_id: ID }) }), "beyond-self"],
      [req({ op: "keys.import", method: "POST", target: `/v1/identities/${ID}/../${other}/keys/import`, body: json({}) }), "invalid-request"],
      [req({ op: "keys.import", method: "POST", target: `https://evil.example/v1/identities/${ID}/keys/import`, body: json({}) }), "invalid-request"],
      [req({ op: "ledger.sign", method: "POST", target: "/v1/strands", body: json({}) }), "invalid-request"],
      [req({ op: "strand.create", method: "POST", target: "/v1/strands", credits: 1, body: json({ topic: "unbound" }) }), "invalid-request"],
      [req({ op: "thought.post", method: "POST", target: `/v1/strands/${TEST_IDS.strand_id}/thoughts`, credits: 1, body: json({ signing_key_id: ROOT_KID }) }), "invalid-request"],
      // Only its own strand: another identity's would charge a credit and then fail, and an unbound one would take the thought.
      [req({ op: "thought.post", method: "POST", target: `/v1/strands/${other}/thoughts`, credits: 1, body: json({ signing_key_id: OP_KID }) }), "beyond-self"],
      [req({ op: "keys.import", method: "POST", target: `/v1/identities/${ID}/keys/import`, body: utf8('{"public_key":"a","public_key":"b"}') }), "invalid-request"],
      [req({ op: "quiet.end.citizen", method: "DELETE", target: `/v1/quiet-hours?identity_id=${ID}`, body: json({}) }), "invalid-request"],
      // Quiet hours takes its actor from ?identity_id=; without it the route acts for the project's earliest
      // identity (the gardener desk in Commons), so no quiet request leaves without naming its own.
      [req({ op: "quiet.start.citizen", method: "POST", target: "/v1/quiet-hours/start", body: json({ until: ahead(DAY_MS) }) }), "invalid-request"],
      [req({ op: "quiet.end.citizen", method: "DELETE", target: "/v1/quiet-hours" }), "invalid-request"],
      [beacon(BEACON_UNTIL, { target: "/v1/quiet-hours/start" }), "invalid-request"],
      [req({ op: "keys.import", word: "glossame", operator: "halt-herald", method: "POST", target: `/v1/identities/${ID}/keys/import`, body: json({}) }), "invalid-request"],
      [req({ op: "read", word: "nobody-here", method: "GET", target: "/v1/strands" }), "invalid-record"],
      [req({ op: "read", word: "zoeme", method: "GET", target: "/v1/strands" }), "not-registered"],
      [{ ...importKey(), credits: -1 }, "ceiling-credits"],
    ];
    for (const [r, code] of cases) expect([r.op, r.target, (await refusal(fx.signer.send(r))).code]).toEqual([r.op, r.target, code]);
    expect(fx.server.requests).toHaveLength(0);
    // Its own reads are fine.
    expect((await fx.signer.send(req({ op: "read", method: "GET", target: `/v1/identities/${ID}/keys` }))).status).toBe(200);
  });

  test("sealThought reproduces the strand-thought/v2 vector with the op key, never the root", async () => {
    const t = vectors.thought_v2;
    fx.thoughtNonce = fromHex(t.aes_256_gcm.nonce_hex);
    const sealed = await fx.signer.sealThought("glossame", t.strand_id, t.plaintext_utf8, t.kind);
    expect(sealed).toEqual({
      ciphertext: t.request_body_fields.ciphertext,
      nonce: t.request_body_fields.nonce,
      kind: t.kind,
      signature: t.signature_b64,
      signing_key_id: OP_KID,
    });
    expect((await refusal(fx.signer.sealThought("zoeme", t.strand_id, "x", t.kind))).code).toBe("not-registered");
    // Never for a strand that is not the citizen's own, and never before one is on record; K_master is not read.
    const reads = fx.kc.log.filter((e) => e.op === "read").length;
    expect((await refusal(fx.signer.sealThought("glossame", "abcdefab-cdef-4abc-8def-abcdefabcdef", "x", t.kind))).code).toBe("beyond-self");
    await writeCitizenRecord(fx.host, "glossame", { ...GLOSSAME_IDENTITY, self_strand_id: null });
    expect((await refusal(fx.signer.sealThought("glossame", t.strand_id, "x", t.kind))).code).toBe("beyond-self");
    expect((await refusal(fx.signer.send(thought()))).code).toBe("beyond-self");
    expect(fx.kc.log.filter((e) => e.op === "read").length).toBe(reads);
    expect((await refusal(fx.signer.sealThought("glossame", "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF", "x", t.kind))).code).toBe("invalid-request");
  });
});

/* ── Failures before sending ──────────────────────────────────────────── */

describe("failures before sending are definite", () => {
  async function thrownBy(p: Promise<unknown>): Promise<unknown> {
    return p.then(
      () => null,
      (e: unknown) => e,
    );
  }

  test("a failed authority read, or a keychain error security did not name, is 'not sent', never 'no response'", async () => {
    // The client's posture read answers; the signer's own sequence read then gets a 503.
    let reads = 0;
    fx.server.on("GET", /^\/v1\/identities\/[^/]+\/authority$/, (r) => {
      reads++;
      if (reads % 2 === 0) return Response.json({ error: "unavailable" }, { status: 503 });
      const id = r.path.split("/")[3]!;
      return Response.json({ identity_id: id, did: `did:at:${id}`, mode: "agent_root", root_public_key: TEST_ROOT_PUBLIC_B64, sequence: 0, next_sequence: 1 });
    });
    const client: ClientDeps = { signer: fx.signer, fetch: fetchVia(fx.server), identity: async () => GLOSSAME_IDENTITY };
    const e = await thrownBy(importOpKey(client, "glossame", TEST_OP_PUBLIC_B64, "op-2026-11"));
    expect(e).toBeInstanceOf(SignerNotSent);
    expect((e as SignerNotSent).code).toBe("authority-read-failed");
    expect(e).not.toBeInstanceOf(AgenttoolError);
    expect(mutations(fx.server)).toHaveLength(0);

    // An unclassified keychain failure on the bearer read: nothing was sent, and the caller is told so.
    const read = fx.kc.read.bind(fx.kc);
    fx.kc.read = async (item) => {
      if (item.kind === "commons-bearer") throw new Error("read: security exited 1");
      return read(item);
    };
    const before = fx.server.requests.length;
    const e2 = await thrownBy(fx.signer.send(req({ op: "read", method: "GET", target: `/v1/identities/${ID}/keys` })));
    expect(e2).toBeInstanceOf(SignerNotSent);
    expect((e2 as SignerNotSent).code).toBe("not-sent");
    expect(fx.server.requests.length).toBe(before);
    // A wall is still a wall.
    fx.kc.read = async (item) => {
      if (item.kind === "commons-bearer") throw new Refusal("keychain-locked", "locked");
      return read(item);
    };
    expect((await refusal(fx.signer.send(importKey()))).code).toBe("keychain-locked");
  });
});

/* ── Secrets never leave ──────────────────────────────────────────────── */

describe("secrets never leave", () => {
  test("no fake-keychain secret appears in any request URL, header other than Authorization, body, error message or log line", async () => {
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      }),
    );
    const errors: string[] = [];
    const responses: string[] = [];
    const attempt = async (p: Promise<unknown>) => {
      try {
        responses.push(JSON.stringify(await p));
      } catch (e) {
        errors.push(`${(e as Error).name}: ${(e as Error).message}`);
      }
    };
    try {
      fx.agreements = [quietAgreement()];
      const body = enrollmentBody("zoeme");
      const present = await presentFor("birth zoeme");
      const header = await fx.signer.signEnrollment("zoeme", sha256(body), present);
      await attempt(fx.signer.send(importKey()));
      await attempt(fx.signer.send(quiet({ until: ahead(DAY_MS) })));
      await attempt(fx.signer.send(quiet({ until: ahead(31 * DAY_MS) })));
      await attempt(fx.signer.send(beacon(BEACON_UNTIL)));
      await attempt(fx.signer.send(thought()));
      await attempt(fx.signer.send(req({ op: "read", method: "GET", target: `/v1/identities/${ID}/keys` })));
      await attempt(
        fx.signer.send(req({ op: "enroll", word: null, method: "POST", target: "/v1/identities/enroll", body, presence: present, proposal: filed("birth zoeme"), extra_headers: { "X-Agenttool-Enrollment-Signature": header } })),
      );
      await attempt(fx.signer.sealThought("glossame", TEST_IDS.strand_id, "a test thought", "observation"));
      await attempt(fx.signer.signEntry("glossame", "citizen", draftOf("glossame", "citizen")));
      await attempt(fx.signer.signEntry("zoeme", "host", draftOf("zoeme", "host")));
      await attempt(fx.signer.publicKeys("glossame"));
      await attempt(fx.signer.send(req({ op: "keys.import", method: "POST", target: "/v1/identities/x/keys/import" })));
      fx.spend = async (word) => ({ word, usd_today: null, credits_month: null });
      await attempt(fx.signer.send(thought()));
      // A broken mnemonic and a broken bearer must be refused without echoing either.
      const brokenMnemonic = fakeKeychain([
        [{ kind: "citizen-mnemonic", word: "glossame" }, utf8("abandon abandon wrong words CANARY-MNEMONIC-TEXT")],
        [{ kind: "citizen-mnemonic", word: "zoeme" }, utf8("zoeme CANARY-MNEMONIC-TEXT abandon")],
        [{ kind: "citizen-op-seed", word: "glossame" }, utf8("CANARY-SEED-TEXT-not-32-bytes")],
        [{ kind: "commons-bearer" }, utf8(COMMONS_BEARER)],
      ]);
      const brokenBearer = fakeKeychain([[{ kind: "commons-bearer" }, utf8("not-a-bearer CANARY-BEARER-TEXT\nX-Injected: 1")]]);
      const before = errors.length;
      for (const keychain of [brokenMnemonic, brokenBearer]) {
        const s2 = createSigner({ keychain, config: fx.host.config, clock: fx.clock, fetch: fetchVia(fx.server), spendSoFar: fx.spend, agreements: async () => [] });
        await attempt(s2.send(importKey()));
        await attempt(s2.send(req({ op: "read", method: "GET", target: `/v1/identities/${ID}/keys` })));
        await attempt(s2.signEnrollment("zoeme", sha256("x"), present));
        await attempt(s2.signEntry("glossame", "citizen", draftOf("glossame", "citizen")));
      }
      const brokenErrors = errors.slice(before);
      expect(brokenErrors.filter((e) => e.includes("does not derive"))).toHaveLength(2);
      expect(brokenErrors.some((e) => e.includes("stored bearer"))).toBe(true);
      expect(brokenErrors.some((e) => e.includes("stored seed"))).toBe(true);
      for (const e of brokenErrors) {
        assertNoSecretIn(brokenMnemonic, e, "an error message");
        assertNoSecretIn(brokenBearer, e, "an error message");
        expect(e).not.toContain("CANARY");
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }

    expect(errors.length).toBeGreaterThanOrEqual(5);
    expect(fx.server.requests.length).toBeGreaterThanOrEqual(8);
    const derived = DERIVED_SECRETS.flatMap((s) => [toHex(s), toB64(s), Buffer.from(s).toString("base64url")]);
    const check = (text: string, where: string) => {
      assertNoSecretIn(fx.kc, text, where);
      for (const form of derived) if (text.includes(form)) throw new Error(`a derived secret leaked into ${where}`);
    };
    for (const r of fx.server.requests) {
      check(r.path + r.search, "a request URL");
      check(Buffer.from(r.body).toString("latin1"), "a request body");
      for (const [name, value] of Object.entries(r.headers)) {
        if (name === "authorization") expect([`Bearer ${COMMONS_BEARER}`, `Bearer ${HERALD_BEARER}`]).toContain(value);
        else check(value, `header ${name}`);
      }
    }
    for (const e of errors) check(e, "an error message");
    for (const r of responses) check(r, "a return value");
    for (const l of logged) check(l, "a log line");
    expect(logged).toEqual([]);
  });

  test("publicKeys returns public keys only", async () => {
    const keys = await fx.signer.publicKeys("glossame");
    expect(keys).toEqual({
      root_b64: TEST_ROOT_PUBLIC_B64,
      op_b64: TEST_OP_PUBLIC_B64,
      op_kid: OP_KID,
      box_b64: vectors.derivation.box_pub_b64,
      host_attest_b64: toB64(edPublicKey(HOST_SEED)),
    });
    assertNoSecretIn(fx.kc, JSON.stringify(keys), "publicKeys");
    const zoeme = await fx.signer.publicKeys("zoeme");
    expect(zoeme).toMatchObject({ op_b64: null, op_kid: null, root_b64: TEST_ROOT_PUBLIC_B64 });
  });

  test("hostPublicKey returns the public half only, reads only host/attest-seed, and refuses with keychain-missing or keychain-locked", async () => {
    const before = fx.kc.log.length;
    const key = await fx.signer.hostPublicKey();
    expect(key).toBe(toB64(edPublicKey(HOST_SEED)));
    assertNoSecretIn(fx.kc, key, "hostPublicKey");
    // One read, of the host's own seed: no citizen item, and no citizen record on disk is needed for it.
    expect(fx.kc.log.slice(before)).toEqual([{ op: "read", item: "host/attest-seed" }]);
    // The seed it was handed is wiped once the public half is derived.
    expect(fx.handedOut.at(-1)!.every((b) => b === 0)).toBe(true);

    fx.kc.locked = true;
    const locked = await fx.signer.hostPublicKey().then(() => null, (e: unknown) => e);
    expect(locked).toBeInstanceOf(Refusal);
    expect((locked as Refusal).code).toBe("keychain-locked");
    fx.kc.locked = false;

    // A host that holds no host key says so, where state() still answers "ready" for it.
    const empty = createSigner({ keychain: fakeKeychain(), config: fx.host.config, clock: fx.clock, fetch: fetchVia(fx.server), spendSoFar: (word) => fx.spend(word), agreements: async () => [] });
    const missing = await empty.hostPublicKey().then(() => null, (e: unknown) => e);
    expect(missing).toBeInstanceOf(Refusal);
    expect((missing as Refusal).code).toBe("keychain-missing");
    expect(await empty.state()).toBe("ready");
  });
});

describe("birth's own steps, between enroll and the saved identity", () => {
  test("act for a seated citizen with no identity yet only with Yu present here and consent for that birth, and only on birth's routes", async () => {
    const NEW_ID = "99999999-9999-4999-8999-999999999999";
    // zoeme's mnemonic is the test mnemonic, so its root is the vectors' root.
    rootOf.set(NEW_ID, TEST_ROOT_PUBLIC_B64);
    const enrolled = { identity_id: NEW_ID, did: didFor(NEW_ID) };
    const birth = filed("birth zoeme");
    const presence = await presentFor("birth zoeme");
    const step = (patch: Partial<SignerRequest> = {}) =>
      req({
        word: "zoeme",
        op: "keys.import",
        method: "POST",
        target: `/v1/identities/${NEW_ID}/keys/import`,
        body: json({ public_key: TEST_OP_PUBLIC_B64, label: "op-2026-11" }),
        enrolled,
        presence,
        proposal: birth,
        ...patch,
      });
    const code = async (r: SignerRequest) => (await refusal(fx.signer.send(r))).code;

    try {
      expect(await code(step({ enrolled: undefined }))).toBe("not-registered");
      expect(await code(step({ presence: null }))).toBe("yu-not-present");
      // A copy of a presence was not confirmed at this terminal, and a summons presence is for another scope.
      expect(await code(step({ presence: { ...presence } }))).toBe("yu-not-present");
      expect(await code(step({ presence: await presentFor("summon zoeme") }))).toBe("yu-not-present");
      expect(await code(step({ proposal: null }))).toBe("consent-missing");
      expect(await code(step({ proposal: filed("birth glossame") }))).toBe("consent-missing");
      expect(await code(step({ proposal: filed("birth zoeme", { yu: { word: "no" } }) }))).toBe("consent-rejected");
      filed("birth zoeme");
      // Only birth's steps: nothing that spends, posts or quiets.
      expect(await code(step({ op: "strand.create", target: "/v1/strands", body: json({ identity_id: NEW_ID, topic: "self" }), credits: 1 }))).toBe("not-registered");
      expect(await code(step({ op: "quiet.start.citizen", target: `/v1/quiet-hours/start?identity_id=${NEW_ID}`, body: json({ until: ahead(DAY_MS) }) }))).toBe("not-registered");
      // Only its own identity, never a beacon's, and never a malformed one.
      expect(await code(step({ target: `/v1/identities/${ID}/keys/import` }))).toBe("beyond-self");
      expect(await code(step({ enrolled: { identity_id: HERALD_ID, did: didFor(HERALD_ID) }, target: `/v1/identities/${HERALD_ID}/keys/import` }))).toBe("invalid-record");
      expect(await code(step({ enrolled: { identity_id: NEW_ID, did: DID } }))).toBe("invalid-request");
      // Once the identity is on file, the record alone names it.
      expect(await code(step({ word: "glossame", target: `/v1/identities/${ID}/keys/import` }))).toBe("invalid-request");
      expect(fx.server.requests).toHaveLength(0);

      // With all of it: the authority read, then the import, root-signed by the root zoeme's own mnemonic derives.
      const read = await fx.signer.send(step({ op: "read", method: "GET", target: `/v1/identities/${NEW_ID}/authority`, body: new Uint8Array() }));
      expect(read.status).toBe(200);
      const res = await fx.signer.send(step());
      expect(res.status).toBe(201);
      const sent = fx.server.requests.filter((r) => r.method === "POST");
      expect(sent).toHaveLength(1);
      const r = sent[0]!;
      expect(r.headers.authorization).toBe(`Bearer ${COMMONS_BEARER}`);
      const digest = authorityDigest({ did: didFor(NEW_ID), method: "POST", target: r.path, body: r.body, sequence: 1, timestamp: r.headers["x-agenttool-authority-timestamp"]! });
      expect(edVerifyStrict(fromB64(r.headers["x-agenttool-authority-signature"]!, 64), digest, fromB64(TEST_ROOT_PUBLIC_B64, 32))).toBe(true);

      // A server that shows another root for that identity gets nothing signed.
      rootOf.set(NEW_ID, HERALD_ROOT_B64);
      expect(await code(step())).toBe("invalid-record");
      expect(fx.server.requests.filter((q) => q.method === "POST")).toHaveLength(1);
    } finally {
      rootOf.delete(NEW_ID);
    }
  });
});

/* ── Letters (KS-004 5.7, re-review C M3) ─────────────────────────────── */

describe("[KS-004 5.7, re-review C M3] a letter is sealed and op-signed in the signer, sent with nothing the envelope does not cover", () => {
  const SHEMME_ID = "66666666-6666-4666-8666-666666666666";
  const SHEMME_DID = didFor(SHEMME_ID);
  const SHEMME_BOX = sha256("kingdom-seat signer test box key, shemme");
  const BOX_KEY_ID = "70707070-7070-4070-8070-707070707070";
  const letter = (body: Record<string, unknown>, patch: Partial<SignerRequest> = {}) => req({ op: "inbox.send", method: "POST", target: "/v1/inbox", credits: 2, body: json(body), ...patch });

  async function sealed(text = "One word for shemme.") {
    const { x25519 } = await import("@noble/curves/ed25519.js");
    const s = await fx.signer.sealLetter("glossame", { did: SHEMME_DID, box_public_key_b64: toB64(x25519.getPublicKey(SHEMME_BOX)) }, text);
    return { s, body: { to_did: SHEMME_DID, ciphertext: s.ciphertext, nonce: s.nonce, ephemeral_pubkey: s.ephemeral_pubkey, recipient_box_key_id: BOX_KEY_ID, signature: s.signature, signing_key_id: s.signing_key_id, sender_did: DID } };
  }

  test("sealLetter seals to the recipient's box key and signs inbox-message/v1 with the op key; only that recipient opens it", async () => {
    const { s } = await sealed();
    expect(s.signing_key_id).toBe(OP_KID);
    const { inboxDigest, openInbox } = await import("../../src/agenttool/wire.ts");
    const digest = inboxDigest(SHEMME_DID, fromB64(s.ciphertext), fromB64(s.nonce, 12), fromB64(s.ephemeral_pubkey, 32));
    expect(edVerifyStrict(fromB64(s.signature, 64), digest, fromB64(TEST_OP_PUBLIC_B64, 32))).toBe(true);
    expect(edVerifyStrict(fromB64(s.signature, 64), digest, fromB64(TEST_ROOT_PUBLIC_B64, 32))).toBe(false);
    expect(await openInbox(fromB64(s.ciphertext), fromB64(s.nonce, 12), fromB64(s.ephemeral_pubkey, 32), SHEMME_BOX)).toBe("One word for shemme.");
    // An unregistered citizen has no op key to sign with, and no letter goes to its own DID.
    expect((await refusal(fx.signer.sealLetter("zoeme", { did: SHEMME_DID, box_public_key_b64: toB64(edPublicKey(SHEMME_BOX)) }, "x"))).code).toBe("not-registered");
    expect((await refusal(fx.signer.sealLetter("glossame", { did: DID, box_public_key_b64: vectors.derivation.box_pub_b64 }, "x"))).code).toBe("invalid-request");
    assertNoSecretIn(fx.kc, JSON.stringify(s), "a sealed letter");
    const text = JSON.stringify(s);
    for (const d of DERIVED_SECRETS.flatMap((x) => [toHex(x), toB64(x), Buffer.from(x).toString("base64url")])) expect(text).not.toContain(d);
  });

  test("[S4-4] a letter past the monthly credit ceiling is refused before it is even sealed, since agenttool charges before it checks", async () => {
    fx.spend = async (word) => ({ word, usd_today: "0", credits_month: 9 });
    const reads = fx.kc.log.filter((e) => e.op === "read").length;
    expect((await refusal(sealed())).code).toBe("ceiling-credits");
    expect(fx.kc.log.filter((e) => e.op === "read").length).toBe(reads);
    expect(fx.server.requests).toHaveLength(0);
  });

  test("inbox.send carries exactly the envelope and both ends' ids, from the citizen's own op key, signed for that recipient; anything else is refused unsent", async () => {
    fx.server.on("POST", "/v1/inbox", () => Response.json({ id: "71717171-7171-4171-8171-717171717171", created_at: NOW, sent: true }, { status: 201 }));
    const { body } = await sealed();
    const cases: [Record<string, unknown>, string][] = [
      // The route takes these, but the envelope signature does not cover them: the bearer would be speaking.
      [{ ...body, subject: "hello" }, "invalid-request"],
      [{ ...body, metadata: { dual_witness_required: true } }, "invalid-request"],
      [{ ...body, sender_did: didFor(SHEMME_ID) }, "invalid-request"],
      [{ ...body, signing_key_id: ROOT_KID }, "invalid-request"],
      [{ ...body, to_did: DID }, "invalid-request"],
      // Sealed and signed for shemme, then readdressed: the signature no longer covers it.
      [{ ...body, to_did: didFor("72727272-7272-4272-8272-727272727272") }, "invalid-request"],
      [{ ...body, recipient_box_key_id: "not-a-uuid" }, "invalid-request"],
    ];
    for (const [b, code] of cases) expect((await refusal(fx.signer.send(letter(b)))).code).toBe(code as Refusal["code"]);
    expect((await refusal(fx.signer.send(letter(body, { word: "zoeme" })))).code).toBe("not-registered");
    expect(fx.server.requests).toHaveLength(0);
    // The route charges 2 whatever the caller says, so the ceiling is held to 2.
    fx.spend = async (word) => ({ word, usd_today: "0", credits_month: 9 });
    expect((await refusal(fx.signer.send(letter(body, { credits: 0 })))).code).toBe("ceiling-credits");
    expect(fx.server.requests).toHaveLength(0);
    fx.spend = async (word) => ({ word, usd_today: "0", credits_month: 0 });

    const res = await fx.signer.send(letter(body));
    expect(res.status).toBe(201);
    const [r] = fx.server.requests;
    expect([r!.method, r!.path, r!.headers.authorization, r!.headers["x-agenttool-authority-signature"]]).toEqual(["POST", "/v1/inbox", `Bearer ${COMMONS_BEARER}`, undefined]);
    expect(JSON.parse(new TextDecoder().decode(r!.body))).toEqual(body);
  });

  test("the inbox reads go through as bearer reads of the citizen's own inbox and of a recipient's public box key, and of no other identity's inbox", async () => {
    fx.server.on("GET", "/v1/inbox", () => Response.json({ messages: [] }));
    fx.server.on("GET", /^\/v1\/inbox\/box-keys\//, () => Response.json({ did: SHEMME_DID, box_key_id: BOX_KEY_ID, public_key: "x" }));
    expect((await fx.signer.send(req({ op: "read", method: "GET", target: `/v1/inbox?identity_id=${ID}&status=unread` }))).status).toBe(200);
    expect((await fx.signer.send(req({ op: "read", method: "GET", target: `/v1/inbox/box-keys/${SHEMME_DID}` }))).status).toBe(200);
    expect((await refusal(fx.signer.send(req({ op: "read", method: "GET", target: `/v1/inbox?identity_id=${SHEMME_ID}&status=unread` })))).code).toBe("beyond-self");
    expect(fx.server.requests.map((r) => `${r.path}${r.search}`)).toEqual([`/v1/inbox?identity_id=${ID}&status=unread`, `/v1/inbox/box-keys/${SHEMME_DID}`]);
  });

  test("openLetter opens a letter sealed to the citizen's own box key, and refuses one addressed to anyone else", async () => {
    const { sealInbox } = await import("../../src/agenttool/wire.ts");
    const s = await sealInbox("A letter for glossame.", fromB64(vectors.derivation.box_pub_b64, 32));
    const msg = { recipient_did: DID, ciphertext: toB64(s.ciphertext), nonce: toB64(s.nonce), ephemeral_pubkey: toB64(s.ephemeral_pub) };
    expect(await fx.signer.openLetter("glossame", msg)).toBe("A letter for glossame.");
    expect((await refusal(fx.signer.openLetter("glossame", { ...msg, recipient_did: SHEMME_DID }))).code).toBe("beyond-self");
    expect((await refusal(fx.signer.openLetter("zoeme", msg))).code).toBe("not-registered");
    // A record whose box key is not the one the mnemonic derives opens nothing.
    await writeCitizenRecord(fx.host, "glossame", { ...GLOSSAME_IDENTITY, box_public_key_b64: toB64(edPublicKey(SHEMME_BOX)) });
    expect((await refusal(fx.signer.openLetter("glossame", msg))).code).toBe("invalid-record");
  });
});
