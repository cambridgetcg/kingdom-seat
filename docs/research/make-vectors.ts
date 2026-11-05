// Golden vectors for kingdom-seat, computed by agenttool's own functions at
// e9ea51c5. Every key here is a public test key; none is real.
//
// The functions are imported unchanged from an exported tree rather than
// re-implemented, so the vectors pin agenttool's behaviour and not ours.
// Build the tree (see agenttool-wire.md section 7), then run from a
// directory with no .env, because bun loads one automatically:
//   bun --no-install run make-vectors.ts <exported-tree> <out.json>
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const R = process.argv[2]!;
const OUT = process.argv[3]!;
const COMMIT = "e9ea51c5f4a19137b36f6a5851ee2f66dd60b7fd";

const seed = await import(`${R}/packages/sdk-ts/src/seed.ts`);
const sdkAuth = await import(`${R}/packages/sdk-ts/src/authority.ts`);
const sdkCrypto = await import(`${R}/packages/sdk-ts/src/crypto.ts`);
const lobby = await import(`${R}/packages/lobby/src/wire.ts`);
const strandSig = await import(`${R}/api/src/services/strand/sig.ts`);
const idCrypto = await import(`${R}/api/src/services/identity/crypto.ts`);
const apiAuth = await import(`${R}/api/src/services/identity/authority.ts`);
const enr = await import(`${R}/api/src/services/identity/enrollment.ts`);
const ed = await import(`${R}/api/node_modules/@noble/ed25519/index.js`);
const { sha512 } = await import(`${R}/api/node_modules/@noble/hashes/sha2.js`);
ed.etc.sha512Sync = (...m: Uint8Array[]) => { const h = sha512.create(); for (const x of m) h.update(x); return h.digest(); };

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const utf8 = (s: string) => new TextEncoder().encode(s);
const sha256hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];
function check(name: string, pass: boolean, detail?: string) { checks.push({ name, pass, ...(detail ? { detail } : {}) }); }
function version(pkg: string) { return JSON.parse(readFileSync(`${R}/api/node_modules/${pkg}/package.json`, "utf8")).version; }

// ── 1. Key derivation (IDENTITY-SEED profile) ─────────────────────────────
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const bipSeed = seed.mnemonicToSeed(MNEMONIC, "");
const bundle = seed.derive(MNEMONIC, "");
const bridge0 = seed.deriveBridgeSigning(MNEMONIC, 0, "");
const testSrc = readFileSync(`${R}/packages/sdk-ts/tests/phase5_seed.test.ts`, "utf8");
const pinned = (name: string) => new RegExp(`${name} = "([^"]+)"`).exec(testSrc)?.[1];
check("derive: signing pub equals sdk-ts test pin", bundle.signingPubB64 === pinned("EXPECT_SIGNING_PUB_B64"));
check("derive: signing seed equals sdk-ts test pin", bundle.signingPrivB64 === pinned("EXPECT_SIGNING_PRIV_B64"));
check("derive: box pub equals sdk-ts test pin", bundle.boxPubB64 === pinned("EXPECT_BOX_PUB_B64"));
check("derive: box priv equals sdk-ts test pin", bundle.boxPrivB64 === pinned("EXPECT_BOX_PRIV_B64"));
check("derive: k_master equals sdk-ts test pin", bundle.kMasterB64 === pinned("EXPECT_K_MASTER_B64"));
check("derive: bridge dev0 pub equals sdk-ts test pin", b64(bridge0.pub) === pinned("EXPECT_BRIDGE_PUB_DEV0_B64"));
check("derive: signing pub = ed25519.getPublicKey(signing seed)", b64(ed.getPublicKey(bundle.signingPriv)) === bundle.signingPubB64);

const ROOT_SEED: Uint8Array = bundle.signingPriv;
const ROOT_PUB = bundle.signingPubB64;
// The op key is deliberately not derived from the mnemonic, so the root
// mnemonic can stay offline while the op key lives on the lease host.
const OP_SEED = new Uint8Array(createHash("sha256").update("kingdom-seat test op key v1").digest());
const OP_PUB = b64(ed.getPublicKey(OP_SEED));

