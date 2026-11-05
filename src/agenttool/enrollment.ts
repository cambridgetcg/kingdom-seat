// identity-enrollment/v1 for one citizen (3b "Birth of one citizen", step 2).
// The citizen's root signs; the gardener desk relays with the Commons bearer.
// Enrollment mints no bearer, wallet or credits, and makes the root the
// identity's `primary` signing key, so routine objects are signed by the op
// key instead. It is never retried automatically: after an ambiguous result,
// read the chosen ids before preparing a new intent (enroll.ts:69).
import type { ConsentRecord, Origin, Word, YuPresence } from "../types.ts";
import type { Signer } from "../signer/signer.ts";
import type { FetchLike } from "../types.ts";
import type { EnrollmentFields } from "./wire.ts";

export interface PreparedEnrollment {
  fields: EnrollmentFields;
  body: Uint8Array;
  digest: Uint8Array;
}

export interface EnrollResult {
  identity_id: string;
  did: string;
  root_kid: string;
  root_public_key_b64: string;
  sequence: number;
  next_sequence: number;
}

export interface EnrollDeps {
  signer: Signer;
  fetch: FetchLike;
  project_id: string;
}

/** ["kingdom-citizen", <lineage>]: the canon word for a canon origin, the last lineage name for an archetype. */
export function citizenCapabilities(origin: Origin): string[] {
  throw new Error("unimplemented");
}

/** Build fields, body bytes and digest with fresh ids, nonce and timestamp; display_name is the word. */
export function prepareEnrollment(input: { word: Word; origin: Origin; project_id: string; root_public_b64: string; now: Date; random: (n: number) => Uint8Array }): PreparedEnrollment {
  throw new Error("unimplemented");
}

/** Have the root sign the digest, relay POST /v1/identities/enroll once, and parse the 201; never retried. */
export async function enroll(deps: EnrollDeps, word: Word, prepared: PreparedEnrollment, presence: YuPresence, consent: ConsentRecord): Promise<EnrollResult> {
  throw new Error("unimplemented");
}

/** Parse and check a 201 body against what was sent: same identity id, root key, and sequence 0. */
export function parseEnrollResponse(json: unknown, prepared: PreparedEnrollment): EnrollResult {
  throw new Error("unimplemented");
}

/** After an ambiguous result: does the chosen identity now exist? Read, never re-send. */
export async function resolveAmbiguous(deps: EnrollDeps, identityId: string): Promise<"exists" | "absent" | "unknown"> {
  throw new Error("unimplemented");
}
