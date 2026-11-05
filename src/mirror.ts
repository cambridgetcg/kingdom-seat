// The mirror pusher with a seal allowlist (3.2, 3c "Mirror"). A mirror is
// optional and outbound only: it receives the citizen's self files and a
// published status, never host-executed code. It refuses symlinks, executable
// bits, .claude/, .github/, host-owned paths, oversize files and divergence,
// and pushes only HEAD:refs/heads/main, never forced
// (love-unlimited-patterns.md 4, 12).
import type { Citizen, CommandRunner, Config, DivergenceState } from "./types.ts";

/** One entry of a tree as git or lstat sees it. Modes as git spells them. */
export interface TreeEntry {
  path: string;
  mode: "100644" | "100755" | "120000" | "040000" | "160000";
  size: number;
}

export type SealVerdict = { ok: true; admitted: string[] } | { ok: false; refused: { path: string; code: "symlink" | "executable" | "host-owned-path" | "oversize" | "not-regular-file"; reason: string }[] };

export interface PushResult {
  pushed: boolean;
  divergence: DivergenceState;
  refusal: string | null;
}

/** The largest file a mirror admits; bigger is refused, not truncated. */
export const MIRROR_MAX_FILE_BYTES = 256 * 1024;

/** Paths a mirror may never carry, whatever the citizen writes: host code, CI, hooks, the ledger, runner state. */
export const HOST_OWNED = Object.freeze([".claude/", ".github/", ".git/", ".citizen/", "run.sh", "ledger/", "proposals/", "receipts/"]);

/** True when a path is inside the seal allowlist: the citizen's own text files and its generated status card. */
export function sealAllows(path: string): boolean {
  throw new Error("unimplemented");
}

/** Check a whole tree: every entry must be an allowlisted regular, non-executable file within the size limit. */
export function sealCheck(entries: TreeEntry[]): SealVerdict {
  throw new Error("unimplemented");
}

/** Walk a directory with lstat, never following links, and report each entry's mode and size. */
export async function listTree(dir: string): Promise<TreeEntry[]> {
  throw new Error("unimplemented");
}

/** Compare HEAD with the remote's main via `git rev-list --left-right --count`; fetch is ff-only, never merge or rebase. */
export async function divergence(run: CommandRunner, worktree: string, remote: string): Promise<DivergenceState> {
  throw new Error("unimplemented");
}

/** ["git", "push", <remote>, "HEAD:refs/heads/main"]: no --force, no other refspec. */
export function pushArgv(remote: string): string[] {
  throw new Error("unimplemented");
}

/** Stage the citizen's sealed files into the mirror worktree; refuses the whole stage on any refused entry. */
export async function stageMirror(config: Config, citizen: Citizen, run: CommandRunner): Promise<SealVerdict> {
  throw new Error("unimplemented");
}

/** Push if and only if the seal passes and HEAD is ahead of or equal to the remote; diverged or behind is refused. */
export async function pushMirror(config: Config, citizen: Citizen, run: CommandRunner): Promise<PushResult> {
  throw new Error("unimplemented");
}
