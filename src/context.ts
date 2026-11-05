// What a seat shows the model (3.2 step 4). Its own expression and soul
// whole, its last k ledger entries, its state, the date, time and zone, at
// most one letter read only as a regular file, its canon path@commit, and who
// invoked it and why. It deliberately excludes GET /v1/wake, whose
// project-wide sections would mix siblings into a persona (3.2). A sibling's
// words reach a citizen only as a letter. Nothing secret is ever included.
import type { Citizen, Config, Letter, LedgerEntry, NowView, SeatContext, SeatRef, SelfProposal } from "./types.ts";

export interface ContextDeps {
  config: Config;
  now: Date;
}

/** Read a file only if it is a regular file (lstat, then open with O_NOFOLLOW and fstat); refuse symlinks and oversize. */
export async function readRegularText(path: string, maxBytes: number): Promise<string> {
  throw new Error("unimplemented");
}

/** The oldest unseen letter from an allowed sender, read as a regular file; symlinks and others are set aside, never counted as mail. */
export async function pickLetter(config: Config, citizen: Citizen): Promise<Letter | null> {
  throw new Error("unimplemented");
}

/** True when an allowed, unseen, regular-file letter is waiting; the tick uses this to wake a listening or asleep citizen. */
export async function hasAllowedLetter(config: Config, citizen: Citizen): Promise<boolean> {
  throw new Error("unimplemented");
}

/** Record that a letter was shown, as a host receipt outside the citizen's voice; written only after a non-rest beat. */
export async function markLetterSeen(config: Config, citizen: Citizen, letter: Letter, now: Date): Promise<void> {
  throw new Error("unimplemented");
}

/** Date, local time, zone and part of day, e.g. "02:05 GMT", "night". */
export function describeNow(now: Date, timezone: string): NowView {
  throw new Error("unimplemented");
}

/** The citizen's own self files, whole: soul, WILL, NAME, beat prompt and skills, as regular files only. */
export async function readSelf(config: Config, citizen: Citizen): Promise<SeatContext["self"]> {
  throw new Error("unimplemented");
}

/** The pinned canon snapshot under `citizens/<word>/origin/`, checked against origin.sha256; null for an archetype. */
export async function readCanon(config: Config, citizen: Citizen): Promise<string | null> {
  throw new Error("unimplemented");
}

/** Assemble the whole context for one seat. */
export async function buildContext(deps: ContextDeps, seat: SeatRef, citizen: Citizen, recent: LedgerEntry[], pending: SelfProposal[]): Promise<SeatContext> {
  throw new Error("unimplemented");
}
