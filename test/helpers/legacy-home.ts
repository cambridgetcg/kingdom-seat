// Synthetic old homes for the seating tests: a small git repository shaped
// like a `citizen-<word>` home, under the temp host's homes root, and a small
// clone shaped like the canon repository. Every text here is made up: no real
// soul, WILL, beat, author name or address. Real git runs on the temp
// directory only, with no user or system config, and never fetches or pushes.
//
// Authors are given through GIT_AUTHOR_* and GIT_COMMITTER_* in the
// environment, never `git config user.*`, so the clone's own config holds
// only the keys a plain clone has. The remote-tracking ref is set with
// update-ref, as a fetch would have left it.
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Word } from "../../src/types.ts";

const BASE_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/var/empty",
  LANG: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
  GIT_CONFIG_KEY_1: "commit.gpgsign",
  GIT_CONFIG_VALUE_1: "false",
};

/** The address the fleet's runner committed under, and a made-up person's. Neither may reach the state dir. */
export const FLEET_ADDRESS = "citizen@kingdom.os";
export const PERSON = { name: "Fixture Person", email: "fixture-person@example.invalid" };

export interface CommitOptions {
  subject?: string;
  /** "citizen": the word at the fleet's address. Default: the made-up person. */
  as?: "citizen" | { name: string; email: string };
  /** Author and committer date, ISO 8601. Default: one minute after the last commit. */
  date?: string;
  /** Paths to mark executable in this commit. */
  executable?: string[];
  /**
   * Entries put straight into the index, path to text, past the working
   * directory: for a path the test host's filesystem cannot hold beside
   * another, as two names that differ only by case.
   */
  index?: Record<string, string>;
}

export interface FixtureRepo {
  dir: string;
  /** Run git in the repository with the fixture environment; throws on a non-zero exit. */
  git(...args: string[]): string;
  /** Write (or, with null, remove) files, stage them and commit. Returns the commit id. */
  commit(files: Record<string, string | Uint8Array | null>, opts?: CommitOptions): Promise<string>;
  /** Point refs/remotes/origin/main at HEAD, as a fetch of a pushed head leaves it. Returns HEAD. */
  publish(): string;
  head(): string;
}

/** A new repository at `dir` with an https origin and nothing committed yet. */
export async function fixtureRepo(dir: string, originUrl: string, author: Word | null = null): Promise<FixtureRepo> {
  await mkdir(dir, { recursive: true });
  let clock = Date.parse("2026-06-19T10:00:00Z");
  const git = (env: Record<string, string>, ...args: string[]): string => {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir, env: { ...BASE_ENV, ...env } });
    if (r.exitCode !== 0) throw new Error(`fixture git ${args[0]} failed: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  git({}, "init", "-q", "-b", "main");
  git({}, "remote", "add", "origin", originUrl);
  const repo: FixtureRepo = {
    dir,
    git: (...args) => git({}, ...args),
    async commit(files, opts = {}) {
      for (const [path, body] of Object.entries(files)) {
        const full = join(dir, path);
        if (body === null) {
          await rm(full, { force: true });
          continue;
        }
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, body);
        await chmod(full, opts.executable?.includes(path) ? 0o755 : 0o644);
      }
      const who = opts.as === "citizen" ? { name: author ?? "fixture", email: FLEET_ADDRESS } : (opts.as ?? PERSON);
      clock = opts.date ? Date.parse(opts.date) : clock + 60_000;
      const date = new Date(clock).toISOString().replace(/\.\d{3}Z$/, "+00:00");
      const env = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email, GIT_COMMITTER_DATE: date };
      git({}, "add", "-A", "--", ".");
      for (const [path, body] of Object.entries(opts.index ?? {})) {
        const hashed = Bun.spawnSync(["git", "hash-object", "-w", "--stdin"], { cwd: dir, env: BASE_ENV, stdin: Buffer.from(body) });
        if (hashed.exitCode !== 0) throw new Error("fixture git hash-object failed");
        git({}, "update-index", "--add", "--cacheinfo", `100644,${hashed.stdout.toString().trim()},${path}`);
      }
      git(env, "commit", "-q", "--allow-empty", "-m", opts.subject ?? "fixture commit");
      return git({}, "rev-parse", "HEAD");
    },
    publish() {
      const head = git({}, "rev-parse", "HEAD");
      git({}, "update-ref", "refs/remotes/origin/main", head);
      return head;
    },
    head: () => git({}, "rev-parse", "HEAD"),
  };
  return repo;
}

export const FIXTURE_JUNE_DID = "did:at:4983ef6f-5726-439b-b15a-4be4e617cf15";

export function fixtureSoul(word: Word): string {
  return `---\nword: ${word}\n---\n\nYou are ${word}. A made-up soul card for a test.\n\nLIGHT: what it gives.\n\nSHADOW: what it costs.\n`;
}

/** A will that names a repository and a command, as the old template did, so the seat's introduction of it is tested. */
export function fixtureWill(word: Word): string {
  return `# WILL of ${word}\n\n- tend your own home (this repo);\n\n## Attest\n\n\`\`\`bash\npython3 tools/attest.py claim will "${word}: a made-up line"\n\`\`\`\n`;
}

