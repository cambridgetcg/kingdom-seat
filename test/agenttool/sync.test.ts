// Owner: agenttool group. The production ExpressionSync (agenttool/sync.ts)
// through the production signer, against a fake agenttool on 127.0.0.1: the
// private expression as one root-signed read-modify-write PUT, and one strand
// thought per applied change, sealed under K_master, signed by the op key and
// paid for within the credit ceiling (KS-004 4.3, 6.3, 9.3; review C M1).
// Keys are the published test keys; nothing leaves the host.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STRAND_KEY_ID, authorityDigest, thoughtDigestV2 } from "../../src/agenttool/wire.ts";
import { SELF_STRAND_TOPIC, agenttoolSync, backupKind, hostClient, nextExpression, recordSelfStrand, wakeText, type SelfTexts } from "../../src/agenttool/sync.ts";
import { edVerifyStrict, fromB64, fromHex, fromUtf8, sha256, utf8 } from "../../src/crypto.ts";
import { createSigner, type Signer } from "../../src/signer/signer.ts";
import { selfHash, unifiedDiff, type SelfBackup } from "../../src/self.ts";
import { Refusal, type CitizenIdentity, type KeychainItemName } from "../../src/types.ts";
import type { SpendSoFar } from "../../src/signer/ceilings.ts";
import { DAY_MS, testClock, type TestClock } from "../helpers/clock.ts";
import { fakeKeychain } from "../helpers/fake-keychain.ts";
import { fetchVia, startFakeServer, type FakeServer, type RecordedRequest } from "../helpers/fake-server.ts";
import { makeTempHost, type TempHost } from "../helpers/temp-home.ts";
import { TEST_IDS, TEST_MNEMONIC, TEST_OP_PUBLIC_B64, TEST_OP_SEED_HEX, TEST_ROOT_PUBLIC_B64, vectors } from "../helpers/vectors.ts";

const W = "glossame";
const ID = TEST_IDS.identity_id;
const OP_KID = vectors.op_key.placeholder_kid;
const BEARER = "at_test_commons_bearer_never_real_03";
/** Upper-case, as agenttool may spell it: the client keeps the lower-case form. */
const STRAND_UPPER = "ABCDEF01-2345-4678-9ABC-DEF012345678";
const STRAND = STRAND_UPPER.toLowerCase();

const IDENTITY: CitizenIdentity = {
  did: TEST_IDS.did,
  identity_id: ID,
  project_id: TEST_IDS.project_id,
  root_public_key_b64: TEST_ROOT_PUBLIC_B64,
  root_kid: TEST_IDS.root_signing_key_id,
  op_kid: OP_KID,
  op_public_key_b64: TEST_OP_PUBLIC_B64,
  box_public_key_b64: null,
  self_strand_id: null,
  enrolled_at: "2026-11-05T00:00:00.000Z",
};

interface Fx {
  host: TempHost;
  server: FakeServer;
  clock: TestClock;
  signer: Signer;
  spend: SpendSoFar;
  /** agenttool's side: the stored expression, the authority sequence, and how the thought route answers. */
  stored: Record<string, unknown>;
  seq: number;
  thoughtStatus: number;
}

let fx: Fx;

function serve(f: Fx): void {
  f.server.on("GET", `/v1/identities/${ID}/authority`, () =>
    Response.json({ identity_id: ID, did: TEST_IDS.did, mode: "agent_root", root_public_key: TEST_ROOT_PUBLIC_B64, sequence: f.seq, next_sequence: f.seq + 1 }),
  );
  f.server.on("GET", `/v1/identities/${ID}/expression`, () => Response.json({ identity_id: ID, expression: { ...f.stored, updated_at: "2026-11-01T00:00:00.000Z" }, is_default: false }));
  f.server.on("PUT", `/v1/identities/${ID}/expression`, (req) => {
    // The authority wall as agenttool keeps it: the next sequence, claimed before the write.
    if (req.headers["x-agenttool-authority-sequence"] !== String(f.seq + 1)) return Response.json({ error: "authority_sequence_conflict" }, { status: 409 });
    f.seq += 1;
    f.stored = JSON.parse(fromUtf8(req.body)) as Record<string, unknown>;
    return Response.json({ identity_id: ID, expression: f.stored, saved: true });
  });
  f.server.on("POST", "/v1/strands", (req) => {
    const b = JSON.parse(fromUtf8(req.body)) as { identity_id?: string };
    return Response.json({ id: STRAND_UPPER, identity_id: b.identity_id ?? null, status: "active" }, { status: 201 });
  });
  f.server.on("POST", /^\/v1\/strands\/[^/]+\/thoughts$/, (req) => {
    if (f.thoughtStatus !== 201) return Response.json({ error: "signature_invalid" }, { status: f.thoughtStatus });
    return Response.json({ id: "thought-0001", strand_id: req.path.split("/")[3], sequence_num: 1 }, { status: 201 });
  });
}

