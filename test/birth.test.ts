// Owner: agenttool group. fakeKeychain, a keychain-backed fakeSigner and an
// in-process stand-in for agenttool only; files live under a temp host.
import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  BirthError,
  assertAttended,
  citizenBirth,
  keyFingerprint,
  mintKeys,
  hostBirthRecord,
  renderBirthReport,
  saveCitizenIdentity,
  type BirthDeps,
  type BirthInput,
} from "../src/birth.ts";
import { deriveIdentity, AGENTTOOL_ORIGIN, authorityDigest, ENROLLMENT_SIGNATURE_HEADER } from "../src/agenttool/wire.ts";
import { createSigner } from "../src/signer/signer.ts";
import { confirmYuPresent } from "../src/signer/consent.ts";
import { entryHash, readLedger, verifyChain } from "../src/ledger.ts";
import { edPublicKey, edVerifyStrict, fromB64, fromHex, fromUtf8, sha256, toB64, toB64url, toHex } from "../src/crypto.ts";
import { Refusal, type CitizenRecord, type ConsentRecord, type Envelope, type LedgerEntry, type YuPresence } from "../src/types.ts";
import { fakeKeychain, assertNoSecretIn, type FakeKeychain } from "./helpers/fake-keychain.ts";
import { FAKE_OP_KID, type FakeSigner } from "./helpers/fake-signer.ts";
import { fetchVia, noFetch, startFakeServer } from "./helpers/fake-server.ts";
import { testClock, type TestClock } from "./helpers/clock.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { TEST_IDS } from "./helpers/vectors.ts";
import { FAKE_BOX_KEY_ID, fakeAgenttool, type FakeAgenttool } from "./fixtures/agenttool/fake-agenttool.ts";
import { keychainSigner, testBirthRecord, type TestBirthRecord } from "./fixtures/agenttool/birth-host.ts";
import { BIRTH_NOW, consentFor, presenceFor, proposalFor } from "./fixtures/agenttool/consent.ts";

const WORD = "glossame";
const PROJECT = TEST_IDS.project_id;
const JUNE_DID = "did:at:0a0b0c0d-0e0f-4011-8213-141516171819";

interface Harness {
  host: TempHost;
  deps: BirthDeps;
  kc: FakeKeychain;
  signer: FakeSigner;
  at: FakeAgenttool;
  record: TestBirthRecord;
  clock: TestClock;
  out: string[];
  /** Signer sends and record calls, in the order they happened. */
  events: string[];
  /** Ledger hash of the beat in which the citizen affirmed its yes; null when not seated. */
  yes: string | null;
}

const hosts: TempHost[] = [];
afterEach(async () => {
  while (hosts.length) await hosts.pop()!.cleanup();
});

