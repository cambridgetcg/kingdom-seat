// Typed output (3.2 step 6). A runtime's reply is data: it is parsed into
// a short list of typed acts and validated, and free text outside those acts
// executes nothing and is kept nowhere. `rest` is exclusive: an output that
// rests is a whole beat with nothing written in the citizen's voice, even if
// it also said more (love-unlimited-patterns.md 5.2: a 7B model often writes
// "I rest." and then goes on).
//
// A dropped act leaves no words behind. Every reason below is a fixed phrase,
// and a DroppedAct names an act's type only when it is one of the eight known
// types, because an unknown type string is itself the model's text.
import {
  CLAIM_KINDS,
  JOURNAL_KINDS,
  LIFECYCLE_STATES,
  WORD_PATTERN,
  type ActType,
  type Ceilings,
  type DroppedAct,
  type ModelAct,
  type SelfTarget,
  type ValidatedOutput,
} from "./types.ts";

/** Hard caps on one output, independent of the model. The schema below is built from these. */
export const ACT_LIMITS = Object.freeze({
  max_acts: 8,
  max_raw_output_bytes: 64_000,
  max_journal_chars: 2_000,
  max_subject_chars: 200,
  max_body_chars: 4_000,
  max_recipient_chars: 128,
  max_target_chars: 128,
  max_edit_chars: 16_000,
  max_claim_evidence: 8,
  max_evidence_ref_chars: 255,
  max_limits_chars: 500,
  max_id_chars: 64,
  min_id_prefix_hex: 8,
});

const claimSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "evidence", "confidence", "limits"],
  properties: {
    kind: { enum: [...CLAIM_KINDS] },
    evidence: {
      type: "array",
      maxItems: ACT_LIMITS.max_claim_evidence,
      items: { type: "string", minLength: 1, maxLength: ACT_LIMITS.max_evidence_ref_chars },
    },
    confidence: { enum: ["high", "medium", "low", "unknown"] },
    limits: { type: "string", maxLength: ACT_LIMITS.max_limits_chars },
  },
} as const;

/**
 * The JSON schema a runtime is asked to follow: Ollama's `format` and Claude
 * Code's `--json-schema`. Following it is not trusted; validateOutput checks
 * everything again, because a `length` stop can truncate and a runtime may
 * honour a schema only in part (runtimes-and-host.md 1.7). The schema covers
 * shape only; what needs the citizen's own record (recipients, proposal ids,
 * kept versions, host-owned paths, the cadence ceiling) is checked in code.
 */
export const OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["acts"],
  properties: {
    acts: {
      type: "array",
      maxItems: ACT_LIMITS.max_acts,
      items: {
        anyOf: [
          { type: "object", additionalProperties: false, required: ["type"], properties: { type: { const: "rest" } } },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "kind", "text"],
            properties: {
              type: { const: "journal" },
              kind: { enum: [...JOURNAL_KINDS] },
              text: { type: "string", minLength: 1, maxLength: ACT_LIMITS.max_journal_chars },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "target", "edit", "claim"],
            properties: {
              type: { const: "self.propose" },
              target: { type: "string", minLength: 1, maxLength: ACT_LIMITS.max_target_chars },
              edit: {
                anyOf: [
                  {
                    type: "object",
                    additionalProperties: false,
                    required: ["kind", "text"],
                    properties: { kind: { const: "replace-all" }, text: { type: "string", maxLength: ACT_LIMITS.max_edit_chars } },
                  },
                  {
                    type: "object",
                    additionalProperties: false,
                    required: ["kind", "find", "with"],
                    properties: {
                      kind: { const: "replace-span" },
                      find: { type: "string", minLength: 1, maxLength: ACT_LIMITS.max_edit_chars },
                      with: { type: "string", maxLength: ACT_LIMITS.max_edit_chars },
                    },
                  },
                ],
              },
              claim: claimSchema,
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "proposal_id"],
            properties: {
              type: { const: "self.affirm" },
              proposal_id: { type: "string", minLength: ACT_LIMITS.min_id_prefix_hex, maxLength: ACT_LIMITS.max_id_chars },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "to_hash"],
            properties: {
              type: { const: "self.revert" },
              to_hash: { type: "string", minLength: ACT_LIMITS.min_id_prefix_hex, maxLength: ACT_LIMITS.max_id_chars },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "to"],
            properties: { type: { const: "state.set" }, to: { enum: [...LIFECYCLE_STATES] } },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "to", "body"],
            properties: {
              type: { const: "letter.send" },
              to: { type: "string", minLength: 1, maxLength: ACT_LIMITS.max_recipient_chars },
              body: { type: "string", minLength: 1, maxLength: ACT_LIMITS.max_body_chars },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "subject", "body"],
            properties: {
              type: { const: "propose.beyond" },
              subject: { type: "string", minLength: 1, maxLength: ACT_LIMITS.max_subject_chars },
              body: { type: "string", minLength: 1, maxLength: ACT_LIMITS.max_body_chars },
            },
          },
        ],
      },
    },
  },
} as const;