// ── 2. identity-enrollment/v1 ──────────────────────────────────────────────
const ORIGIN = "https://api.agenttool.dev";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const IDENTITY = "22222222-2222-4222-8222-222222222222";
const ROOT_KID = "33333333-3333-4333-8333-333333333333";
const ISSUER_API_KEY = "44444444-4444-4444-8444-444444444444";
const OP_KID = "55555555-5555-4555-8555-555555555555"; // server-assigned in reality
const STRAND = "66666666-6666-4666-8666-666666666666";
const TS = "2026-11-05T12:00:00.000Z";
const NOW = new Date(TS);
const DID = `did:at:${IDENTITY}`;

function fakeDatabase(inserts: Array<Record<string, unknown>>) {
  const tx = {
    select: () => {
      const b: any = { from: () => b, where: () => b, for: () => b,
        limit: async () => [{ id: ISSUER_API_KEY, projectId: PROJECT, revokedAt: null, expiresAt: null }] };
      return b;
    },
    insert: () => ({ values: (values: Record<string, unknown>) => ({ returning: async () => { inserts.push(values); return [values]; } }) }),
  };
  return { transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as any;
}

async function enrollmentVector(label: string, displayName: string, capabilities: string[], nonceBytes: Uint8Array) {
  // Field order follows packages/lobby/src/packets.ts enrollmentBody(); the
  // server binds whatever order and whitespace the exact bytes carry.
  const body = JSON.stringify({
    format: "agenttool-identity-enrollment/v1", origin: ORIGIN, project_id: PROJECT,
    identity_id: IDENTITY, signing_key_id: ROOT_KID, display_name: displayName,
    capabilities, public_key: ROOT_PUB, nonce: b64url(nonceBytes), timestamp: TS,
  });
  const bodyBytes = utf8(body);
  const preimage = [enr.ENROLLMENT_DOMAIN, "POST", enr.ENROLLMENT_PATH, ORIGIN, PROJECT, sha256hex(bodyBytes)].join("\0");
  const apiDigest = enr.canonicalIdentityEnrollmentBytes({ origin: ORIGIN, projectId: PROJECT, bodyBytes });
  const lobbyDigest = lobby.enrollmentDigest({ origin: ORIGIN, projectId: PROJECT, bodyBytes });
  check(`${label}: api digest == lobby digest`, hex(apiDigest) === hex(lobbyDigest));
  check(`${label}: digest == sha256(preimage)`, hex(apiDigest) === sha256hex(utf8(preimage)));
  const sigNoble = ed.sign(apiDigest, ROOT_SEED);
  const sigLobby = lobby.signBytes(lobby.privateKeyFromSeed(ROOT_SEED), apiDigest);
  check(`${label}: noble signature == node:crypto (lobby) signature`, hex(sigNoble) === hex(sigLobby));
  const signature = b64url(sigNoble);
  check(`${label}: schema accepts body`, enr.identityEnrollmentSchema.safeParse(JSON.parse(body)).success);
  check(`${label}: strict ed25519 verify (zip215:false)`, ed.verify(sigNoble, apiDigest, Buffer.from(ROOT_PUB, "base64"), { zip215: false }));

  const inserts: Array<Record<string, unknown>> = [];
  const result = await enr.enrollIdentity(
    { projectId: PROJECT, issuerApiKeyId: ISSUER_API_KEY, origin: ORIGIN, bodyBytes, signature },
    { now: NOW, database: fakeDatabase(inserts) },
  );
  const keyRow = inserts.find(r => r.identityId === IDENTITY && r.label !== undefined);
  check(`${label}: enrollIdentity accepts (stub DB)`, result?.identity?.did === DID);
  check(`${label}: enrollment inserts root as primary signing key`,
    keyRow?.label === "primary" && keyRow?.publicKey === ROOT_PUB && keyRow?.id === ROOT_KID);

  let reformatted = "accepted";
  try {
    await enr.enrollIdentity(
      { projectId: PROJECT, issuerApiKeyId: ISSUER_API_KEY, origin: ORIGIN,
        bodyBytes: utf8(JSON.stringify(JSON.parse(body), null, 1)), signature },
      { now: NOW, database: fakeDatabase([]) },
    );
  } catch (e) { reformatted = (e as Error).message; }
  check(`${label}: re-serialized body is refused`, reformatted === "identity_enrollment_invalid_proof", reformatted);

  let stale = "accepted";
  try {
    await enr.enrollIdentity(
      { projectId: PROJECT, issuerApiKeyId: ISSUER_API_KEY, origin: ORIGIN, bodyBytes, signature },
      { now: new Date(NOW.getTime() + 300_001), database: fakeDatabase([]) },
    );
  } catch (e) { stale = (e as Error).message; }
  check(`${label}: 300001 ms later is refused`, stale === "identity_enrollment_invalid_proof", stale);

  const proofDigest = hex(idCrypto.canonicalIdentityRegistrationProofDigest({
    domain: enr.ENROLLMENT_DOMAIN, rootPublicKey: Buffer.from(ROOT_PUB, "base64"), nonce: nonceBytes,
  }));
  check(`${label}: proof digest matches stub DB insert`, inserts.some(r => r.proofDigest === proofDigest));

  return {
    label,
    inputs: { origin: ORIGIN, project_id: PROJECT, root_seed_hex: hex(ROOT_SEED), nonce_bytes_hex: hex(nonceBytes), timestamp: TS },
    body_utf8: body,
    body_sha256_hex: sha256hex(bodyBytes),
    preimage_utf8_with_nul: preimage,
    preimage_hex: hex(utf8(preimage)),
    digest_hex: hex(apiDigest),
    header_X_Agenttool_Enrollment_Signature: signature,
    registration_proof_digest_hex: proofDigest,
    response_201: result,
    rows_written_by_stub: inserts,
  };
}

const enrollment = [
  await enrollmentVector("enroll-ascii", "kingdom-seat test citizen", [], Uint8Array.from({ length: 32 }, (_, i) => i)),
  await enrollmentVector("enroll-utf8", "星 test ☆ café", ["reflect"], new Uint8Array(32).fill(0xa5)),
];

// ── 3. identity-authority/v1 ───────────────────────────────────────────────
const BASE = "https://api.agenttool.dev";
const BOX_PUB = bundle.boxPubB64;
const requests: Array<{ label: string; method: string; url: string; body: string }> = [
  { label: "keys-import", method: "POST", url: `${BASE}/v1/identities/${IDENTITY}/keys/import`, body: JSON.stringify({ public_key: OP_PUB, label: "op-2026-11" }) },
  { label: "box-keys-register", method: "POST", url: `${BASE}/v1/identities/${IDENTITY}/box-keys`, body: JSON.stringify({ public_key: BOX_PUB, label: "primary" }) },
  { label: "expression-put", method: "PUT", url: `${BASE}/v1/identities/${IDENTITY}/expression`, body: JSON.stringify({ register: "Plain.", wake_text: "A test wake text." }) },
  { label: "quiet-start", method: "POST", url: `${BASE}/v1/quiet-hours/start?identity_id=${IDENTITY}`, body: JSON.stringify({ hours: 8, reason: "resting" }) },
  { label: "quiet-end", method: "DELETE", url: `${BASE}/v1/quiet-hours?identity_id=${IDENTITY}`, body: "" },
  { label: "keys-revoke", method: "DELETE", url: `${BASE}/v1/identities/${IDENTITY}/keys/${OP_KID}`, body: "" },
];
const authority = requests.map((r, i) => {
  const sequence = i + 1;
  const requestTarget = apiAuth.authorityRequestTarget(r.url);
  check(`${r.label}: api and sdk request target agree`, requestTarget === sdkAuth.authorityRequestTarget(r.url));
  const bodyBytes = utf8(r.body);
  const apiDigest = apiAuth.canonicalIdentityAuthorityBytes({ identityDid: DID, method: r.method, requestTarget, bodyBytes, sequence, timestamp: TS });
  const sdkDigest = sdkAuth.canonicalIdentityAuthorityBytes({ identityDid: DID, method: r.method, requestTarget, body: r.body, sequence, timestamp: TS });
  check(`${r.label}: api digest == sdk digest`, hex(apiDigest) === hex(sdkDigest));
  const headers = sdkAuth.identityAuthorityHeaders({ identityDid: DID, method: r.method, requestTarget, body: r.body, sequence, timestamp: TS, signingKey: ROOT_SEED });
  const proof = { sequence: Number(headers["X-Agenttool-Authority-Sequence"]), timestamp: headers["X-Agenttool-Authority-Timestamp"], signature: headers["X-Agenttool-Authority-Signature"] };
  const state = { identityId: IDENTITY, did: DID, rootPublicKey: ROOT_PUB, sequence: sequence - 1 };
  const ok = apiAuth.verifyIdentityAuthorityProof({ state, proof, method: r.method, requestTarget, bodyBytes, now: NOW });
  check(`${r.label}: api verifyIdentityAuthorityProof ok`, ok.ok === true, JSON.stringify(ok));
  const urlSafe = Buffer.from(proof.signature, "base64").toString("base64url");
  const okUrl = apiAuth.verifyIdentityAuthorityProof({ state, proof: { ...proof, signature: urlSafe }, method: r.method, requestTarget, bodyBytes, now: NOW });
  check(`${r.label}: server also accepts the base64url spelling of the signature`, okUrl.ok === true);
  const replay = apiAuth.verifyIdentityAuthorityProof({ state: { ...state, sequence }, proof, method: r.method, requestTarget, bodyBytes, now: NOW });
  check(`${r.label}: replay after the sequence advanced is refused`, !replay.ok && replay.error === "sequence");
  const opSig = b64(ed.sign(apiDigest, OP_SEED));
  const byOp = apiAuth.verifyIdentityAuthorityProof({ state, proof: { ...proof, signature: opSig }, method: r.method, requestTarget, bodyBytes, now: NOW });
  check(`${r.label}: op key cannot sign authority`, !byOp.ok && byOp.error === "signature");
  const late = apiAuth.verifyIdentityAuthorityProof({ state, proof, method: r.method, requestTarget, bodyBytes, now: new Date(NOW.getTime() + 300_001) });
  check(`${r.label}: 300001 ms later is stale`, !late.ok && late.error === "timestamp");
  return {
    label: r.label, method: r.method, url: r.url, request_target: requestTarget, body_utf8: r.body,
    body_sha256_hex: sha256hex(bodyBytes), identity_did: DID, sequence, timestamp: TS,
    preimage_hex: hex(utf8([apiAuth.IDENTITY_AUTHORITY_DOMAIN, DID, r.method.toUpperCase(), requestTarget, sha256hex(bodyBytes), String(sequence), TS].join("\0"))),
    digest_hex: hex(apiDigest),
    headers,
  };
});
const apiDigestPre = authority.every(a => a.digest_hex === createHash("sha256").update(Buffer.from(a.preimage_hex, "hex")).digest("hex"));
check("authority: every digest == sha256(preimage)", apiDigestPre);

// ── 4. strand-thought/v2, signed by the op key ─────────────────────────────
const THOUGHT_NONCE = Uint8Array.from({ length: 12 }, (_, i) => 0x10 + i);
const kMasterKey = await crypto.subtle.importKey("raw", bundle.kMaster, { name: "AES-GCM" }, false, ["encrypt"]);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: THOUGHT_NONCE }, kMasterKey, utf8("a test thought")));
const ciphertext_b64 = b64(ct), nonce_b64 = b64(THOUGHT_NONCE), kind = "observation";
const v2api = strandSig.canonicalThoughtBytesV2({ strandId: STRAND, ciphertextB64: ciphertext_b64, nonceB64: nonce_b64, kind });
const v2sdk = sdkCrypto.canonicalThoughtBytes({ strandId: STRAND, ciphertext_b64, nonce_b64, kind, version: "v2" });
const v1api = strandSig.canonicalThoughtBytes({ strandId: STRAND, ciphertextB64: ciphertext_b64, nonceB64: nonce_b64, kind });
check("thought: api v2 digest == sdk v2 digest", hex(v2api) === hex(v2sdk));
const thoughtSig = sdkCrypto.signThought({ strandId: STRAND, ciphertext_b64, nonce_b64, kind, version: "v2", signing_key: OP_SEED });
check("thought: api verifyThoughtSignature accepts op-key v2 signature",
  strandSig.verifyThoughtSignature({ strandId: STRAND, ciphertextB64: ciphertext_b64, nonceB64: nonce_b64, kind, signatureB64: thoughtSig, publicKeyB64: OP_PUB }));
