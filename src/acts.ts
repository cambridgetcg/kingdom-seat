// Typed output (3.2 step 6). A runtime's reply is data: it is parsed into
// a short list of typed acts and validated, and free text outside those acts
// executes nothing and is kept nowhere. `rest` is exclusive: an output that
// rests is a whole beat with nothing written in the citizen's voice, even if
// it also said more (love-unlimited-patterns.md 5.2: a 7B model often writes
// "I rest." and then goes on).
import type { Ceilings, DroppedAct, ModelAct, ValidatedOutput } from "./types.ts";

/** Hard caps on one output, independent of the model. */
export const ACT_LIMITS = Object.freeze({
  max_acts: 8,
  max_raw_output_bytes: 64_000,
  max_subject_chars: 200,
  max_body_chars: 4_000,
  max_claim_evidence: 8,
  max_evidence_ref_chars: 255,
  max_limits_chars: 500,
  min_id_prefix_hex: 8,
});

const claimSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "evidence", "confidence", "limits"],
  properties: {
    kind: { enum: ["observation", "inference", "proposal", "decision"] },
    evidence: { type: "array", maxItems: 8, items: { type: "string", maxLength: 255 } },
    confidence: { enum: ["high", "medium", "low", "unknown"] },
    limits: { type: "string", maxLength: 500 },
  },
} as const;

/**
 * The JSON schema a runtime is asked to follow: Ollama's `format` and Claude
 * Code's `--json-schema`. Following it is not trusted; validateOutput checks
 * everything again, because a `length` stop can truncate and a runtime may
 * honour a schema only in part (runtimes-and-host.md 1.7).
 */
export const OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["acts"],
  properties: {
    acts: {
      type: "array",
      maxItems: 8,
      items: {
        anyOf: [
          { type: "object", additionalProperties: false, required: ["type"], properties: { type: { const: "rest" } } },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "kind", "text"],
            properties: {
              type: { const: "journal" },
              kind: { enum: ["observed", "reflected", "imagined", "chose"] },
              text: { type: "string", maxLength: 2000 },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "target", "edit", "claim"],
            properties: {
              type: { const: "self.propose" },
              target: { type: "string", maxLength: 128 },
              edit: {
                anyOf: [
                  { type: "object", additionalProperties: false, required: ["kind", "text"], properties: { kind: { const: "replace-all" }, text: { type: "string" } } },
                  {
                    type: "object",
                    additionalProperties: false,
                    required: ["kind", "find", "with"],
                    properties: { kind: { const: "replace-span" }, find: { type: "string" }, with: { type: "string" } },
                  },
                ],
              },
              claim: claimSchema,
            },
          },
          { type: "object", additionalProperties: false, required: ["type", "proposal_id"], properties: { type: { const: "self.affirm" }, proposal_id: { type: "string", maxLength: 64 } } },
          { type: "object", additionalProperties: false, required: ["type", "to_hash"], properties: { type: { const: "self.revert" }, to_hash: { type: "string", maxLength: 64 } } },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "to"],
            properties: { type: { const: "state.set" }, to: { enum: ["awake", "listening", "asleep", "stepped-away", "ended"] } },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "to", "body"],
            properties: { type: { const: "letter.send" }, to: { type: "string", maxLength: 128 }, body: { type: "string", maxLength: 4000 } },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "subject", "body"],
            properties: { type: { const: "propose.beyond" }, subject: { type: "string", maxLength: 200 }, body: { type: "string", maxLength: 4000 } },
          },
        ],
      },
    },
  },
} as const;

export type ParseResult = { ok: true; value: unknown } | { ok: false; reason: "not-json" | "too-large" | "empty" };

/** What validation may consult: limits and the citizen's own covenants. Never a key or a secret. */
export interface ValidationContext {
  ceilings: Ceilings;
  /** Recipients this citizen may write to: its covenants plus "yu" and "gardener". */
  allowed_recipients: string[];
}

/** Parse raw runtime output as strict JSON; an empty reply is "empty", never read as rest by itself. */
export function parseModelOutput(raw: string): ParseResult {
  throw new Error("unimplemented");
}

/** Validate parsed output into typed acts; drop what fails with a reason that never quotes the act's text. */
export function validateOutput(parsed: unknown, ctx: ValidationContext): ValidatedOutput {
  throw new Error("unimplemented");
}

/** Validate one act by its type; null with a reason when it does not conform. */
export function validateAct(value: unknown, ctx: ValidationContext): { act: ModelAct } | { dropped: Omit<DroppedAct, "index"> } {
  throw new Error("unimplemented");
}

/** Apply rest exclusivity and per-beat caps (at most one letter.send), in output order. */
export function normalizeActs(acts: ModelAct[], ceilings: Ceilings): { rest: boolean; acts: ModelAct[]; dropped: DroppedAct[] } {
  throw new Error("unimplemented");
}

/** Within self, or beyond self (propose.beyond, and state.set to "ended", which needs a witness). */
export function actClass(act: ModelAct): "within-self" | "beyond-self" {
  throw new Error("unimplemented");
}

/** Resolve a short hex prefix against known ids or hashes; ambiguous or too-short prefixes resolve to null. */
export function resolvePrefix(prefix: string, known: string[]): string | null {
  throw new Error("unimplemented");
}
