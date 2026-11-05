// The mirror pusher with a seal allowlist (3.2, 3c "Mirror"). A mirror is
// optional and outbound only: it receives the citizen's self files and a
// published status, never host-executed code. It refuses symlinks, executable
// bits, .claude/, .github/, host-owned paths, oversize files and divergence,
// and pushes only HEAD:refs/heads/main, never forced
// (love-unlimited-patterns.md 4, 12).
//
// Why an allowlist rather than a denylist: a home today mixes the self with
// hooks, workflows and runners that execute on someone's machine, and whoever
// can push to it decides what runs next. Naming what may go out is the only
// list that stays short. Nothing comes back in: letters arrive in letters/,
// never by fetch, so a public remote's content never reaches a prompt.
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isInside } from "./config.ts";
import { appendHostNote } from "./status.ts";
import { mirrorCardState } from "./state.ts";
import { Refusal, type Citizen, type CommandResult, type CommandRunner, type Config, type DivergenceState, type RefusalCode } from "./types.ts";

/** One entry of a tree as git or lstat sees it. Modes as git spells them; "000000" is anything git cannot hold (a fifo, socket or device). */
export interface TreeEntry {
  path: string;
  mode: "100644" | "100755" | "120000" | "040000" | "160000" | "000000";
  size: number;
}

export type SealCode = "symlink" | "executable" | "host-owned-path" | "oversize" | "not-regular-file";
export type SealVerdict = { ok: true; admitted: string[] } | { ok: false; refused: { path: string; code: SealCode; reason: string }[] };

export interface PushResult {
  pushed: boolean;
  divergence: DivergenceState;
  refusal: string | null;
}

/** The largest file a mirror admits; bigger is refused, not truncated. */
export const MIRROR_MAX_FILE_BYTES = 256 * 1024;

/** Paths a mirror may never carry, whatever the citizen writes: host code, CI, hooks, the ledger, runner state. */
export const HOST_OWNED = Object.freeze([".claude/", ".github/", ".git/", ".citizen/", "run.sh", "ledger/", "proposals/", "receipts/"]);

/** The generated status card at the mirror's root (3.3 "Mirror card state"). The host writes it; a self file of that name is refused. */
export const MIRROR_CARD_PATH = "kingdom.yaml";

/** Where the remote's main is fetched to: a private ref, so no branch or upstream config is ever touched. */
export const MIRROR_TRACKING_REF = "refs/kingdom-seat/mirror/main";

/** The only refspec a mirror push ever names. */
export const PUSH_REFSPEC = "HEAD:refs/heads/main";

/** Text the citizen writes: no scripts, no binaries, nothing a host or a forge would execute. */
const TEXT_FILE = /\.(md|txt|json)$/;
/** No leading dot (no dotfiles or dot-dirs anywhere) and no leading hyphen (nothing that reads as an option). */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_DEPTH = 4;
const MAX_PATH = 255;
const DOT_DIRS = new Set(HOST_OWNED.filter((h) => h.startsWith(".")).map((h) => h.slice(0, -1)));
const ROOT_DIRS = new Set(HOST_OWNED.filter((h) => h.endsWith("/") && !h.startsWith(".")).map((h) => h.slice(0, -1)));
const HOST_FILES = new Set(HOST_OWNED.filter((h) => !h.endsWith("/")));

/** A listing larger than this is not a self; it is refused rather than walked. */
const MAX_LIST_ENTRIES = 10_000;
const GIT_TIMEOUT_MS = 120_000;
const STD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/* ── The seal ─────────────────────────────────────────────────────────── */

/** True when a path names a host-owned place: .claude, .github, .git or .citizen at any depth, run.sh anywhere, ledger/proposals/receipts at the root. */
export function hostOwned(path: string): boolean {
  // Case-folded: the lease host's filesystem does not tell .GitHub from .github.
  const segs = path.toLowerCase().split("/");
  if (segs.some((s) => DOT_DIRS.has(s))) return true;
  if (ROOT_DIRS.has(segs[0] ?? "")) return true;
  return HOST_FILES.has(segs.at(-1) ?? "");
}

/** A relative POSIX path in one spelling: no "", ".", ".." or dot segments, within depth and length. */
function cleanPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH) return false;
  const segs = path.split("/");
  return segs.length <= MAX_DEPTH && segs.every((s) => SEGMENT.test(s));
}

