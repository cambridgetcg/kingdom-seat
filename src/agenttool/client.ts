// agenttool calls a citizen makes as itself (3.4), all through the signer so
// the bearer and root never leave it. One root-authorised request in flight
// per identity, awaiting each response before signing the next, because the
// sequence is the replay wall and a valid proof is spent even if the route's
// own write then fails (agenttool-wire.md section 2). Every per-identity
// route names the citizen with ?identity_id=, because an enrolled guest is
// never the project's default actor.
import type { CitizenIdentity, FetchLike, Word } from "../types.ts";
import type { Signer } from "../signer/signer.ts";
import type { Expression } from "./wire.ts";

export interface ClientDeps {
  signer: Signer;
  /** Used only for unauthenticated public reads; everything else goes through signer.send. */
  fetch: FetchLike;
  identity(word: Word): Promise<CitizenIdentity>;
}

export class AgenttoolError extends Error {
  override readonly name = "AgenttoolError";
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

/** The public profile fields a beacon reader and an existence check need (agents.ts:109-136). */
export interface PublicAgent {
  did: string;
  name: string | null;
  status: "active" | "revoked" | "memorial";
  quiet_until: string | null;
  quiet_reason: string | null;
}

export interface KeyRow {
  kid: string;
  public_key: string;
  label: string;
  active: boolean;
  created_at: string;
  revoked_at: string | null;
  authority_root: boolean;
}

/** GET /v1/identities/:id/authority: the current and next sequence, read before any root act and after an uncertain one. */
export async function readAuthority(deps: ClientDeps, word: Word): Promise<{ sequence: number; next_sequence: number }> {
  throw new Error("unimplemented");
}

/** GET /v1/identities/:id/keys: the key rows, for verifying envelopes against the op key. */
export async function listKeys(deps: ClientDeps, word: Word): Promise<KeyRow[]> {
  throw new Error("unimplemented");
}

/** Root-signed POST keys/import of the op key; the kid comes back from the server. */
export async function importOpKey(deps: ClientDeps, word: Word, publicKeyB64: string, label: string): Promise<{ kid: string }> {
  throw new Error("unimplemented");
}

/** Root-signed DELETE of an op key during rotation; the root row can never be revoked. */
export async function revokeKey(deps: ClientDeps, word: Word, kid: string): Promise<void> {
  throw new Error("unimplemented");
}

/** Root-signed POST /v1/identities/:id/box-keys, once at birth, after a local 32-byte check. */
export async function registerBoxKey(deps: ClientDeps, word: Word, publicKeyB64: string): Promise<{ id: string }> {
  throw new Error("unimplemented");
}

/** Root-signed PUT of the private expression; validated locally first, since PUT replaces the whole object. */
export async function putExpression(deps: ClientDeps, word: Word, expression: Expression): Promise<void> {
  throw new Error("unimplemented");
}

/** Root-signed quiet start with an explicit `until`; the signer refuses more than 30 days ahead for a citizen. */
export async function startCitizenQuiet(deps: ClientDeps, word: Word, untilIso: string): Promise<{ until: string }> {
  throw new Error("unimplemented");
}

/** Root-signed DELETE of the citizen's own quiet, with an empty body. */
export async function endCitizenQuiet(deps: ClientDeps, word: Word): Promise<void> {
  throw new Error("unimplemented");
}

/** POST /v1/strands bound to the citizen's identity_id (1 credit); a bound strand accepts only its own identity's keys. */
export async function createStrand(deps: ClientDeps, word: Word, topic: string): Promise<{ strand_id: string }> {
  throw new Error("unimplemented");
}

/** POST a v2-signed thought (1 credit, charged before verification), sealed by the signer. */
export async function postThought(deps: ClientDeps, word: Word, strandId: string, plaintext: string, kind: string): Promise<{ thought_id: string }> {
  throw new Error("unimplemented");
}

/** Unauthenticated GET /public/agents/:did through deps.fetch; parses only the fields PublicAgent names. */
export async function readPublicAgent(deps: Pick<ClientDeps, "fetch">, did: string): Promise<PublicAgent> {
  throw new Error("unimplemented");
}