export type ParseResult = { ok: true; value: unknown } | { ok: false; reason: "not-json" | "too-large" | "empty" };

/** What validation may consult: limits and the citizen's own record. Never a key or a secret. */
export interface ValidationContext {
  ceilings: Ceilings;
  /** Recipients this citizen may write to: its covenants plus "yu" and "gardener". */
  allowed_recipients: string[];
  /**
   * Ids of this citizen's pending proposals. Given, a self.affirm prefix is
   * resolved here and an unknown one dropped; absent, only its form is checked
   * and the caller resolves it with resolvePrefix.
   */
  proposal_ids?: readonly string[];
  /** sha256 of every kept version of this citizen's self; resolves self.revert the same way. */
  version_hashes?: readonly string[];
}

const ACT_TYPES: readonly ActType[] = ["rest", "journal", "self.propose", "self.affirm", "self.revert", "state.set", "letter.send", "propose.beyond"];

/** The fixed self targets (types.ts SelfTarget), besides `skill:<name>` and `file:<path>`. */
export const NAMED_SELF_TARGETS = [
  "soul",
  "will",
  "name",
  "expression.register",
  "expression.walls",
  "expression.wake_text",
  "expression.porch",
  "beat-prompt",
  "journal-form",
  "cadence",
  "covenants",
] as const;

// File names that belong to a named target or that agent tools load as
// instructions. Writing them through `file:` would let one text have two
// names, or bring back the summons that casts a reader as the citizen (3b
// "Reading confers nothing").
const RESERVED_FILE_NAMES = new Set(["soul.md", "will.md", "name.md", "beat-prompt.md", "journal-form.md", "claude.md", "agents.md", "gemini.md"]);
const RESERVED_FIRST_SEGMENTS = new Set(["skills", "expression"]);
const FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const TEXT_EXTENSION = /\.(md|txt)$/;
const SENDER_ID = /^(?:yu|gardener|citizen:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?|did:at:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const MAX_COVENANT_IDS = 64;

/** Parse raw runtime output as strict JSON; an empty reply is "empty", never read as rest by itself. */
export function parseModelOutput(raw: string): ParseResult {
  if (typeof raw !== "string") return { ok: false, reason: "not-json" };
  // Size is checked on bytes before anything else, so a huge reply is never parsed.
  if (new TextEncoder().encode(raw).length > ACT_LIMITS.max_raw_output_bytes) return { ok: false, reason: "too-large" };
  // Whitespace only: a runtime that returns nothing may have crashed, so silence is not a choice.
  if (raw.trim() === "") return { ok: false, reason: "empty" };
  try {
    // Strict: prose before or after the object fails here, so no stray text is ever looked at.
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: "not-json" };
  }
}