/** True when a path is inside the seal allowlist: the citizen's own text files and its generated status card. */
export function sealAllows(path: string): boolean {
  if (path === MIRROR_CARD_PATH) return true;
  return cleanPath(path) && !hostOwned(path) && TEXT_FILE.test(path);
}

/**
 * Check a whole tree: every entry must be an allowlisted regular, non-executable file within the size limit.
 * With `allowCard: false` (the citizen's own files) the card's name is host-owned, so a self file cannot replace it.
 */
export function sealCheck(entries: TreeEntry[], opts: { allowCard?: boolean } = {}): SealVerdict {
  const allowCard = opts.allowCard ?? true;
  const refused: { path: string; code: SealCode; reason: string }[] = [];
  const admitted: string[] = [];
  const refuse = (path: string, code: SealCode, reason: string) => refused.push({ path, code, reason });
  for (const e of entries) {
    if (e.mode === "120000") refuse(e.path, "symlink", "a symlink is refused, never followed");
    else if (e.mode === "160000") refuse(e.path, "not-regular-file", "a submodule is not a file");
    else if (e.mode === "000000") refuse(e.path, "not-regular-file", "not a regular file");
    else if (e.mode === "040000") {
      // A directory holds nothing itself, but a host-owned one (an empty .claude/) is still refused.
      if (hostOwned(e.path) || !cleanPath(e.path)) refuse(e.path, "host-owned-path", "a host-owned or ill-formed directory");
    } else if (hostOwned(e.path) || (!allowCard && e.path === MIRROR_CARD_PATH)) refuse(e.path, "host-owned-path", "a host-owned path");
    else if (!sealAllows(e.path)) refuse(e.path, "host-owned-path", "outside the seal allowlist (text files with plain names only)");
    else if (e.mode === "100755") refuse(e.path, "executable", "an executable bit is refused");
    else if (e.mode !== "100644") refuse(e.path, "not-regular-file", "not a regular file");
    else if (!Number.isSafeInteger(e.size) || e.size < 0 || e.size > MIRROR_MAX_FILE_BYTES) refuse(e.path, "oversize", `larger than ${MIRROR_MAX_FILE_BYTES} bytes; refused, not truncated`);
    else admitted.push(e.path);
  }
  return refused.length > 0 ? { ok: false, refused } : { ok: true, admitted: admitted.sort() };
}

/** Walk a directory with lstat, never following links, and report each entry's mode and size. */
export async function listTree(dir: string): Promise<TreeEntry[]> {
  const top = await lstat(dir);
  if (top.isSymbolicLink()) throw new Refusal("symlink", "the directory to list is a symlink; refused, not followed");
  if (!top.isDirectory()) throw new Refusal("not-regular-file", "the directory to list is not a directory");
  const out: TreeEntry[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    for (const name of (await readdir(rel ? join(dir, rel) : dir)).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      if (out.length >= MAX_LIST_ENTRIES) throw new Refusal("oversize", `more than ${MAX_LIST_ENTRIES} entries`);
      // lstat: a link is reported as a link and never entered, so nothing outside `dir` is listed.
      const st = await lstat(join(dir, path));
      if (st.isSymbolicLink()) out.push({ path, mode: "120000", size: st.size });
      else if (st.isDirectory()) {
        out.push({ path, mode: "040000", size: 0 });
        if (depth >= 16) throw new Refusal("oversize", "directories nested too deep");
        await walk(path, depth + 1);
      } else if (st.isFile()) out.push({ path, mode: (st.mode & 0o111) !== 0 ? "100755" : "100644", size: st.size });
      else out.push({ path, mode: "000000", size: st.size });
    }
  };
  await walk("", 0);
  return out;
}

/** Parse `git ls-tree -r -l -z` output into tree entries. A mode git does not normally write reads as not-regular. */
export function parseLsTree(stdout: Uint8Array | string): TreeEntry[] {
  const text = typeof stdout === "string" ? stdout : new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  const out: TreeEntry[] = [];
  for (const rec of text.split("\0")) {
    if (rec === "") continue;
    const m = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64}) +(-|\d+)\t([\s\S]+)$/.exec(rec);
    if (!m) throw new Error("ls-tree: unreadable record");
    const raw = m[1]!;
    const mode: TreeEntry["mode"] = raw === "100644" || raw === "100755" || raw === "120000" || raw === "040000" || raw === "160000" ? raw : "000000";
    out.push({ path: m[5]!, mode, size: m[4] === "-" ? 0 : Number(m[4]) });
  }
  return out;
}

