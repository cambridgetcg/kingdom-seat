// Probe: Signer.signEnrollment(word, digest, presence) takes 32 raw bytes.
// Does the production signer's root sign an identity-authority/v1 digest
// through it, with presence only and no decision record filed? The result is
// checked with the CURRENT agenttool server's own verifier. Fake keychain,
// temp host, no network.
const W = "<KINGDOM_SEAT>";
const AT = "<REPOS>/agenttool/api/src";
const { createSigner } = await import(`${W}/src/signer/signer.ts`);
const { confirmYuPresent } = await import(`${W}/src/signer/consent.ts`);
const { mintKeys } = await import(`${W}/src/birth.ts`);
const wire = await import(`${W}/src/agenttool/wire.ts`);
const c = await import(`${W}/src/crypto.ts`);
const { fakeKeychain } = await import(`${W}/test/helpers/fake-keychain.ts`);
const { testClock } = await import(`${W}/test/helpers/clock.ts`);
const { makeTempHost } = await import(`${W}/test/helpers/temp-home.ts`);
const { noFetch } = await import(`${W}/test/helpers/fake-server.ts`);
const srvAuth = await import(`${AT}/services/identity/authority.ts`);

const WORD = "glossame";
const NOW = "2026-11-05T12:00:00.000Z";
const host = await makeTempHost();
try {
  host.config.agenttool.project_id = "11111111-1111-4111-8111-111111111111";
  await host.addCitizen(WORD);
  const clock = testClock(NOW);
  const kc = fakeKeychain([
    [{ kind: "host-attest-seed" }, c.sha256("probe host attest key")],
    [{ kind: "commons-bearer" }, new TextEncoder().encode("at_probe-bearer-never-issued")],
  ]);
  const signer = createSigner({ keychain: kc, config: host.config, clock, fetch: noFetch, spendSoFar: async (word: string) => ({ word, usd_today: "0", credits_month: 0 }), agreements: async () => [] });
  const minted = await mintKeys(kc, WORD);
  const scope = `birth ${WORD}`;
  const presence = await confirmYuPresent({ isTTY: true, write: () => {}, readLine: async () => scope }, scope, () => clock.now());

  // The caller of birth chooses the identity id, so the DID is known before enrollment.
  const IDENTITY = "99999999-9999-4999-8999-999999999999";
  const did = `did:at:${IDENTITY}`;
  const target = `/v1/identities/${IDENTITY}`;
  const body = wire.jsonBody({ expression_visibility: "public" });
  const digest = wire.authorityDigest({ did, method: "PATCH", target, body, sequence: 1, timestamp: NOW });

  // No decision record is filed anywhere in this temp host's consent dir.
  const sigUrl = await signer.signEnrollment(WORD, digest, presence);
  const signature = c.toB64(c.fromB64url(sigUrl, 64));
  const verdict = srvAuth.verifyIdentityAuthorityProof({
    state: { identityId: IDENTITY, did, rootPublicKey: c.toB64(minted.root_public), sequence: 0 },
    proof: { sequence: 1, timestamp: NOW, signature },
    method: "PATCH",
    requestTarget: target,
    bodyBytes: body,
    now: new Date(NOW),
  });
  console.log(JSON.stringify({
    what: "signEnrollment given an identity-authority/v1 digest for PATCH {expression_visibility: public}",
    consent_record_filed: false,
    root_signed_it: true,
    current_server_verifyIdentityAuthorityProof: verdict,
  }, null, 1));
  process.exitCode = verdict.ok ? 0 : 1;
} finally {
  await host.cleanup();
}