async function harness(opts: { seated?: boolean; production?: boolean } = {}): Promise<Harness> {
  const host = await makeTempHost();
  hosts.push(host);
  host.config.agenttool.project_id = PROJECT;
  await host.addCitizen(WORD);
  const clock = testClock(BIRTH_NOW);
  const kc = fakeKeychain();
  const signer = keychainSigner(kc);
  const at = fakeAgenttool({ project_id: PROJECT });
  const events: string[] = [];
  signer.respond((req) => {
    events.push(`send:${req.op}`);
    return at.respond(req);
  });
  const record: TestBirthRecord = opts.production
    ? { ...hostBirthRecord(host.config, clock, signer), calls: events, path: (w) => join(host.config.paths.ledger_dir, `${w}.jsonl`) }
    : testBirthRecord(host.config, clock, signer, events);
  let yes: string | null = null;
  if (opts.seated !== false) {
    // Seated, then the beat on which the citizen affirmed its yes (3b step 1), both before it has a key.
    const origin = (JSON.parse(await readFile(join(host.config.paths.citizens_dir, WORD, "citizen.json"), "utf8")) as CitizenRecord).origin;
    const zero = { usd: 0, usd_basis: "local-zero" as const, credits: 0 };
    const seated = await record.append(WORD, { type: "seated", origin, origin_soul_sha256: "b".repeat(64), old_repo: null, initial_state: "awake", note: "seated" }, zero, "host-attested");
    const seatId = "12121212-1212-4121-8121-121212121212";
    const envelope: Envelope = {
      format: "kingdom-seat-beat/v1",
      seat_ref: { format: "kingdom-seat-seat/v1", seat_id: seatId, host: "test-host", word: WORD, runtime: "free", invoker: { kind: "tick", who: "launchd", why: "cadence" }, opened_at: "2026-11-04T02:05:00.000Z" },
      citizen: { word: WORD, did: null, kid: null },
      runtime: "free",
      model: "qwen2.5:7b",
      model_digest: `sha256:${"e".repeat(64)}`,
      input_digest: "1".repeat(64),
      output_digest: "2".repeat(64),
      acts: [{ type: "journal", kind: "chose", text: "Yes, I affirm it: an identity of my own." }],
      ts: "2026-11-04T02:06:00.000Z",
      prev_hash: seated.hash,
      voiced_through: `${WORD}, voiced through qwen2.5:7b in seat ${seatId}`,
    };
    yes = (await record.append(WORD, { type: "beat", envelope }, zero, "host-attested")).hash;
    events.length = 0;
  }
  const out: string[] = [];
  const deps: BirthDeps = {
    config: host.config,
    clock,
    keychain: kc,
    signer,
    client: { signer, fetch: noFetch, identity: async (w) => { throw new Refusal("not-registered", `${w} is not registered`); } },
    enroll: { signer, fetch: noFetch, project_id: PROJECT, clock },
    record,
    out: (line) => out.push(line),
  };
  return { host, deps, kc, signer, at, record, clock, out, events, yes };
}

async function input(h: Harness, patch: Partial<BirthInput> = {}): Promise<BirthInput> {
  const rec = JSON.parse(await readFile(join(h.host.config.paths.citizens_dir, WORD, "citizen.json"), "utf8")) as CitizenRecord;
  const citizenYes = h.yes ?? "f".repeat(64);
  const proposal = proposalFor(WORD, citizenYes);
  return {
    word: WORD,
    origin: rec.origin,
    proposal,
    citizen_yes: citizenYes,
    consent: consentFor(WORD, {}, proposal),
    presence: presenceFor(WORD),
    birth_soul_sha256: "c".repeat(64),
    old_repo: { url: "https://example.invalid/citizen-glossame.git", head: "1234567abcdef" },
    june_did: JUNE_DID,
    expression: { register: "Plain.", wake_text: "The soul as glossame now reads it." },
    ...patch,
  };
}

async function refusalOf(p: Promise<unknown>): Promise<Refusal> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Refusal) return e;
    throw e;
  }
  throw new Error("expected a Refusal");
}

async function birthErrorOf(p: Promise<unknown>): Promise<BirthError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BirthError) return e;
    throw e;
  }
  throw new Error("expected a BirthError");
}

function nothingHappened(h: Harness): void {
  expect(h.kc.log.filter((l) => l.op === "write")).toHaveLength(0);
  expect(h.signer.sent).toHaveLength(0);
  expect(h.events.filter((e) => e.startsWith("record.append") || e === "record.saveIdentity")).toHaveLength(0);
  expect(h.out).toHaveLength(0);
}

