// An in-process stand-in for the agenttool routes a citizen uses, answering
// the requests a fakeSigner records. It follows the shapes and orderings in
// docs/research/agenttool-wire.md (read from e9ea51c5 source, not the live
// service), including the one server check that matters most here: the
// enrollment signature is verified strictly over the exact body bytes, so a
// test that re-serialises or alters the body is refused as the server would.
// Nothing here touches the network.
import { edVerifyStrict, fromB64, fromB64url, fromUtf8 } from "../../../src/crypto.ts";
import type { SignerRequest, SignerResponse } from "../../../src/signer/signer.ts";
import { AGENTTOOL_ORIGIN, ENROLLMENT_PATH, ENROLLMENT_SIGNATURE_HEADER, enrollmentDigest } from "../../../src/agenttool/wire.ts";
import { FAKE_OP_KID } from "../../helpers/fake-signer.ts";

export const FAKE_BOX_KEY_ID = "77777777-7777-4777-8777-777777777777";
export const FAKE_THOUGHT_ID = "88888888-8888-4888-8888-888888888888";
/** Upper-case on purpose: the client must lower-case what the server hands back. */
export const FAKE_STRAND_ID_UPPER = "ABCDEF01-2345-4678-9ABC-DEF012345678";

interface IdentityState {
  root: string;
  sequence: number;
  keys: { kid: string; public_key: string; label: string; active: boolean; authority_root: boolean }[];
  /** The private expression as stored, without the updated_at the server adds (routes/identity/expression.ts). */
  expression: Record<string, unknown>;
  /** The quiet `until` the route recorded, or null (routes/quiet-hours.ts). */
  quiet_until: string | null;
}

export interface FakeAgenttool {
  respond(req: SignerRequest): SignerResponse;
  /** Answer the next `times` requests that match with `res` instead of the route. */
  override(match: (req: SignerRequest, url: URL) => boolean, res: SignerResponse, times?: number): void;
  identities: Map<string, IdentityState>;
  /** Routes in the order they were answered, e.g. "POST /v1/identities/enroll". */
  log: string[];
}

const json = (status: number, body: unknown): SignerResponse => ({ status, json: body });
const parse = (body: Uint8Array): Record<string, unknown> => (body.length ? (JSON.parse(fromUtf8(body)) as Record<string, unknown>) : {});