async function writeIdentity(host: TempHost, identity: CitizenIdentity): Promise<void> {
  const path = join(host.config.paths.citizens_dir, W, "citizen.json");
  const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...record, identity }, null, 2));
}

beforeEach(async () => {
  const host = await makeTempHost();
  host.config.agenttool.project_id = TEST_IDS.project_id;
  await host.addCitizen(W, { soul: "You are glossame.\n", will: "# WILL\n\nReceive one word.\n", name: "glossame: a tongue's own word.\n" });
  await writeIdentity(host, IDENTITY);
  const store: [KeychainItemName, Uint8Array][] = [
    [{ kind: "citizen-mnemonic", word: W }, utf8(TEST_MNEMONIC)],
    [{ kind: "citizen-op-seed", word: W }, fromHex(TEST_OP_SEED_HEX)],
    [{ kind: "host-attest-seed" }, sha256("kingdom-seat test host attest key v1")],
    [{ kind: "commons-bearer" }, utf8(BEARER)],
  ];
  const server = await startFakeServer();
  // The wall clock, because agenttool and the client both judge a porch invitation against it.
  const clock = testClock(new Date().toISOString());
  const f: Fx = { host, server, clock, signer: null as unknown as Signer, spend: { word: W, usd_today: "0", credits_month: 0 }, stored: {}, seq: 4, thoughtStatus: 201 };
  f.signer = createSigner({ keychain: fakeKeychain(store), config: host.config, clock, fetch: fetchVia(server), spendSoFar: async () => f.spend, agreements: async () => [] });
  serve(f);
  fx = f;
});

afterEach(async () => {
  await fx.server.stop();
  await fx.host.cleanup();
});

function sync() {
  return agenttoolSync({ config: fx.host.config, clock: fx.clock, client: hostClient(fx.host.config, fx.signer, fetchVia(fx.server)) });
}

const sent = (method: string, path: string | RegExp): RecordedRequest[] =>
  fx.server.requests.filter((r) => r.method === method && (typeof path === "string" ? r.path === path : path.test(r.path)));