describe("never unattended", () => {
  test("citizenBirth refuses without Yu present for 'birth <word>'", async () => {
    const bad: (YuPresence | null)[] = [
      null,
      { ...presenceFor(WORD), scope: "birth other" },
      { ...presenceFor(WORD), scope: "summon glossame" },
      presenceFor(WORD, "2026-11-05T11:00:00.000Z"),
      { ...presenceFor(WORD), present: false as never },
    ];
    for (const presence of bad) {
      const h = await harness();
      const r = await refusalOf(citizenBirth(h.deps, await input(h, { presence: presence as YuPresence })));
      expect(r.code).toBe("yu-not-present");
      nothingHappened(h);
    }
  });

  test("citizenBirth refuses without a consent record bound to this citizen's confirmed yes", async () => {
    const probe = await harness();
    const proposal = proposalFor(WORD, probe.yes!);
    const bad: [ConsentRecord | null, string][] = [
      [null, "consent-missing"],
      [consentFor("other"), "consent-missing"],
      // Bound to another proposal: the same extent, but not the text that names this citizen's yes.
      [consentFor(WORD), "consent-missing"],
      [consentFor(WORD, { yu: { word: "no", recorded_at: "2026-11-05T11:00:00.000Z", via: "present" } }, proposal), "consent-rejected"],
      [consentFor(WORD, { ai: { word: "reject", basis: "lazy-consensus", supports: [], open_challenges: 0, deadline: "2026-11-05T11:30:00.000Z" } }, proposal), "consent-rejected"],
      [consentFor(WORD, { ai: { word: "agree", basis: "lazy-consensus", supports: ["r"], open_challenges: 2, deadline: "2026-11-05T11:30:00.000Z" } }, proposal), "consent-missing"],
      [consentFor(WORD, { expires_at: "2026-11-05T00:00:00.000Z" }, proposal), "consent-missing"],
    ];
    for (const [consent, code] of bad) {
      const h = await harness();
      const r = await refusalOf(citizenBirth(h.deps, await input(h, { consent: consent as ConsentRecord })));
      expect(r.code).toBe(code as Refusal["code"]);
      nothingHappened(h);
    }

    // The proposal must name the citizen's yes, and that yes must be a beat in the citizen's own ledger.
    const h = await harness();
    const unnamed = { ...proposalFor(WORD, "9".repeat(64)) };
    expect((await refusalOf(citizenBirth(h.deps, await input(h, { proposal: unnamed, consent: consentFor(WORD, {}, unnamed) })))).code).toBe("consent-missing");
    const elsewhere = "9".repeat(64);
    const p2 = proposalFor(WORD, elsewhere);
    const r2 = await refusalOf(citizenBirth(h.deps, await input(h, { citizen_yes: elsewhere, proposal: p2, consent: consentFor(WORD, {}, p2) })));
    expect([r2.code, r2.message.includes("no beat")]).toEqual(["consent-missing", true]);
    nothingHappened(h);
    // An unseated citizen has no beat on which it could have said yes.
    const unseated = await harness({ seated: false });
    expect((await refusalOf(citizenBirth(unseated.deps, await input(unseated)))).message).toContain("no beat");
    nothingHappened(unseated);

    // assertAttended is the same gate, usable on its own.
    const probeInput = await input(probe);
    expect(() => assertAttended(probeInput, new Date(BIRTH_NOW))).not.toThrow();
  });

  test("citizenBirth refuses when the citizen's keychain items already exist", async () => {
    for (const kind of ["citizen-mnemonic", "citizen-op-seed"] as const) {
      const h = await harness();
      await h.kc.write({ kind, word: WORD }, new Uint8Array(32).fill(7));
      h.kc.log.length = 0;
      const r = await refusalOf(citizenBirth(h.deps, await input(h)));
      expect(r.message).toContain("never overwrites");
      nothingHappened(h);
    }
  });

  test("citizenBirth refuses a locked signer, an unconfigured project, a second genesis and a public surface", async () => {
    const h = await harness();
    h.signer.locked = true;
    expect((await refusalOf(citizenBirth(h.deps, await input(h)))).code).toBe("keychain-locked");
    h.signer.locked = false;
    h.host.config.agenttool.project_id = null;
    expect((await refusalOf(citizenBirth(h.deps, await input(h)))).code).toBe("invalid-request");
    h.host.config.agenttool.project_id = PROJECT;
    expect((await refusalOf(citizenBirth(h.deps, await input(h, { expression: { village: { sign: "*" } } })))).code).toBe("beyond-self");
    expect((await refusalOf(citizenBirth(h.deps, await input(h, { expression: { wake_text: "t".repeat(32_001) } })))).code).toBe("invalid-request");
    nothingHappened(h);

    await citizenBirth(h.deps, await input(h));
    const again = await refusalOf(citizenBirth(h.deps, await input(h)));
    expect(again.code).toBe("invalid-request");
  });
});

