#!/usr/bin/env bun
// citizen-seat: the one runner, and so the only way into a citizen (3.2).
//
//   citizen-seat tick                 one launchd tick: HALT, lock, select, seat
//   citizen-seat seat <word>          one supervised seat now (summons needs --yu-present)
//   citizen-seat halt                 raise HALT: local file, then beacons this host holds
//   citizen-seat status               regenerate and print the status file
//   citizen-seat verify <word>        verify a citizen's ledger chain and signatures, offline
//
// There is no verb to lower HALT. Only Yu lowers it, by hand (3.6).
import type { ExitCode, RuntimeClass, Word } from "./types.ts";

export type Command =
  | { verb: "tick"; config: string | null }
  | {
      verb: "seat";
      config: string | null;
      word: Word;
      runtime: RuntimeClass;
      why: string;
      yu_present: boolean;
      /** Set by the supervising parent: run the seat pipeline in this process. */
      child: boolean;
      seat_ref_path: string | null;
    }
  | { verb: "halt"; config: string | null }
  | { verb: "status"; config: string | null; json: boolean }
  | { verb: "verify"; config: string | null; word: Word }
  | { verb: "help" };

export const USAGE = [
  "usage: citizen-seat <verb> [--config <path>]",
  "  tick",
  "  seat <word> [--runtime free|summon] [--why <text>] [--yu-present]",
  "  halt",
  "  status [--json]",
  "  verify <word>",
].join("\n");

/** Parse argv into one Command; unknown verbs or flags, and invalid words, are refused with usage. */
export function parseArgs(argv: string[]): Command {
  throw new Error("unimplemented");
}

/** Run one command with real dependencies and return its exit code; never prints a secret. */
export async function main(argv: string[]): Promise<ExitCode> {
  throw new Error("unimplemented");
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
