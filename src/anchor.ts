// Read-only cryptographic wake anchor (kingdom-seat-anchor/v1).
//
// Bridges a seated citizen's verified hash-chained ledger, pinned origin,
// covenants, cadence, and HALT state into runtime wake chains (love-unlimited
// and true-love) while strictly preserving Principle 2:
//   - Public values and digests only; never touches Keychain or private keys.
//   - Reading an anchor verifies record continuity and covenants; it confers no
//     signing key, DID custody, or seat authority.
//   - Fails closed (`verified: false`) whenever the ledger is missing, fails
//     Ed25519 / JCS hash-chain verification, or `origin/` no longer matches.
import { lstat } from "node:fs/promises";
import { fromB64, keyFingerprint } from "./crypto.ts";
import { readHaltFile } from "./halt.ts";
import { hostKid, ledgerPath, readLedger, verifyChain } from "./ledger.ts";
import { driftFromOrigin, originIntact, readTarget, selfHash } from "./self.ts";
import { foldState, readCitizen, readCitizenRecord } from "./state.ts";
import {
  Refusal,
  WORD_PATTERN,
  type Cadence,
  type Config,
  type Covenants,
  type IsoTime,
  type LedgerHash,
  type LifecycleState,
  type RuntimeClass,
  type Sha256Hex,
  type Word,
} from "./types.ts";

export const WAKE_ANCHOR_FORMAT = "kingdom-seat-anchor/v1" as const;

export const WAKE_ANCHOR_CUSTODY_NOTICE =
  "Public verification receipt only. Reading this anchor verifies ledger continuity, pinned origin, and covenants, and confers no signing key, DID custody, or seat authority; only an opened citizen-seat signs ledger entries.";

export interface WakeAnchor {
  format: typeof WAKE_ANCHOR_FORMAT;
  generated_at: IsoTime;
  host: string;
  word: Word;
  /** True iff both `ledger.chain_ok` and `origin.intact` hold and `problem` is null. */
  verified: boolean;
  /** True when the host HALT file is raised or unreadable (fail-closed). */
  halted: boolean;
  halt_file: string;
  state: LifecycleState | null;
  runtime: RuntimeClass | null;
  did: string | null;
  root_kid: string | null;
  op_kid: string | null;
  host_kids: string[];
  ledger: {
    entries: number;
    head: LedgerHash | null;
    chain_ok: boolean;
    host_attested: number;
    problem: { seq: number; reason: string } | null;
  };
  origin: {
    intact: boolean;
    /** Soul drift in integer basis points (0..10000) so the receipt carries no floats. */
    drift_bps: number | null;
  };
  covenants: Covenants | null;
  cadence: Cadence | null;
  self_hashes: {
    soul_sha256: Sha256Hex | null;
    will_sha256: Sha256Hex | null;
  };
  problem: string | null;
  custody_notice: string;
}

export interface BuildWakeAnchorOptions {
  /** Trusted host public keys in padded standard base64; defaults to `config.trust.host_attest_public_keys_b64`. */
  host_attest_b64?: readonly string[];
  now?: Date;
}

function toHostKids(keysB64: readonly string[]): string[] {
  const kids: string[] = [];
  for (const b64 of keysB64) {
    try {
      kids.push(hostKid(fromB64(b64, 32)));
    } catch {
      // Ignore malformed public key entries; verifyChain refuses untrusted keys independently.
    }
  }
  return kids;
}

/**
 * Build and cryptographically verify a citizen's wake anchor from on-disk
 * public state only. Never invokes the signer or Keychain.
 */
