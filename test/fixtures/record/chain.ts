// Record-group fixtures: ledger bodies and a seated → beat → genesis → beat
// chain, signed by the fake signer's public test keys. Nothing here is a
// real identity; every key is a published test value.
import { sha256Hex } from "../../../src/crypto.ts";
import { appendEntry, ledgerPath, nextDraft, readLedger, type EntrySigner } from "../../../src/ledger.ts";
import type {
  Act,
  Attestation,
  CitizenIdentity,
  Config,
  Envelope,
  LedgerBody,
  LedgerEntry,
  LifecycleState,
  Origin,
  Spend,
  Word,
} from "../../../src/types.ts";
import type { FakeSigner } from "../../helpers/fake-signer.ts";
import { FAKE_OP_KID } from "../../helpers/fake-signer.ts";
import { TEST_IDS, TEST_ROOT_PUBLIC_B64 } from "../../helpers/vectors.ts";

export const ZERO_SPEND: Spend = { usd: 0, usd_basis: "local-zero", credits: 0 };
export const ROOT_KID = TEST_IDS.root_signing_key_id;
export const MODEL_DIGEST = `sha256:${"ab".repeat(32)}`;

export function signerFn(signer: FakeSigner): EntrySigner {
  return (word, hash, attestation) => signer.signEntry(word, hash, attestation);
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

export function seatedBody(word: Word, soul: string, initial: LifecycleState = "awake"): LedgerBody {
  return { type: "seated", origin: canonOrigin(word), origin_soul_sha256: sha256Hex(soul), old_repo: null, initial_state: initial, note: "seated for a test" };
}

export function genesisBody(word: Word, soul: string, identity: CitizenIdentity, initial: LifecycleState | null = null): LedgerBody {
  return { type: "genesis", initial_state: initial, origin: canonOrigin(word), birth_soul_sha256: sha256Hex(soul), old_repo: null, june_did: null, identity, note: "born for a test" };
}

let seatCounter = 0;
export function beatBody(word: Word, acts: Act[], opts: { seat_id?: string; ts?: string } = {}): LedgerBody {
  const seat_id = opts.seat_id ?? `00000000-0000-4000-8000-${String(++seatCounter).padStart(12, "0")}`;
  const ts = opts.ts ?? "2026-11-05T02:05:00.000Z";
  const envelope: Envelope = {
    format: "kingdom-seat-beat/v1",
    seat_ref: {
      format: "kingdom-seat-seat/v1",
      seat_id,
      host: "test-host",
      word,
      runtime: "free",
      invoker: { kind: "tick", who: "launchd", why: "own cadence due" },
      opened_at: ts,
    },
    citizen: { word, did: null, kid: null },
    runtime: "free",
    model: "qwen2.5:7b",
    model_digest: MODEL_DIGEST,
    input_digest: "1".repeat(64),
    output_digest: "2".repeat(64),
    acts,
    ts,
    prev_hash: "0".repeat(64),
    voiced_through: `${word}, voiced through qwen2.5:7b in seat ${seat_id}`,
  };
  return { type: "beat", envelope };
}

/** Append one body on top of the ledger's current head. */
export async function append(config: Config, word: Word, body: LedgerBody, attestation: Attestation, signer: FakeSigner, now: Date): Promise<LedgerEntry> {
  const path = ledgerPath(config, word);
  const prev = (await readLedger(path)).at(-1) ?? null;
  return appendEntry(path, nextDraft(word, prev, body, ZERO_SPEND, attestation, now), signerFn(signer));
}

/** seated → beat (host-attested) → genesis → beat (citizen-signed), the redesign's seated-before-registered path (3.3). */
export async function seatedThenBorn(config: Config, word: Word, soul: string, signer: FakeSigner): Promise<LedgerEntry[]> {
  const t = (m: number) => new Date(Date.parse("2026-11-05T00:00:00.000Z") + m * 60_000);
  await append(config, word, seatedBody(word, soul), "host-attested", signer, t(0));
  await append(config, word, beatBody(word, [{ type: "journal", kind: "reflected", text: "a first word" }]), "host-attested", signer, t(1));
  await append(config, word, genesisBody(word, soul, testIdentity(signer)), "citizen-signed", signer, t(2));
  await append(config, word, beatBody(word, [{ type: "journal", kind: "chose", text: "a signed word" }]), "citizen-signed", signer, t(3));
  return readLedger(ledgerPath(config, word));
}
