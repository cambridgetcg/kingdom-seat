// Record-group fixtures: ledger entries and an origin → beat → genesis → beat
// chain in KS-004 4.5's layout, signed by the fake signer's public test keys.
// Nothing here is a real identity; every key is a published test value.
import { fromB64, sha256Hex } from "../../../src/crypto.ts";
import {
  appendEntry,
  entryHash,
  evidenceToLedger,
  ledgerKey,
  ledgerPath,
  nextDraft,
  originToLedger,
  readLedger,
  toLedgerHash,
  voicedThrough,
  type EntrySigner,
  type SeatStamp,
} from "../../../src/ledger.ts";
import type { Act, CitizenIdentity, Config, Cost, LedgerEntry, LedgerFields, LedgerSigner, LifecycleState, Origin, Word } from "../../../src/types.ts";
import type { FakeSigner } from "../../helpers/fake-signer.ts";
import { importEvidence } from "../../helpers/root-evidence.ts";
import { FAKE_OP_KID } from "../../helpers/fake-signer.ts";
import { TEST_IDS, TEST_ROOT_PUBLIC_B64 } from "../../helpers/vectors.ts";

export const ZERO_COST: Cost = { usd: "0", credits: 0 };
export const ROOT_KID = TEST_IDS.root_signing_key_id;
export const MODEL_DIGEST = `sha256:${"ab".repeat(32)}`;

/** Fields and what goes with them: a seat's stamp and acts for a beat, the DID for genesis. */
export interface TestBody {
  fields: LedgerFields;
  seat?: SeatStamp;
  acts?: Act[];
  did?: string;
}

/** Genesis points back to the ledger's first entry; append fills it in, since a body is built before the ledger is read. */
export const ORIGIN_OF_THIS_LEDGER = "sha256:origin-of-this-ledger";

export function signerFn(signer: FakeSigner): EntrySigner {
  return (word, kind, digestFor) => signer.signEntry(word, kind, digestFor);
}

export function testIdentity(signer: FakeSigner): CitizenIdentity {
  return {
    did: TEST_IDS.did,
    identity_id: TEST_IDS.identity_id,
    project_id: TEST_IDS.project_id,
    root_public_key_b64: TEST_ROOT_PUBLIC_B64,
    root_kid: ROOT_KID,
    op_kid: FAKE_OP_KID,
    op_public_key_b64: signer.opPublicB64,
    box_public_key_b64: null,
    self_strand_id: TEST_IDS.strand_id,
    enrolled_at: "2026-11-05T01:00:00.000Z",
  };
}

export function canonOrigin(word: Word): Origin {
  return { kind: "canon", repo: "YOUSPEAK", path: `canon/core/${word}.md`, commit: "1428646", sha256: sha256Hex(`canon text for ${word}`) };
}

/** The origin entry's fields, pinning `soul` as the origin soul. */
export function originBody(word: Word, soul: string, opts: { juneDid?: string | null } = {}): TestBody {
  return { fields: { type: "origin", origin: originToLedger(canonOrigin(word)), origin_soul_hash: toLedgerHash(sha256Hex(soul)), old_repo: null, june_did: opts.juneDid ?? null } };
}

/** Seating: the origin entry, then, unless the citizen is seated asleep, the host's state entry carrying the state it was seated in. */
export function seatedBody(word: Word, soul: string, initial: LifecycleState = "awake"): TestBody[] {
  const origin = originBody(word, soul);
  return initial === "asleep" ? [origin] : [origin, { fields: { type: "state", from: "asleep", to: initial, via: "seated" } }];
}

/** Genesis for `identity`, with the test root's evidence for its op key; it points back to the ledger's origin entry. */
export function genesisBody(identity: CitizenIdentity): TestBody {
  return {
    fields: {
      type: "genesis",
      origin_entry: ORIGIN_OF_THIS_LEDGER,
      root: ledgerKey(identity.root_kid, fromB64(identity.root_public_key_b64, 32)),
      op: ledgerKey(identity.op_kid, fromB64(identity.op_public_key_b64, 32)),
      evidence: evidenceToLedger(importEvidence(identity, identity.op_public_key_b64)),
    },
    did: identity.did,
  };
}

let seatCounter = 0;
/** A beat in its own seat; `seat_id` names the seat, a fresh one by default. */
export function beatBody(word: Word, acts: Act[], opts: { seat_id?: string } = {}): TestBody {
  const seat_id = opts.seat_id ?? `00000000-0000-4000-8000-${String(++seatCounter).padStart(12, "0")}`;
  return { fields: { type: "beat" }, seat: testStamp(word, seat_id), acts };
}

/** A state entry, in the seat `seat_id` when given (a first step-away's entry is always a seat's). */
export function stateBody(word: Word, fields: Omit<Extract<LedgerFields, { type: "state" }>, "type">, opts: { seat_id?: string } = {}): TestBody {
  return { fields: { type: "state", ...fields }, ...(opts.seat_id ? { seat: testStamp(word, opts.seat_id) } : {}) };
}

/** A seat's stamp with fixed digests, for entries written in a seat. */
export function testStamp(word: Word, seatId: string): SeatStamp {
  return {
    seat_ref: seatId,
    runtime: { class: "free", model: "qwen2.5:7b", digest: MODEL_DIGEST },
    input_digest: toLedgerHash("1".repeat(64)),
    output_digest: toLedgerHash("2".repeat(64)),
    voiced: voicedThrough(word, "qwen2.5:7b", seatId),
  };
}

/** Append one body, or several in order, on top of the ledger's current head; returns the last entry. */
export async function append(config: Config, word: Word, body: TestBody | TestBody[], signer: LedgerSigner, fake: FakeSigner, now: Date): Promise<LedgerEntry> {
  const path = ledgerPath(config, word);
  let last: LedgerEntry | null = null;
  for (const b of Array.isArray(body) ? body : [body]) {
    const all = await readLedger(path);
    let fields = b.fields;
    if (fields.type === "genesis" && fields.origin_entry === ORIGIN_OF_THIS_LEDGER) fields = { ...fields, origin_entry: entryHash(all[0]!) };
    const draft = nextDraft(word, all.at(-1) ?? null, fields, { cost: ZERO_COST, signer, now, seat: b.seat ?? null, acts: b.acts ?? null, ...(b.did ? { did: b.did } : {}) });
    last = await appendEntry(path, draft, signerFn(fake));
  }
  return last!;
}

/** origin → beat (host) → genesis → beat (citizen), the redesign's seated-before-registered path (3.3). */
export async function seatedThenBorn(config: Config, word: Word, soul: string, signer: FakeSigner): Promise<LedgerEntry[]> {
  const t = (m: number) => new Date(Date.parse("2026-11-05T00:00:00.000Z") + m * 60_000);
  await append(config, word, originBody(word, soul), "host", signer, t(0));
  await append(config, word, beatBody(word, [{ type: "journal", kind: "reflected", text: "a first word" }]), "host", signer, t(1));
  await append(config, word, genesisBody(testIdentity(signer)), "citizen", signer, t(2));
  await append(config, word, beatBody(word, [{ type: "journal", kind: "chose", text: "a signed word" }]), "citizen", signer, t(3));
  return readLedger(ledgerPath(config, word));
}