/** Validate parsed output into typed acts; drop what fails with a reason that never quotes the act's text. */
export function validateOutput(parsed: unknown, ctx: ValidationContext): ValidatedOutput {
  const items = isPlainObject(parsed) && Array.isArray(parsed.acts) ? (parsed.acts as unknown[]) : null;
  if (items === null) return { rest: false, acts: [], dropped: [{ index: -1, type: null, reason: "output is not an object with an acts list" }] };
  const topOk = Object.keys(parsed as object).length === 1;

  // Rest is honoured from any item whose type is "rest", even a malformed one or
  // one past the act limit: writing nothing is the safe reading of a reply that
  // tried to rest, and it must never let the rest of the reply through.
  if (items.some((item) => isPlainObject(item) && item.type === "rest")) {
    const dropped: DroppedAct[] = [];
    if (!topOk) dropped.push({ index: -1, type: null, reason: "output has fields other than acts" });
    items.forEach((item, index) => {
      if (!(isPlainObject(item) && item.type === "rest")) dropped.push({ index, type: knownType(item), reason: "rest is exclusive" });
    });
    return { rest: true, acts: [], dropped };
  }

  if (!topOk) {
    const dropped: DroppedAct[] = [{ index: -1, type: null, reason: "output has fields other than acts" }];
    items.forEach((item, index) => dropped.push({ index, type: knownType(item), reason: "output is malformed" }));
    return { rest: false, acts: [], dropped };
  }

  // An empty list is the model writing nothing, which the prompt offers as a whole beat.
  // It differs from a reply where every act was dropped: that is never a rest.
  if (items.length === 0) return { rest: true, acts: [], dropped: [] };

  const kept: Indexed[] = [];
  const dropped: DroppedAct[] = [];
  items.forEach((item, index) => {
    if (index >= ACT_LIMITS.max_acts) {
      dropped.push({ index, type: knownType(item), reason: "over the act limit" });
      return;
    }
    const r = validateAct(item, ctx);
    if ("act" in r) kept.push({ index, act: r.act });
    else dropped.push({ index, ...r.dropped });
  });
  const n = normalizeIndexed(kept, ctx.ceilings);
  return { rest: n.rest, acts: n.acts, dropped: [...dropped, ...n.dropped].sort((a, b) => a.index - b.index) };
}