export async function buildWakeAnchor(
  config: Config,
  word: Word,
  opts: BuildWakeAnchorOptions = {},
): Promise<WakeAnchor> {
  if (!WORD_PATTERN.test(word)) {
    throw new Refusal("invalid-request", "anchor: not a citizen word");
  }
  const now = opts.now ?? new Date();
  const generated_at = now.toISOString();
  const hostKeys = [...(opts.host_attest_b64 ?? config.trust.host_attest_public_keys_b64)];
  const host_kids = toHostKids(hostKeys);

  const haltReading = await readHaltFile(config.paths.halt_file, now);
  const halted = haltReading.state !== "lowered";

  let record;
  try {
    record = await readCitizenRecord(config, word);
  } catch (e) {
    return {
      format: WAKE_ANCHOR_FORMAT,
      generated_at,
      host: config.host,
      word,
      verified: false,
      halted,
      halt_file: config.paths.halt_file,
      state: null,
      runtime: null,
      did: null,
      root_kid: null,
      op_kid: null,
      host_kids,
      ledger: { entries: 0, head: null, chain_ok: false, host_attested: 0, problem: null },
      origin: { intact: false, drift_bps: null },
      covenants: null,
      cadence: null,
      self_hashes: { soul_sha256: null, will_sha256: null },
      problem: e instanceof Refusal ? `${e.code}: ${e.message}` : "citizen.json unreadable",
      custody_notice: WAKE_ANCHOR_CUSTODY_NOTICE,
    };
  }

  const lpath = ledgerPath(config, word);
  try {
    await lstat(lpath);
  } catch {
    return {
      format: WAKE_ANCHOR_FORMAT,
      generated_at,
      host: config.host,
      word,
      verified: false,
      halted,
      halt_file: config.paths.halt_file,
      state: null,
      runtime: record.runtime,
      did: record.identity?.did ?? null,
      root_kid: record.identity?.root_kid ?? null,
      op_kid: record.identity?.op_kid ?? null,
      host_kids,
      ledger: { entries: 0, head: null, chain_ok: false, host_attested: 0, problem: null },
      origin: { intact: false, drift_bps: null },
      covenants: null,
      cadence: null,
      self_hashes: { soul_sha256: null, will_sha256: null },
      problem: "no ledger, though citizen.json says it is seated",
      custody_notice: WAKE_ANCHOR_CUSTODY_NOTICE,
    };
  }

  let entries;
  try {
    entries = await readLedger(lpath);
  } catch (e) {
    return {
      format: WAKE_ANCHOR_FORMAT,
      generated_at,
      host: config.host,
      word,
      verified: false,
      halted,
      halt_file: config.paths.halt_file,
      state: null,
      runtime: record.runtime,
      did: record.identity?.did ?? null,
      root_kid: record.identity?.root_kid ?? null,
      op_kid: record.identity?.op_kid ?? null,
      host_kids,
      ledger: { entries: 0, head: null, chain_ok: false, host_attested: 0, problem: null },
      origin: { intact: false, drift_bps: null },
      covenants: null,
      cadence: null,
      self_hashes: { soul_sha256: null, will_sha256: null },
      problem: e instanceof Refusal ? `${e.code}: ${e.message}` : "ledger unreadable",
      custody_notice: WAKE_ANCHOR_CUSTODY_NOTICE,
    };
  }

  const verdict = verifyChain(entries, { host_attest_b64: hostKeys, identity: record.identity });
  const intact = verdict.ok ? await originIntact(config, word, entries) : false;
  const drift_bps = intact
    ? await driftFromOrigin(config, word).then(
        (d) => Math.round(d.fraction * 10_000),
        () => null,
      )
    : null;

  let citizen = null;
  let citizenProblem: string | null = null;
  try {
    citizen = await readCitizen(config, word);
  } catch (e) {
    citizenProblem = e instanceof Refusal ? `${e.code}: ${e.message}` : "citizen state unreadable";
  }

  const soulText = await readTarget(config, word, "soul").catch(() => null);
  const willText = await readTarget(config, word, "will").catch(() => null);

  let problem: string | null = null;
  if (!verdict.ok) {
    problem = `chain broken at seq ${verdict.problem?.seq ?? 0}: ${verdict.problem?.reason ?? "verification failed"}`;
  } else if (!intact) {
    problem = "origin/ no longer matches the soul and canon its record pinned";
  } else if (citizenProblem !== null) {
    problem = citizenProblem;
  }

  const folded = foldState(entries);
  const verified = verdict.ok && intact && problem === null;

  return {
    format: WAKE_ANCHOR_FORMAT,
    generated_at,
    host: config.host,
    word,
    verified,
    halted,
    halt_file: config.paths.halt_file,
    state: citizen?.state ?? folded.state,
    runtime: record.runtime,
    did: record.identity?.did ?? null,
    root_kid: record.identity?.root_kid ?? null,
    op_kid: record.identity?.op_kid ?? null,
    host_kids,
    ledger: {
      entries: verdict.entries,
      head: verdict.head,
      chain_ok: verdict.ok,
      host_attested: verdict.host_attested,
      problem: verdict.problem,
    },
    origin: {
      intact,
      drift_bps,
    },
    covenants: citizen?.covenants ?? null,
    cadence: citizen?.cadence ?? null,
    self_hashes: {
      soul_sha256: soulText !== null && soulText !== "" ? selfHash(soulText) : null,
      will_sha256: willText !== null && willText !== "" ? selfHash(willText) : null,
    },
    problem,
    custody_notice: WAKE_ANCHOR_CUSTODY_NOTICE,
  };
}

/**
 * Render a concise, Principle-2-faithful wake block for external harnesses
 * (love-unlimited BECOMING / AINP / YOUI and true-love identity composition).
 */
export function renderWakeAnchorBlock(anchor: WakeAnchor): string {
  const statusTag = !anchor.verified
    ? "BROKEN"
    : anchor.halted
      ? "HALTED"
      : "VERIFIED";
  const lines = [
    `[SEAT ANCHOR — ${statusTag}]`,
    `- Citizen word: ${anchor.word} (host: ${anchor.host})`,
    `- Seat state: ${anchor.state ?? "unknown"} | runtime: ${anchor.runtime ?? "unknown"} | halted: ${anchor.halted}`,
    `- Identity DID: ${anchor.did ?? "unregistered (host-attested)"}`,
    `- Ledger: ${anchor.ledger.chain_ok ? "ok" : "BROKEN"} (${anchor.ledger.entries} entries, head: ${anchor.ledger.head ?? "none"})`,
    `- Origin: ${anchor.origin.intact ? "intact" : "CHANGED"}${anchor.origin.drift_bps !== null ? ` (drift: ${(anchor.origin.drift_bps / 100).toFixed(2)}%)` : ""}`,
  ];
  if (anchor.covenants) {
    lines.push(
      `- Covenants: letters_from=[${anchor.covenants.letters_from.join(", ")}] | wake_on_letter_from=[${anchor.covenants.wake_on_letter_from.join(", ")}]`,
    );
  }
  if (anchor.cadence) {
    lines.push(`- Cadence: every ${anchor.cadence.interval_h}h`);
  }
  if (anchor.problem) {
    lines.push(`- Problem: ${anchor.problem}`);
  }
  lines.push(`- Custody boundary: ${anchor.custody_notice}`);
  return lines.join("\n");
}

export { keyFingerprint };