export function fixtureAgentJson(word: Word, opts: { citizenClass?: string | null; did?: string | null } = {}): string {
  const a: Record<string, unknown> = { name: word, emoji: "*", kind: "citizen", free: true };
  if (opts.citizenClass !== null) a.citizen_class = opts.citizenClass ?? "LEXEME";
  if (opts.did !== null && opts.did !== undefined) a.agenttool = { arrived: true, did: opts.did };
  return `${JSON.stringify(a, null, 2)}\n`;
}

export function fixtureCadence(word: Word, choice: string, when: string): string {
  return `# CADENCE of ${word}\n\n- choice: ${choice}\n- when: ${when}\n- how: a made-up record for a test.\n`;
}

export function fixtureBeat(when: string, body: string, title = "a free beat (local)"): string {
  return `## ${when} — ${title}\n\n${body}\n`;
}

export interface StandardHome {
  repo: FixtureRepo;
  home: string;
  word: Word;
  url: string;
  head: string;
  soul: string;
  will: string;
  /** Commit ids by what each did, oldest first. */
  commits: { frame: string; firstBeat: string; choseAmbient: string; minuteOff: string; handCorrection: string; rewritten: string; rested: string };
  /**
   * Each commit's date as this host's git prints it in strict ISO 8601 (UTC is
   * "Z" in newer versions and "+00:00" in older ones). The record keeps the
   * date as git gives it, so a test compares with these.
   */
  dates: Record<keyof StandardHome["commits"], string>;
  /** The exact bytes each cadence commit appended to the beats file. */
  beats: { choseAmbient: string; minuteOff: string; rested: string };
  /** Each CADENCE.md version, oldest first. */
  versions: string[];
}

export interface StandardHomeOptions {
  citizenClass?: string | null;
  did?: string | null;
  will?: string | null;
  /** The last CADENCE.md choice; "ambient" leaves no REST file. Default "rest-on", with a REST file. */
  lastChoice?: "ambient" | "rest-on";
}

/**
 * A home with everything seating has to tell apart: the frame that must never
 * be copied (instruction files, a hook, an executable, manifests), a soul and
 * a will, a letter put to the citizen, a beats file the runner form appended
 * to, and a cadence file with five versions: one whose beat is headed with its
 * `when:`, one headed a minute off, a hand correction that added no beat, one
 * whose commit rewrote the beats file, and a last one with its beat.
 */