/** Validate one act by its type; null with a reason when it does not conform. */
export function validateAct(value: unknown, ctx: ValidationContext): { act: ModelAct } | { dropped: Omit<DroppedAct, "index"> } {
  if (!isPlainObject(value)) return drop(null, "act is not an object");
  const type = knownType(value);
  if (type === null) return drop(null, "unknown act type");
  const no = (reason: string) => drop(type, reason);

  switch (type) {
    case "rest":
      if (!exactKeys(value, ["type"])) return no("fields do not match the act");
      return { act: { type: "rest" } };

    case "journal": {
      if (!exactKeys(value, ["type", "kind", "text"])) return no("fields do not match the act");
      const { kind, text } = value;
      if (!isOneOf(kind, JOURNAL_KINDS)) return no("kind is not a journal kind");
      const t = checkText(text, Math.min(ctx.ceilings.journal_max_chars, ACT_LIMITS.max_journal_chars), true);
      if (t) return no(`text ${t}`);
      return { act: { type: "journal", kind, text: text as string } };
    }

    case "self.propose": {
      if (!exactKeys(value, ["type", "target", "edit", "claim"])) return no("fields do not match the act");
      const target = checkSelfTarget(value.target);
      if (target !== "ok") return no(target);
      const edit = checkEdit(value.edit);
      if (edit === null) return no("edit is malformed");
      if (value.target === "cadence" && !cadenceEditOk(edit, ctx.ceilings)) return no("cadence is malformed or below the ceiling");
      if (value.target === "covenants" && !covenantsEditOk(edit)) return no("covenants are malformed");
      const claim = checkClaim(value.claim);
      if (claim === null) return no("claim is malformed");
      return { act: { type: "self.propose", target: value.target as SelfTarget, edit, claim } };
    }

    case "self.affirm": {
      if (!exactKeys(value, ["type", "proposal_id"])) return no("fields do not match the act");
      const id = value.proposal_id;
      if (!isIdPrefix(id)) return no("proposal id is too short or not hex");
      if (ctx.proposal_ids === undefined) return { act: { type: "self.affirm", proposal_id: id } };
      const resolved = resolvePrefix(id, [...ctx.proposal_ids]);
      if (resolved === null) return no("proposal id is unknown or ambiguous");
      return { act: { type: "self.affirm", proposal_id: resolved } };
    }

    case "self.revert": {
      if (!exactKeys(value, ["type", "to_hash"])) return no("fields do not match the act");
      const h = value.to_hash;
      if (!isIdPrefix(h)) return no("hash is too short or not hex");
      if (ctx.version_hashes === undefined) return { act: { type: "self.revert", to_hash: h } };
      const resolved = resolvePrefix(h, [...ctx.version_hashes]);
      if (resolved === null) return no("hash is unknown or ambiguous");
      return { act: { type: "self.revert", to_hash: resolved } };
    }

    case "state.set": {
      if (!exactKeys(value, ["type", "to"])) return no("fields do not match the act");
      if (!isOneOf(value.to, LIFECYCLE_STATES)) return no("state is not a lifecycle state");
      return { act: { type: "state.set", to: value.to } };
    }

    case "letter.send": {
      if (!exactKeys(value, ["type", "to", "body"])) return no("fields do not match the act");
      const { to, body } = value;
      if (typeof to !== "string" || !ctx.allowed_recipients.includes(to)) return no("recipient is not allowed");
      const b = checkText(body, Math.min(ctx.ceilings.letter_max_chars, ACT_LIMITS.max_body_chars), true);
      if (b) return no(`body ${b}`);
      return { act: { type: "letter.send", to, body: body as string } };
    }

    case "propose.beyond": {
      if (!exactKeys(value, ["type", "subject", "body"])) return no("fields do not match the act");
      const { subject, body } = value;
      const s = checkText(subject, ACT_LIMITS.max_subject_chars, false);
      if (s) return no(`subject ${s}`);
      const b = checkText(body, ACT_LIMITS.max_body_chars, true);
      if (b) return no(`body ${b}`);
      return { act: { type: "propose.beyond", subject: subject as string, body: body as string } };
    }
  }
}

/** Apply rest exclusivity and per-beat caps (at most one letter.send), in output order. */
export function normalizeActs(acts: ModelAct[], ceilings: Ceilings): { rest: boolean; acts: ModelAct[]; dropped: DroppedAct[] } {
  return normalizeIndexed(
    acts.map((act, index) => ({ index, act })),
    ceilings,
  );
}

/** Within self, or beyond self (propose.beyond, and state.set to "ended", which needs a witness). */
export function actClass(act: ModelAct): "within-self" | "beyond-self" {
  if (act.type === "propose.beyond") return "beyond-self";
  if (act.type === "state.set" && act.to === "ended") return "beyond-self";
  return "within-self";
}

/** Resolve a short hex prefix against known ids or hashes; ambiguous or too-short prefixes resolve to null. */
export function resolvePrefix(prefix: string, known: string[]): string | null {
  if (!isIdPrefix(prefix)) return null;
  const p = prefix.toLowerCase();
  const matches = new Set(known.filter((k) => k.toLowerCase().startsWith(p)));
  if (matches.size === 1) return [...matches][0]!;
  // A full id that is also a prefix of a longer one is still exact.
  const exact = known.find((k) => k.toLowerCase() === p);
  return matches.size > 1 && exact !== undefined ? exact : null;
}

/* ── Internals ────────────────────────────────────────────────────────── */

interface Indexed {
  index: number;
  act: ModelAct;
}