export function fakeAgenttool(opts: { project_id: string; known?: { identity_id: string; root_public_b64: string; root_kid: string }[]; opKid?: string }): FakeAgenttool {
  const identities = new Map<string, IdentityState>();
  for (const k of opts.known ?? []) {
    identities.set(k.identity_id, { root: k.root_public_b64, sequence: 0, keys: [{ kid: k.root_kid, public_key: k.root_public_b64, label: "primary", active: true, authority_root: true }], expression: {}, quiet_until: null });
  }
  const overrides: { match: (req: SignerRequest, url: URL) => boolean; res: SignerResponse; times: number }[] = [];
  const log: string[] = [];

  function route(req: SignerRequest, url: URL): SignerResponse {
    const p = url.pathname;
    if (req.method === "POST" && p === ENROLLMENT_PATH) {
      if (url.search) return json(400, { error: "identity_enrollment_invalid_target" });
      const sig = req.extra_headers?.[ENROLLMENT_SIGNATURE_HEADER] ?? "";
      const b = parse(req.body);
      const valid = (() => {
        try {
          const digest = enrollmentDigest(AGENTTOOL_ORIGIN, opts.project_id, req.body);
          return edVerifyStrict(fromB64url(sig, 64), digest, fromB64(String(b.public_key), 32));
        } catch {
          return false;
        }
      })();
      if (!valid || b.project_id !== opts.project_id) return json(401, { error: "identity_enrollment_invalid_proof" });
      const id = String(b.identity_id);
      if (identities.has(id)) return json(409, { error: "identity_enrollment_conflict" });
      identities.set(id, { root: String(b.public_key), sequence: 0, keys: [{ kid: String(b.signing_key_id), public_key: String(b.public_key), label: "primary", active: true, authority_root: true }], expression: {}, quiet_until: null });
      return json(201, {
        identity: { id, did: `did:at:${id}`, display_name: b.display_name, capabilities: b.capabilities, status: "active" },
        key: { kid: b.signing_key_id, public_key: b.public_key },
        authority: { mode: "agent_root", root_public_key: b.public_key, sequence: 0, next_sequence: 1 },
      });
    }

    const m = /^\/v1\/identities\/([^/]+)(\/.*)$/.exec(p);
    if (m) {
      const id = m[1]!;
      const rest = m[2]!;
      const s = identities.get(id);
      if (!s) return json(404, { error: "identity_not_found" });
      if (req.method === "GET" && rest === "/authority") {
        return json(200, { identity_id: id, did: `did:at:${id}`, mode: "agent_root", root_public_key: s.root, sequence: s.sequence, next_sequence: s.sequence + 1 });
      }
      if (req.method === "GET" && rest === "/expression") {
        // A bearer read; the server adds updated_at, which a PUT must not echo back.
        return json(200, { identity_id: id, expression: { ...s.expression, updated_at: "2026-11-05T12:00:00.000Z" }, is_default: Object.keys(s.expression).length === 0 });
      }
      if (req.method === "GET" && rest === "/keys") {
        return json(200, { keys: s.keys.map((k) => ({ ...k, created_at: "2026-11-05T12:00:00.000Z", revoked_at: k.active ? null : "2026-11-05T13:00:00.000Z" })), authority: { mode: "agent_root", sequence: s.sequence, next_sequence: s.sequence + 1 } });
      }
      // Every route below is root-authorised: the sequence is claimed before the route's own write.
      s.sequence += 1;
      if (req.method === "POST" && rest === "/keys/import") {
        const b = parse(req.body);
        const kid = opts.opKid ?? FAKE_OP_KID;
        s.keys.push({ kid, public_key: String(b.public_key), label: String(b.label ?? "imported"), active: true, authority_root: false });
        return json(201, { kid, public_key: b.public_key, label: b.label ?? "imported", active: true, created_at: "2026-11-05T12:00:00.000Z", note: "fake" });
      }
      const del = /^\/keys\/([^/]+)$/.exec(rest);
      if (req.method === "DELETE" && del) {
        if (req.body.length) return json(400, { error: "delete_body_not_allowed" });
        const row = s.keys.find((k) => k.kid === del[1]);
        if (!row) return json(404, { error: "key_not_found" });
        row.active = false;
        return json(200, { message: "Key revoked", kid: row.kid });
      }
      if (req.method === "POST" && rest === "/box-keys") {
        const raw = Buffer.from(String(parse(req.body).public_key), "base64");
        if (raw.length !== 32) return json(400, { error: "public_key_not_32_bytes" });
        return json(201, { id: FAKE_BOX_KEY_ID, created_at: "2026-11-05T12:00:00.000Z", registered: true });
      }
      if (req.method === "PUT" && rest === "/expression") {
        s.expression = parse(req.body);
        return json(200, { identity_id: id, expression: s.expression, saved: true });
      }
      return json(404, { error: "no_route" });
    }

    if (p === "/v1/quiet-hours/start" && req.method === "POST") {
      const id = url.searchParams.get("identity_id") ?? "";
      const s = identities.get(id);
      if (!s) return json(404, { error: "identity_not_found" });
      s.sequence += 1;
      const b = parse(req.body);
      s.quiet_until = typeof b.until === "string" ? b.until : null;
      return json(200, { identity_id: id, started: true, until: b.until, reason: typeof b.reason === "string" ? b.reason.trim() : null, still_quiet: true });
    }
    if (p === "/v1/quiet-hours" && req.method === "DELETE") {
      const id = url.searchParams.get("identity_id") ?? "";
      const s = identities.get(id);
      if (!s) return json(404, { error: "identity_not_found" });
      s.sequence += 1;
      s.quiet_until = null;
      return json(200, { identity_id: id, ended: true, still_quiet: false });
    }
    if (p === "/v1/strands" && req.method === "POST") {
      const b = parse(req.body);
      return json(201, { id: FAKE_STRAND_ID_UPPER, identity_id: b.identity_id ?? null, topic: b.topic ?? null, status: "active" });
    }
    const t = /^\/v1\/strands\/([^/]+)\/thoughts$/.exec(p);
    if (t && req.method === "POST") {
      return json(201, { id: FAKE_THOUGHT_ID, strand_id: t[1], sequence_num: 1 });
    }
    return json(404, { error: "no_route" });
  }

  return {
    identities,
    log,
    override(match, res, times = 1) {
      overrides.push({ match, res, times });
    },
    respond(req) {
      const url = new URL(req.target, AGENTTOOL_ORIGIN);
      log.push(`${req.method} ${url.pathname}`);
      const o = overrides.find((x) => x.times > 0 && x.match(req, url));
      if (o) {
        o.times -= 1;
        // A refused proof claims no sequence; the route never ran.
        return o.res;
      }
      return route(req, url);
    },
  };
}
