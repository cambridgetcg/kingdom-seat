// Shared helpers for the verify-mirror-fence probes. Everything is written under
// TMPDIR (set by the runner to a directory inside this probes dir). Real citizen
// clones are only READ (git archive / git show); nothing is written to them.
// Fakes only: no keychain, no network, no real home, no CLI against a real host.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export const SEAT = "<KINGDOM_SEAT>";
export const CLONES = "<REPOS>";

export const GIT_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/var/empty",
  LANG: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
};

export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (r.exitCode !== 0) throw new Error(`fixture git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

export function gitTry(cwd: string, ...args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

/** Read one file of a real clone's HEAD without touching the clone. */
export function showFromClone(word: string, path: string): string {
  const r = Bun.spawnSync(["git", "-C", `${CLONES}/citizen-${word}`, "show", `HEAD:${path}`], { env: GIT_ENV });
  if (r.exitCode !== 0) throw new Error(`git show failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** names+modes of a real clone's HEAD tree (read only). */
export function cloneTree(word: string): string[] {
  const r = Bun.spawnSync(["git", "-C", `${CLONES}/citizen-${word}`, "ls-tree", "-r", "HEAD"], { env: GIT_ENV });
  return r.stdout
    .toString()
    .trim()
    .split("\n")
    .map((l) => `${l.split(/\s+/)[0]} ${l.split("\t")[1]}`);
}

/**
 * A throwaway repo whose single commit holds a copy of the real citizen-<word> HEAD tree
 * (files copied out with `git archive`, which only reads the clone), and a bare "remote" of it.
 */
export async function legacyRemote(root: string, word: string): Promise<{ seed: string; bare: string }> {
  const seed = join(root, `seed-${word}`);
  const bare = join(root, `remote-${word}.git`);
  await mkdir(seed, { recursive: true });
  const tar = Bun.spawnSync(["git", "-C", `${CLONES}/citizen-${word}`, "archive", "--format=tar", "HEAD"], { env: GIT_ENV });
  if (tar.exitCode !== 0) throw new Error(`archive failed: ${tar.stderr.toString()}`);
  const x = Bun.spawnSync(["tar", "-x", "-C", seed], { stdin: tar.stdout });
  if (x.exitCode !== 0) throw new Error(`untar failed: ${x.stderr.toString()}`);
  git(seed, "init", "-q", "-b", "main");
  git(seed, "add", "-A", "-f");
  git(seed, "commit", "-q", "-m", `legacy home of ${word} (copied tree)`);
  git(root, "clone", "-q", "--bare", seed, bare);
  return { seed, bare };
}

export function tree(repo: string, rev = "HEAD"): string[] {
  const o = gitTry(repo, "ls-tree", "-r", "--name-only", rev);
  return o.code === 0 && o.out !== "" ? o.out.split("\n") : [];
}

export function treeModes(repo: string, rev = "HEAD"): string[] {
  return git(repo, "ls-tree", "-r", rev)
    .split("\n")
    .map((l) => `${l.split(/\s+/)[0]} ${l.split("\t")[1]}`);
}