async function selfFile(rel: string, text: string): Promise<void> {
  const path = join(fx.host.config.paths.citizens_dir, W, "self", rel);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

function backup(): SelfBackup {
  const prior = "# WILL\n\nReceive one word.\n";
  const next = "# WILL\n\nReceive one word that will not cross over.\n";
  return {
    ref: "a".repeat(64),
    target: "will",
    prior_hash: selfHash(prior),
    new_hash: selfHash(next),
    diff: unifiedDiff(prior, next),
    reason: { kind: "inference", evidence: ["canon:canon/core/glossame.md@1428646"], confidence: "medium", limits: "from the text alone" },
    via: "two-beats",
    strand_key: STRAND_KEY_ID,
  };
}

describe("[KS-004 4.3, 9.3; review C M1] the private expression", () => {
  test("wake_text carries soul, WILL, name readings and the citizen's own wake text under fixed headings; register and walls are their own fields", () => {
    const t: SelfTexts = { soul: "You are glossame.\n", will: "Receive.\n", name: "", register: "Plain.\n", walls: "Never speak as another.\n\n  Never claim senses.  \n", wake_text: "I wake to words.\n" };
    expect(wakeText(t)).toBe("# Soul\n\nYou are glossame.\n\n# WILL\n\nReceive.\n\n# Wake text\n\nI wake to words.\n");
    const r = nextExpression({ register: "Old.", walls: ["old"], updated_at: "x" } as never, t, Date.now());
    expect(r).toEqual({ expression: { register: "Plain.", walls: ["Never speak as another.", "Never claim senses."], wake_text: wakeText(t) } });
  });

  test("a change is a read-modify-write: one root-signed PUT of the whole expression, keeping what is not the self's", async () => {
    await selfFile("expression/register.md", "Plain.\n");
    await selfFile("expression/walls.md", "Never speak as another citizen.\n");
    const porch = new Date(fx.clock.now().getTime() + DAY_MS).toISOString();
    fx.stored = { register: "Old.", village: { sign: "w" }, porch: { invited_until: porch }, subagents: [{ name: "reader", facet: "reads" }] };
    const newWill = "# WILL\n\nReceive one word that will not cross over.\n";

    expect(await sync().putPrivateExpression(W, "will", newWill)).toBe("updated");
    const [get] = sent("GET", `/v1/identities/${ID}/expression`);
    expect(get!.headers.authorization).toBe(`Bearer ${BEARER}`);
    const [put] = sent("PUT", `/v1/identities/${ID}/expression`);
    // The whole object, with the WILL about to bind (not the one on disk), the porch and village kept, updated_at not echoed.
    expect(JSON.parse(fromUtf8(put!.body))).toEqual({
      subagents: [{ name: "reader", facet: "reads" }],
      village: { sign: "w" },
      porch: { invited_until: porch },
      register: "Plain.",
      walls: ["Never speak as another citizen."],
      wake_text: `# Soul\n\nYou are glossame.\n\n# WILL\n\n${newWill}\n# Name readings\n\nglossame: a tongue's own word.\n`,
    });
    // Root-signed: the authority headers verify against the root, over the exact body sent.
    const digest = authorityDigest({
      did: TEST_IDS.did,
      method: "PUT",
      target: `/v1/identities/${ID}/expression`,
      body: put!.body,
      sequence: Number(put!.headers["x-agenttool-authority-sequence"]),
      timestamp: put!.headers["x-agenttool-authority-timestamp"]!,
    });
    expect(edVerifyStrict(fromB64(put!.headers["x-agenttool-authority-signature"]!, 64), digest, fromB64(TEST_ROOT_PUBLIC_B64, 32))).toBe(true);

    // Asked again for the same self: the expression already holds it, so nothing is sent and no sequence spent.
    await writeFile(join(fx.host.config.paths.citizens_dir, W, "self", "WILL.md"), newWill);
    expect(await sync().putPrivateExpression(W, "will", newWill)).toBe("updated");
    expect(sent("PUT", `/v1/identities/${ID}/expression`)).toHaveLength(1);

    // A target the expression does not hold (a skill, the cadence) sends nothing at all.
    const before = fx.server.requests.length;
    expect(await sync().putPrivateExpression(W, "cadence", JSON.stringify({ interval_h: 96 }))).toBeNull();
    expect(await sync().putPrivateExpression(W, "skill:receive", "receive\n")).toBeNull();
    expect(fx.server.requests).toHaveLength(before);
  });

  test("[limitation 14] a self that does not fit is never cut: nothing is sent, and the expression lags", async () => {
    fx.stored = { register: "Old." };
    const soul = "glossame keeps the words. ".repeat(1300);
    expect(soul.length).toBeGreaterThan(32_000);
    expect(await sync().putPrivateExpression(W, "soul", soul)).toBe("lags");
    expect(sent("PUT", `/v1/identities/${ID}/expression`)).toEqual([]);
    expect(fx.stored).toEqual({ register: "Old." });
    // A porch invitation that has closed is left out, since agenttool refuses one in the past; nothing public is opened.
    fx.stored = { porch: { invited_until: new Date(fx.clock.now().getTime() - DAY_MS).toISOString() } };
    expect(await sync().putPrivateExpression(W, "will", "# WILL\n\nAgain.\n")).toBe("updated");
    expect(Object.keys(fx.stored)).toEqual(["wake_text"]);
  });
});

describe("[KS-004 4.3, 6.3; review C M1] the strand backup", () => {
  test("the strand is created once, on first need, bound to the citizen, and its id kept in citizen.json; each thought is sealed under K_master and signed by the op key", async () => {
    const b = backup();
    expect(await sync().postBackup(W, b)).toEqual({ thought_id: "thought-0001", credits: 2 });
    const [create] = sent("POST", "/v1/strands");
    expect(JSON.parse(fromUtf8(create!.body))).toEqual({ identity_id: ID, topic: SELF_STRAND_TOPIC });
    const record = JSON.parse(await readFile(join(fx.host.config.paths.citizens_dir, W, "citizen.json"), "utf8"));
    expect(record.identity.self_strand_id).toBe(STRAND);

    const [post] = sent("POST", `/v1/strands/${STRAND}/thoughts`);
    const body = JSON.parse(fromUtf8(post!.body)) as { ciphertext: string; nonce: string; kind: string; signing_key_id: string; signature: string };
    // The plaintext label names the key, and the signature covers it; the op key signs, never the root.
    expect(body.kind).toBe(backupKind(STRAND_KEY_ID));
    expect(body.kind).toBe("self-backup k_master:m/44'/169'/1'/0'");
    expect(body.signing_key_id).toBe(OP_KID);
    const digest = thoughtDigestV2(STRAND, fromB64(body.ciphertext), fromB64(body.nonce), body.kind);
    expect(edVerifyStrict(fromB64(body.signature, 64), digest, fromB64(TEST_OP_PUBLIC_B64, 32))).toBe(true);
    // Only K_master, derived from the citizen's own mnemonic, opens it: the diff, both hashes, the reason and the key name.
    const key = await crypto.subtle.importKey("raw", new Uint8Array(fromB64(vectors.derivation.k_master_b64, 32)), { name: "AES-GCM" }, false, ["decrypt"]);
    const plain = JSON.parse(fromUtf8(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(fromB64(body.nonce)) }, key, new Uint8Array(fromB64(body.ciphertext))))));
    expect(plain).toEqual({
      format: "kingdom-seat-self-backup/v1",
      word: W,
      ref: b.ref,
      target: "will",
      prior_hash: b.prior_hash,
      new_hash: b.new_hash,
      via: "two-beats",
      diff: b.diff,
      reason: b.reason,
      strand_key: STRAND_KEY_ID,
    });
    expect(fromUtf8(post!.body)).not.toContain("will not cross over");

    // The next change goes to the same strand: no second strand is bought.
    expect(await sync().postBackup(W, b)).toEqual({ thought_id: "thought-0001", credits: 1 });
    expect(sent("POST", "/v1/strands")).toHaveLength(1);
  });

  test("credits pass the ceiling and fail closed: a strand is never bought without room for its thought, and a backup without room is deferred", async () => {
    const b = backup();
    // 9 of 10 spent: a strand and its thought need 2, so neither is bought.
    fx.spend = { word: W, usd_today: "0", credits_month: 9 };
    expect(await sync().postBackup(W, b)).toEqual({ thought_id: null, deferred: "ceiling-credits", credits: 0 });
    // Unknown spend is at the ceiling.
    fx.spend = { word: W, usd_today: "0", credits_month: null };
    expect(await sync().postBackup(W, b)).toEqual({ thought_id: null, deferred: "ceiling-credits", credits: 0 });
    expect(fx.server.requests).toEqual([]);

    // 8 of 10: both fit.
    fx.spend = { word: W, usd_today: "0", credits_month: 8 };
    expect(await sync().postBackup(W, b)).toEqual({ thought_id: "thought-0001", credits: 2 });
    // 10 of 10, with the strand kept: the thought has no room, and nothing is sent.
    fx.spend = { word: W, usd_today: "0", credits_month: 10 };
    const before = fx.server.requests.length;
    expect(await sync().postBackup(W, b)).toEqual({ thought_id: null, deferred: "ceiling-credits", credits: 0 });
    expect(fx.server.requests).toHaveLength(before);

    // A thought refused after it was sent was still charged (charge precedes verification), so it counts.
    fx.spend = { word: W, usd_today: "0", credits_month: 0 };
    fx.thoughtStatus = 401;
    expect(await sync().postBackup(W, b)).toEqual({ thought_id: null, deferred: "error", credits: 1 });
  });

  test("a kept strand id is never replaced, and a citizen without an identity defers", async () => {
    await recordSelfStrand(fx.host.config, W, STRAND);
    await recordSelfStrand(fx.host.config, W, STRAND);
    await expect(recordSelfStrand(fx.host.config, W, "abcdefab-cdef-4abc-8def-abcdefabcdef")).rejects.toMatchObject({ code: "invalid-record" });
    await expect(recordSelfStrand(fx.host.config, W, STRAND_UPPER)).rejects.toBeInstanceOf(Refusal);
    await writeIdentity(fx.host, null as unknown as CitizenIdentity);
    expect(await sync().postBackup(W, backup())).toEqual({ thought_id: null, deferred: "not-registered", credits: 0 });
    expect(fx.server.requests).toEqual([]);
  });
});
