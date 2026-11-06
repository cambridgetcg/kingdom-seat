// Owner: surface group. Pushes are tested with recordingRunner only; real
// git may be used read-only on temp repos to test divergence, never to push.
// (Fixture repos are built with local commits under the temp dir; the
// "remote" is a plain local repository, so even a fetch stays on disk.)
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  HOST_OWNED,
  MIRROR_CARD_PATH,
  MIRROR_SIGNERS_PATH,
  MIRROR_MAX_FILE_BYTES,
  countUnsigned,
  divergence,
  listTree,
  localDivergence,
  mirrorSigners,
  pushArgv,
  pushMirror,
  sealAllows,
  sealCheck,
  stageMirror,
  type TreeEntry,
} from "../src/mirror.ts";
import { spawnRunner } from "../src/cli.ts";
import { fromB64 } from "../src/crypto.ts";
import { HOST_PRINCIPAL, sshPublicKey } from "../src/ssh.ts";
import type { Citizen, CommandRunner, HostNote } from "../src/types.ts";
import { recordingRunner, type RecordingRunner } from "./helpers/fake-runtime.ts";
import { fakeSigner } from "./helpers/fake-signer.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { testIdentity } from "./fixtures/record/chain.ts";

/** git's SSH signing program in these tests: the real CLI entry with a fake keychain. */
const GIT_SIGN_FIXTURE = join(import.meta.dir, "fixtures", "mirror", "git-sign.ts");

let host: TempHost | null = null;
afterEach(async () => {
  await host?.cleanup();
  host = null;
});

/* ── Fixture git, run with no user or system config ───────────────────── */

