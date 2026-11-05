// Owner: agenttool group. fakeSigner records sends; fetchVia for public reads.
// No request leaves the process except to the fake server on 127.0.0.1.
import { afterEach, describe, expect, test } from "bun:test";
import {
  AgenttoolError,
  createStrand,
  endCitizenQuiet,
  importOpKey,
  listKeys,
  postThought,
  putExpression,
  readAuthority,
  readPublicAgent,
  registerBoxKey,
  revokeKey,
  startCitizenQuiet,
  type ClientDeps,
  type ClientIdentity,
} from "../../src/agenttool/client.ts";
import { AGENTTOOL_ORIGIN } from "../../src/agenttool/wire.ts";
import { Refusal, type SignerOp, type Word } from "../../src/types.ts";
import type { Signer, SignerRequest, SignerResponse } from "../../src/signer/signer.ts";
import { FAKE_OP_KID, fakeSigner, type FakeSigner } from "../helpers/fake-signer.ts";
import { fetchVia, noFetch, publicAgentJson, startFakeServer, type FakeServer } from "../helpers/fake-server.ts";
import { TEST_IDS, TEST_OP_PUBLIC_B64, TEST_ROOT_PUBLIC_B64, vectors } from "../helpers/vectors.ts";
import { FAKE_STRAND_ID_UPPER, fakeAgenttool, type FakeAgenttool } from "../fixtures/agenttool/fake-agenttool.ts";

const WORD: Word = "glossame";
const ID = TEST_IDS.identity_id;
const IDENTITY: ClientIdentity = {
  identity_id: ID,
  did: TEST_IDS.did,
  root_kid: TEST_IDS.root_signing_key_id,
  root_public_key_b64: TEST_ROOT_PUBLIC_B64,
  self_strand_id: FAKE_STRAND_ID_UPPER.toLowerCase(),
};
const ROOT_OPS = new Set<SignerOp>(["keys.import", "keys.revoke", "box-keys.register", "expression.put.private", "quiet.start.citizen", "quiet.end.citizen"]);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const vector = (label: string) => vectors.authority.find((a) => a.label === label)!;

interface Harness {
  deps: ClientDeps;
  signer: FakeSigner;
  at: FakeAgenttool;
  /** Requests other than reads. */
  acts(): SignerRequest[];
}

function harness(extra: ClientIdentity[] = []): Harness {
  const signer = fakeSigner();
  const at = fakeAgenttool({
    project_id: TEST_IDS.project_id,
    known: [IDENTITY, ...extra].map((i) => ({ identity_id: i.identity_id, root_public_b64: i.root_public_key_b64, root_kid: i.root_kid })),
  });
  signer.respond((req) => at.respond(req));
  const byWord = new Map<string, ClientIdentity>([[WORD, IDENTITY], ...extra.map((i, n) => [`other-${n}`, i] as [string, ClientIdentity])]);
  const deps: ClientDeps = {
    signer,
    fetch: noFetch,
    async identity(word) {
      const id = byWord.get(word);
      if (!id) throw new Refusal("not-registered", `${word} is not registered`);
      return id;
    },
  };
  return { deps, signer, at, acts: () => signer.sent.filter((r) => r.op !== "read") };
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

async function agenttoolErrorOf(p: Promise<unknown>): Promise<AgenttoolError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AgenttoolError) return e;
    throw e;
  }
  throw new Error("expected an AgenttoolError");
}

async function everyCall(h: Harness): Promise<void> {
  await readAuthority(h.deps, WORD);
  await listKeys(h.deps, WORD);
  await importOpKey(h.deps, WORD, TEST_OP_PUBLIC_B64, "op-2026-11");
  await registerBoxKey(h.deps, WORD, vectors.derivation.box_pub_b64);
  await putExpression(h.deps, WORD, { register: "Plain.", wake_text: "A test wake text." });
  await startCitizenQuiet(h.deps, WORD, "2026-11-20T00:00:00.000Z");
  await endCitizenQuiet(h.deps, WORD);
  await revokeKey(h.deps, WORD, FAKE_OP_KID);
  const { strand_id } = await createStrand(h.deps, WORD, "self");
  await postThought(h.deps, WORD, strand_id, "a reason", "resolution");
}

