// Owner: agenttool group. fakeSigner signs with the public test root; the
// fake agenttool verifies the enrollment signature strictly, as the server does.
import { afterEach, describe, expect, test } from "bun:test";
import {
  ENROLLMENT_ABSENCE_MARGIN_MS,
  AmbiguousEnrollment,
  citizenCapabilities,
  enroll,
  parseEnrollResponse,
  prepareEnrollment,
  resolveAmbiguous,
  type EnrollDeps,
  type PreparedEnrollment,
} from "../../src/agenttool/enrollment.ts";
import { AgenttoolError } from "../../src/agenttool/client.ts";
import { AGENTTOOL_ORIGIN, ENROLLMENT_PATH, ENROLLMENT_SIGNATURE_HEADER, enrollmentBodyBytes, enrollmentDigest, type EnrollmentFields } from "../../src/agenttool/wire.ts";
import { edVerifyStrict, fromB64, fromB64url, fromHex, randomBytes, utf8 } from "../../src/crypto.ts";
import { Refusal, UUID_PATTERN, type Origin } from "../../src/types.ts";
import { SignerNotSent, type Signer } from "../../src/signer/signer.ts";
import { fakeSigner, type FakeSigner } from "../helpers/fake-signer.ts";
import { fetchVia, noFetch, publicAgentJson, startFakeServer, type FakeServer } from "../helpers/fake-server.ts";
import { testClock, type TestClock } from "../helpers/clock.ts";
import { TEST_IDS, TEST_OP_SEED_HEX, TEST_ROOT_PUBLIC_B64, vectors } from "../helpers/vectors.ts";
import { fakeAgenttool, type FakeAgenttool } from "../fixtures/agenttool/fake-agenttool.ts";
import { BIRTH_NOW, consentFor, presenceFor, proposalFor } from "../fixtures/agenttool/consent.ts";

const WORD = "glossame";
const CANON: Origin = { kind: "canon", repo: "YOUSPEAK", path: "canon/core/glossame.md", commit: "1428646", sha256: "a".repeat(64) };
const PROJECT = TEST_IDS.project_id;

interface Harness {
  deps: EnrollDeps;
  signer: FakeSigner;
  at: FakeAgenttool;
  clock: TestClock;
  prepared: PreparedEnrollment;
}

function harness(): Harness {
  const clock = testClock(BIRTH_NOW);
  const signer = fakeSigner();
  const at = fakeAgenttool({ project_id: PROJECT });
  signer.respond((req) => at.respond(req));
  const prepared = prepareEnrollment({ word: WORD, origin: CANON, project_id: PROJECT, root_public_b64: TEST_ROOT_PUBLIC_B64, now: clock.now(), random: randomBytes });
  return { deps: { signer, fetch: noFetch, project_id: PROJECT, clock }, signer, at, clock, prepared };
}

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