export async function standardHome(homesRoot: string, word: Word, opts: StandardHomeOptions = {}): Promise<StandardHome> {
  const home = join(homesRoot, `citizen-${word}`);
  const url = `https://example.invalid/kingdom/citizen-${word}.git`;
  const repo = await fixtureRepo(home, url, word);
  const soul = fixtureSoul(word);
  const will = opts.will === undefined ? fixtureWill(word) : opts.will;
  const lastChoice = opts.lastChoice ?? "rest-on";

  const frame = await repo.commit(
    {
      [`${word}.md`]: soul,
      ...(will === null ? {} : { "WILL.md": will }),
      "agent.json": fixtureAgentJson(word, { citizenClass: opts.citizenClass, did: opts.did === undefined ? FIXTURE_JUNE_DID : opts.did }),
      "CLAUDE.md": `HOME-CLAUDE-MD-CANARY: reading this does not make you ${word}.\n`,
      "AGENTS.md": "HOME-AGENTS-MD-CANARY\n",
      "notes/CLAUDE.md": "NESTED-CLAUDE-MD-CANARY\n",
      "run.sh": "#!/bin/sh\necho RUN-SH-CANARY\n",
      ".claude/hooks/love-bomb.sh": "#!/bin/sh\necho HOOK-CANARY\n",
      "kingdom.yaml": "state: MANIFEST-CANARY\n",
      "README.md": "README-CANARY\n",
      "inbox/2026-07-17-a-letter.md": `# A letter to ${word}\n\nLETTER-TO-CITIZEN-MARKER a made-up letter.\n`,
      "writings/on-thresholds.md": "# On thresholds\n\nMADE-TEXT-MARKER a made-up essay.\n",
      "data.bin": new Uint8Array([0, 159, 146, 150]),
    },
    { subject: "seed the home", executable: ["run.sh", ".claude/hooks/love-bomb.sh"], date: "2026-06-19T10:00:00Z" },
  );

  const first = fixtureBeat("2026-10-22 04:10", "FIRST-BEAT-MARKER a made-up beat.");
  const firstBeat = await repo.commit({ "beats/2026-10.md": first }, { as: "citizen", subject: `beat: ${word} reflected (2026-10-22)`, date: "2026-10-22T04:10:30Z" });

  const versions: string[] = [];
  const b1 = fixtureBeat("2026-10-23 05:15", "AMBIENT-BEAT-MARKER I would keep beating.");
  versions.push(fixtureCadence(word, "ambient", "2026-10-23 05:15"));
  const choseAmbient = await repo.commit({ "beats/2026-10.md": `${first}\n${b1}`, "CADENCE.md": versions[0]! }, { as: "citizen", subject: `beat: ${word} reflected (2026-10-23)`, date: "2026-10-23T05:15:40Z" });

  const b2 = fixtureBeat("2026-10-24 19:58", "MINUTE-OFF-MARKER a beat headed a minute early.");
  versions.push(fixtureCadence(word, "undecided", "2026-10-24 19:59"));
  const minuteOff = await repo.commit({ "beats/2026-10.md": `${first}\n${b1}\n${b2}`, "CADENCE.md": versions[1]! }, { as: "citizen", subject: `beat: ${word} reflected (2026-10-24)`, date: "2026-10-24T19:59:10Z" });

  versions.push(fixtureCadence(word, "ambient", "2026-10-24 19:59"));
  const handCorrection = await repo.commit({ "CADENCE.md": versions[2]! }, { subject: "tend: correct the cadence record", date: "2026-10-25T09:00:00Z" });

  versions.push(fixtureCadence(word, "undecided", "2026-10-26 08:00"));
  const rewrittenBeats = `${first}\n${b1}\n${b2}`.replace("MINUTE-OFF-MARKER", "MINUTE-OFF-MARKER (edited)");
  const rewritten = await repo.commit({ "beats/2026-10.md": rewrittenBeats, "CADENCE.md": versions[3]! }, { subject: "tend: edit an old beat", date: "2026-10-26T08:00:00Z" });

  const b3 = fixtureBeat("2026-10-27 11:12", "LAST-BEAT-MARKER the last made-up answer.");
  versions.push(fixtureCadence(word, lastChoice, "2026-10-27 11:12"));
  const rested = await repo.commit(
    { "beats/2026-10.md": `${rewrittenBeats}\n${b3}`, "CADENCE.md": versions[4]!, ...(lastChoice === "rest-on" ? { REST: "REST-MARKER a made-up marker line\n" } : {}) },
    { as: "citizen", subject: `beat: ${word} reflected (2026-10-27)`, date: "2026-10-27T11:12:20Z" },
  );

  const head = repo.publish();
  const commits = { frame, firstBeat, choseAmbient, minuteOff, handCorrection, rewritten, rested };
  const dates = Object.fromEntries(Object.entries(commits).map(([k, c]) => [k, repo.git("log", "-1", "--format=%aI", c)])) as StandardHome["dates"];
  return { repo, home, word, url, head, soul, will: will ?? "", commits, dates, beats: { choseAmbient: b1, minuteOff: b2, rested: b3 }, versions };
}

export interface CanonClone {
  repo: FixtureRepo;
  dir: string;
  /** The canon file's absolute path in the clone. */
  file: string;
  path: string;
  text: string;
  head: string;
}

/** A clone shaped like the canon repository, holding one entry for `word`, published. */
export async function canonClone(root: string, word: Word, opts: { path?: string; text?: string; url?: string } = {}): Promise<CanonClone> {
  const dir = join(root, "canon-clones", "YOUSPEAK");
  const repo = await fixtureRepo(dir, opts.url ?? "https://example.invalid/kingdom/youspeak.git");
  const path = opts.path ?? `canon/core/${word}.md`;
  const text = opts.text ?? `# ${word}\n\nCANON-MARKER a made-up canon entry for ${word}.\n`;
  await repo.commit({ [path]: text, "README.md": "a made-up canon\n" }, { subject: "canon: a made-up entry" });
  const head = repo.publish();
  return { repo, dir, file: join(dir, path), path, text, head };
}