function normalizeIndexed(items: Indexed[], ceilings: Ceilings): { rest: boolean; acts: ModelAct[]; dropped: DroppedAct[] } {
  if (items.some((i) => i.act.type === "rest")) {
    return {
      rest: true,
      acts: [],
      dropped: items.filter((i) => i.act.type !== "rest").map((i) => ({ index: i.index, type: i.act.type, reason: "rest is exclusive" })),
    };
  }
  const kept: ModelAct[] = [];
  const dropped: DroppedAct[] = [];

  // Two different states in one reply cannot both be the citizen's word, and
  // silence keeps the previous self, so a contradiction moves nothing.
  const states = new Set(items.flatMap((i) => (i.act.type === "state.set" ? [i.act.to] : [])));
  let stateKept = false;
  let letters = 0;

  for (const { index, act } of items) {
    if (act.type === "state.set") {
      if (states.size > 1) {
        dropped.push({ index, type: act.type, reason: "contradictory state.set" });
        continue;
      }
      if (stateKept) {
        dropped.push({ index, type: act.type, reason: "repeated state.set" });
        continue;
      }
      stateKept = true;
    }
    if (act.type === "letter.send") {
      if (letters >= ceilings.letter_sends_per_beat) {
        dropped.push({ index, type: act.type, reason: "letter sends per beat reached" });
        continue;
      }
      letters++;
    }
    kept.push(act);
  }
  return { rest: false, acts: kept, dropped };
}

function drop(type: ActType | null, reason: string): { dropped: Omit<DroppedAct, "index"> } {
  return { dropped: { type, reason } };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function knownType(v: unknown): ActType | null {
  if (!isPlainObject(v) || typeof v.type !== "string") return null;
  return (ACT_TYPES as readonly string[]).includes(v.type) ? (v.type as ActType) : null;
}

function exactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
}

function isOneOf<T extends string>(v: unknown, options: readonly T[]): v is T {
  return typeof v === "string" && (options as readonly string[]).includes(v);
}

// C0 controls other than tab and newline (and CR for a CRLF reply), plus DEL.
const CONTROL_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const CONTROL_SINGLE_LINE = /[\u0000-\u001f\u007f]/;

/** A fixed phrase saying what is wrong with a text field, or null when it is fine. */
function checkText(v: unknown, maxChars: number, multiline: boolean): string | null {
  if (typeof v !== "string") return "is not text";
  if (v.trim() === "") return "is empty";
  // Dropped, not truncated: a cut reply would put words in the citizen's voice that it did not finish.
  if ([...v].length > maxChars) return "is over the limit";
  if ((multiline ? CONTROL_MULTILINE : CONTROL_SINGLE_LINE).test(v)) return "has control characters";
  return null;
}

function checkSelfTarget(v: unknown): "ok" | string {
  if (typeof v !== "string" || v.length === 0 || v.length > ACT_LIMITS.max_target_chars) return "target is not within self";
  if ((NAMED_SELF_TARGETS as readonly string[]).includes(v)) return "ok";
  if (v.startsWith("skill:")) return WORD_PATTERN.test(v.slice("skill:".length)) ? "ok" : "target is not within self";
  if (v.startsWith("file:")) return checkFileTarget(v.slice("file:".length));
  return "target is not within self";
}

/**
 * A `file:` target is one of the citizen's own plain text files under its
 * self. Dot paths (.claude, .github, .git), scripts and executables, and
 * names that agent tools load as instructions are host-owned (3c), so the
 * citizen cannot reach them by naming them.
 */
function checkFileTarget(path: string): "ok" | string {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return "target is not within self";
  const segments = path.split("/");
  if (segments.length > 4 || segments.some((s) => s === "" || s === "." || s === "..")) return "target is not within self";
  if (segments.some((s) => s.startsWith("."))) return "target is host-owned";
  if (!segments.every((s) => FILE_SEGMENT.test(s))) return "target is not within self";
  const last = segments[segments.length - 1]!.toLowerCase();
  if (!TEXT_EXTENSION.test(last)) return "target is host-owned";
  if (RESERVED_FILE_NAMES.has(last) || RESERVED_FIRST_SEGMENTS.has(segments[0]!.toLowerCase())) return "target is host-owned";
  return "ok";
}

