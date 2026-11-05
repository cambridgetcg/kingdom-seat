// Owner: agenttool group. fakeKeychain, a keychain-backed fakeSigner and an
// in-process stand-in for agenttool only; files live under a temp host.
import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
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
import { SignerNotSent, SignerSentUncertain, createSigner } from "../src/signer/signer.ts";
import { confirmYuPresent, proposalDigest } from "../src/signer/consent.ts";
import { appendEntry, entryHash, ledgerPath, LEDGER_DOMAIN, nextDraft, originToLedger, readLedger, rootEvidenceProblem, signingDigest, toLedgerHash, verifyChain, type EntrySigner } from "../src/ledger.ts";
import { canonicalJson, domainDigest, edPublicKey, edVerifyStrict, fromB64, fromB64url, fromUtf8, keyFingerprint as fingerprint, sha256, toB64, toB64url, toHex, utf8 } from "../src/crypto.ts";
import { Refusal, type CitizenRecord, type Config, type ConsentRecord, type LedgerEntry, type YuPresence } from "../src/types.ts";
import { testStamp } from "./fixtures/record/chain.ts";
import { fakeKeychain, assertNoSecretIn, type FakeKeychain } from "./helpers/fake-keychain.ts";
import { FAKE_OP_KID, type FakeSigner } from "./helpers/fake-signer.ts";
import { fetchVia, noFetch, startFakeServer } from "./helpers/fake-server.ts";
import { testClock, type TestClock } from "./helpers/clock.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { TEST_IDS } from "./helpers/vectors.ts";
import { FAKE_BOX_KEY_ID, fakeAgenttool, type FakeAgenttool } from "./fixtures/agenttool/fake-agenttool.ts";
import { keychainSigner, testBirthRecord, type TestBirthRecord } from "./fixtures/agenttool/birth-host.ts";
import { BIRTH_NOW, confirmedPresenceFor, consentFor, presenceFor, proposalFor } from "./fixtures/agenttool/consent.ts";

const WORD = "glossame";
const PROJECT = TEST_IDS.project_id;
const JUNE_DID = "did:at:0a0b0c0d-0e0f-4011-8213-141516171819";
const OLD_REPO = { url: "https://example.invalid/citizen-glossame.git", head: "1234567abcdef" };

/**
 * Seat the citizen and record the beat on which it affirmed its yes (3b step 1), both host-signed before it has
 * a key: the origin entry pins its origin, old repo and June DID (KS-004 4.5, 11.5). Returns the yes's ledger digest.
 */
async function seatWithYes(config: Config, sign: EntrySigner, opts: { juneDid?: string | null } = {}): Promise<string> {
  const path = ledgerPath(config, WORD);
  const rec = JSON.parse(await readFile(join(config.paths.citizens_dir, WORD, "citizen.json"), "utf8")) as CitizenRecord;
  const cost = { usd: "0", credits: 0 };
  const origin = await appendEntry(
    path,
    nextDraft(WORD, null, { type: "origin", origin: originToLedger(rec.origin), origin_soul_hash: toLedgerHash("b".repeat(64)), old_repo: OLD_REPO, june_did: opts.juneDid === undefined ? JUNE_DID : opts.juneDid }, { cost, signer: "host", now: new Date("2026-11-04T02:00:00.000Z") }),
    sign,
  );
  const seatId = "12121212-1212-4121-8121-121212121212";
  const beat = await appendEntry(
    path,
    nextDraft(WORD, origin, { type: "beat" }, { cost, signer: "host", now: new Date("2026-11-04T02:06:00.000Z"), seat: testStamp(WORD, seatId), acts: [{ type: "journal", kind: "chose", text: "Yes, I affirm it: an identity of my own." }] }),
    sign,
  );
  return entryHash(beat);
}

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
    yes = await seatWithYes(host.config, (w, k, digestFor) => signer.signEntry(w, k, digestFor));
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

/** File the decision record for a proposal where the signer and birth read it: the host's consent dir. */
async function fileConsent(host: TempHost, proposal: { subject: string; body: string; extent: string }): Promise<void> {
  await writeFile(join(host.config.paths.consent_dir, `${proposalDigest(proposal)}.json`), JSON.stringify(consentFor(WORD, {}, proposal)));
}