/* ── git, run with a fixed environment ────────────────────────────────── */

/**
 * The environment every mirror git command runs with. No hooks run (hooksPath
 * /dev/null), no user or system config is read, nothing prompts, and only the
 * ssh, https and file transports are allowed, so a remote URL cannot name a
 * helper that executes a command.
 */
export function gitEnv(parent: Record<string, string | undefined> = process.env): Record<string, string> {
  return {
    PATH: STD_PATH,
    // ssh finds the deploy key's config and known_hosts under HOME.
    HOME: parent.HOME && isAbsolute(parent.HOME) ? parent.HOME : "/var/empty",
    LANG: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: "ssh:https:file",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "commit.gpgsign",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "protocol.ext.allow",
    GIT_CONFIG_VALUE_2: "never",
  };
}

async function git(run: CommandRunner, worktree: string, args: string[], extraEnv: Record<string, string> = {}): Promise<CommandResult> {
  return run(["git", ...args], { cwd: worktree, env: { ...gitEnv(), ...extraEnv }, timeoutMs: GIT_TIMEOUT_MS });
}

function out(r: CommandResult): string {
  return new TextDecoder().decode(r.stdout);
}

async function gitOk(run: CommandRunner, worktree: string, args: string[], extraEnv: Record<string, string> = {}): Promise<CommandResult> {
  const r = await git(run, worktree, args, extraEnv);
  // The command and its exit only; git's own stderr can echo paths the citizen chose.
  if (r.code !== 0) throw new Error(`git ${args[0]} exited ${r.code}`);
  return r;
}

/** Refuse a remote that could be read as an option or that names a transport helper; only paths, file, ssh and https remain. */
export function assertRemote(remote: string): void {
  const bad = (why: string) => new Refusal("invalid-request", `mirror remote ${why}`);
  if (typeof remote !== "string" || remote.length === 0 || remote.length > 2048) throw bad("must be a non-empty string");
  if (/[\s\u0000-\u001f\u007f]/.test(remote)) throw bad("must not contain whitespace or control characters");
  if (remote.startsWith("-")) throw bad("must not start with '-'");
  if (remote.startsWith("/")) {
    if (resolve(remote) !== remote) throw bad("path must be normalised");
    return;
  }
  if (/^(file:\/\/\/|ssh:\/\/|https:\/\/)/.test(remote)) return;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._/~-]+$/.test(remote)) return;
  throw bad("must be an absolute path, file:///, ssh://, https:// or user@host:path");
}

/** The worktree is host-owned: never a home, never a seat cwd, never inside a citizen's own files or the record. */
async function assertWorktree(config: Config, worktree: string): Promise<void> {
  if (typeof worktree !== "string" || !isAbsolute(worktree) || resolve(worktree) !== worktree) {
    throw new Refusal("invalid-request", "mirror worktree must be an absolute, normalised path");
  }
  const p = config.paths;
  for (const home of p.homes) if (isInside(worktree, home)) throw new Refusal("cwd-in-home", "mirror worktree is inside a citizen home");
  for (const d of [p.seats_dir, p.citizens_dir, p.ledger_dir, p.consent_dir]) {
    if (isInside(worktree, d)) throw new Refusal("invalid-request", "mirror worktree is inside the seat's own state");
  }
  const st = await lstat(worktree).catch(() => null);
  if (!st) throw new Refusal("invalid-request", "mirror worktree does not exist");
  if (st.isSymbolicLink()) throw new Refusal("symlink", "mirror worktree is a symlink");
  if (!st.isDirectory()) throw new Refusal("not-regular-file", "mirror worktree is not a directory");
  // A .git file (gitdir: pointer) could send every command to another repository.
  const g = await lstat(join(worktree, ".git")).catch(() => null);
  if (!g || !g.isDirectory() || g.isSymbolicLink()) throw new Refusal("invalid-request", "mirror worktree has no .git directory of its own");
}

/* ── Divergence ───────────────────────────────────────────────────────── */

