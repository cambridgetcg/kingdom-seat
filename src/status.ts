// The generated status file (3.2 "Status file", 3.1 principle 6): written
// from what the runner reads, never kept by hand. Per citizen it shows the
// last beat against its interval, divergence, push refusals, unsigned commits
// and spend. REGISTRY probes it. Host notes are the host's record of ticks,
// rests and refusals; they never carry a citizen's voice or a model's words.
import type { Config, HaltStatus, HostNote, StatusFile, Word } from "./types.ts";

export interface StatusDeps {
  config: Config;
  now: Date;
  halt: HaltStatus | null;
  signerState: "ready" | "locked" | "unknown";
}

/** Append one host note to host.jsonl; `detail` is checked to hold no model output. */
export async function appendHostNote(config: Config, note: HostNote): Promise<void> {
  throw new Error("unimplemented");
}

/** Host notes since a time, oldest first; null when the log is unreadable (callers treat that as fail-closed). */
export async function readHostNotes(config: Config, since: Date): Promise<HostNote[] | null> {
  throw new Error("unimplemented");
}

/** Build the whole status from citizen records, ledgers, host notes and mirror state. */
export async function buildStatus(deps: StatusDeps): Promise<StatusFile> {
  throw new Error("unimplemented");
}

/** Write atomically (temp file in the same directory, fsync, rename), mode 0644. */
export async function writeStatus(path: string, status: StatusFile): Promise<void> {
  throw new Error("unimplemented");
}

/** Plain-text view for `citizen-seat status`, one line per citizen plus the HALT and signer lines. */
export function renderStatus(status: StatusFile): string {
  throw new Error("unimplemented");
}

/** Last beat versus interval for one citizen, for REGISTRY's per-citizen probe. */
export function overdue(lastBeatAt: string | null, intervalH: number, now: Date): boolean {
  throw new Error("unimplemented");
}

/** The words status reports on, in roster order. */
export async function statusWords(config: Config): Promise<Word[]> {
  throw new Error("unimplemented");
}