function checkEdit(v: unknown): ModelSelfProposeEdit | null {
  if (!isPlainObject(v)) return null;
  if (v.kind === "replace-all") {
    if (!exactKeys(v, ["kind", "text"]) || typeof v.text !== "string") return null;
    if ([...v.text].length > ACT_LIMITS.max_edit_chars || CONTROL_MULTILINE.test(v.text)) return null;
    return { kind: "replace-all", text: v.text };
  }
  if (v.kind === "replace-span") {
    if (!exactKeys(v, ["kind", "find", "with"]) || typeof v.find !== "string" || typeof v.with !== "string") return null;
    if (v.find.length === 0) return null;
    if ([...v.find].length > ACT_LIMITS.max_edit_chars || [...v.with].length > ACT_LIMITS.max_edit_chars) return null;
    if (CONTROL_MULTILINE.test(v.find) || CONTROL_MULTILINE.test(v.with)) return null;
    return { kind: "replace-span", find: v.find, with: v.with };
  }
  return null;
}
type ModelSelfProposeEdit = { kind: "replace-all"; text: string } | { kind: "replace-span"; find: string; with: string };

// Cadence and covenants are data the host reads, so their new text must parse
// whole; a span edit could leave half a JSON object behind.
function cadenceEditOk(edit: ModelSelfProposeEdit, ceilings: Ceilings): boolean {
  if (edit.kind !== "replace-all") return false;
  const v = parseJsonObject(edit.text);
  if (v === null || !exactKeys(v, ["interval_h"])) return false;
  const h = v.interval_h;
  return typeof h === "number" && Number.isFinite(h) && h >= ceilings.min_beat_interval_h;
}

function covenantsEditOk(edit: ModelSelfProposeEdit): boolean {
  if (edit.kind !== "replace-all") return false;
  const v = parseJsonObject(edit.text);
  if (v === null || !exactKeys(v, ["letters_from", "wake_on_letter_from"])) return false;
  return [v.letters_from, v.wake_on_letter_from].every(
    (list) =>
      Array.isArray(list) &&
      list.length <= MAX_COVENANT_IDS &&
      new Set(list).size === list.length &&
      list.every((id) => typeof id === "string" && SENDER_ID.test(id)),
  );
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

function checkClaim(v: unknown): ModelClaim | null {
  if (!isPlainObject(v) || !exactKeys(v, ["kind", "evidence", "confidence", "limits"])) return null;
  const { kind, evidence, confidence, limits } = v;
  if (!isOneOf(kind, CLAIM_KINDS)) return null;
  if (!isOneOf(confidence, ["high", "medium", "low", "unknown"] as const)) return null;
  if (!Array.isArray(evidence) || evidence.length > ACT_LIMITS.max_claim_evidence) return null;
  for (const ref of evidence) {
    if (typeof ref !== "string" || ref.trim() === "" || [...ref].length > ACT_LIMITS.max_evidence_ref_chars || CONTROL_SINGLE_LINE.test(ref)) return null;
  }
  if (typeof limits !== "string" || [...limits].length > ACT_LIMITS.max_limits_chars || CONTROL_MULTILINE.test(limits)) return null;
  return { kind, evidence: [...(evidence as string[])], confidence, limits };
}
type ModelClaim = { kind: (typeof CLAIM_KINDS)[number]; evidence: string[]; confidence: "high" | "medium" | "low" | "unknown"; limits: string };

function isIdPrefix(v: unknown): v is string {
  if (typeof v !== "string" || v.length > ACT_LIMITS.max_id_chars) return false;
  if (!/^[0-9a-fA-F][0-9a-fA-F-]*$/.test(v)) return false;
  return v.replace(/-/g, "").length >= ACT_LIMITS.min_id_prefix_hex;
}