/** Compare HEAD with the last fetched remote main, without fetching; for status, which never touches the network. */
export async function localDivergence(run: CommandRunner, worktree: string): Promise<DivergenceState> {
  const upstream = await git(run, worktree, ["rev-parse", "--verify", "--quiet", `${MIRROR_TRACKING_REF}^{commit}`]);
  const head = await git(run, worktree, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (upstream.code !== 0) return "no-upstream";
  if (head.code !== 0) return "behind";
  const r = await gitOk(run, worktree, ["rev-list", "--left-right", "--count", `HEAD...${MIRROR_TRACKING_REF}`]);
  const m = /^(\d+)\s+(\d+)\s*$/.exec(out(r));
  if (!m) throw new Error("git rev-list: unreadable count");
  const ahead = Number(m[1]);
  const behind = Number(m[2]);
  if (ahead > 0 && behind > 0) return "diverged";
  if (behind > 0) return "behind";
  if (ahead > 0) return "ahead";
  return "equal";
}

/** Compare HEAD with the remote's main via `git rev-list --left-right --count`; fetch is ff-only, never merge or rebase. */
export async function divergence(run: CommandRunner, worktree: string, remote: string): Promise<DivergenceState> {
  assertRemote(remote);
  // No "+" on the refspec: the private ref only fast-forwards, so a remote whose history was rewritten fails here instead of being taken in.
  // Not --quiet: that would also hide the "[rejected] (non-fast-forward)" line this reads.
  const f = await git(run, worktree, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", remote, `refs/heads/main:${MIRROR_TRACKING_REF}`]);
  if (f.code !== 0) {
    if (/non-fast-forward|\[rejected\]/.test(f.stderr)) return "diverged";
    // Offline, no such branch, or no access: the remote's main is unknown, and unknown is never pushed over.
    return "no-upstream";
  }
  return localDivergence(run, worktree);
}

/** Commits on HEAD that carry no signature header at all (bounded); read from raw headers, so no verifier program runs. */
export async function countUnsigned(run: CommandRunner, worktree: string): Promise<number> {
  const head = await git(run, worktree, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head.code !== 0) return 0;
  const r = await gitOk(run, worktree, ["rev-list", "--header", "--max-count=10000", "HEAD"]);
  let unsigned = 0;
  for (const rec of out(r).split("\0")) {
    if (rec.trim() === "") continue;
    const headers = rec.split("\n\n")[0] ?? "";
    if (!/\ngpgsig(-sha256)? /.test(headers)) unsigned++;
  }
  return unsigned;
}

/* ── Stage and push ───────────────────────────────────────────────────── */

/** ["git", "push", <remote>, "HEAD:refs/heads/main"]: no --force, no other refspec. */
export function pushArgv(remote: string): string[] {
  assertRemote(remote);
  return ["git", "push", remote, PUSH_REFSPEC];
}

/** The status card: what the runner reads of the citizen, and nothing it chose to keep private. */
export function mirrorCard(citizen: Pick<Citizen, "word" | "state">): string {
  return [
    "# Generated by kingdom-seat from what the runner reads; never edited by hand.",
    `name: citizen-${citizen.word}`,
    `word: ${citizen.word}`,
    `state: ${mirrorCardState(citizen.state)}`,
    "kept_by: kingdom-seat",
    "",
  ].join("\n");
}

/** Read one admitted file through O_NOFOLLOW and check it again, so a swap after listing is refused, not published. */
async function readSealed(path: string): Promise<Uint8Array> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw new Refusal("symlink", "a self file became a symlink");
    throw e;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Refusal("not-regular-file", "a self file is not a regular file");
    if ((st.mode & 0o111) !== 0) throw new Refusal("executable", "a self file gained an executable bit");
    if (st.size > MIRROR_MAX_FILE_BYTES) throw new Refusal("oversize", "a self file grew past the limit");
    return new Uint8Array(await fh.readFile());
  } finally {
    await fh.close();
  }
}

