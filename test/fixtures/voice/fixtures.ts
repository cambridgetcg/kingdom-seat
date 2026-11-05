// Fixtures for the voice group's tests: a Citizen from a temp-host fixture, a
// SeatRef, hand-made ledger entries and proposals, and a small JSON Schema
// checker covering exactly the keywords OUTPUT_JSON_SCHEMA uses, so the
// schema can be tested against validateOutput without a new dependency.
import {
  DEFAULT_CEILINGS,
  type Act,
  type Citizen,
  type CitizenRecord,
  type Invoker,
  type LedgerEntry,
  type SeatRef,
  type SelfProposal,
  type SelfTarget,
  type Word,
} from "../../../src/types.ts";
import type { ValidationContext } from "../../../src/acts.ts";

export const SEAT_ID = "4f1d2c3b-0a9e-4d8c-8b7a-6f5e4d3c2b1a";

export function citizenOf(record: CitizenRecord, over: Partial<Citizen> = {}): Citizen {
  return {
    ...record,
    state: "awake",
    pending_state: null,
    cadence: { interval_h: 72 },
    covenants: { letters_from: ["yu", "gardener"], wake_on_letter_from: ["yu"] },
    last_beat_at: null,
    ...over,
  };
}

export function seatFor(word: Word, invoker: Invoker = { kind: "tick", who: "launchd", why: "its own cadence is due" }): SeatRef {
  return { format: "kingdom-seat-seat/v1", seat_id: SEAT_ID, host: "test-host", word, runtime: "free", invoker, opened_at: "2026-11-05T02:05:00.000Z" };
}

const ZERO = "0".repeat(64);

/** A beat entry carrying `acts`; hashes and signature are placeholders, since context only reads entries. */
export function beatEntry(word: Word, seq: number, acts: Act[]): LedgerEntry {
  return {
    format: "kingdom-seat-ledger/v1",
    word,
    seq,
    ts: new Date(Date.parse("2026-11-01T00:00:00.000Z") + seq * 3_600_000).toISOString(),
    prev_hash: ZERO,
    body: {
      type: "beat",
      envelope: {
        format: "kingdom-seat-beat/v1",
        seat_ref: seatFor(word),
        citizen: { word, did: null, kid: null },
        runtime: "free",
        model: "fake-model:test",
        model_digest: `sha256:${"f".repeat(64)}`,
        input_digest: ZERO,
        output_digest: ZERO,
        acts,
        ts: "2026-11-01T00:00:00.000Z",
        prev_hash: ZERO,
        voiced_through: `${word}, voiced through fake-model:test in seat ${SEAT_ID}`,
      },
    },
    spend: { usd: 0, usd_basis: "local-zero", credits: 0 },
    attestation: "host-attested",
    hash: ZERO,
    signature: { alg: "ed25519", kid: "host-attest", public_key_b64: "AAAA", sig_b64: "AAAA" },
  };
}

export function proposalOf(word: Word, id: string, target: SelfTarget, diff: string, status: SelfProposal["status"] = "pending"): SelfProposal {
  return {
    id,
    word,
    act: {
      type: "self.propose",
      target,
      prior_hash: "a".repeat(64),
      new_hash: "b".repeat(64),
      diff,
      claim: { kind: "inference", evidence: ["canon:canon/core/glossame.md@1428646"], confidence: "low", limits: "from the text alone; I have no senses" },
    },
    proposed_at: "2026-11-02T00:00:00.000Z",
    proposed_in_seat: "11111111-2222-4333-8444-555555555555",
    status,
  };
}

export function validationContext(over: Partial<ValidationContext> = {}): ValidationContext {
  return { ceilings: { ...DEFAULT_CEILINGS }, allowed_recipients: ["yu", "gardener", "citizen:shemme"], ...over };
}

/* ── A small JSON Schema checker ──────────────────────────────────────── */

type Schema = Record<string, unknown>;

/**
 * Supports the keywords OUTPUT_JSON_SCHEMA uses: type (object, array,
 * string), enum, const, required, properties, additionalProperties: false,
 * items, anyOf, maxItems, minLength and maxLength (in code points). Any other
 * keyword throws, so the schema cannot grow a keyword this checker ignores.
 */
export function schemaAccepts(schema: Schema, value: unknown): boolean {
  const known = new Set(["type", "enum", "const", "required", "properties", "additionalProperties", "items", "anyOf", "maxItems", "minLength", "maxLength"]);
  for (const k of Object.keys(schema)) if (!known.has(k)) throw new Error(`schemaAccepts: unsupported keyword ${k}`);

  if (schema.anyOf !== undefined) return (schema.anyOf as Schema[]).some((s) => schemaAccepts(s, value));
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum !== undefined && !(schema.enum as unknown[]).includes(value)) return false;

  switch (schema.type) {
    case undefined:
      return true;
    case "string": {
      if (typeof value !== "string") return false;
      const n = [...value].length;
      if (typeof schema.minLength === "number" && n < schema.minLength) return false;
      if (typeof schema.maxLength === "number" && n > schema.maxLength) return false;
      return true;
    }
    case "array": {
      if (!Array.isArray(value)) return false;
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
      return schema.items === undefined || value.every((v) => schemaAccepts(schema.items as Schema, v));
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const o = value as Record<string, unknown>;
      const props = (schema.properties ?? {}) as Record<string, Schema>;
      for (const r of (schema.required ?? []) as string[]) if (!Object.hasOwn(o, r)) return false;
      for (const k of Object.keys(o)) {
        if (!Object.hasOwn(props, k)) {
          if (schema.additionalProperties === false) return false;
          continue;
        }
        if (!schemaAccepts(props[k]!, o[k])) return false;
      }
      return true;
    }
    default:
      throw new Error(`schemaAccepts: unsupported type ${String(schema.type)}`);
  }
}