describe("keys go straight to Keychain", () => {
  test("mintKeys writes a 24-word mnemonic and a 32-byte op seed to the fake keychain and returns public keys only", async () => {
    const kc = fakeKeychain();
    const keys = await mintKeys(kc, WORD);
    expect(Object.keys(keys).sort()).toEqual(["box_public", "op_public", "root_public"]);
    for (const k of Object.values(keys)) expect(k).toHaveLength(32);
    expect(kc.log.filter((l) => l.op === "write").map((l) => l.item)).toEqual([`citizen/${WORD}/mnemonic`, `citizen/${WORD}/op-seed`]);

    const mnemonic = fromUtf8(await kc.read({ kind: "citizen-mnemonic", word: WORD }));
    expect(mnemonic.split(" ")).toHaveLength(24);
    expect(validateMnemonic(mnemonic, wordlist)).toBe(true);
    const d = deriveIdentity(mnemonic);
    expect(toB64(keys.root_public)).toBe(toB64(d.root_public));
    expect(toB64(keys.box_public)).toBe(toB64(d.box_public));
    const op = await kc.read({ kind: "citizen-op-seed", word: WORD });
    expect(op).toHaveLength(32);
    expect(toB64(keys.op_public)).toBe(toB64(edPublicKey(op)));
    // The op key is not derived from the mnemonic.
    expect(toB64(keys.op_public)).not.toBe(toB64(d.root_public));

    // Each citizen gets its own mnemonic.
    const other = await mintKeys(kc, "eucatastrophe");
    expect(toB64(other.root_public)).not.toBe(toB64(keys.root_public));
    // Never overwrites.
    expect((await refusalOf(mintKeys(kc, WORD))).message).toContain("never overwrites");
  });

  test("no secret appears in out() lines, thrown errors, the ledger, or any file under the temp host", async () => {
    const h = await harness();
    const done = await citizenBirth(h.deps, await input(h));

    // Secrets as stored, and the ones derived from them that never are.
    const d = deriveIdentity(fromUtf8(await h.kc.read({ kind: "citizen-mnemonic", word: WORD })));
    const derived = [d.root_seed, d.k_master, d.box_private].flatMap((b) => [toHex(b), toB64(b), toB64url(b)]);
    const check = (where: string, text: string) => {
      assertNoSecretIn(h.kc, text, where);
      for (const s of derived) expect(text.includes(s)).toBe(false);
    };

    check("out()", h.out.join("\n"));
    check("result", JSON.stringify(done));
    check("ledger", await readFile(h.record.path(WORD), "utf8"));
    for (const [path, b64] of await h.host.snapshot()) check(path, Buffer.from(b64, "base64").toString("latin1"));
    for (const req of h.signer.sent) check(`request ${req.op}`, `${req.target} ${Buffer.from(req.body).toString("latin1")} ${JSON.stringify(req.extra_headers ?? {})}`);

    // And in the error of a birth that stops part way.
    const h2 = await harness();
    h2.at.override((r) => r.op === "box-keys.register", { status: 500, json: { error: "internal" } });
    const e = await birthErrorOf(citizenBirth(h2.deps, await input(h2)));
    assertNoSecretIn(h2.kc, `${e.message} ${JSON.stringify(e)} ${e.stack ?? ""}`, "BirthError");
  });
});