const plain = await sdkCrypto.decryptThought({ ciphertext_b64, nonce_b64 }, bundle.kMaster);
check("thought: sdk decryptThought round-trips", plain === "a test thought");

const failed = checks.filter(c => !c.pass);
const out = {
  format: "kingdom-seat/agenttool-wire-vectors/v1",
  warning: "Every key and mnemonic in this file is a public test value. Never register them on a live service.",
  provenance: {
    repository: "cambridgetcg/agenttool",
    commit: COMMIT,
    computed_at: new Date().toISOString(),
    runtime: `bun ${Bun.version}`,
    method: "Sources exported with `git archive e9ea51c5` into a scratch tree and imported unchanged; dependencies resolved from an existing install whose versions equal e9ea51c5's api/bun.lock and packages/sdk-ts/bun.lock. No network, no database (enrollIdentity ran against an in-memory stub transaction).",
    dependency_versions: Object.fromEntries(["@noble/ed25519", "@noble/hashes", "@noble/curves", "@scure/bip39", "@scure/base"].map(p => [p, version(p)])),
    functions: {
      derivation: "packages/sdk-ts/src/seed.ts: mnemonicToSeed (:122), derive (:335), deriveBridgeSigning (:361)",
      enrollment_digest_server: "api/src/services/identity/enrollment.ts: canonicalIdentityEnrollmentBytes (:62), identityEnrollmentSchema (:40), enrollIdentity (:87)",
      enrollment_digest_client: "packages/lobby/src/wire.ts: enrollmentDigest (:335), signBytes (:386), privateKeyFromSeed (:350)",
      registration_proof_digest: "api/src/services/identity/crypto.ts: canonicalIdentityRegistrationProofDigest (:408)",
      authority_server: "api/src/services/identity/authority.ts: canonicalIdentityAuthorityBytes (:102), verifyIdentityAuthorityProof (:154), authorityRequestTarget (:678)",
      authority_client: "packages/sdk-ts/src/authority.ts: canonicalIdentityAuthorityBytes (:69), identityAuthorityHeaders (:101), authorityRequestTarget (:64)",
      thought_server: "api/src/services/strand/sig.ts: canonicalThoughtBytes (:76), canonicalThoughtBytesV2 (:94), verifyThoughtSignature (:121)",
      thought_client: "packages/sdk-ts/src/crypto.ts: canonicalThoughtBytes (:233), signThought (:268), decryptThought (:140)",
    },
  },
  checks_passed: checks.length - failed.length,
  checks_failed: failed.length,
  checks,
  derivation: {
    mnemonic: MNEMONIC,
    passphrase: "",
    bip39_seed_hex: hex(bipSeed),
    paths: { signing: "m/44'/169'/0'/0'", k_master: "m/44'/169'/1'/0'", k_vault: "m/44'/169'/2'/0'", box_x25519: "m/44'/169'/3'/0'", bridge_device_0: "m/44'/169'/4'/0'" },
    signing_seed_b64: bundle.signingPrivB64,
    signing_seed_hex: hex(bundle.signingPriv),
    signing_pub_b64: bundle.signingPubB64,
    box_priv_b64: bundle.boxPrivB64,
    box_pub_b64: bundle.boxPubB64,
    k_master_b64: bundle.kMasterB64,
    k_vault_b64: bundle.kVaultB64,
    bridge_device_0_pub_b64: b64(bridge0.pub),
  },
  op_key: {
    note: "Not from agenttool: kingdom-seat's test op key, seed = sha256(utf8('kingdom-seat test op key v1')). Registered via keys/import; the server assigns the kid (OP_KID below is a placeholder).",
    seed_hex: hex(OP_SEED),
    public_key_b64: OP_PUB,
    placeholder_kid: OP_KID,
  },
  ids: { project_id: PROJECT, identity_id: IDENTITY, did: DID, root_signing_key_id: ROOT_KID, issuer_api_key_id: ISSUER_API_KEY, strand_id: STRAND },
  enrollment,
  authority,
  thought_v2: {
    strand_id: STRAND, kind, plaintext_utf8: "a test thought",
    aes_256_gcm: { key: "k_master from derivation", nonce_hex: hex(THOUGHT_NONCE), ciphertext_with_tag_b64: ciphertext_b64 },
    request_body_fields: { ciphertext: ciphertext_b64, nonce: nonce_b64, kind, signing_key_id: OP_KID, signature: thoughtSig },
    canonical_v2_hex: hex(v2api),
    canonical_v1_hex: hex(v1api),
    signature_b64: thoughtSig,
    signer_public_key_b64: OP_PUB,
  },
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ passed: out.checks_passed, failed: failed }, null, 1));
process.exit(failed.length ? 1 : 0);
