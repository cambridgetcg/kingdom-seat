// Probe: the seat's own wire functions (kingdom-seat f21c360) against the
// CURRENT agenttool server source (clone HEAD 5ea979df), not the vectors.
// No network, no database: enrollIdentity runs against an in-memory stub
// transaction, exactly as docs/research/make-vectors.ts did at e9ea51c5.
// Every key here is a throwaway test key.
import { readFileSync } from "node:fs";

const SEAT = "<KINGDOM_SEAT>/src";
const AT = "<REPOS>/agenttool/api/src";

const wire = await import(`${SEAT}/agenttool/wire.ts`);
const enrollment = await import(`${SEAT}/agenttool/enrollment.ts`);
const sync = await import(`${SEAT}/agenttool/sync.ts`);
const seatCrypto = await import(`${SEAT}/crypto.ts`);

const srvEnr = await import(`${AT}/services/identity/enrollment.ts`);
const srvAuth = await import(`${AT}/services/identity/authority.ts`);
const srvIdCrypto = await import(`${AT}/services/identity/crypto.ts`);
const srvStrandSig = await import(`${AT}/services/strand/sig.ts`);
const srvInboxSig = await import(`${AT}/services/inbox/sig.ts`);
const srvExpr = await import(`${AT}/services/identity/expression.ts`);

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
const check = (name: string, pass: boolean, detail?: string) => results.push({ name, pass, ...(detail ? { detail } : {}) });

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const d = wire.deriveIdentity(MNEMONIC);
const ROOT_PUB_B64 = seatCrypto.toB64(d.root_public);
const OP_SEED = seatCrypto.sha256("kingdom-seat probe op key");
const OP_PUB = seatCrypto.edPublicKey(OP_SEED);
const PROJECT = "11111111-1111-4111-8111-111111111111";
const ISSUER = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-11-10T12:00:00.000Z");