async function input(h: Harness, patch: Partial<BirthInput> = {}): Promise<BirthInput> {
  const rec = JSON.parse(await readFile(join(h.host.config.paths.citizens_dir, WORD, "citizen.json"), "utf8")) as CitizenRecord;
  const citizenYes = h.yes ?? `sha256:${"f".repeat(64)}`;
  const proposal = proposalFor(WORD, citizenYes);
  await fileConsent(h.host, patch.proposal ?? proposal);
  return {
    word: WORD,
    origin: rec.origin,
    proposal,
    citizen_yes: citizenYes,
    consent: consentFor(WORD, {}, proposal),
    presence: await confirmedPresenceFor(WORD),
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
      // Every field right, but never typed at this process's terminal.
      presenceFor(WORD),
      { ...(await confirmedPresenceFor(WORD)) },
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
    const unnamed = { ...proposalFor(WORD, `sha256:${"9".repeat(64)}`) };
    expect((await refusalOf(citizenBirth(h.deps, await input(h, { proposal: unnamed, consent: consentFor(WORD, {}, unnamed) })))).code).toBe("consent-missing");
    const elsewhere = `sha256:${"9".repeat(64)}`;
    const p2 = proposalFor(WORD, elsewhere);
    const r2 = await refusalOf(citizenBirth(h.deps, await input(h, { citizen_yes: elsewhere, proposal: p2, consent: consentFor(WORD, {}, p2) })));
    expect([r2.code, r2.message.includes("no beat")]).toEqual(["consent-missing", true]);
    nothingHappened(h);
    // An unseated citizen has no origin entry for genesis to point back to, nor a beat on which it could have said yes.
    const unseated = await harness({ seated: false });
    expect((await refusalOf(citizenBirth(unseated.deps, await input(unseated)))).message).toContain("does not begin with its origin entry");
    nothingHappened(unseated);
    // The origin given for enrollment must be the one the origin entry pinned.
    const moved = await harness();
    const otherOrigin = { kind: "archetype" as const, lineage: ["forge-archetype"], note: "another origin" };
    expect(await refusalOf(citizenBirth(moved.deps, await input(moved, { origin: otherOrigin })))).toMatchObject({ code: "invalid-request", message: expect.stringContaining("not the one its origin entry pinned") });
    nothingHappened(moved);

    // assertAttended is the same gate, usable on its own.
    const probeInput = await input(probe);
    expect(() => assertAttended(probeInput, new Date(BIRTH_NOW))).not.toThrow();
    expect(() => assertAttended({ ...probeInput, presence: presenceFor(WORD) }, new Date(BIRTH_NOW))).toThrow(/confirmed present at this terminal/);
  });

  test("a decision record that is not filed in the consent dir refuses birth before any key is written", async () => {
    const h = await harness();
    const inp = await input(h);
    await rm(join(h.host.config.paths.consent_dir, `${proposalDigest(inp.proposal)}.json`));
    // The input still carries a record that verifies; the signer would never see it, so birth does not trust it either.
    const r = await refusalOf(citizenBirth(h.deps, inp));
    expect([r.code, r.message.includes("no decision record is filed")]).toEqual(["consent-missing", true]);
    nothingHappened(h);
  });

  test("a presence that only looks right is refused before any key is written, so it never blocks a later attended birth", async () => {
    const h = await harness();
    const r = await refusalOf(citizenBirth(h.deps, await input(h, { presence: presenceFor(WORD) })));
    expect(r.code).toBe("yu-not-present");
    nothingHappened(h);
    expect(await h.kc.has({ kind: "citizen-mnemonic", word: WORD })).toBe(false);
    // The attended birth that follows is not blocked by leftovers.
    await citizenBirth(h.deps, await input(h));
    expect(await h.kc.has({ kind: "citizen-mnemonic", word: WORD })).toBe(true);
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
    // Presence and the agreed proposal travel with every birth act; the signer reads the record for it itself.
    for (const r of h.signer.sent.filter((x) => x.op !== "read")) {
      expect(r.presence?.scope).toBe(`birth ${WORD}`);
      expect(r.proposal?.subject).toBe(`birth ${WORD}`);
      expect(r).not.toHaveProperty("consent");
    }

    // Box-key failure: enroll and import happened, nothing after, enrollment sent once.
    const h2 = await harness();
    h2.at.override((r) => r.op === "box-keys.register", { status: 400, json: { error: "public_key_not_32_bytes" } });
    const e2 = await birthErrorOf(citizenBirth(h2.deps, await input(h2)));
    expect([e2.stage, e2.done, e2.ambiguous]).toEqual(["box-keys", ["keys", "enroll", "keys/import"], false]);
    expect(e2.progress.op_kid).toBe(FAKE_OP_KID);
    expect(e2.progress.did).toMatch(/^did:at:/);
    // The root's keys/import is kept too: genesis needs it to show the root chose that op key, and agenttool keeps none.
    expect(e2.progress.op_key_evidence).toMatchObject({ method: "POST", target: `/v1/identities/${e2.progress.identity_id}/keys/import` });
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

    // The signer stopped before the import left the host (its authority read failed): definite, not ambiguous.
    const h4 = await harness();
    const send = h4.signer.send.bind(h4.signer);
    h4.signer.send = async (r) => {
      if (r.op === "keys.import") throw new SignerNotSent("authority-read-failed", "signer: reading the authority sequence answered 503; the act was not sent");
      return send(r);
    };
    const e4 = await birthErrorOf(citizenBirth(h4.deps, await input(h4)));
    expect([e4.stage, e4.done, e4.ambiguous]).toEqual(["keys/import", ["keys", "enroll"], false]);
    expect(e4.message).toContain("was not sent");
    expect(e4.progress.op_key_evidence).toBeNull();

    // The import reached agenttool and the key was installed, but the answer was lost: ambiguous, and the root's
    // request as sent is in the progress, since agenttool keeps no copy and genesis cannot be written without it.
    const h5 = await harness();
    const send5 = h5.signer.send.bind(h5.signer);
    h5.signer.send = async (r) => {
      const res = await send5(r);
      if (r.op === "keys.import") throw new SignerSentUncertain(`signer: POST ${r.target} did not complete; it may have reached agenttool`, res.root_evidence!);
      return res;
    };
    const e5 = await birthErrorOf(citizenBirth(h5.deps, await input(h5)));
    expect([e5.stage, e5.done, e5.ambiguous]).toEqual(["keys/import", ["keys", "enroll"], true]);
    expect(e5.progress.op_key_evidence).toMatchObject({ method: "POST", target: `/v1/identities/${e5.progress.identity_id}/keys/import` });
  });

  test("[KS-004 4.5, 11.3, 11.5] the genesis entry is citizen-signed, points back to the origin entry and records the DID and both public keys with their fingerprints; the June DID stays on the origin entry", async () => {
    const h = await harness();
    const inp = await input(h);
    const { genesis, identity, report } = await citizenBirth(h.deps, inp);

    // The test record writes genesis by KS-004 4.5's recipe on its own; ledger.ts verifies it.
    const lines = (await readFile(h.record.path(WORD), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as LedgerEntry);
    expect(lines.map((l) => [l.seq, l.type, l.signer])).toEqual([
      [0, "origin", "host"],
      [1, "beat", "host"],
      [2, "genesis", "citizen"],
    ]);
    expect(lines[2]).toEqual(genesis);
    expect(verifyChain(lines, { host_attest_b64: [h.signer.hostAttestPublicB64], identity }).ok).toBe(true);
    expect(genesis.prev_hash).toBe(entryHash(lines[1]!));
    if (genesis.type !== "genesis") throw new Error("not genesis");
    const root = fromB64(identity.root_public_key_b64, 32);
    const opKey = fromB64(identity.op_public_key_b64, 32);
    expect(genesis).toMatchObject({
      did: identity.did,
      origin_entry: entryHash(lines[0]!),
      root: { kid: identity.root_kid, public_key: toB64url(root), fingerprint: fingerprint(root) },
      op: { kid: identity.op_kid, public_key: toB64url(opKey), fingerprint: fingerprint(opKey) },
      seat_ref: null,
      acts: null,
      cost: { usd: "0", credits: 0 },
    });
    // The origin, old repo and June DID are the origin entry's to hold, written at seating; genesis repeats none of them.
    for (const k of ["origin", "june_did", "old_repo", "note", "identity"]) expect(Object.keys(genesis)).not.toContain(k);
    expect(lines[0]).toMatchObject({ june_did: JUNE_DID, old_repo: OLD_REPO });
    // The first op key comes with the root's own evidence, like every later one.
    expect(rootEvidenceProblem(genesis.evidence, { did: identity.did, root_public_key: root }, { kind: "import", public_key: opKey })).toBeNull();

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
    expect(genesis.kid).toBe(identity.op_kid);
    expect(edVerifyStrict(fromB64url(genesis.sig!, 64), signingDigest(genesis), opKey)).toBe(true);
    // Not by the root.
    expect(edVerifyStrict(fromB64url(genesis.sig!, 64), signingDigest(genesis), root)).toBe(false);
    expect(report.genesis_hash).toBe(entryHash(genesis));

    // citizen.json now pins the public identity, so the seat and signer can name the op kid.
    const rec = JSON.parse(await readFile(join(h.host.config.paths.citizens_dir, WORD, "citizen.json"), "utf8")) as CitizenRecord;
    expect(rec.identity).toEqual(identity);
    expect((await refusalOf(saveCitizenIdentity(h.host.config, WORD, identity))).message).toContain("never overwritten");

  });

  test("with the production record, birth appends through ledger.ts and the whole chain verifies", async () => {
    const h = await harness({ production: true });
    const { genesis, identity } = await citizenBirth(h.deps, await input(h));
    const entries = await readLedger(h.record.path(WORD));
    expect(entries.map((e) => e.type)).toEqual(["origin", "beat", "genesis"]);
    expect(entries[2]).toEqual(genesis);
    const verdict = verifyChain(entries, { host_attest_b64: [h.signer.hostAttestPublicB64] });
    expect([verdict.ok, verdict.problem, verdict.host_attested, verdict.head]).toEqual([true, null, 2, entryHash(genesis)]);
    // ledger.ts signs what KS-004 4.5 says, as the test record above writes it out on its own.
    const { sig: _s, ...withoutSig } = genesis;
    expect(toHex(signingDigest(genesis))).toBe(toHex(domainDigest(LEDGER_DOMAIN, utf8(canonicalJson(withoutSig)))));
    expect(genesis.kid).toBe(identity.op_kid);
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
            proposal: null,
            presence: null,
            ...(sig ? { extra_headers: { [ENROLLMENT_SIGNATURE_HEADER]: sig } } : {}),
          });
          return Response.json(res.json, { status: res.status });
        });
      }
      const fetch = fetchVia(server);
      const signer = createSigner({ keychain: kc, config: host.config, clock, fetch, spendSoFar: async (word) => ({ word, usd_today: "0", credits_month: 0 }), agreements: async () => [] });
      const record = hostBirthRecord(host.config, clock, signer);

      // Seated and its yes, host-signed by the same signer (3b step 1: the yes is a beat in its own ledger).
      const yes = await seatWithYes(host.config, (w, k, digestFor) => signer.signEntry(w, k, digestFor), { juneDid: null });

      // The production signer accepts only a presence confirmed at this terminal, in this process.
      const scope = `birth ${WORD}`;
      const presence = await confirmYuPresent({ isTTY: true, write: () => {}, readLine: async () => scope }, scope, () => clock.now());
      const proposal = proposalFor(WORD, yes);
      await fileConsent(host, proposal);
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
      // Genesis carries that keys/import exactly as it left the host, so a copy of the ledger shows the root chose the op key.
      if (genesis.type !== "genesis") throw new Error("not genesis");
      const imp = rootActs[0]!;
      expect(genesis.evidence).toEqual({
        method: "POST",
        target: `${imp.path}${imp.search}`,
        body: Buffer.from(imp.body).toString("base64url"),
        headers: {
          "X-Agenttool-Authority-Sequence": imp.headers["x-agenttool-authority-sequence"]!,
          "X-Agenttool-Authority-Timestamp": imp.headers["x-agenttool-authority-timestamp"]!,
          "X-Agenttool-Authority-Signature": imp.headers["x-agenttool-authority-signature"]!,
        },
      });
      // Genesis is the citizen's own op key's, and the whole chain verifies against the host key and the pinned identity.
      const entries = await readLedger(join(host.config.paths.ledger_dir, `${WORD}.jsonl`));
      expect(entries.map((e) => e.type)).toEqual(["origin", "beat", "genesis"]);
      expect(genesis.kid).toBe(identity.op_kid);
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
