// Consent until consent/v1 merges (decision 12): a decision record bound to
// a proposal's sha256 that carries Yu's recorded word and Ai's voice. Yu and
// Ai must both agree; either may reject; silence from Yu never binds (3.6).
import type { ConsentClass, ConsentRecord, SignerOp, StandingAgreement, YuPresence } from "../types.ts";

export type ConsentVerdict = { ok: true; via: ConsentRecord["yu"]["via"] } | { ok: false; code: "consent-missing" | "consent-rejected"; reason: string };

/** Minimal terminal access, injected so tests never need a real TTY. */
export interface TtyIO {
  isTTY: boolean;
  write(text: string): void;
  readLine(): Promise<string | null>;
}

/** The sha256 a consent record binds to: domain-tagged canonical JSON of the proposal. */
export function proposalDigest(proposal: { subject: string; body: string; extent: string }): string {
  throw new Error("unimplemented");
}

/** Within self, within a standing agreement, or beyond self, for one signer op (3.6 consent table). */
export function classifyOp(op: SignerOp): ConsentClass {
  throw new Error("unimplemented");
}

/** Check one record against the proposal digest: bound sha256, Yu yes, Ai agree, no open challenge, not expired. */
export function verifyConsent(record: ConsentRecord, proposalSha256: string, now: Date): ConsentVerdict {
  throw new Error("unimplemented");
}

/** Does a standing agreement cover this op at this extent? Anything beyond its extent is a new proposal. */
export function agreementCovers(agreement: StandingAgreement, op: SignerOp, extent: string, now: Date): boolean {
  throw new Error("unimplemented");
}

/** Load decision records from the consent dir: regular files only, strict JSON, invalid ones skipped and reported. */
export async function loadConsentRecords(dir: string): Promise<{ records: ConsentRecord[]; invalid: string[] }> {
  throw new Error("unimplemented");
}

/** Ask Yu at the controlling terminal to type the scope back; refuses when stdin is not a TTY. */
export async function confirmYuPresent(io: TtyIO, scope: string, now: () => Date): Promise<YuPresence> {
  throw new Error("unimplemented");
}

/** A presence is valid for one scope and a short window, so it cannot be replayed later or elsewhere. */
export function presenceValid(presence: YuPresence | null, scope: string, now: Date, maxAgeS?: number): boolean {
  throw new Error("unimplemented");
}
