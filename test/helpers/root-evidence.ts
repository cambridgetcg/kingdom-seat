// Root evidence for test ledgers: a keys/import or key revoke request signed
// with the published test root (vectors.json), built with the same wire
// functions the signer uses. No real identity is named.
import { AUTHORITY_HEADERS, authorityDigest, authorityHeaders, jsonBody } from "../../src/agenttool/wire.ts";
import { edSign, fromHex, toB64 } from "../../src/crypto.ts";
import type { CitizenIdentity, RootEvidence } from "../../src/types.ts";
import { TEST_ROOT_SEED_HEX } from "./vectors.ts";

export interface EvidenceOptions {
  sequence?: number;
  timestamp?: string;
  /** The key that signs; the test root by default. Another seed makes evidence the root never gave. */
  rootSeed?: Uint8Array;
}

function signed(identity: Pick<CitizenIdentity, "did">, method: string, target: string, body: Uint8Array, o: EvidenceOptions): RootEvidence {
  const sequence = o.sequence ?? 1;
  const timestamp = o.timestamp ?? "2026-11-05T01:00:00.000Z";
  const digest = authorityDigest({ did: identity.did, method, target, body, sequence, timestamp });
  const h = authorityHeaders(sequence, timestamp, edSign(digest, o.rootSeed ?? fromHex(TEST_ROOT_SEED_HEX)));
  return {
    method,
    target,
    body_b64: toB64(body),
    headers: {
      [AUTHORITY_HEADERS.sequence]: h[AUTHORITY_HEADERS.sequence]!,
      [AUTHORITY_HEADERS.timestamp]: h[AUTHORITY_HEADERS.timestamp]!,
      [AUTHORITY_HEADERS.signature]: h[AUTHORITY_HEADERS.signature]!,
    },
  };
}

/** The root-signed POST keys/import that installs `publicKeyB64`, as the signer would have sent it. */
export function importEvidence(identity: Pick<CitizenIdentity, "did" | "identity_id">, publicKeyB64: string, o: EvidenceOptions = {}): RootEvidence {
  return signed(identity, "POST", `/v1/identities/${identity.identity_id}/keys/import`, jsonBody({ public_key: publicKeyB64, label: "op-2026-11" }), o);
}

/** The root-signed DELETE that revokes `kid`. */
export function revokeEvidence(identity: Pick<CitizenIdentity, "did" | "identity_id">, kid: string, o: EvidenceOptions = {}): RootEvidence {
  return signed(identity, "DELETE", `/v1/identities/${identity.identity_id}/keys/${kid}`, new Uint8Array(), o);
}