describe("requests through the signer", () => {
  test("every per-identity request names the citizen's own identity where the route reads it, and never another", async () => {
    const h = harness();
    await everyCall(h);
    expect(h.signer.sent.length).toBeGreaterThanOrEqual(10);
    for (const req of h.signer.sent) {
      const url = new URL(req.target, AGENTTOOL_ORIGIN);
      expect(url.origin).toBe(AGENTTOOL_ORIGIN);
      expect(url.pathname + url.search).toBe(req.target);
      const inPath = /^\/v1\/identities\/([^/]+)\//.exec(url.pathname)?.[1];
      const inQuery = url.searchParams.getAll("identity_id");
      const body = req.body.length ? (JSON.parse(text(req.body)) as Record<string, unknown>) : {};
      const named = [inPath, ...inQuery, body.identity_id].filter((x) => x !== undefined);
      if (url.pathname.startsWith("/v1/quiet-hours")) {
        // Quiet hours picks its actor from this query; without it the project's primary identity would act.
        expect(inQuery).toEqual([ID]);
      } else if (url.pathname === "/v1/strands") {
        // A strand bound to the citizen accepts only the citizen's own keys.
        expect(body.identity_id).toBe(ID);
      } else if (!url.pathname.startsWith("/v1/strands/")) {
        expect(inPath).toBe(ID);
      }
      for (const n of named) expect(n).toBe(ID);
      expect(req.word).toBe(WORD);
      expect(req.operator).toBeNull();
    }
    // The targets are exactly the vectors' targets, so what authority signs is what the server rebuilds.
    const targets = new Set(h.signer.sent.map((r) => r.target));
    for (const a of vectors.authority) expect(targets.has(a.request_target)).toBe(true);
  });

  test("importOpKey, registerBoxKey, putExpression and quiet routes use the right SignerOp, method, target and exact body", async () => {
    const h = harness();
    const presence = { present: true as const, via: "tty-confirm" as const, confirmed_at: "2026-11-05T12:00:00.000Z", scope: `birth ${WORD}` };
    const auth = { presence, proposal: null };
    expect(await importOpKey(h.deps, WORD, TEST_OP_PUBLIC_B64, "op-2026-11", auth)).toEqual({ kid: FAKE_OP_KID });
    expect(await registerBoxKey(h.deps, WORD, vectors.derivation.box_pub_b64, auth)).toEqual({ id: "77777777-7777-4777-8777-777777777777" });
    await putExpression(h.deps, WORD, { register: "Plain.", wake_text: "A test wake text." }, auth);
    expect(await startCitizenQuiet(h.deps, WORD, "2026-11-20T00:00:00.000Z")).toEqual({ until: "2026-11-20T00:00:00.000Z" });

    const [imp, box, expr, quiet] = h.acts();
    // The bodies are the vectors' bytes and the targets the vectors' targets.
    expect([imp!.op, imp!.method, imp!.target, text(imp!.body)]).toEqual(["keys.import", "POST", vector("keys-import").request_target, vector("keys-import").body_utf8]);
    expect([box!.op, box!.method, box!.target, text(box!.body)]).toEqual(["box-keys.register", "POST", vector("box-keys-register").request_target, vector("box-keys-register").body_utf8]);
    expect([expr!.op, expr!.method, expr!.target, text(expr!.body)]).toEqual(["expression.put.private", "PUT", vector("expression-put").request_target, vector("expression-put").body_utf8]);
    expect([quiet!.op, quiet!.method, quiet!.target]).toEqual(["quiet.start.citizen", "POST", vector("quiet-start").request_target]);
    for (const r of [imp!, box!, expr!]) {
      expect(r.credits).toBe(0);
      expect(r.presence).toEqual(presence);
    }
    expect(quiet!.presence).toBeNull();
  });

  test("every root act is preceded by a posture read of the authority route", async () => {
    const h = harness();
    await importOpKey(h.deps, WORD, TEST_OP_PUBLIC_B64, "op-2026-11");
    expect(h.signer.sent.map((r) => [r.op, r.method, r.target])).toEqual([
      ["read", "GET", `/v1/identities/${ID}/authority`],
      ["keys.import", "POST", vector("keys-import").request_target],
    ]);
    // A root that is not this host's refuses before any root request.
    const other = harness();
    other.at.identities.get(ID)!.root = TEST_OP_PUBLIC_B64;
    expect((await refusalOf(registerBoxKey(other.deps, WORD, vectors.derivation.box_pub_b64))).code).toBe("invalid-record");
    expect(other.acts()).toHaveLength(0);
  });

  test("[S4-5] startCitizenQuiet always sends an explicit until, never hours, and an empty reason", async () => {
    const h = harness();
    for (const until of ["2026-11-06T00:00:00.000Z", "2026-12-05T02:05:00.000Z"]) {
      await startCitizenQuiet(h.deps, WORD, until);
    }
    const quiet = h.acts().filter((r) => r.op === "quiet.start.citizen");
    expect(quiet).toHaveLength(2);
    for (const r of quiet) {
      const body = JSON.parse(text(r.body)) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["until"]);
      expect(typeof body.until).toBe("string");
      expect(body).not.toHaveProperty("hours");
      expect(body).not.toHaveProperty("reason");
      expect(r.target).toBe(`/v1/quiet-hours/start?identity_id=${ID}`);
    }
    // The server then shows no reason at all.
    expect(h.at.respond(quiet[0]!).json).toMatchObject({ reason: null });
    // A non-canonical until is refused locally, before anything is signed or sent.
    const before = h.signer.sent.length;
    for (const bad of ["2026-11-06", "2026-11-06T00:00:00Z", "8"]) {
      expect((await refusalOf(startCitizenQuiet(h.deps, WORD, bad))).code).toBe("invalid-request");
    }
    expect(h.signer.sent.length).toBe(before);
  });

  test("endCitizenQuiet and revokeKey send an empty body with DELETE", async () => {
    const h = harness();
    await importOpKey(h.deps, WORD, TEST_OP_PUBLIC_B64, "op-2026-11");
    await endCitizenQuiet(h.deps, WORD);
    await revokeKey(h.deps, WORD, FAKE_OP_KID);
    const [, end, revoke] = h.acts();
    expect([end!.op, end!.method, end!.target, end!.body.length]).toEqual(["quiet.end.citizen", "DELETE", `${vector("quiet-end").request_target}`, 0]);
    expect([revoke!.op, revoke!.method, revoke!.target, revoke!.body.length]).toEqual(["keys.revoke", "DELETE", vector("keys-revoke").request_target, 0]);
    // The root row is never revoked; refused before any request.
    const before = h.signer.sent.length;
    expect((await refusalOf(revokeKey(h.deps, WORD, IDENTITY.root_kid))).code).toBe("invalid-request");
    expect(h.signer.sent.length).toBe(before);
  });

  test("createStrand binds identity_id; postThought uses signer.sealThought and the strand id in lowercase", async () => {
    const h = harness();
    const sealed: { word: string; strandId: string; kind: string }[] = [];
    const seal = h.signer.sealThought.bind(h.signer);
    h.signer.sealThought = async (word, strandId, plaintext, kind) => {
      sealed.push({ word, strandId, kind });
      return seal(word, strandId, plaintext, kind);
    };

    const { strand_id } = await createStrand(h.deps, WORD, "self");
    expect(strand_id).toBe(FAKE_STRAND_ID_UPPER.toLowerCase());
    const create = h.acts()[0]!;
    expect([create.op, create.method, create.target, create.credits]).toEqual(["strand.create", "POST", "/v1/strands", 1]);
    expect(JSON.parse(text(create.body))).toEqual({ identity_id: ID, topic: "self" });

    expect(await postThought(h.deps, WORD, FAKE_STRAND_ID_UPPER, "a reason", "resolution")).toEqual({ thought_id: "88888888-8888-4888-8888-888888888888" });
    expect(sealed).toEqual([{ word: WORD, strandId: strand_id, kind: "resolution" }]);
    const post = h.acts()[1]!;
    expect([post.op, post.method, post.target, post.credits]).toEqual(["thought.post", "POST", `/v1/strands/${strand_id}/thoughts`, 1]);
    const body = JSON.parse(text(post.body)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["ciphertext", "nonce", "kind", "signing_key_id", "signature"]);
    expect(body.signing_key_id).toBe(FAKE_OP_KID);
    // The plaintext is never in the request.
    expect(text(post.body)).not.toContain("a reason");

    // An unbound strand would accept any project key, so it is refused.
    h.at.override((r) => r.op === "strand.create", { status: 201, json: { id: FAKE_STRAND_ID_UPPER, identity_id: null } });
    expect((await agenttoolErrorOf(createStrand(h.deps, WORD, "self"))).code).toBe("malformed_response");

    // A thought to any strand but the citizen's own is refused before it is sealed or sent: the credit is charged
    // before agenttool checks the strand, and an unbound strand takes any key in the project.
    const sealedBefore = sealed.length;
    const sentBefore = h.signer.sent.length;
    expect((await refusalOf(postThought(h.deps, WORD, "66666666-6666-4666-8666-666666666666", "x", "drift"))).code).toBe("beyond-self");
    expect([sealed.length, h.signer.sent.length]).toEqual([sealedBefore, sentBefore]);
    const unstranded = { ...h.deps, identity: async () => ({ ...IDENTITY, self_strand_id: null }) };
    expect((await refusalOf(postThought(unstranded, WORD, strand_id, "x", "drift"))).code).toBe("beyond-self");
    expect([sealed.length, h.signer.sent.length]).toEqual([sealedBefore, sentBefore]);

    // A thought sealed by the root kid is a root act; refused before sending, since the credit is charged before verification.
    h.signer.sealThought = async (_w, _s, _p, kind) => ({ ciphertext: "AAAA", nonce: "AAAAAAAAAAAAAAAA", kind, signature: "A".repeat(88), signing_key_id: IDENTITY.root_kid });
    const before = h.signer.sent.length;
    expect((await refusalOf(postThought(h.deps, WORD, strand_id, "x", "drift"))).code).toBe("invalid-request");
    expect(h.signer.sent.length).toBe(before);
  });

  test("a 409 authority_sequence_conflict re-reads next_sequence once and never sends two root requests at once", async () => {
    const conflict: SignerResponse = { status: 409, json: { error: "authority_sequence_conflict", details: { received_sequence: 1, current_sequence: 1, next_sequence: 2 } } };

    // One conflict: read, send, read again, send again.
    const h = harness();
    h.at.override((r) => r.op === "keys.import", conflict);
    expect(await importOpKey(h.deps, WORD, TEST_OP_PUBLIC_B64, "op-2026-11")).toEqual({ kid: FAKE_OP_KID });
    expect(h.signer.sent.map((r) => r.op)).toEqual(["read", "keys.import", "read", "keys.import"]);

    // Two conflicts: it stops after the one resend.
    const h2 = harness();
    h2.at.override((r) => r.op === "keys.import", conflict, 5);
    const err = await agenttoolErrorOf(importOpKey(h2.deps, WORD, TEST_OP_PUBLIC_B64, "op-2026-11"));
    expect([err.status, err.code]).toEqual([409, "authority_sequence_conflict"]);
    expect(h2.acts()).toHaveLength(2);

    // Other refusals are not resent.
    const h3 = harness();
    h3.at.override((r) => r.op === "keys.import", { status: 401, json: { error: "authority_proof_stale" } });
    expect((await agenttoolErrorOf(importOpKey(h3.deps, WORD, TEST_OP_PUBLIC_B64, "op-2026-11"))).code).toBe("authority_proof_stale");
    expect(h3.acts()).toHaveLength(1);

    // Concurrency: many root acts at once for one identity, through a signer that answers slowly.
    const second: ClientIdentity = { identity_id: "99999999-9999-4999-8999-999999999999", did: "did:at:99999999-9999-4999-8999-999999999999", root_kid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", root_public_key_b64: TEST_ROOT_PUBLIC_B64, self_strand_id: null };
    const h4 = harness([second]);
    const inFlight = new Map<string, number>();
    let maxPerIdentity = 0;
    let maxOverall = 0;
    const base = h4.signer;
    const slow: Signer = {
      ...base,
      async send(req) {
        if (!ROOT_OPS.has(req.op)) return base.send(req);
        const url = new URL(req.target, AGENTTOOL_ORIGIN);
        const who = /^\/v1\/identities\/([^/]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get("identity_id")!;
        inFlight.set(who, (inFlight.get(who) ?? 0) + 1);
        maxPerIdentity = Math.max(maxPerIdentity, inFlight.get(who)!);
        maxOverall = Math.max(maxOverall, [...inFlight.values()].reduce((a, b) => a + b, 0));
        await Bun.sleep(5);
        try {
          return await base.send(req);
        } finally {
          inFlight.set(who, inFlight.get(who)! - 1);
        }
      },
    };
    h4.deps.signer = slow;
    h4.at.override((r) => r.op === "box-keys.register", conflict);
    await Promise.all([
      importOpKey(h4.deps, WORD, TEST_OP_PUBLIC_B64, "op-2026-11"),
      registerBoxKey(h4.deps, WORD, vectors.derivation.box_pub_b64),
      putExpression(h4.deps, WORD, { register: "Plain." }),
      startCitizenQuiet(h4.deps, WORD, "2026-11-20T00:00:00.000Z"),
      endCitizenQuiet(h4.deps, WORD),
      putExpression(h4.deps, "other-0", { register: "Other." }),
    ]);
    expect(maxPerIdentity).toBe(1);
    // A different identity is not held up by this one's lane.
    expect(maxOverall).toBe(2);
    // Each act read posture and then sent alone; the conflicted one read again before its resend.
    const mine = h4.signer.sent.filter((r) => r.target.includes(ID)).map((r) => r.op);
    const reads = mine.filter((op) => op === "read").length;
    expect(mine.filter((op) => op !== "read")).toHaveLength(6);
    expect(reads).toBe(6);
  });

  test("errors become AgenttoolError with status and code, and carry no secret", async () => {
    const secret = "at_live_0123456789abcdefSECRET";
    const h = harness();
    h.at.override((r) => r.op === "expression.put.private", { status: 401, json: { error: "authority_proof_invalid", message: `bearer ${secret} rejected`, echo: secret } });
    const e1 = await agenttoolErrorOf(putExpression(h.deps, WORD, { register: "x" }));
    expect([e1.status, e1.code, e1.name]).toEqual([401, "authority_proof_invalid", "AgenttoolError"]);

    // Free text where a code should be is dropped, not copied.
    h.at.override((r) => r.op === "keys.import", { status: 500, json: { error: `Internal error near ${secret}` } });
    const e2 = await agenttoolErrorOf(importOpKey(h.deps, WORD, TEST_OP_PUBLIC_B64, "op"));
    expect([e2.status, e2.code]).toEqual([500, null]);

    // A transport failure is "no response", without the underlying text.
    const failing: Signer = { ...h.signer, send: async () => { throw new Error(`socket closed; Authorization: Bearer ${secret}`); } };
    const e3 = await agenttoolErrorOf(readAuthority({ ...h.deps, signer: failing }, WORD));
    expect([e3.status, e3.code]).toEqual([0, "no_response"]);

    for (const e of [e1, e2, e3]) {
      const shown = `${e.message} ${String(e)} ${JSON.stringify(e)} ${e.stack ?? ""}`;
      expect(shown).not.toContain(secret);
    }

    // A wall's refusal passes through unchanged: nothing was sent.
    h.signer.locked = true;
    expect((await refusalOf(readAuthority(h.deps, WORD))).code).toBe("keychain-locked");
  });

  test("local refusals happen before any request: bad box key, bad expression, root as op key, unknown word", async () => {
    const h = harness();
    expect((await refusalOf(registerBoxKey(h.deps, WORD, Buffer.alloc(31).toString("base64")))).code).toBe("invalid-request");
    expect((await refusalOf(putExpression(h.deps, WORD, { wake_text: "t".repeat(32_001) }))).code).toBe("invalid-request");
    expect((await refusalOf(importOpKey(h.deps, WORD, TEST_ROOT_PUBLIC_B64, "op"))).code).toBe("invalid-request");
    expect((await refusalOf(importOpKey(h.deps, WORD, TEST_OP_PUBLIC_B64, ""))).code).toBe("invalid-request");
    expect((await refusalOf(readAuthority(h.deps, "Not A Word"))).code).toBe("invalid-request");
    expect(h.signer.sent).toHaveLength(0);
  });

  test("readAuthority and listKeys parse their shapes and mark the root row", async () => {
    const h = harness();
    expect(await readAuthority(h.deps, WORD)).toEqual({ sequence: 0, next_sequence: 1 });
    await importOpKey(h.deps, WORD, TEST_OP_PUBLIC_B64, "op-2026-11");
    expect(await readAuthority(h.deps, WORD)).toEqual({ sequence: 1, next_sequence: 2 });
    const keys = await listKeys(h.deps, WORD);
    expect(keys.map((k) => [k.kid, k.authority_root, k.active])).toEqual([
      [IDENTITY.root_kid, true, true],
      [FAKE_OP_KID, false, true],
    ]);
    h.at.override((r) => r.target.includes("/authority"), { status: 200, json: { identity_id: ID, did: TEST_IDS.did, sequence: 3, next_sequence: 5 } });
    expect((await agenttoolErrorOf(readAuthority(h.deps, WORD))).code).toBe("malformed_response");
  });
});

describe("public reads", () => {
  let server: FakeServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  test("readPublicAgent parses the active shape, the memorial shape (no quiet fields) and 404", async () => {
    server = await startFakeServer();
    const deps = { fetch: fetchVia(server) };
    const did = TEST_IDS.did;
    const path = `/public/agents/${did}`;

    server.on("GET", path, () => Response.json(publicAgentJson(did, null)));
    expect(await readPublicAgent(deps, did)).toEqual({ did, name: "halt-beacon", status: "active", quiet_until: null, quiet_reason: null });

    server.on("GET", path, () => Response.json(publicAgentJson(did, "2099-01-01T00:00:00.000Z", "")));
    expect(await readPublicAgent(deps, did)).toMatchObject({ status: "active", quiet_until: "2099-01-01T00:00:00.000Z", quiet_reason: "" });

    server.on("GET", path, () => Response.json({ status: "memorial", did, name: "remembered", born_at: "2026-06-09T00:00:00.000Z", memorial_basis: "x", _note: "fake" }));
    expect(await readPublicAgent(deps, did)).toEqual({ did, name: "remembered", status: "memorial", quiet_until: null, quiet_reason: null });

    server.on("GET", path, () => Response.json({ error: "agent_not_found" }, { status: 404 }));
    const e404 = await agenttoolErrorOf(readPublicAgent(deps, did));
    expect([e404.status, e404.code]).toEqual([404, "agent_not_found"]);

    // Fail closed on anything a beacon reader could misread as "not quiet".
    const { quiet_until: _q, ...noQuiet } = publicAgentJson(did, null);
    server.on("GET", path, () => Response.json(noQuiet));
    expect((await agenttoolErrorOf(readPublicAgent(deps, did))).code).toBe("malformed_response");
    server.on("GET", path, () => Response.json(publicAgentJson("did:at:99999999-9999-4999-8999-999999999999", null)));
    expect((await agenttoolErrorOf(readPublicAgent(deps, did))).code).toBe("malformed_response");
    server.on("GET", path, () => new Response("not json", { headers: { "content-type": "application/json" } }));
    expect((await agenttoolErrorOf(readPublicAgent(deps, did))).code).toBe("malformed_response");

    const seen = server.requests.filter((r) => r.path === path);
    expect(seen.length).toBe(7);
    for (const r of seen) {
      expect(r.method).toBe("GET");
      expect(r.headers.authorization).toBeUndefined();
    }
    expect((await refusalOf(readPublicAgent(deps, "did:at:not-a-uuid"))).code).toBe("invalid-request");
    expect(server.requests.length).toBe(7);
  });

  test("readPublicAgent with no reachable server is 'no response', never a lowered reading", async () => {
    const e = await agenttoolErrorOf(readPublicAgent({ fetch: noFetch }, TEST_IDS.did));
    expect([e.status, e.code]).toEqual([0, "no_response"]);
  });
});