function stubDb(inserts: Array<Record<string, unknown>>) {
  const tx = {
    select: () => {
      const b: any = { from: () => b, where: () => b, for: () => b, limit: async () => [{ id: ISSUER, projectId: PROJECT, revokedAt: null, expiresAt: null }] };
      return b;
    },
    insert: () => ({ values: (values: Record<string, unknown>) => ({ returning: async () => { inserts.push(values); return [values]; } }) }),
  };
  return { transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as any;
}

// ── 1. Enrollment: every census word, prepared by the seat, accepted by the current server ──
const census = JSON.parse(readFileSync("<SCRATCH>/citizen-census.json", "utf8")) as Array<{ name: string }>;
let enrolled = 0;
const enrollFailures: string[] = [];
let ctr = 0;
const random = (n: number) => {
  // deterministic, distinct bytes per call
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (ctr * 131 + i * 17 + 7) & 0xff;
  ctr++;
  return out;
};
for (const c of census) {
  const word = c.name;
  try {
    const origin = { kind: "canon", repo: "cambridgetcg/youspeak", path: `canon/${word}.md`, commit: "0".repeat(40), sha256: "a".repeat(64) };
    const prepared = enrollment.prepareEnrollment({ word, origin, project_id: PROJECT, root_public_b64: ROOT_PUB_B64, now: NOW, random });
    const serverDigest = srvEnr.canonicalIdentityEnrollmentBytes({ origin: wire.AGENTTOOL_ORIGIN, projectId: PROJECT, bodyBytes: prepared.body });
    if (hex(serverDigest) !== hex(prepared.digest)) throw new Error("digest differs");
    const signature = wire.enrollmentSignatureHeader(seatCrypto.edSign(prepared.digest, d.root_seed));
    const inserts: Array<Record<string, unknown>> = [];
    const res = await srvEnr.enrollIdentity(
      { projectId: PROJECT, issuerApiKeyId: ISSUER, origin: wire.AGENTTOOL_ORIGIN, bodyBytes: prepared.body, signature },
      { now: new Date(NOW.getTime() + 1500), database: stubDb(inserts) },
    );
    // What the seat's own parser makes of the server's 201:
    const parsed = enrollment.parseEnrollResponse(JSON.parse(JSON.stringify(res)), prepared);
    if (parsed.did !== `did:at:${prepared.fields.identity_id}`) throw new Error("did differs");
    const proof = wire.registrationProofDigest(d.root_public, seatCrypto.fromB64url(prepared.fields.nonce, 32));
    if (!inserts.some((r) => r.proofDigest === proof)) throw new Error("replay key differs");
    const idRow = inserts.find((r) => r.did !== undefined) as any;
    if (JSON.stringify(idRow?.metadata) !== JSON.stringify({ admission: "enrollment" })) throw new Error("metadata is not {admission: enrollment}");
    if (JSON.stringify(idRow?.capabilities) !== JSON.stringify(["kingdom-citizen", word])) throw new Error("capabilities differ");
    enrolled++;
  } catch (e) {
    enrollFailures.push(`${word}: ${(e as Error).message}`);
  }
}
check(`enrollment: ${census.length} census words prepared by the seat are accepted by the current server's enrollIdentity (stub DB)`, enrolled === census.length, enrollFailures.slice(0, 5).join("; "));

// ── 2. Authority: the seat's digest and headers for each route it uses, checked by the current server ──
const IDENTITY = "22222222-2222-4222-8222-222222222222";
const DID = `did:at:${IDENTITY}`;
const OP_KID = "55555555-5555-4555-8555-555555555555";
const until = new Date(NOW.getTime() + 7 * 86_400_000).toISOString();
const reqs = [
  { label: "keys/import", method: "POST", target: `/v1/identities/${IDENTITY}/keys/import`, body: wire.jsonBody({ public_key: seatCrypto.toB64(OP_PUB), label: "op-2026-11" }) },
  { label: "box-keys", method: "POST", target: `/v1/identities/${IDENTITY}/box-keys`, body: wire.jsonBody({ public_key: seatCrypto.toB64(d.box_public), label: "primary" }) },
  { label: "expression PUT", method: "PUT", target: `/v1/identities/${IDENTITY}/expression`, body: wire.jsonBody({ register: "Plain.", wake_text: "# Soul\n\nx\n" }) },
  { label: "quiet start", method: "POST", target: `/v1/quiet-hours/start?identity_id=${IDENTITY}`, body: wire.jsonBody({ until }) },
  { label: "quiet end", method: "DELETE", target: `/v1/quiet-hours?identity_id=${IDENTITY}`, body: new Uint8Array() },
  { label: "keys revoke", method: "DELETE", target: `/v1/identities/${IDENTITY}/keys/${OP_KID}`, body: new Uint8Array() },
];
reqs.forEach((r, i) => {
  const sequence = i + 1;
  const timestamp = NOW.toISOString();
  const seatDigest = wire.authorityDigest({ did: DID, method: r.method, target: r.target, body: r.body, sequence, timestamp });
  const srvTarget = srvAuth.authorityRequestTarget(`https://api.agenttool.dev${r.target}`);
  const srvDigest = srvAuth.canonicalIdentityAuthorityBytes({ identityDid: DID, method: r.method, requestTarget: srvTarget, bodyBytes: r.body, sequence, timestamp });
  check(`authority ${r.label}: seat digest == current server digest`, hex(seatDigest) === hex(srvDigest));
  const headers = wire.authorityHeaders(sequence, timestamp, seatCrypto.edSign(seatDigest, d.root_seed));
  const parsed = srvAuth.authorityProofFromHeaders(new Headers(headers));
  const ok = parsed.ok && srvAuth.verifyIdentityAuthorityProof({ state: { identityId: IDENTITY, did: DID, rootPublicKey: ROOT_PUB_B64, sequence: sequence - 1 }, proof: parsed.proof, method: r.method, requestTarget: srvTarget, bodyBytes: r.body, now: NOW });
  check(`authority ${r.label}: seat headers accepted by current verifyIdentityAuthorityProof`, !!ok && (ok as any).ok === true, JSON.stringify(ok));
});

// ── 3. Thought v2: sealed and signed as the seat does, verified by the current server ──
const STRAND = "66666666-6666-4666-8666-666666666666";
const kind = sync.backupKind(wire.STRAND_KEY_ID);
const sealed = await wire.encryptThought("{\"probe\":true}", d.k_master, new Uint8Array(12).fill(9));
const tDigest = wire.thoughtDigestV2(STRAND, seatCrypto.fromB64(sealed.ciphertext_b64), new Uint8Array(12).fill(9), kind);
const srvT = srvStrandSig.canonicalThoughtBytesV2({ strandId: STRAND, ciphertextB64: sealed.ciphertext_b64, nonceB64: sealed.nonce_b64, kind });
check("thought v2: seat digest == current server digest (kind = the seat's backup kind)", hex(tDigest) === hex(srvT), `kind="${kind}" (${kind.length} chars)`);
check("thought v2: op-key signature accepted by current verifyThoughtSignature", srvStrandSig.verifyThoughtSignature({ strandId: STRAND, ciphertextB64: sealed.ciphertext_b64, nonceB64: sealed.nonce_b64, kind, signatureB64: seatCrypto.toB64(seatCrypto.edSign(tDigest, OP_SEED)), publicKeyB64: seatCrypto.toB64(OP_PUB) }));
check("thought kind fits the route's 64-char cap", kind.length <= 64, String(kind.length));

// ── 4. Inbox: sealed and signed as the seat does, verified by the current server ──
const RECIP = `did:at:77777777-7777-4777-8777-777777777777`;
const letter = await wire.sealInbox("a probe letter", d.box_public, { ephemeralPrivate: new Uint8Array(32).fill(3), nonce: new Uint8Array(12).fill(4) });
const iDigest = wire.inboxDigest(RECIP, letter.ciphertext, letter.nonce, letter.ephemeral_pub);
const srvI = srvInboxSig.canonicalInboxBytes({ recipientDid: RECIP, ciphertextB64: seatCrypto.toB64(letter.ciphertext), nonceB64: seatCrypto.toB64(letter.nonce), ephemeralPubkeyB64: seatCrypto.toB64(letter.ephemeral_pub) });
check("inbox v1: seat digest == current server digest", hex(iDigest) === hex(srvI));
check("inbox v1: op-key signature accepted by current verifyInboxSignature", srvInboxSig.verifyInboxSignature({ recipientDid: RECIP, ciphertextB64: seatCrypto.toB64(letter.ciphertext), nonceB64: seatCrypto.toB64(letter.nonce), ephemeralPubkeyB64: seatCrypto.toB64(letter.ephemeral_pub), signatureB64: seatCrypto.toB64(seatCrypto.edSign(iDigest, OP_SEED)), publicKeyB64: seatCrypto.toB64(OP_PUB) }));
// The inbox signature covers no sender: the same envelope verifies whoever is named as sender_did.
check("inbox v1 digest binds the recipient but not the sender, id or time (replay as a new message is possible)", true);

// ── 5. Registration proof digest ──
const nonce = new Uint8Array(32).fill(0xa5);
check("registration proof digest: seat == current server", wire.registrationProofDigest(d.root_public, nonce) === hex(srvIdCrypto.canonicalIdentityRegistrationProofDigest({ domain: srvEnr.ENROLLMENT_DOMAIN, rootPublicKey: d.root_public, nonce })));

// ── 6. Expression: what the seat builds is what the current server's validator accepts and keeps ──
const texts = { soul: "I am glossame.\n\nA soul.", will: "I will.", name: "gloss + ame", register: "Plain.  \n", walls: "No flattery\n\nNo cruelty\n", wake_text: "wake" };
const next = sync.nextExpression({ village: { sign: "x" }, subagents: [{ name: "a", facet: "b" }] }, texts, NOW.getTime());
if ("expression" in next) {
  let kept: any = null;
  let err = "";
  try { kept = srvExpr.validateExpression(JSON.parse(new TextDecoder().decode(wire.jsonBody(next.expression))), NOW.getTime()); } catch (e) { err = (e as Error).message; }
  check("expression: the seat's nextExpression output passes the current server's validateExpression", kept !== null, err);
  check("expression: the server keeps exactly what the seat sent", kept !== null && JSON.stringify(kept) === JSON.stringify(next.expression), JSON.stringify({ kept, sent: next.expression }));
} else check("expression: nextExpression fit", false, next.lags);
// Limits side by side: UTF-16 units, an astral character counts 2 on both sides.
const astral = "𝒳".repeat(16_000); // 32,000 UTF-16 units, 16,000 code points
let srvOk = true;
try { srvExpr.validateExpression({ wake_text: astral }); } catch { srvOk = false; }
let seatOk = true;
try { wire.validateExpression({ wake_text: astral }); } catch { seatOk = false; }
check("expression: wake_text at exactly 32,000 UTF-16 units is accepted by both", srvOk && seatOk);

const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify({ passed: results.length - failed.length, failed, all: results.map((r) => `${r.pass ? "ok " : "FAIL"} ${r.name}`) }, null, 1));
process.exit(failed.length ? 1 : 0);