/** Write one file into the worktree without following any link on the way, mode 0644. */
async function writeIntoWorktree(worktree: string, rel: string, bytes: Uint8Array): Promise<void> {
  const segs = rel.split("/");
  let dir = worktree;
  for (const s of segs.slice(0, -1)) {
    dir = join(dir, s);
    const st = await lstat(dir).catch(() => null);
    if (!st) await mkdir(dir, { mode: 0o755 });
    else if (st.isSymbolicLink()) throw new Refusal("symlink", "a directory in the mirror worktree is a symlink");
    else if (!st.isDirectory()) throw new Refusal("not-regular-file", "a path in the mirror worktree is not a directory");
  }
  const path = join(worktree, rel);
  const fh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644).catch((e: NodeJS.ErrnoException) => {
    throw e.code === "ELOOP" ? new Refusal("symlink", "a file in the mirror worktree is a symlink") : e;
  });
  try {
    if (!(await fh.stat()).isFile()) throw new Refusal("not-regular-file", "a file in the mirror worktree is not a regular file");
    let off = 0;
    while (off < bytes.length) off += (await fh.write(bytes, off, bytes.length - off)).bytesWritten;
  } finally {
    await fh.close();
  }
  // Clears any executable bit an earlier file at this path had.
  await chmod(path, 0o644);
}

function sealRefusal(e: unknown): SealVerdict | null {
  if (!(e instanceof Refusal)) return null;
  const codes: RefusalCode[] = ["symlink", "executable", "host-owned-path", "oversize", "not-regular-file"];
  if (!codes.includes(e.code)) return null;
  return { ok: false, refused: [{ path: "", code: e.code as SealCode, reason: e.message }] };
}