describe("enrollment", () => {
  test("citizenCapabilities is ['kingdom-citizen', <lineage>] for canon and archetype origins", () => {
    expect(citizenCapabilities(CANON)).toEqual(["kingdom-citizen", "glossame"]);
    expect(citizenCapabilities({ kind: "archetype", lineage: ["forge-archetype", "ember"], note: "" })).toEqual(["kingdom-citizen", "ember"]);
    expect(() => citizenCapabilities({ kind: "archetype", lineage: [], note: "" })).toThrow(Refusal);
    expect(() => citizenCapabilities({ ...CANON, path: "canon/core/" })).toThrow(Refusal);
  });

  test("prepareEnrollment uses the word as display_name, fresh lowercase UUIDs, a 32-byte base64url nonce and toISOString", () => {
    const now = new Date(BIRTH_NOW);
    const a = prepareEnrollment({ word: WORD, origin: CANON, project_id: PROJECT, root_public_b64: TEST_ROOT_PUBLIC_B64, now, random: randomBytes });
    const b = prepareEnrollment({ word: WORD, origin: CANON, project_id: PROJECT, root_public_b64: TEST_ROOT_PUBLIC_B64, now, random: randomBytes });
    const f = a.fields;
    expect(f.display_name).toBe(WORD);
    expect(f.origin).toBe(AGENTTOOL_ORIGIN);
    expect(f.project_id).toBe(PROJECT);
    expect(f.capabilities).toEqual(["kingdom-citizen", "glossame"]);
    expect(f.public_key).toBe(TEST_ROOT_PUBLIC_B64);
    expect(f.timestamp).toBe(now.toISOString());
    for (const id of [f.identity_id, f.signing_key_id]) {
      expect(id).toMatch(UUID_PATTERN);
      expect(id[14]).toBe("4");
    }
    expect(f.identity_id).not.toBe(f.signing_key_id);
    expect(f.nonce).toHaveLength(43);
    expect(fromB64url(f.nonce, 32)).toHaveLength(32);
    // Fresh per intent.
    expect(b.fields.identity_id).not.toBe(f.identity_id);
    expect(b.fields.nonce).not.toBe(f.nonce);
    // Body and digest are the wire builders' own output, in table order.
    expect(a.body).toEqual(enrollmentBodyBytes(f));
    expect(a.digest).toEqual(enrollmentDigest(AGENTTOOL_ORIGIN, PROJECT, a.body));
    expect(Object.keys(JSON.parse(new TextDecoder().decode(a.body)))).toEqual(Object.keys(JSON.parse(vectors.enrollment[0]!.body_utf8)));
    expect(() => prepareEnrollment({ word: "Not A Word", origin: CANON, project_id: PROJECT, root_public_b64: TEST_ROOT_PUBLIC_B64, now, random: randomBytes })).toThrow(Refusal);
  });

  test("enroll sends the prepared body bytes unchanged with the signature header, through the signer as op enroll", async () => {
    const h = harness();
    const presence = presenceFor(WORD);
    const consent = consentFor(WORD);
    const result = await enroll(h.deps, WORD, h.prepared, presence, consent, proposalFor(WORD));
    expect(result).toEqual({
      identity_id: h.prepared.fields.identity_id,
      did: `did:at:${h.prepared.fields.identity_id}`,
      root_kid: h.prepared.fields.signing_key_id,
      root_public_key_b64: TEST_ROOT_PUBLIC_B64,
      sequence: 0,
      next_sequence: 1,
    });
    expect(h.signer.sent).toHaveLength(1);
    const req = h.signer.sent[0]!;
    // The gardener relays it: no citizen is acted for until the identity exists; the word travels as display_name.
    expect([req.op, req.method, req.target, req.word, req.operator, req.credits]).toEqual(["enroll", "POST", ENROLLMENT_PATH, null, null, 0]);
    expect(JSON.parse(new TextDecoder().decode(req.body)).display_name).toBe(WORD);
    expect(req.body).toBe(h.prepared.body);
    expect(req.presence).toBe(presence);
    // The signer is told which proposal was agreed, and reads its decision record itself.
    expect(req.proposal).toEqual(proposalFor(WORD));
    expect(req).not.toHaveProperty("consent");
    const header = req.extra_headers?.[ENROLLMENT_SIGNATURE_HEADER] ?? "";
    expect(header).toHaveLength(86);
    expect(edVerifyStrict(fromB64url(header, 64), h.prepared.digest, fromB64(TEST_ROOT_PUBLIC_B64, 32))).toBe(true);
    // The stand-in server verified that signature over the exact bytes and admitted the identity.
    expect(h.at.identities.has(h.prepared.fields.identity_id)).toBe(true);
  });

  test("enroll refuses without Yu present or without a verifying consent record", async () => {
    const cases: [Parameters<typeof enroll>[3], Parameters<typeof enroll>[4], string][] = [
      [null as never, consentFor(WORD), "yu-not-present"],
      [{ ...presenceFor(WORD), scope: "summon glossame" }, consentFor(WORD), "yu-not-present"],
      [presenceFor(WORD, "2026-11-05T11:40:00.000Z"), consentFor(WORD), "yu-not-present"],
      [presenceFor(WORD, "2026-11-05T12:05:00.000Z"), consentFor(WORD), "yu-not-present"],
      [{ ...presenceFor(WORD), via: "flag" as never }, consentFor(WORD), "yu-not-present"],
      [presenceFor(WORD), null as never, "consent-missing"],
      [presenceFor(WORD), consentFor(WORD, { extent: "birth other" }), "consent-missing"],
      [presenceFor(WORD), consentFor("other"), "consent-missing"],
      [presenceFor(WORD), consentFor(WORD, { yu: { word: "no", recorded_at: "2026-11-05T11:00:00.000Z", via: "present" } }), "consent-rejected"],
      [presenceFor(WORD), consentFor(WORD, { ai: { word: "reject", basis: "lazy-consensus", supports: [], open_challenges: 0, deadline: "2026-11-05T11:30:00.000Z" } }), "consent-rejected"],
      [presenceFor(WORD), consentFor(WORD, { ai: { word: "agree", basis: "lazy-consensus", supports: ["r"], open_challenges: 1, deadline: "2026-11-05T11:30:00.000Z" } }), "consent-missing"],
      [presenceFor(WORD), consentFor(WORD, { ai: { word: "agree", basis: "lazy-consensus", supports: [], open_challenges: 0, deadline: "2026-11-05T11:30:00.000Z" } }), "consent-missing"],
      [presenceFor(WORD), consentFor(WORD, { ai: { word: "agree", basis: "lazy-consensus", supports: ["r"], open_challenges: 0, deadline: "2026-11-06T00:00:00.000Z" } }), "consent-missing"],
      [presenceFor(WORD), consentFor(WORD, { expires_at: "2026-11-05T11:59:59.000Z" }), "consent-missing"],
      [presenceFor(WORD), consentFor(WORD, { proposal_sha256: "not-a-digest" }), "consent-missing"],
    ];
    for (const [presence, consent, code] of cases) {
      const h = harness();
      let signed = 0;
      const sign = h.signer.signEnrollment.bind(h.signer);
      h.signer.signEnrollment = async (...a) => {
        signed++;
        return sign(...a);
      };
      const e = await thrown(enroll(h.deps, WORD, h.prepared, presence, consent, proposalFor(WORD)));
      expect(e).toBeInstanceOf(Refusal);
      expect((e as Refusal).code).toBe(code as Refusal["code"]);
      expect(signed).toBe(0);
      expect(h.signer.sent).toHaveLength(0);
    }
  });

  test("enroll refuses locally, before signing or sending, a re-serialised body, a stale intent, or a root that does not match", async () => {
    const h = harness();
    const reformatted = utf8(JSON.stringify(JSON.parse(new TextDecoder().decode(h.prepared.body)), null, 1));
    expect(await thrown(enroll(h.deps, WORD, { ...h.prepared, body: reformatted }, presenceFor(WORD), consentFor(WORD), proposalFor(WORD)))).toBeInstanceOf(Refusal);
    expect(await thrown(enroll(h.deps, "other", h.prepared, presenceFor("other"), consentFor("other"), proposalFor("other")))).toBeInstanceOf(Refusal);

    h.clock.advance(271_000);
    expect(((await thrown(enroll(h.deps, WORD, h.prepared, presenceFor(WORD, "2026-11-05T12:04:00.000Z"), consentFor(WORD), proposalFor(WORD)))) as Refusal).message).toContain("too old");
    h.clock.set(BIRTH_NOW);

    // A signer whose root is not the key in the body: the signature fails locally and nothing leaves the host.
    const wrong = fakeSigner({ rootSeed: fromHex(TEST_OP_SEED_HEX) });
    const e = await thrown(enroll({ ...h.deps, signer: wrong }, WORD, h.prepared, presenceFor(WORD), consentFor(WORD), proposalFor(WORD)));
    expect((e as Refusal).message).toContain("nothing was sent");
    expect(wrong.sent).toHaveLength(0);
    expect(h.signer.sent).toHaveLength(0);
  });

  test("an ambiguous result (network error, 5xx) is never retried; resolveAmbiguous reads instead", async () => {
    // 5xx: one send, then an AmbiguousEnrollment naming the chosen ids.
    const h = harness();
    h.at.override((r) => r.op === "enroll", { status: 503, json: { error: "identity_enrollment_unavailable" } }, 10);
    const e = await thrown(enroll(h.deps, WORD, h.prepared, presenceFor(WORD), consentFor(WORD), proposalFor(WORD)));
    expect(e).toBeInstanceOf(AmbiguousEnrollment);
    expect((e as AmbiguousEnrollment).identity_id).toBe(h.prepared.fields.identity_id);
    expect((e as AmbiguousEnrollment).signing_key_id).toBe(h.prepared.fields.signing_key_id);
    expect(h.signer.sent.filter((r) => r.op === "enroll")).toHaveLength(1);

    // No response at all: also ambiguous, also one attempt.
    const h2 = harness();
    let attempts = 0;
    const dropped: Signer = {
      ...h2.signer,
      async send() {
        attempts++;
        throw new Error("connection reset");
      },
    };
    const e2 = await thrown(enroll({ ...h2.deps, signer: dropped }, WORD, h2.prepared, presenceFor(WORD), consentFor(WORD), proposalFor(WORD)));
    expect([e2 instanceof AmbiguousEnrollment, (e2 as AmbiguousEnrollment).status, attempts]).toEqual([true, 0, 1]);

    // The signer stopped before relaying (its bearer read failed): definite, never an AmbiguousEnrollment.
    const h2b = harness();
    const stopped: Signer = {
      ...h2b.signer,
      async send() {
        throw new SignerNotSent("not-sent", "signer: stopped before sending; nothing of the act left the host");
      },
    };
    const e2b = await thrown(enroll({ ...h2b.deps, signer: stopped }, WORD, h2b.prepared, presenceFor(WORD), consentFor(WORD), proposalFor(WORD)));
    expect(e2b).toBeInstanceOf(SignerNotSent);
    expect(e2b).not.toBeInstanceOf(AmbiguousEnrollment);

    // A 4xx is definite: the server's transaction rolled back.
    const h3 = harness();
    h3.at.override((r) => r.op === "enroll", { status: 401, json: { error: "identity_enrollment_invalid_proof" } });
    const e3 = await thrown(enroll(h3.deps, WORD, h3.prepared, presenceFor(WORD), consentFor(WORD), proposalFor(WORD)));
    expect(e3).toBeInstanceOf(AgenttoolError);
    expect([(e3 as AgenttoolError).status, (e3 as AgenttoolError).code]).toEqual([401, "identity_enrollment_invalid_proof"]);

    // resolveAmbiguous reads; it never enrolls. Inside the freshness window, a 404 is not yet "absent".
    const id = h.prepared.fields.identity_id;
    const before = h.signer.sent.length;
    expect(await resolveAmbiguous(h.deps, id, h.prepared)).toBe("unknown");
    // Just past the window on this host's clock, the server's clock may be behind, or its commit still in flight.
    const sent = Date.parse(h.prepared.fields.timestamp);
    h.clock.set(new Date(sent + 300_001).toISOString());
    expect(await resolveAmbiguous(h.deps, id, h.prepared)).toBe("unknown");
    h.clock.set(new Date(sent + 300_000 + ENROLLMENT_ABSENCE_MARGIN_MS).toISOString());
    expect(await resolveAmbiguous(h.deps, id, h.prepared)).toBe("unknown");
    h.clock.set(new Date(sent + 300_001 + ENROLLMENT_ABSENCE_MARGIN_MS).toISOString());
    expect(await resolveAmbiguous(h.deps, id, h.prepared)).toBe("absent");
    const reads = h.signer.sent.slice(before);
    expect(reads.map((r) => [r.op, r.method, r.target])).toEqual(Array.from({ length: 4 }, () => ["read", "GET", `/v1/identities/${id}/authority`]));

    // When the request did land, the read says so.
    const h4 = harness();
    h4.at.identities.set(h4.prepared.fields.identity_id, { root: TEST_ROOT_PUBLIC_B64, sequence: 0, keys: [] });
    expect(await resolveAmbiguous(h4.deps, h4.prepared.fields.identity_id, h4.prepared)).toBe("exists");
    expect(h4.signer.sent.every((r) => r.op === "read")).toBe(true);
  });

  test("parseEnrollResponse refuses a 201 whose identity id, root key or sequence differs from what was sent", () => {
    const v = vectors.enrollment[0]!;
    const fields = JSON.parse(v.body_utf8) as EnrollmentFields;
    const prepared: PreparedEnrollment = { fields, body: utf8(v.body_utf8), digest: fromHex(v.digest_hex) };
    expect(parseEnrollResponse(v.response_201, prepared)).toEqual({
      identity_id: TEST_IDS.identity_id,
      did: TEST_IDS.did,
      root_kid: TEST_IDS.root_signing_key_id,
      root_public_key_b64: TEST_ROOT_PUBLIC_B64,
      sequence: 0,
      next_sequence: 1,
    });
    const r = v.response_201;
    const variants: unknown[] = [
      { ...r, identity: { ...r.identity, id: "99999999-9999-4999-8999-999999999999" } },
      { ...r, identity: { ...r.identity, did: "did:at:99999999-9999-4999-8999-999999999999" } },
      { ...r, key: { ...r.key, public_key: vectors.op_key.public_key_b64 } },
      { ...r, key: { ...r.key, kid: vectors.op_key.placeholder_kid } },
      { ...r, authority: { ...r.authority, root_public_key: vectors.op_key.public_key_b64 } },
      { ...r, authority: { ...r.authority, sequence: 1, next_sequence: 2 } },
      { ...r, authority: { ...r.authority, mode: "legacy_bearer" } },
      { identity: r.identity },
      null,
    ];
    for (const bad of variants) {
      const e = (() => {
        try {
          parseEnrollResponse(bad, prepared);
        } catch (err) {
          return err;
        }
        return null;
      })();
      expect(e).toBeInstanceOf(AgenttoolError);
      expect((e as AgenttoolError).code).toBe("enroll_response_mismatch");
    }
  });
});

describe("resolveAmbiguous falls back to the public read only to confirm existence", () => {
  let server: FakeServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  test("a failed signer read and a public 200 is 'exists'; a public 404 is 'unknown', never 'absent'", async () => {
    server = await startFakeServer();
    const h = harness();
    const failing: Signer = { ...h.signer, send: async () => { throw new Error("offline"); } };
    const deps: EnrollDeps = { ...h.deps, signer: failing, fetch: fetchVia(server) };
    const id = h.prepared.fields.identity_id;
    h.clock.advance(400_000);
    expect(await resolveAmbiguous(deps, id, h.prepared)).toBe("unknown");
    server.on("GET", `/public/agents/did:at:${id}`, () => Response.json(publicAgentJson(`did:at:${id}`, null)));
    expect(await resolveAmbiguous(deps, id, h.prepared)).toBe("exists");
    expect(server.requests.every((r) => r.method === "GET" && r.path === `/public/agents/did:at:${id}`)).toBe(true);
  });
});