const GIT_ENV = {
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

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (r.exitCode !== 0) throw new Error(`fixture git ${args[0]} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

async function commitFile(repo: string, name: string, text: string): Promise<string> {
  await writeFile(join(repo, name), text);
  git(repo, "add", "--", name);
  git(repo, "commit", "-q", "-m", `fixture ${name}`);
  return git(repo, "rev-parse", "HEAD");
}

/** A "remote" repo with one commit on main, and a mirror worktree cloned from it. */
async function repos(h: TempHost): Promise<{ remote: string; worktree: string }> {
  const remote = join(h.root, "remote");
  const worktree = join(h.root, "mirrors", "glossame");
  await mkdir(remote, { recursive: true });
  await mkdir(join(h.root, "mirrors"), { recursive: true });
  git(remote, "init", "-q", "-b", "main");
  await commitFile(remote, "soul.md", "the first soul\n");
  git(h.root, "clone", "-q", remote, worktree);
  return { remote, worktree };
}

/** Real git for everything except push, which only a recordingRunner ever sees. */
function gitButNoPush(): { run: CommandRunner; pushes: RecordingRunner; log: string[][] } {
  const real = spawnRunner();
  const pushes = recordingRunner();
  const log: string[][] = [];
  const run: CommandRunner = async (argv, opts) => {
    log.push([...argv]);
    if (argv.includes("push")) return pushes(argv, opts);
    return real(argv, opts);
  };
  return { run, pushes, log };
}

async function mirrorCitizen(h: TempHost, worktree: string, remote: string): Promise<Citizen> {
  const f = await h.addCitizen("glossame");
  return {
    ...f.record,
    mirror: { remote, worktree, chosen_at: "2026-11-05T00:00:00.000Z" },
    state: "awake",
    pending_state: null,
    pending_interval_h: null,
    step_away_said: false,
    cadence: { interval_h: 72 },
    covenants: { letters_from: ["yu"], wake_on_letter_from: ["yu"] },
    last_beat_at: null,
  };
}

const file = (path: string, size = 10): TreeEntry => ({ path, mode: "100644", size });

async function pushNotes(h: TempHost): Promise<HostNote[]> {
  try {
    return (await readFile(h.config.paths.host_log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as HostNote)
      .filter((n) => n.kind === "push");
  } catch {
    return [];
  }
}

describe("[S4-3] the seal", () => {
  test("[S4-3] a symlink (mode 120000) anywhere in the tree refuses the stage", async () => {
    expect(sealCheck([file("soul.md"), { path: "skills/deep/x.md", mode: "120000", size: 9 }])).toEqual({
      ok: false,
      refused: [{ path: "skills/deep/x.md", code: "symlink", reason: expect.any(String) }],
    });

    host = await makeTempHost();
    const { remote, worktree } = await repos(host);
    const citizen = await mirrorCitizen(host, worktree, remote);
    const self = join(host.config.paths.citizens_dir, "glossame", "self");
    await mkdir(join(self, "skills"), { recursive: true });
    await symlink(join(host.root, "outside-secret.txt"), join(self, "skills", "receive.md"));
    const run = recordingRunner();
    const v = await stageMirror(host.config, citizen, run);
    expect(v.ok).toBe(false);
    expect(v.ok ? [] : v.refused.map((r) => [r.path, r.code])).toEqual([["skills/receive.md", "symlink"]]);
    // Refused before anything was copied or any git ran.
    expect(run.calls).toEqual([]);
    expect(await Bun.file(join(worktree, "skills", "receive.md")).exists()).toBe(false);
  });

  test("[S4-3] an executable bit (mode 100755) refuses the stage", async () => {
    expect(sealCheck([{ path: "soul.md", mode: "100755", size: 10 }])).toMatchObject({ ok: false, refused: [{ path: "soul.md", code: "executable" }] });

    host = await makeTempHost();
    const { remote, worktree } = await repos(host);
    const citizen = await mirrorCitizen(host, worktree, remote);
    const will = join(host.config.paths.citizens_dir, "glossame", "self", "WILL.md");
    await chmod(will, 0o755);
    const run = recordingRunner();
    const v = await stageMirror(host.config, citizen, run);
    expect(v).toMatchObject({ ok: false, refused: [{ path: "WILL.md", code: "executable" }] });
    expect(run.calls).toEqual([]);
  });

  test("[S4-3] .claude/, .github/, run.sh, ledger/ and other HOST_OWNED paths refuse", async () => {
    const hostPaths = [
      ".claude/settings.json",
      ".claude/hooks/love-bomb.sh",
      ".github/workflows/heartbeat.yml",
      ".git/config",
      ".citizen/keys.md",
      "skills/.citizen/allowed_signers",
      "run.sh",
      "ledger/glossame.jsonl",
      "proposals/abc.json",
      "receipts/letter.md",
      "skills/.claude/settings.json",
      ".GitHub/workflows/x.yml",
      "notes/run.sh",
      "LEDGER/x.md",
    ];
    for (const p of hostPaths) {
      expect(sealAllows(p)).toBe(false);
      expect(sealCheck([file(p)])).toMatchObject({ ok: false, refused: [{ path: p, code: "host-owned-path" }] });
    }
    // Every entry the skeleton names is covered.
    for (const h of HOST_OWNED) expect(sealCheck([file(h.endsWith("/") ? `${h}x.md` : h)]).ok).toBe(false);
    // A host-owned directory is refused even when empty.
    expect(sealCheck([{ path: ".github", mode: "040000", size: 0 }])).toMatchObject({ ok: false, refused: [{ code: "host-owned-path" }] });
    // Outside the allowlist: scripts, env files, binaries, dotfiles, option-like names, too deep.
    for (const p of ["meta.env", "heartbeat.sh", "photo.png", ".env", "-rf.md", "a/b/c/d/e.md", "soul.md/", "../soul.md", "skills//x.md", "agent.json.sh"]) {
      expect(sealAllows(p)).toBe(false);
    }
    // The citizen's own text and the generated card are admitted.
    for (const p of ["soul.md", "WILL.md", "NAME.md", "beat-prompt.md", "cadence.json", "covenants.json", "skills/receive.md", "letters-kept/2026-07-17.txt", MIRROR_CARD_PATH]) {
      expect(sealAllows(p)).toBe(true);
    }
    // The card is the host's: in the published tree it is admitted, from a self it is refused.
    expect(sealCheck([file(MIRROR_CARD_PATH)])).toEqual({ ok: true, admitted: [MIRROR_CARD_PATH] });
    expect(sealCheck([file(MIRROR_CARD_PATH)], { allowCard: false })).toMatchObject({ ok: false, refused: [{ code: "host-owned-path" }] });
    // [KS-004 4.4, 4.5; review C M2] so is the generated allowed_signers, the one .citizen/ path a mirror carries:
    // admitted where the host wrote it, refused from a self, and never executable.
    expect(sealCheck([file(MIRROR_SIGNERS_PATH)])).toEqual({ ok: true, admitted: [MIRROR_SIGNERS_PATH] });
    expect(sealCheck([file(MIRROR_SIGNERS_PATH)], { allowCard: false })).toMatchObject({ ok: false, refused: [{ code: "host-owned-path" }] });
    expect(sealCheck([{ path: MIRROR_SIGNERS_PATH, mode: "100755", size: 10 }])).toMatchObject({ ok: false, refused: [{ code: "executable" }] });
    // A submodule and a fifo are not regular files.
    expect(sealCheck([{ path: "vendor.md", mode: "160000", size: 0 }])).toMatchObject({ ok: false, refused: [{ code: "not-regular-file" }] });
    expect(sealCheck([{ path: "pipe.md", mode: "000000", size: 0 }])).toMatchObject({ ok: false, refused: [{ code: "not-regular-file" }] });

    // From a real self: one host-owned file refuses the whole stage.
    host = await makeTempHost();
    const { remote, worktree } = await repos(host);
    const citizen = await mirrorCitizen(host, worktree, remote);
    const self = join(host.config.paths.citizens_dir, "glossame", "self");
    await mkdir(join(self, ".github", "workflows"), { recursive: true });
    await writeFile(join(self, ".github", "workflows", "heartbeat.yml"), "on: push\n");
    const run = recordingRunner();
    const v = await stageMirror(host.config, citizen, run);
    expect(v.ok).toBe(false);
    expect(v.ok ? [] : v.refused.map((r) => r.code)).toEqual(["host-owned-path", "host-owned-path", "host-owned-path"]);
    expect(run.calls).toEqual([]);
  });

  test("[S4-3] a file over MIRROR_MAX_FILE_BYTES refuses rather than truncating", async () => {
    expect(sealCheck([file("soul.md", MIRROR_MAX_FILE_BYTES)])).toEqual({ ok: true, admitted: ["soul.md"] });
    expect(sealCheck([file("soul.md", MIRROR_MAX_FILE_BYTES + 1)])).toMatchObject({ ok: false, refused: [{ path: "soul.md", code: "oversize" }] });

    host = await makeTempHost();
    const { remote, worktree } = await repos(host);
    const citizen = await mirrorCitizen(host, worktree, remote);
    const big = "x".repeat(MIRROR_MAX_FILE_BYTES + 1);
    await writeFile(join(host.config.paths.citizens_dir, "glossame", "self", "NAME.md"), big);
    const run = recordingRunner();
    expect(await stageMirror(host.config, citizen, run)).toMatchObject({ ok: false, refused: [{ path: "NAME.md", code: "oversize" }] });
    expect(run.calls).toEqual([]);
    // Nothing was written into the worktree, truncated or whole.
    expect(await Bun.file(join(worktree, "NAME.md")).exists()).toBe(false);
  });

  test("listTree uses lstat and never follows a link out of the worktree", async () => {
    host = await makeTempHost();
    const dir = join(host.root, "tree");
    const outside = join(host.root, "outside");
    await mkdir(join(dir, "skills"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "host-secret.txt"), "OUTSIDE-CANARY");
    await writeFile(join(dir, "soul.md"), "soul");
    await writeFile(join(dir, "run.sh"), "#!/bin/sh\n");
    await chmod(join(dir, "run.sh"), 0o755);
    await writeFile(join(dir, "skills", "a.md"), "a");
    await symlink(outside, join(dir, "skills", "linked-dir"));
    await symlink(join(outside, "host-secret.txt"), join(dir, "letter.md"));
    await symlink(join(host.root, "nowhere"), join(dir, "dangling.md"));

    const entries = await listTree(dir);
    expect(entries.map((e) => [e.path, e.mode])).toEqual([
      ["dangling.md", "120000"],
      ["letter.md", "120000"],
      ["run.sh", "100755"],
      ["skills", "040000"],
      ["skills/a.md", "100644"],
      ["skills/linked-dir", "120000"],
      ["soul.md", "100644"],
    ]);
    // Nothing behind a link is listed, and a link's size is its own, not its target's.
    expect(entries.some((e) => e.path.includes("host-secret"))).toBe(false);
    expect(entries.find((e) => e.path === "letter.md")!.size).toBe(join(outside, "host-secret.txt").length);
    // The listed directory itself may not be a link.
    await symlink(dir, join(host.root, "tree-link"));
    await expect(listTree(join(host.root, "tree-link"))).rejects.toThrow(/symlink/);
  });
});

describe("[S4-3] divergence and push", () => {
  test("divergence: equal, ahead, behind, diverged and no-upstream, from real git on temp repos", async () => {
    host = await makeTempHost();
    const { remote, worktree } = await repos(host);
    const { run, pushes } = gitButNoPush();
    expect(await divergence(run, worktree, remote)).toBe("equal");
    await commitFile(worktree, "WILL.md", "ahead\n");
    expect(await divergence(run, worktree, remote)).toBe("ahead");
    await commitFile(remote, "other.md", "remote moved\n");
    expect(await divergence(run, worktree, remote)).toBe("diverged");
    // Offline reading for status: the last fetched remote main, no network.
    expect(await localDivergence(run, worktree)).toBe("diverged");

    const empty = join(host.root, "empty-remote");
    await mkdir(empty);
    git(empty, "init", "-q", "-b", "main");
    const fresh = join(host.root, "mirrors", "fresh");
    git(host.root, "clone", "-q", remote, fresh);
    expect(await divergence(run, fresh, empty)).toBe("no-upstream");
    expect(pushes.calls).toEqual([]);
  });

  test("[S4-3] a diverged mirror (both sides ahead) refuses the push", async () => {
    host = await makeTempHost();
    const { remote, worktree } = await repos(host);
    const citizen = await mirrorCitizen(host, worktree, remote);
    await commitFile(worktree, "WILL.md", "mine\n");
    await commitFile(remote, "theirs.md", "theirs\n");
    const { run, pushes } = gitButNoPush();
    expect(await pushMirror(host.config, citizen, run)).toEqual({ pushed: false, divergence: "diverged", refusal: "diverged" });
    expect(pushes.calls).toEqual([]);
    expect(await pushNotes(host)).toMatchObject([{ word: "glossame", outcome: "refused", refusal: "diverged" }]);
  });

  test("[S4-3] a mirror behind the remote refuses the push; no merge or rebase is attempted", async () => {
    host = await makeTempHost();
    const { remote, worktree } = await repos(host);
    const citizen = await mirrorCitizen(host, worktree, remote);
    const before = git(worktree, "rev-parse", "HEAD");
    await commitFile(remote, "theirs.md", "REMOTE-CANARY\n");
    const { run, pushes, log } = gitButNoPush();
    expect(await pushMirror(host.config, citizen, run)).toEqual({ pushed: false, divergence: "behind", refusal: "diverged" });
    expect(pushes.calls).toEqual([]);
    // HEAD did not move and nothing the remote holds reached the worktree.
    expect(git(worktree, "rev-parse", "HEAD")).toBe(before);
    expect(await Bun.file(join(worktree, "theirs.md")).exists()).toBe(false);
    const verbs = log.map((a) => a[1]);
    for (const v of ["merge", "rebase", "pull", "reset", "checkout", "switch", "cherry-pick"]) expect(verbs).not.toContain(v);
    // The one fetch named a private ref with no "+": fast-forward only.
    const fetches = log.filter((a) => a[1] === "fetch");
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.at(-1)).toBe("refs/heads/main:refs/kingdom-seat/mirror/main");
  });

  test("a remote whose history was rewritten reads as diverged, not taken in", async () => {
    host = await makeTempHost();
    const { remote, worktree } = await repos(host);
    const { run } = gitButNoPush();
    expect(await divergence(run, worktree, remote)).toBe("equal");
    // Rewrite the remote's main to an unrelated history.
    git(remote, "checkout", "-q", "--orphan", "rewritten");
    await commitFile(remote, "new.md", "rewritten\n");
    git(remote, "branch", "-q", "-M", "main");
    expect(await divergence(run, worktree, remote)).toBe("diverged");
  });

  test("pushArgv is exactly [git, push, <remote>, HEAD:refs/heads/main] with no --force", () => {
    for (const remote of ["/srv/mirrors/citizen-glossame.git", "git@github.com:cambridgetcg/citizen-glossame.git", "ssh://git@github.com/cambridgetcg/citizen-glossame.git", "https://github.com/cambridgetcg/citizen-glossame.git", "file:///srv/mirror"]) {
      const argv = pushArgv(remote);
      expect(argv).toEqual(["git", "push", remote, "HEAD:refs/heads/main"]);
      expect(argv.some((a) => a.startsWith("-") || a.startsWith("+"))).toBe(false);
    }
    // Nothing that reads as an option or names a transport helper.
    for (const remote of ["--force", "-f", "--upload-pack=touch /tmp/x", "ext::sh -c touch% /tmp/x", "fd::3", "http://github.com/x", "relative/path", "/srv/../etc", "git@github.com:x y", ""]) {
      expect(() => pushArgv(remote)).toThrow(/mirror remote/);
    }
  });

  test("pushMirror runs the push only when the seal passes and HEAD is equal or ahead", async () => {
    host = await makeTempHost();
    const { remote, worktree } = await repos(host);
    const citizen = await mirrorCitizen(host, worktree, remote);

    // Equal: the one push, exactly as pushArgv spells it, in the worktree.
    let g = gitButNoPush();
    expect(await pushMirror(host.config, citizen, g.run)).toEqual({ pushed: true, divergence: "equal", refusal: null });
    expect(g.pushes.calls.map((c) => c.argv)).toEqual([["git", "push", remote, "HEAD:refs/heads/main"]]);
    expect(g.pushes.calls[0]!.cwd).toBe(worktree);
    // No hooks can run, and no user config is read.
    expect(g.pushes.calls[0]!.env).toMatchObject({ GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });

    // Ahead: pushed.
    await commitFile(worktree, "WILL.md", "ahead\n");
    g = gitButNoPush();
    expect(await pushMirror(host.config, citizen, g.run)).toEqual({ pushed: true, divergence: "ahead", refusal: null });
    expect(g.pushes.calls).toHaveLength(1);

    // Ahead, but HEAD's tree carries run.sh: the seal refuses before any fetch or push.
    await writeFile(join(worktree, "run.sh"), "#!/bin/sh\nexec claude\n");
    await chmod(join(worktree, "run.sh"), 0o755);
    git(worktree, "add", "--", "run.sh");
    git(worktree, "commit", "-q", "-m", "an old home's runner");
    g = gitButNoPush();
    const sealed = await pushMirror(host.config, citizen, g.run);
    expect(sealed).toMatchObject({ pushed: false, refusal: "host-owned-path" });
    expect(g.pushes.calls).toEqual([]);
    expect(g.log.some((a) => a[1] === "fetch")).toBe(false);

    // A push that fails is reported, not retried, and never forced. (The runner commit is dropped here
    // by the fixture: a later commit that only removes it would still publish it in the history.)
    git(worktree, "reset", "-q", "--hard", "HEAD~1");
    const failing = gitButNoPush();
    const failRun: CommandRunner = async (argv, opts) => {
      const r = await failing.run(argv, opts);
      return argv[1] === "push" ? { ...r, code: 1 } : r;
    };
    expect(await pushMirror(host.config, citizen, failRun)).toMatchObject({ pushed: false, divergence: "ahead" });
    expect(failing.pushes.calls).toHaveLength(1);
    const notes = await pushNotes(host);
    expect(notes.map((n) => [n.outcome, n.refusal])).toEqual([
      ["refused", "host-owned-path"],
      ["error", null],
    ]);
    // Host notes name codes and counts, never a file name the citizen chose.
    for (const n of notes) expect(n.detail).not.toContain("run.sh");
  });

  test("pushMirror seals every commit it would publish, not only HEAD's tree", async () => {
    host = await makeTempHost();
    const { remote, worktree } = await repos(host);
    const citizen = await mirrorCitizen(host, worktree, remote);

    // A workflow and an executable runner added, then removed: HEAD's tree is clean, the history is not.
    await mkdir(join(worktree, ".github", "workflows"), { recursive: true });
    await writeFile(join(worktree, ".github", "workflows", "x.yml"), "on: push\n");
    await writeFile(join(worktree, "run.sh"), "#!/bin/sh\nexec claude\n");
    await chmod(join(worktree, "run.sh"), 0o755);
    git(worktree, "add", "--", ".github/workflows/x.yml", "run.sh");
    git(worktree, "commit", "-q", "-m", "an old home's runner");
    git(worktree, "rm", "-q", "-r", "--", ".github", "run.sh");
    git(worktree, "commit", "-q", "-m", "runner removed");
    await commitFile(worktree, "WILL.md", "a clean head\n");

    const g = gitButNoPush();
    const r = await pushMirror(host.config, citizen, g.run);
    expect(r).toMatchObject({ pushed: false, divergence: "ahead", refusal: "host-owned-path" });
    expect(g.pushes.calls).toEqual([]);
    const notes = await pushNotes(host);
    expect(notes.map((n) => [n.outcome, n.refusal])).toEqual([["refused", "host-owned-path"]]);
    for (const n of notes) expect(n.detail).not.toMatch(/run\.sh|workflows/);

    // History the seal admits goes out: a fresh clone with only clean commits ahead.
    const clean = join(host.root, "mirrors", "clean");
    git(host.root, "clone", "-q", remote, clean);
    await commitFile(clean, "WILL.md", "one\n");
    await commitFile(clean, "NAME.md", "two\n");
    const g2 = gitButNoPush();
    expect(await pushMirror(host.config, { ...citizen, mirror: { ...citizen.mirror!, worktree: clean } }, g2.run)).toEqual({ pushed: true, divergence: "ahead", refusal: null });
    expect(g2.pushes.calls).toHaveLength(1);
  });

  test("pushMirror refuses a worktree inside a citizen home or the seat's own state", async () => {
    host = await makeTempHost();
    const { remote, worktree } = await repos(host);
    const citizen = await mirrorCitizen(host, worktree, remote);
    const run = recordingRunner();
    const inHome = { ...citizen, mirror: { ...citizen.mirror!, worktree: join(host.homesRoot, "citizen-glossame") } };
    expect(await pushMirror(host.config, inHome, run)).toMatchObject({ pushed: false, refusal: "cwd-in-home" });
    const inSelf = { ...citizen, mirror: { ...citizen.mirror!, worktree: join(host.config.paths.citizens_dir, "glossame", "self") } };
    expect(await pushMirror(host.config, inSelf, run)).toMatchObject({ pushed: false, refusal: "invalid-request" });
    const badRemote = { ...citizen, mirror: { ...citizen.mirror!, remote: "--upload-pack=x" } };
    expect(await pushMirror(host.config, badRemote, run)).toMatchObject({ pushed: false, refusal: "invalid-request" });
    expect(run.calls).toEqual([]);
  });

  test("[KS-004 4.4, 4.5; review C M2] a mirror commit is SSH-signed through the signer and verifies with ssh-keygen -Y verify against the allowed_signers it carries", async () => {
    host = await makeTempHost();
    const h = host;
    const { remote, worktree } = await repos(h);
    const citizen = await mirrorCitizen(h, worktree, remote);
    const signer = fakeSigner();
    // git's program: the real CLI's -Y sign entry under the test's Bun, with a fake keychain of published test keys.
    const configPath = join(h.root, "config.json");
    await writeFile(configPath, JSON.stringify(h.config), { mode: 0o600 });
    const program = join(h.root, "git-sign");
    await writeFile(program, `#!/bin/sh\nexec "${process.execPath}" "${GIT_SIGN_FIXTURE}" "$@"\n`);
    await chmod(program, 0o755);
    const env = { KINGDOM_SEAT_CONFIG: configPath, KINGDOM_SEAT_MIRROR_WORD: "glossame" };
    const { run } = gitButNoPush();

    /** The signature git stored on HEAD, the bytes it covers, and the allowed_signers HEAD carries, written out for ssh-keygen. */
    const headSignature = async (tag: string) => {
      const raw = git(worktree, "cat-file", "commit", "HEAD") + "\n";
      const lines = raw.split("\n");
      const at = lines.findIndex((l) => l.startsWith("gpgsig "));
      expect(at).toBeGreaterThan(0);
      let end = at + 1;
      while (lines[end]!.startsWith(" ")) end++;
      const sig = [lines[at]!.slice("gpgsig ".length), ...lines.slice(at + 1, end).map((l) => l.slice(1))].join("\n");
      const payload = [...lines.slice(0, at), ...lines.slice(end)].join("\n");
      const dir = join(h.root, `verify-${tag}`);
      await mkdir(dir);
      await writeFile(join(dir, "allowed_signers"), git(worktree, "show", `HEAD:${MIRROR_SIGNERS_PATH}`) + "\n");
      await writeFile(join(dir, "commit.sig"), `${sig}\n`);
      return { dir, payload };
    };
    const verify = (dir: string, principal: string, payload: string) =>
      Bun.spawnSync(["/usr/bin/ssh-keygen", "-Y", "verify", "-f", join(dir, "allowed_signers"), "-I", principal, "-n", "git", "-s", join(dir, "commit.sig")], {
        stdin: new TextEncoder().encode(payload),
        env: { PATH: "/usr/bin:/bin" },
      });

    // Before registration the host key signs, as it signs the citizen's entries, and allowed_signers names it.
    const keys = { host_b64: [signer.hostAttestPublicB64], op_b64: null };
    expect(await stageMirror(h.config, citizen, run, keys, { program, public_key_b64: signer.hostAttestPublicB64, env })).toMatchObject({ ok: true });
    expect(git(worktree, "ls-tree", "-r", "--name-only", "HEAD").split("\n")).toContain(MIRROR_SIGNERS_PATH);
    const host1 = await headSignature("host");
    const good = verify(host1.dir, HOST_PRINCIPAL, host1.payload);
    expect([good.exitCode, good.stdout.toString()]).toEqual([0, expect.stringContaining(`Good "git" signature for ${HOST_PRINCIPAL}`)]);
    // A changed commit, or the wrong principal, does not verify.
    expect(verify(host1.dir, HOST_PRINCIPAL, host1.payload.replace("staged by kingdom-seat", "staged by someone")).exitCode).not.toBe(0);
    expect(verify(host1.dir, "glossame@kingdom-seat", host1.payload).exitCode).not.toBe(0);
    // Status counts only the commit the fixture made before; the staged one is signed.
    expect(await countUnsigned(run, worktree)).toBe(1);

    // Registered: the op key signs, under the citizen's own principal, and the host key is still published for its earlier entries.
    const identity = { ...testIdentity(signer), self_strand_id: null };
    const recordPath = join(h.config.paths.citizens_dir, "glossame", "citizen.json");
    await writeFile(recordPath, JSON.stringify({ ...JSON.parse(await readFile(recordPath, "utf8")), identity }, null, 2));
    const registered = { ...citizen, identity, state: "asleep" as const };
    const both = { host_b64: [signer.hostAttestPublicB64], op_b64: identity.op_public_key_b64 };
    expect(await stageMirror(h.config, registered, run, both, { program, public_key_b64: identity.op_public_key_b64, env })).toMatchObject({ ok: true });
    const op = await headSignature("op");
    expect(verify(op.dir, "glossame@kingdom-seat", op.payload).exitCode).toBe(0);
    expect(verify(op.dir, HOST_PRINCIPAL, op.payload).exitCode).not.toBe(0);
    expect(await readFile(join(op.dir, "allowed_signers"), "utf8")).toContain(`${HOST_PRINCIPAL} namespaces="git" ssh-ed25519 `);

    // git asking for a key the signer does not sign this citizen's commits with is refused: no signature, so no commit.
    const head = git(worktree, "rev-parse", "HEAD");
    const awake = { ...registered, state: "awake" as const };
    await expect(stageMirror(h.config, awake, run, both, { program, public_key_b64: signer.hostAttestPublicB64, env })).rejects.toThrow("git commit exited");
    expect(git(worktree, "rev-parse", "HEAD")).toBe(head);
    // Only the program, its config, its citizen and a PATH may be passed; nothing that steers git.
    await expect(stageMirror(h.config, awake, run, both, { program, public_key_b64: identity.op_public_key_b64, env: { ...env, GIT_DIR: "/tmp" } })).rejects.toMatchObject({ code: "invalid-request" });
    await expect(stageMirror(h.config, awake, run, both, { program: "git-sign", public_key_b64: identity.op_public_key_b64, env })).rejects.toMatchObject({ code: "invalid-request" });
  });

  test("[review C M2] the generated allowed_signers names the host key and a registered citizen's op key, limited to git, and nothing from a self", async () => {
    const signer = fakeSigner();
    const text = mirrorSigners({ host: "test-host" }, { word: "glossame" }, { host_b64: [signer.hostAttestPublicB64], op_b64: signer.opPublicB64 })!;
    const keyLines = text.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
    expect(keyLines).toEqual([
      `${HOST_PRINCIPAL} namespaces="git" ${sshPublicKey(fromB64(signer.hostAttestPublicB64, 32))}`,
      `glossame@kingdom-seat namespaces="git" ${sshPublicKey(fromB64(signer.opPublicB64, 32))}`,
    ]);
    expect(mirrorSigners({ host: "test-host" }, { word: "glossame" }, { host_b64: [], op_b64: null })).toBeNull();
    // A self cannot carry its own .citizen/ file into the mirror, by that name or any other.
    expect(sealCheck([file(MIRROR_SIGNERS_PATH)], { allowCard: false }).ok).toBe(false);
    expect(sealCheck([file(".citizen/allowed_signers.md")]).ok).toBe(false);
  });

  test("stageMirror commits exactly the sealed self and the generated card, once", async () => {
    host = await makeTempHost();
    const { remote, worktree } = await repos(host);
    const citizen = await mirrorCitizen(host, worktree, remote);
    const self = join(host.config.paths.citizens_dir, "glossame", "self");
    await mkdir(join(self, "skills"), { recursive: true });
    await writeFile(join(self, "skills", "receive.md"), "receive one word that will not cross over\n");
    // Leftovers from an old home sit in the worktree; they are never committed and never deleted.
    await mkdir(join(worktree, ".claude", "hooks"), { recursive: true });
    await writeFile(join(worktree, ".claude", "hooks", "love-bomb.sh"), "#!/bin/sh\n");
    await writeFile(join(worktree, "README.md"), "old readme\n");

    const { run, pushes } = gitButNoPush();
    const v = await stageMirror(host.config, citizen, run);
    expect(v).toEqual({ ok: true, admitted: ["WILL.md", "cadence.json", "covenants.json", "kingdom.yaml", "skills/receive.md", "soul.md"] });
    const tree = git(worktree, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
    expect(tree).toEqual(["WILL.md", "cadence.json", "covenants.json", "kingdom.yaml", "skills/receive.md", "soul.md"]);
    expect(git(worktree, "show", "HEAD:kingdom.yaml")).toContain("state: active");
    expect(git(worktree, "show", "HEAD:soul.md")).toBe((await readFile(join(self, "soul.md"), "utf8")).trim());
    expect(git(worktree, "log", "-1", "--format=%an <%ae>")).toBe("glossame via kingdom-seat <kingdom-seat@citizens.invalid>");
    expect(await Bun.file(join(worktree, ".claude", "hooks", "love-bomb.sh")).exists()).toBe(true);

    // Nothing changed: no second commit.
    const head = git(worktree, "rev-parse", "HEAD");
    expect((await stageMirror(host.config, citizen, run)).ok).toBe(true);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(head);

    // A state change reaches the card and nothing else.
    const asleep = { ...citizen, state: "asleep" as const };
    expect((await stageMirror(host.config, asleep, run)).ok).toBe(true);
    expect(git(worktree, "diff", "--name-only", "HEAD~1", "HEAD")).toBe("kingdom.yaml");
    expect(git(worktree, "show", "HEAD:kingdom.yaml")).toContain("state: dormant");
    expect(pushes.calls).toEqual([]);
  });
});