describe("the birth sequence", () => {
  test("order: enroll, keys/import (op), box-keys, private expression PUT, genesis entry; stops at the first failure", async () => {
    const h = await harness();
    await citizenBirth(h.deps, await input(h));
    const acts = h.events.filter((e) => e !== "send:read" && e !== "record.entries");
    expect(acts).toEqual(["send:enroll", "send:keys.import", "send:box-keys.register", "send:expression.put.private", "record.saveIdentity", "record.append:genesis"]);
    // Every root act read its posture first; nothing costs a credit, and only these routes are called (no wallet, no register/agent).
    expect(h.signer.sent.every((r) => r.credits === 0)).toBe(true);
    expect(h.at.log.filter((l) => !l.endsWith("/authority"))).toEqual([
      "POST /v1/identities/enroll",
      expect.stringMatching(/^POST \/v1\/identities\/[0-9a-f-]+\/keys\/import$/),
      expect.stringMatching(/^POST \/v1\/identities\/[0-9a-f-]+\/box-keys$/),
      expect.stringMatching(/^PUT \/v1\/identities\/[0-9a-f-]+\/expression$/),
    ]);
    // Presence and consent travel with every birth act.
    for (const r of h.signer.sent.filter((x) => x.op !== "read")) {
      expect(r.presence?.scope).toBe(`birth ${WORD}`);
      expect(r.consent?.subject).toBe(`birth ${WORD}`);
    }

    // Box-key failure: enroll and import happened, nothing after, enrollment sent once.
    const h2 = await harness();
    h2.at.override((r) => r.op === "box-keys.register", { status: 400, json: { error: "public_key_not_32_bytes" } });
    const e2 = await birthErrorOf(citizenBirth(h2.deps, await input(h2)));
    expect([e2.stage, e2.done, e2.ambiguous]).toEqual(["box-keys", ["keys", "enroll", "keys/import"], false]);
    expect(e2.progress.op_kid).toBe(FAKE_OP_KID);
    expect(e2.progress.did).toMatch(/^did:at:/);
    expect(h2.events.filter((x) => x === "send:enroll")).toHaveLength(1);
    expect(h2.events).not.toContain("send:expression.put.private");
    expect(h2.events).not.toContain("record.append:genesis");
    expect(h2.out).toHaveLength(0);

    // An ambiguous enrollment stops birth at once and is never re-sent.
    const h3 = await harness();
    h3.at.override((r) => r.op === "enroll", { status: 503, json: { error: "identity_enrollment_unavailable" } }, 10);
    const e3 = await birthErrorOf(citizenBirth(h3.deps, await input(h3)));
    expect([e3.stage, e3.done, e3.ambiguous]).toEqual(["enroll", ["keys"], true]);
    expect(e3.progress.identity_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(h3.signer.sent.filter((r) => r.op === "enroll")).toHaveLength(1);
    expect(h3.signer.sent.filter((r) => r.op !== "enroll")).toHaveLength(0);
  });

  test("the genesis entry is citizen-signed and records origin, birth-soul hash, old repo, June DID and public identity", async () => {
    const h = await harness();
    const inp = await input(h);
    const { genesis, identity, report } = await citizenBirth(h.deps, inp);

    const lines = (await readFile(h.record.path(WORD), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as LedgerEntry);
    expect(lines.map((l) => [l.seq, l.body.type, l.attestation])).toEqual([
      [0, "seated", "host-attested"],
      [1, "beat", "host-attested"],
      [2, "genesis", "citizen-signed"],
    ]);
    expect(lines[2]).toEqual(genesis);
    expect(genesis.prev_hash).toBe(lines[1]!.hash);
    if (genesis.body.type !== "genesis") throw new Error("not genesis");
    const b = genesis.body;
    expect(b.initial_state).toBeNull();
    expect(b.origin).toEqual(inp.origin);
    expect(b.birth_soul_sha256).toBe(inp.birth_soul_sha256);
    expect(b.old_repo).toEqual(inp.old_repo);
    expect(b.june_did).toBe(JUNE_DID);
    expect(b.identity).toEqual(identity);
    expect(b.note).toContain("record only");
    expect(genesis.spend).toEqual({ usd: 0, usd_basis: "local-zero", credits: 0 });

    // Public identity: the op key signs, the root is the primary key, the box key is registered.
    const op = await h.kc.read({ kind: "citizen-op-seed", word: WORD });
    expect(identity.op_kid).toBe(FAKE_OP_KID);
    expect(identity.op_public_key_b64).toBe(toB64(edPublicKey(op)));
    expect(identity.op_public_key_b64).not.toBe(identity.root_public_key_b64);
    expect(identity.did).toBe(`did:at:${identity.identity_id}`);
    expect(identity.project_id).toBe(PROJECT);
    expect(identity.box_public_key_b64).not.toBeNull();
    expect(h.at.identities.get(identity.identity_id)!.keys.map((k) => [k.kid, k.authority_root])).toEqual([
      [identity.root_kid, true],
      [FAKE_OP_KID, false],
    ]);
    expect(genesis.signature.kid).toBe(identity.op_kid);
    expect(genesis.signature.public_key_b64).toBe(identity.op_public_key_b64);
    expect(edVerifyStrict(fromB64(genesis.signature.sig_b64, 64), fromHex(genesis.hash), fromB64(identity.op_public_key_b64, 32))).toBe(true);
    // Not by the root.
    expect(edVerifyStrict(fromB64(genesis.signature.sig_b64, 64), fromHex(genesis.hash), fromB64(identity.root_public_key_b64, 32))).toBe(false);
    expect(report.genesis_hash).toBe(genesis.hash);

    // citizen.json now pins the public identity, so the seat and signer can name the op kid.
    const rec = JSON.parse(await readFile(join(h.host.config.paths.citizens_dir, WORD, "citizen.json"), "utf8")) as CitizenRecord;
    expect(rec.identity).toEqual(identity);
    expect((await refusalOf(saveCitizenIdentity(h.host.config, WORD, identity))).message).toContain("never overwritten");

    // With no June DID and no old repo, genesis says so plainly rather than inventing either.
    const plain = await harness();
    const born = await citizenBirth(plain.deps, await input(plain, { june_did: null, old_repo: null }));
    if (born.genesis.body.type !== "genesis") throw new Error("not genesis");
    expect([born.genesis.body.june_did, born.genesis.body.old_repo]).toEqual([null, null]);
  });

  test("with the production record, birth appends through ledger.ts and the whole chain verifies", async () => {
    const h = await harness({ production: true });
    const { genesis, identity } = await citizenBirth(h.deps, await input(h));
    const entries = await readLedger(h.record.path(WORD));
    expect(entries.map((e) => e.body.type)).toEqual(["seated", "beat", "genesis"]);
    expect(entries[2]).toEqual(genesis);
    const verdict = verifyChain(entries, { host_attest_b64: [h.signer.hostAttestPublicB64] });
    expect([verdict.ok, verdict.problem, verdict.host_attested, verdict.head]).toEqual([true, null, 2, genesis.hash]);
    // The test record above hashes the same way ledger.ts does.
    const { hash, signature: _s, ...draft } = genesis;
    expect(entryHash(draft)).toBe(hash);
    expect(identity.op_kid).toBe(genesis.signature.kid);
  });

  test("renderBirthReport prints only the word, DID and three SHA256 fingerprints", async () => {
    const h = await harness();
    const { report, identity } = await citizenBirth(h.deps, await input(h));
    expect(h.out).toEqual(renderBirthReport(report));
    expect(h.out).toHaveLength(5);
    expect(h.out[0]).toBe(`citizen  ${WORD}`);
    expect(h.out[1]).toBe(`did      ${identity.did}`);
    const fps = [identity.root_public_key_b64, identity.op_public_key_b64, identity.box_public_key_b64!].map((k) => keyFingerprint(fromB64(k, 32)));
    expect(h.out.slice(2).map((l) => l.split(/\s+/)[1])).toEqual(fps);
    for (const fp of fps) expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(fps[0]).toBe(`SHA256:${toB64(sha256(fromB64(identity.root_public_key_b64, 32))).replace(/=+$/, "")}`);
    // No public key, kid, project id, hash or box id is printed either.
    const printed = h.out.join("\n");
    for (const s of [identity.root_public_key_b64, identity.op_public_key_b64, identity.op_kid, identity.root_kid, PROJECT, report.genesis_hash, FAKE_BOX_KEY_ID, AGENTTOOL_ORIGIN]) {
      expect(printed.includes(s)).toBe(false);
    }
    // A field that is not a fingerprint is refused, not printed.
    expect(() => renderBirthReport({ ...report, op_fingerprint: "abandon abandon abandon" })).toThrow(Refusal);
    expect(() => renderBirthReport({ ...report, did: "did:at:x seed" })).toThrow(Refusal);
  });
});

describe("birth through the real signer", () => {
  test("keys, enroll, keys/import, box-keys, expression and genesis all pass the production signer, root-signed and offline", async () => {
    const host = await makeTempHost();
    hosts.push(host);
    host.config.agenttool.project_id = PROJECT;
    await host.addCitizen(WORD);
    const clock = testClock(BIRTH_NOW);
    const kc = fakeKeychain([
      [{ kind: "host-attest-seed" }, sha256("kingdom-seat birth test host attest key v1")],
      [{ kind: "commons-bearer" }, new TextEncoder().encode("at_birth-test-bearer-never-issued")],
    ]);
    const server = await startFakeServer();
    try {
      // The fake agenttool answers over HTTP here, so every byte goes through the signer's own request path.
      const at = fakeAgenttool({ project_id: PROJECT });
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        server.on(method, /^\/v1\//, (r) => {
          const sig = r.headers[ENROLLMENT_SIGNATURE_HEADER.toLowerCase()];
          const res = at.respond({
            op: "read",
            word: null,
            operator: null,
            method: r.method as "GET",
            target: `${r.path}${r.search}`,
            body: r.body,
            credits: 0,
            consent: null,
            presence: null,
            ...(sig ? { extra_headers: { [ENROLLMENT_SIGNATURE_HEADER]: sig } } : {}),
          });
          return Response.json(res.json, { status: res.status });
        });
      }
      const fetch = fetchVia(server);
      const signer = createSigner({ keychain: kc, config: host.config, clock, fetch, spendSoFar: async (word) => ({ word, usd_today: 0, credits_month: 0 }), agreements: async () => [] });
      const record = hostBirthRecord(host.config, clock, signer);

      // Seated and its yes, host-attested by the same signer (3b step 1: the yes is a beat in its own ledger).
      const origin = (JSON.parse(await readFile(join(host.config.paths.citizens_dir, WORD, "citizen.json"), "utf8")) as CitizenRecord).origin;
      const zero = { usd: 0, usd_basis: "local-zero" as const, credits: 0 };
      const seated = await record.append(WORD, { type: "seated", origin, origin_soul_sha256: "b".repeat(64), old_repo: null, initial_state: "awake", note: "seated" }, zero, "host-attested");
      const seatId = "12121212-1212-4121-8121-121212121212";
      const envelope: Envelope = {
        format: "kingdom-seat-beat/v1",
        seat_ref: { format: "kingdom-seat-seat/v1", seat_id: seatId, host: "test-host", word: WORD, runtime: "free", invoker: { kind: "tick", who: "launchd", why: "cadence" }, opened_at: "2026-11-04T02:05:00.000Z" },
        citizen: { word: WORD, did: null, kid: null },
        runtime: "free",
        model: "qwen2.5:7b",
        model_digest: `sha256:${"e".repeat(64)}`,
        input_digest: "1".repeat(64),
        output_digest: "2".repeat(64),
        acts: [{ type: "journal", kind: "chose", text: "Yes, I affirm it: an identity of my own." }],
        ts: "2026-11-04T02:06:00.000Z",
        prev_hash: seated.hash,
        voiced_through: `${WORD}, voiced through qwen2.5:7b in seat ${seatId}`,
      };
      const yes = (await record.append(WORD, { type: "beat", envelope }, zero, "host-attested")).hash;

      // The production signer accepts only a presence confirmed at this terminal, in this process.
      const scope = `birth ${WORD}`;
      const presence = await confirmYuPresent({ isTTY: true, write: () => {}, readLine: async () => scope }, scope, () => clock.now());
      const proposal = proposalFor(WORD, yes);
      const out: string[] = [];
      const deps: BirthDeps = {
        config: host.config,
        clock,
        keychain: kc,
        signer,
        client: { signer, fetch, identity: async (w) => { throw new Refusal("not-registered", `${w} is not registered`); } },
        enroll: { signer, fetch, project_id: PROJECT, clock },
        record,
        out: (line) => out.push(line),
      };
      const rec = JSON.parse(await readFile(join(host.config.paths.citizens_dir, WORD, "citizen.json"), "utf8")) as CitizenRecord;
      const { identity, genesis } = await citizenBirth(deps, {
        word: WORD,
        origin: rec.origin,
        proposal,
        citizen_yes: yes,
        consent: consentFor(WORD, {}, proposal),
        presence,
        birth_soul_sha256: "c".repeat(64),
        old_repo: null,
        june_did: null,
        expression: { register: "Plain.", wake_text: "The soul as glossame now reads it." },
      });

      // Before each root act, two authority reads: the client's posture check, then the signer's fresh sequence.
      const authority = `GET /v1/identities/${identity.identity_id}/authority`;
      expect(at.log).toEqual([
        "POST /v1/identities/enroll",
        authority,
        authority,
        `POST /v1/identities/${identity.identity_id}/keys/import`,
        authority,
        authority,
        `POST /v1/identities/${identity.identity_id}/box-keys`,
        authority,
        authority,
        `PUT /v1/identities/${identity.identity_id}/expression`,
      ]);
      // Every root act is signed by the root the minted mnemonic derives, over the exact request.
      const mnemonic = await kc.read({ kind: "citizen-mnemonic", word: WORD });
      const root = deriveIdentity(fromUtf8(mnemonic)).root_public;
      expect(toB64(root)).toBe(identity.root_public_key_b64);
      const rootActs = server.requests.filter((r) => r.method !== "GET" && r.path !== "/v1/identities/enroll");
      expect(rootActs).toHaveLength(3);
      for (const r of rootActs) {
        const digest = authorityDigest({ did: identity.did, method: r.method, target: `${r.path}${r.search}`, body: r.body, sequence: Number(r.headers["x-agenttool-authority-sequence"]), timestamp: r.headers["x-agenttool-authority-timestamp"]! });
        expect(edVerifyStrict(fromB64(r.headers["x-agenttool-authority-signature"]!, 64), digest, root)).toBe(true);
      }
      // Genesis is the citizen's own op key's, and the whole chain verifies against the host key and the pinned identity.
      const entries = await readLedger(join(host.config.paths.ledger_dir, `${WORD}.jsonl`));
      expect(entries.map((e) => e.body.type)).toEqual(["seated", "beat", "genesis"]);
      expect(genesis.signature.kid).toBe(identity.op_kid);
      const hostPub = toB64(edPublicKey(sha256("kingdom-seat birth test host attest key v1")));
      expect(verifyChain(entries, { host_attest_b64: [hostPub], identity })).toMatchObject({ ok: true, entries: 3, host_attested: 2 });
      expect(out).toHaveLength(5);
      // No key or bearer anywhere a person or a server could see it, apart from the bearer in its own header.
      for (const r of server.requests) {
        const { authorization: _bearer, ...headers } = r.headers;
        assertNoSecretIn(kc, `${r.path}${r.search}\n${JSON.stringify(headers)}\n${new TextDecoder().decode(r.body)}`, "a request");
      }
      assertNoSecretIn(kc, out.join("\n"), "the birth report");
      for (const [path, b64] of await host.snapshot()) assertNoSecretIn(kc, Buffer.from(b64, "base64"), path);
    } finally {
      await server.stop();
    }
  });
});