/** Stage the citizen's sealed files into the mirror worktree; refuses the whole stage on any refused entry. */
export async function stageMirror(config: Config, citizen: Citizen, run: CommandRunner): Promise<SealVerdict> {
  const m = citizen.mirror;
  if (!m) throw new Refusal("invalid-request", "this citizen keeps no mirror");
  await assertWorktree(config, m.worktree);
  const selfDir = join(config.paths.citizens_dir, citizen.word, "self");

  // 1. The citizen's own files, sealed before anything is copied or any git runs.
  let first: SealVerdict;
  const files = new Map<string, Uint8Array>();
  try {
    first = sealCheck(await listTree(selfDir), { allowCard: false });
    if (!first.ok) return first;
    for (const p of first.admitted) files.set(p, await readSealed(join(selfDir, p)));
  } catch (e) {
    const v = sealRefusal(e);
    if (v) return v;
    throw e;
  }
  files.set(MIRROR_CARD_PATH, new TextEncoder().encode(mirrorCard(citizen)));

  // 2. Into the worktree. Files not in this set stay on disk untouched; they simply are not in the next commit.
  try {
    for (const [p, bytes] of files) await writeIntoWorktree(m.worktree, p, bytes);
  } catch (e) {
    const v = sealRefusal(e);
    if (v) return v;
    throw e;
  }

  // 3. The index is exactly these paths, and the tree git built from it is sealed again, as git sees it.
  const wt = m.worktree;
  const paths = [...files.keys()].sort();
  await gitOk(run, wt, ["read-tree", "--empty"]);
  await gitOk(run, wt, ["update-index", "--add", "--", ...paths]);
  const tree = out(await gitOk(run, wt, ["write-tree"])).trim();
  const sealed = sealCheck(parseLsTree((await gitOk(run, wt, ["ls-tree", "-r", "-l", "-z", "--full-tree", tree])).stdout));
  if (!sealed.ok) {
    await git(run, wt, ["read-tree", "HEAD"]);
    return sealed;
  }

  // 4. Commit only a changed tree. The author names the host program, never a person.
  const headTree = await git(run, wt, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"]);
  if (headTree.code === 0 && out(headTree).trim() === tree) return sealed;
  const who = { GIT_AUTHOR_NAME: `${citizen.word} via kingdom-seat`, GIT_AUTHOR_EMAIL: "kingdom-seat@citizens.invalid", GIT_COMMITTER_NAME: "kingdom-seat", GIT_COMMITTER_EMAIL: "kingdom-seat@citizens.invalid" };
  await gitOk(run, wt, ["commit", "--quiet", "--no-verify", "-m", `${citizen.word}: self and status card, staged by kingdom-seat`], who);
  return sealed;
}

/** More commits ahead than this is not a citizen's few beats of self; it is refused rather than walked. */
const MAX_COMMITS_AHEAD = 1_000;

/** Seal the tree of every commit between the fetched remote main and HEAD; the first refusal stops it. */
async function sealHistory(run: CommandRunner, wt: string): Promise<{ ok: true; commits: number } | { ok: false; commits: number; code: RefusalCode }> {
  const r = await gitOk(run, wt, ["rev-list", `--max-count=${MAX_COMMITS_AHEAD + 1}`, `${MIRROR_TRACKING_REF}..HEAD`]);
  const commits = out(r)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (commits.length > MAX_COMMITS_AHEAD) return { ok: false, commits: commits.length, code: "oversize" };
  for (const c of commits) {
    if (!/^[0-9a-f]{40,64}$/.test(c)) return { ok: false, commits: commits.length, code: "invalid-request" };
    const ls = await git(run, wt, ["ls-tree", "-r", "-l", "-z", "--full-tree", c]);
    if (ls.code !== 0) return { ok: false, commits: commits.length, code: "invalid-request" };
    const v = sealCheck(parseLsTree(ls.stdout));
    if (!v.ok) return { ok: false, commits: commits.length, code: v.refused[0]!.code };
  }
  return { ok: true, commits: commits.length };
}

/**
 * Push if and only if the seal passes on HEAD and on every commit the remote
 * lacks, and HEAD is ahead of or equal to the remote; diverged or behind is
 * refused.
 */
export async function pushMirror(config: Config, citizen: Citizen, run: CommandRunner): Promise<PushResult> {
  const note = async (outcome: "refused" | "error", refusal: RefusalCode | null, detail: string) => {
    // Codes and states only: file names in a self are the citizen's words, so none goes into a host note.
    await appendHostNote(config, { ts: new Date().toISOString(), host: config.host, kind: "push", word: citizen.word, outcome, refusal, detail: `mirror push ${detail}` }).catch(() => {});
  };
  const m = citizen.mirror;
  if (!m) return { pushed: false, divergence: "no-upstream", refusal: "invalid-request" };
  try {
    assertRemote(m.remote);
    await assertWorktree(config, m.worktree);
  } catch (e) {
    const code = e instanceof Refusal ? e.code : "invalid-request";
    await note("refused", code, `refused: ${code}`);
    return { pushed: false, divergence: "no-upstream", refusal: code };
  }
  const wt = m.worktree;

  // 1. The seal, on the tree HEAD would publish, as git holds it.
  const ls = await git(run, wt, ["ls-tree", "-r", "-l", "-z", "--full-tree", "HEAD"]);
  if (ls.code !== 0) {
    await note("refused", "invalid-request", "refused: no HEAD to push");
    return { pushed: false, divergence: await localDivergence(run, wt).catch(() => "no-upstream" as const), refusal: "invalid-request" };
  }
  const sealed = sealCheck(parseLsTree(ls.stdout));
  if (!sealed.ok) {
    const code = sealed.refused[0]!.code;
    await note("refused", code, `refused by the seal: ${sealed.refused.length} entries, first ${code}`);
    return { pushed: false, divergence: await localDivergence(run, wt).catch(() => "no-upstream" as const), refusal: code };
  }

  // 2. Fast-forward or nothing: behind, diverged or unknown is refused, and nothing is merged or rebased.
  const d = await divergence(run, wt, m.remote);
  if (d !== "ahead" && d !== "equal") {
    await note("refused", "diverged", `refused: HEAD is ${d}`);
    return { pushed: false, divergence: d, refusal: "diverged" };
  }

  // 3. A push publishes every commit the remote lacks, not only HEAD's tree, so each one is sealed.
  // A commit stageMirror did not make (a workflow added, then removed) would otherwise go out in the history.
  const history = await sealHistory(run, wt);
  if (!history.ok) {
    await note("refused", history.code, `refused by the seal: ${history.commits} commits ahead, one carries ${history.code}`);
    return { pushed: false, divergence: d, refusal: history.code };
  }

  // 4. The one push: HEAD to main, never forced; the remote's own non-fast-forward check is a second wall.
  const r = await run(pushArgv(m.remote), { cwd: wt, env: gitEnv(), timeoutMs: GIT_TIMEOUT_MS });
  if (r.code !== 0) {
    await note("error", null, `failed: git push exited ${r.code}`);
    return { pushed: false, divergence: d, refusal: `push exited ${r.code}` };
  }
  return { pushed: true, divergence: d, refusal: null };
}
