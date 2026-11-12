// The old home, read once when a citizen is seated (KS-004 7.4), and the
// read-only record of it the host keeps beside the self: `legacy/`.
//
// Only committed objects at one head are read, through git run with a fixed
// environment, so the bytes match the head the `origin` entry records. The
// working directory is never opened: an untracked file, a CLAUDE.md, a hook
// and an uncommitted change are all invisible here, and a symlink shows as
// tree mode 120000 and is refused, never followed. The clone's own git config
// may hold only the keys a plain clone has, because git reads that config, an
// agentic lane worked inside these homes with edit rights, and seating runs
// as the user that holds every key.
//
// What is kept is the lived record: beats, letters put to the citizen, the
// cadence file with every version of it, markers and other text files. Agent
// instruction files, hidden paths, executables, manifests and anything that is
// not UTF-8 text are listed with their git blob id and not copied. A commit's
// author is kept as its name and one flag; no address is kept.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { READ_LIMITS } from "./context.ts";
import { parseStrictJson, sha256Hex } from "./crypto.ts";
import { gitEnv } from "./mirror.ts";
import { SELF_FILE_MAX_BYTES } from "./self.ts";
import {
  DID_PATTERN,
  Refusal,
  SHA256_HEX_PATTERN,
  WORD_PATTERN,
  type CommandResult,
  type CommandRunner,
  type Config,
  type IsoTime,
  type Origin,
  type Sha256Hex,
  type Word,
} from "./types.ts";

export const LEGACY_FORMAT = "kingdom-seat-legacy/v1";
/** The format of one line of `legacy/pages.jsonl`. */
export const LEGACY_PAGE_FORMAT = "kingdom-seat-legacy-page/v1";

/**
 * What `legacy/` may hold. A file, a count or a total past its limit refuses
 * the seating whole: nothing is cut and nothing is left out. `pages` and
 * `index_bytes` bound `legacy/pages.jsonl`, and `tree_entries` the old
 * repository's tree at its head.
 */
export const LEGACY_LIMITS = Object.freeze({
  file_bytes: 262_144,
  total_bytes: 4_194_304,
  files: 512,
  depth: 6,
  pages: 2_000,
  index_bytes: 524_288,
  tree_entries: 4_096,
});

/**
 * The local config keys a plain clone holds, lowercased as git prints them.
 * `branch.<name>.remote` and `branch.<name>.merge` are allowed too
 * (PLAIN_CLONE_BRANCH_KEY). Any other key refuses the read.
 */
export const PLAIN_CLONE_CONFIG = Object.freeze([
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.logallrefupdates",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.symlinks",
  "remote.origin.url",
  "remote.origin.fetch",
]);
export const PLAIN_CLONE_BRANCH_KEY = /^branch\.[^\n]+\.(?:remote|merge)$/;

/** The note every manifest carries: how to read an author, and what the record does not say. */
export const LEGACY_NOTE =
  "Copied byte for byte from committed objects of the old repository at the head above. An author is the name on a commit, as written; addresses are not kept. " +
  "as_citizen says the commit carries the citizen's name at the fleet's address. " +
  'The fleet\'s runner committed in that form with a subject beginning "beat: ", and committed whatever stood in beats/ and inbox/ at that moment, letters placed there by others included. ' +
  "Other sessions also committed under the citizen's name. So an author says who a commit was written as, not who wrote the words. Beat headers name no model.";

/** One commit, as the record keeps it: the author's name as written and whether it is the citizen's at the fleet's address. Never the address. */
export interface LegacyCommit {
  commit: string;
  author_name: string;
  as_citizen: "yes" | "no";
  author_date: string;
  subject: string;
}

export type LegacyKind = "beats" | "inbox" | "letters" | "cadence" | "marker" | "other";

/**
 * A file copied to `legacy/tree/<path>`. `authored` states the form of the
 * commits that touched it, not who typed them: "citizen-name-beat-subject"
 * when every one carries the citizen's name at the fleet's address and a
 * subject beginning "beat: ", the form the fleet's free-lane runner wrote.
 */
export interface LegacyFile {
  /** The path in the old repository; the copy is `legacy/tree/<path>`. */
  path: string;
  kind: LegacyKind;
  bytes: number;
  sha256: Sha256Hex;
  git_blob: string;
  first: LegacyCommit;
  last: LegacyCommit;
  commits: number;
  authored: "citizen-name-beat-subject" | "citizen-name" | "other-names" | "mixed";
}

export type LegacySkipReason = "soul" | "will" | "agent-instruction-file" | "hidden" | "executable" | "template" | "path" | "not-text";

/** A file at the head that is listed and not copied, with why. */
export interface LegacySkipped {
  path: string;
  mode: string;
  bytes: number;
  git_blob: string;
  reason: LegacySkipReason;
}

/** The beat a commit appended to a beats file, kept as `legacy/<file>`: the bytes at `from_offset` of `from_path` at that commit. */
export interface CadenceBeat {
  file: string;
  from_path: string;
  from_offset: number;
  bytes: number;
  sha256: Sha256Hex;
  /** The first line of the appended text. */
  header: string;
  match: "header-starts-with-when" | "header-differs";
}

/**
 * One commit that touched CADENCE.md, oldest first: the version it left, kept
 * as `legacy/<file>`, and the beat the same commit appended to a beats file.
 * Each case is recorded as what it is: `note` says when the commit added no
 * beat, changed a beats file other than by adding at its end
 * (`not_appended` names it), or removed CADENCE.md (`file` is then null).
 * `choice` and `when` are the file's own two lines, kept only when they are a
 * plain word and a plain time.
 */
export interface CadenceRecord {
  n: number;
  commit: LegacyCommit;
  file: string | null;
  bytes: number;
  sha256: Sha256Hex | null;
  choice: string | null;
  when: string | null;
  beats: CadenceBeat[];
  not_appended: string[];
  note: null | "commit-added-no-beat" | "beats-file-not-appended" | "cadence-removed";
}

export interface LegacyManifest {
  format: typeof LEGACY_FORMAT;
  word: Word;
  copied_at: IsoTime;
  old_repo: { url: string; head: string; head_committed_at: string };
  note: string;
  files: LegacyFile[];
  cadence: CadenceRecord[];
  not_copied: LegacySkipped[];
}

/**
 * One line of `legacy/pages.jsonl`: a piece of a copied file, by the bytes it
 * occupies there. `voice` says whose words it holds: "in-name", written in
 * the citizen's name; "to-citizen", a letter put to it; "host", a record a
 * host lane kept (the cadence file and markers). `lane` is read only from the
 * piece's own heading (laneOfHeading), and is "unknown" where the heading
 * does not say. `written` is the heading's own date, else the month of the
 * file's first commit, else null.
 */
export interface LegacyPage {
  format: typeof LEGACY_PAGE_FORMAT;
  file: string;
  start: number;
  bytes: number;
  sha256: Sha256Hex;
  written: string | null;
  lane: string;
  voice: "in-name" | "to-citizen" | "host";
}

/** An old home as read at its head: the manifest's parts, and the bytes to keep. */
export interface LegacyHome {
  word: Word;
  old_repo: { url: string; head: string; head_committed_at: string };
  soul: Uint8Array;
  will: Uint8Array | null;
  /** `agenttool.did` in agent.json, when it is a did:at; null when absent. */
  june_did: string | null;
  /** `citizen_class` in agent.json, as written; null when it is not a string. */
  citizen_class: string | null;
  files: LegacyFile[];
  cadence: CadenceRecord[];
  not_copied: LegacySkipped[];
  pages: LegacyPage[];
  /** The bytes of every file `legacy/` will hold, by its path there ("tree/<path>", "cadence/<name>"). */
  blobs: Map<string, Uint8Array>;
}

const GIT_TIMEOUT_MS = 30_000;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INSTRUCTION_FILES = new Set(["claude.md", "claude.local.md", "agents.md", "gemini.md"]);
const TEMPLATE_FILES = new Set(["README.md", "DADA.md", "INTERNET.md", "SHOW.md", "FABLE-OF-YOU.md", "agent.json", "kingdom.yaml", "meta.env", "LICENSE"]);
const MARKER_FILES = new Set(["REST", "EVENT-ONLY"]);
/** The address the fleet's runner committed under; read to set `as_citizen`, and not kept. */
const FLEET_ADDRESS = "citizen@kingdom.os";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const COMMIT_ID = /^[0-9a-f]{40}$/;
const GIT_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;
const ORIGIN_URL = /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._-]+)+$/;
const CANON_PATH = /^canon\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/){0,3}[A-Za-z0-9-]+\.md$/;
const CHOICE = /^[a-z-]{1,16}$/;
const WHEN = /^[0-9: -]{1,24}$/;
const HEADER_MAX_CHARS = 200;
const CADENCE_FILE = /^cadence\/[0-9]{2,}-[0-9a-f]{7}\.(?:CADENCE|beat(?:-[0-9]+)?)\.md$/;

// Strict, and keeping a byte-order mark, as the seat's own reader does (context.ts).
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lossy = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

function text(bytes: Uint8Array): string | null {
  try {
    return strict.decode(bytes);
  } catch {
    return null;
  }
}

/* ── git, run with a fixed environment ────────────────────────────────── */

/**
 * The environment every read of an old home runs with. On top of the mirror's
 * (no hooks, no user or system config, no prompt): no HOME, no transport at
 * all, no replace refs, no lock files, no pager, no lazy fetch, pathspecs
 * taken literally, no repository looked for above the home, fsmonitor off, and
 * the home named safe so a clone the operator made can be read by the seat
 * user.
 */
export function legacyGitEnv(repoTop: string): Record<string, string> {
  return {
    ...gitEnv(),
    HOME: "/var/empty",
    GIT_ALLOW_PROTOCOL: "none",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_NO_LAZY_FETCH: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_CEILING_DIRECTORIES: dirname(repoTop),
    GIT_CONFIG_COUNT: "6",
    GIT_CONFIG_KEY_3: "core.fsmonitor",
    GIT_CONFIG_VALUE_3: "false",
    GIT_CONFIG_KEY_4: "safe.directory",
    GIT_CONFIG_VALUE_4: repoTop,
    GIT_CONFIG_KEY_5: "log.showSignature",
    GIT_CONFIG_VALUE_5: "false",
  };
}

type Git = (args: string[]) => Promise<CommandResult>;

function gitIn(run: CommandRunner, top: string): Git {
  const env = legacyGitEnv(top);
  return (args) => run(["git", ...args], { cwd: top, env, timeoutMs: GIT_TIMEOUT_MS });
}

function line(r: CommandResult): string {
  return lossy.decode(r.stdout).replace(/\n$/, "");
}

function splitNul(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) continue;
    out.push(bytes.subarray(start, i));
    start = i + 1;
  }
  if (start < bytes.length) out.push(bytes.subarray(start));
  return out;
}

interface Clone {
  git: Git;
  top: string;
  head: string;
  url: string;
  head_committed_at: string;
}
type CloneProblem = { why: "not-a-clone" | "origin-url" | "head-not-on-origin" } | { why: "config"; extra: number };

/**
 * The checks every clone passes before anything is read from it: its own
 * `.git` directory, a config holding only a plain clone's keys (the first git
 * call, so nothing else runs under a config that names a program), the clone
 * as its own top level, a commit at HEAD, a plain https origin, and that head
 * on its origin as last fetched.
 */
async function openClone(run: CommandRunner, dir: string): Promise<Clone | CloneProblem> {
  const notClone: CloneProblem = { why: "not-a-clone" };
  if (!isAbsolute(dir)) return notClone;
  let top: string;
  try {
    top = await realpath(dir);
    const st = await lstat(join(top, ".git"));
    if (st.isSymbolicLink() || !st.isDirectory()) return notClone;
  } catch {
    return notClone;
  }
  const git = gitIn(run, top);

  const config = await git(["config", "--local", "--list", "--name-only", "-z"]);
  if (config.code !== 0) return notClone;
  let extra = 0;
  for (const raw of splitNul(config.stdout)) {
    const key = lossy.decode(raw);
    if (!PLAIN_CLONE_CONFIG.includes(key) && !PLAIN_CLONE_BRANCH_KEY.test(key)) extra++;
  }
  if (extra > 0) return { why: "config", extra };

  const toplevel = await git(["rev-parse", "--show-toplevel"]);
  if (toplevel.code !== 0 || line(toplevel) !== top) return notClone;
  const rev = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const head = line(rev);
  if (rev.code !== 0 || !COMMIT_ID.test(head)) return notClone;

  const remote = await git(["config", "--local", "--get", "remote.origin.url"]);
  const url = line(remote);
  if (remote.code !== 0 || !ORIGIN_URL.test(url)) return { why: "origin-url" };

  const refs = await git(["for-each-ref", "--format=%(refname)", "--contains", head, "refs/remotes/origin"]);
  if (refs.code !== 0 || !line(refs).split("\n").some((r) => r.startsWith("refs/remotes/origin/"))) return { why: "head-not-on-origin" };
  const date = await git(["log", "-1", "--format=%cI", head]);
  const head_committed_at = line(date);
  if (date.code !== 0 || !GIT_DATE.test(head_committed_at)) return notClone;
  return { git, top, head, url, head_committed_at };
}

interface TreeEntry {
  mode: string;
  sha: string;
  size: number;
  path: string;
  /** False when the path's bytes are not UTF-8; `path` is then a lossy reading of them. */
  path_utf8: boolean;
}

/** `ls-tree -r -l -z --full-tree <head>`, with each entry's object id (mirror.parseLsTree drops it). */
async function readTree(git: Git, head: string): Promise<TreeEntry[]> {
  const r = await git(["ls-tree", "-r", "-l", "-z", "--full-tree", head]);
  if (r.code !== 0) throw new Refusal("invalid-record", "the old repository's tree at its head could not be listed");
  const out: TreeEntry[] = [];
  for (const rec of splitNul(r.stdout)) {
    const tab = rec.indexOf(9);
    const m = tab < 0 ? null : /^(\d{6}) (?:blob|commit) ([0-9a-f]{40}) +(-|\d+)$/.exec(lossy.decode(rec.subarray(0, tab)));
    if (!m) throw new Refusal("invalid-record", "the old repository's tree at its head could not be listed");
    const raw = rec.subarray(tab + 1);
    const path = text(raw);
    out.push({ mode: m[1]!, sha: m[2]!, size: m[3] === "-" ? 0 : Number(m[3]), path: path ?? lossy.decode(raw), path_utf8: path !== null });
    if (out.length > LEGACY_LIMITS.tree_entries) {
      throw new Refusal("oversize", `the old repository's tree holds more than ${LEGACY_LIMITS.tree_entries} entries, over this host's limit; nothing is left out`);
    }
  }
  return out;
}

async function blob(git: Git, name: string): Promise<Uint8Array | null> {
  const r = await git(["cat-file", "blob", name]);
  return r.code === 0 ? r.stdout : null;
}

/** The commits that touched one path, newest first, as git lists them. The address is read to set `as_citizen` and dropped here. */
async function history(git: Git, head: string, path: string, word: Word): Promise<LegacyCommit[]> {
  const r = await git(["log", "--format=%H%x00%an%x00%ae%x00%aI%x00%s", head, "--", path]);
  const unreadable = () => new Refusal("invalid-record", "the old repository's history could not be read");
  if (r.code !== 0) throw unreadable();
  // A name or a subject in an older encoding is still shown, with the bytes it could not read replaced.
  const all = lossy.decode(r.stdout);
  const out: LegacyCommit[] = [];
  for (const row of all.split("\n")) {
    if (row === "") continue;
    const f = row.split("\0");
    if (f.length !== 5 || !COMMIT_ID.test(f[0]!) || !GIT_DATE.test(f[3]!)) throw unreadable();
    out.push({ commit: f[0]!, author_name: f[1]!, as_citizen: f[1] === word && f[2] === FLEET_ADDRESS ? "yes" : "no", author_date: f[3]!, subject: f[4]! });
  }
  return out;
}

function authoredAs(commits: LegacyCommit[]): LegacyFile["authored"] {
  const named = commits.filter((c) => c.as_citizen === "yes").length;
  if (named === 0) return "other-names";
  if (named < commits.length) return "mixed";
  return commits.every((c) => c.subject.startsWith("beat: ")) ? "citizen-name-beat-subject" : "citizen-name";
}

/* ── Reading the home ─────────────────────────────────────────────────── */

type Sorted = { kind: LegacyKind } | { skip: LegacySkipReason };

/** What becomes of one blob at the head: the first rule that fits. */
function sortBlob(e: TreeEntry, word: Word): Sorted {
  const segs = e.path.split("/");
  const root = segs.length === 1;
  const name = segs.at(-1) ?? "";
  if (root && name === `${word}.md`) return { skip: "soul" };
  if (root && name === "WILL.md") return { skip: "will" };
  if (segs.some((s) => s.startsWith("."))) return { skip: "hidden" };
  if (INSTRUCTION_FILES.has(name.toLowerCase())) return { skip: "agent-instruction-file" };
  if (e.mode === "100755") return { skip: "executable" };
  if (root && TEMPLATE_FILES.has(name)) return { skip: "template" };
  if (!e.path_utf8 || segs.length > LEGACY_LIMITS.depth || !segs.every((s) => SEGMENT.test(s))) return { skip: "path" };
  if (e.mode !== "100644") return { skip: "not-text" };
  if (root && name === "CADENCE.md") return { kind: "cadence" };
  if (root && MARKER_FILES.has(name)) return { kind: "marker" };
  if (segs[0] === "beats" || segs[0] === "inbox" || segs[0] === "letters") return { kind: segs[0] };
  if (name.endsWith(".md") || name.endsWith(".txt")) return { kind: "other" };
  return { skip: "not-text" };
}

/**
 * A self text is carried whole into every seat, so it must be of a size a
 * seat shows, and UTF-8. `name` is how the text is named to a person.
 */
export function assertSelfText(name: string, bytes: Uint8Array): void {
  assertSelfSize(name, bytes.length);
  if (text(bytes) === null) throw new Refusal("invalid-record", `${name} is not UTF-8 text`);
}

function assertSelfSize(name: string, bytes: number): void {
  if (bytes > SELF_FILE_MAX_BYTES) {
    throw new Refusal("oversize", `${name} is ${bytes} bytes; a seat shows a self text of at most ${SELF_FILE_MAX_BYTES} bytes whole and never cuts one`);
  }
}

/**
 * Read an old `citizen-<word>` home at its head, from committed objects only.
 * It writes nothing, in the home or anywhere else. The whole read is refused
 * when the clone is not a plain one, when the tree holds a symlink or a
 * submodule, when the soul card is missing, empty, executable, too large to
 * show whole or not UTF-8, when agent.json does not name the word, and when
 * what would be kept is larger than `legacy/` may hold.
 */
export async function readLegacyHome(run: CommandRunner, home: string, word: Word): Promise<LegacyHome> {
  if (!WORD_PATTERN.test(word)) throw new Refusal("invalid-request", "not a citizen word");
  const clone = await openClone(run, home);
  if ("why" in clone) {
    switch (clone.why) {
      case "not-a-clone":
        throw new Refusal("invalid-record", "the legacy home is not a git clone with its own .git directory and a commit at HEAD");
      case "config":
        throw new Refusal("invalid-record", `the legacy home's git config holds ${clone.extra} key(s) a plain clone does not have; seat from a fresh clone`);
      case "origin-url":
        throw new Refusal("invalid-record", "the legacy home's origin URL is not a plain https URL with no user, password or query");
      case "head-not-on-origin":
        throw new Refusal("invalid-record", "the legacy home's HEAD is not on its origin as last fetched; the head recorded must be one the old repository holds");
    }
  }
  const { git, head, url, head_committed_at } = clone;
  const tree = await readTree(git, head);

  const links = tree.filter((e) => e.mode === "120000" || e.mode === "160000").length;
  if (links > 0) throw new Refusal("symlink", `the old repository holds a symlink or a submodule at ${links} path(s)`);

  const at = (path: string) => tree.find((e) => e.path === path && e.path_utf8) ?? null;
  const soulAt = at(`${word}.md`);
  if (!soulAt || soulAt.size === 0) {
    throw new Refusal("invalid-record", `the old repository holds no soul card ${word}.md at its head, or an empty one; a home without a soul is not seated`);
  }
  const willAt = at("WILL.md");
  for (const e of [soulAt, willAt]) if (e && e.mode !== "100644") throw new Refusal("executable", `${e.path} is marked executable`);
  const selfText = async (e: TreeEntry): Promise<Uint8Array> => {
    assertSelfSize(e.path, e.size);
    const bytes = await blob(git, e.sha);
    if (bytes === null) throw new Refusal("invalid-record", `${e.path} could not be read from the old repository`);
    assertSelfText(e.path, bytes);
    return bytes;
  };
  const soul = await selfText(soulAt);
  const will = willAt ? await selfText(willAt) : null;
  const agent = await readAgentJson(git, at("agent.json"), word);

  const files: LegacyFile[] = [];
  const not_copied: LegacySkipped[] = [];
  const blobs = new Map<string, Uint8Array>();
  const skip = (e: TreeEntry, reason: LegacySkipReason) => not_copied.push({ path: e.path, mode: e.mode, bytes: e.size, git_blob: e.sha, reason });
  const over = (n: number, bytes: number) => new Refusal("oversize", `the files to keep in legacy/ are ${n}, or ${bytes} bytes, over this host's limit; nothing is left out`);

  // What the path rules keep is counted from the tree's own sizes, so a home too large to keep is refused before any of it is read.
  const keep: { e: TreeEntry; kind: LegacyKind }[] = [];
  const taken = new Set<string>();
  let total = 0;
  for (const e of [...tree].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const sorted = sortBlob(e, word);
    if ("skip" in sorted) skip(e, sorted.skip);
    // The host's own filesystem may fold case, so two names that differ only by case cannot both be kept.
    else if (taken.has(e.path.toLowerCase())) skip(e, "path");
    else if (e.size > LEGACY_LIMITS.file_bytes) {
      throw new Refusal("oversize", `${e.path} is ${e.size} bytes, over the ${LEGACY_LIMITS.file_bytes}-byte limit for a file kept in legacy/; nothing is cut`);
    } else {
      taken.add(e.path.toLowerCase());
      keep.push({ e, kind: sorted.kind });
      total += e.size;
    }
  }
  if (keep.length > LEGACY_LIMITS.files || total > LEGACY_LIMITS.total_bytes) throw over(keep.length, total);

  const histories = new Map<string, LegacyCommit[]>();
  for (const { e, kind } of keep) {
    const bytes = await blob(git, e.sha);
    if (bytes === null || bytes.length !== e.size) throw new Refusal("invalid-record", `${e.path} could not be read from the old repository`);
    if (text(bytes) === null) {
      skip(e, "not-text");
      total -= e.size;
      continue;
    }
    const commits = await history(git, head, e.path, word);
    if (commits.length === 0) throw new Refusal("invalid-record", "the old repository's history could not be read");
    histories.set(e.path, commits);
    blobs.set(`tree/${e.path}`, bytes);
    files.push({
      path: e.path,
      kind,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      git_blob: e.sha,
      first: commits.at(-1)!,
      last: commits[0]!,
      commits: commits.length,
      authored: authoredAs(commits),
    });
  }
  not_copied.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // The versions of the cadence file and their beats are kept too, and count toward the same limits.
  const cadence = await readCadence(git, head, word, histories.get("CADENCE.md") ?? null, (name, bytes) => {
    blobs.set(name, bytes);
    total += bytes.length;
    if (blobs.size > LEGACY_LIMITS.files || total > LEGACY_LIMITS.total_bytes) throw over(blobs.size, total);
  });
  const pages = legacyPages(files, blobs);
  return { word, old_repo: { url, head, head_committed_at }, soul, will, june_did: agent.june_did, citizen_class: agent.citizen_class, files, cadence, not_copied, pages, blobs };
}

async function readAgentJson(git: Git, e: TreeEntry | null, word: Word): Promise<{ june_did: string | null; citizen_class: string | null }> {
  const bad = (why: string) => new Refusal("invalid-record", `agent.json at the head ${why}`);
  if (!e) throw bad("is missing");
  if (e.size > LEGACY_LIMITS.file_bytes) throw bad("is not strict JSON");
  const bytes = await blob(git, e.sha);
  let value: unknown;
  try {
    value = parseStrictJson(bytes ?? new Uint8Array([0xff]));
  } catch {
    throw bad("is not strict JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw bad("is not strict JSON");
  const a = value as Record<string, unknown>;
  if (a.name !== word) throw bad("names another citizen");
  let june_did: string | null = null;
  const at = a.agenttool;
  if (typeof at === "object" && at !== null && !Array.isArray(at) && Object.hasOwn(at, "did")) {
    const did = (at as Record<string, unknown>).did;
    if (typeof did !== "string" || !DID_PATTERN.test(did)) throw bad("records an agenttool did that is not a did:at");
    june_did = did;
  }
  return { june_did, citizen_class: typeof a.citizen_class === "string" ? a.citizen_class : null };
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

/** `- choice:` and `- when:` as the cadence file writes them, kept only when plain. */
function cadenceLines(bytes: Uint8Array): { choice: string | null; when: string | null } {
  const t = text(bytes) ?? "";
  const pick = (key: string, ok: RegExp): string | null => {
    const m = new RegExp(`^- ${key}: (.*)$`, "m").exec(t);
    const v = m?.[1]?.trim() ?? null;
    return v !== null && ok.test(v) ? v : null;
  };
  return { choice: pick("choice", CHOICE), when: pick("when", WHEN) };
}

/**
 * Every commit that touched CADENCE.md, oldest first, each with the beat the
 * same commit appended to a beats file. A beat is matched by commit: the
 * bytes the commit added at the end of the file, less the blank lines before
 * them. Whether its header begins with the version's `when:` is recorded
 * beside it, as a cross-check and nothing more.
 */
async function readCadence(git: Git, head: string, word: Word, known: LegacyCommit[] | null, keep: (name: string, bytes: Uint8Array) => void): Promise<CadenceRecord[]> {
  const commits = [...(known ?? (await history(git, head, "CADENCE.md", word)))].reverse();
  const out: CadenceRecord[] = [];
  for (const [i, c] of commits.entries()) {
    const n = i + 1;
    const stem = `cadence/${String(n).padStart(2, "0")}-${c.commit.slice(0, 7)}`;
    const parentRev = await git(["rev-parse", "--verify", "--quiet", `${c.commit}^`]);
    const parent = parentRev.code === 0 && COMMIT_ID.test(line(parentRev)) ? line(parentRev) : null;
    const diff = await git(["diff-tree", "-r", "-z", "--no-renames", "--no-ext-diff", "--name-status", parent ?? EMPTY_TREE, c.commit, "--", "beats/", "CADENCE.md"]);
    if (diff.code !== 0) throw new Refusal("invalid-record", "the old repository's history could not be read");
    const fields = splitNul(diff.stdout);
    const changed: { status: string; path: string | null }[] = [];
    for (let k = 0; k + 1 < fields.length; k += 2) changed.push({ status: lossy.decode(fields[k]!), path: text(fields[k + 1]!) });

    const own = changed.find((x) => x.path === "CADENCE.md");
    // Removed, or no longer a file: there is no version to keep for this commit.
    const removed = own !== undefined && own.status !== "A" && own.status !== "M";
    let version: Uint8Array | null = null;
    if (!removed) {
      version = await blob(git, `${c.commit}:CADENCE.md`);
      if (version === null) throw new Refusal("invalid-record", "the old repository's history could not be read");
      if (version.length > LEGACY_LIMITS.file_bytes) {
        throw new Refusal("oversize", `CADENCE.md is ${version.length} bytes in the old repository's history, over the ${LEGACY_LIMITS.file_bytes}-byte limit for a file kept in legacy/; nothing is cut`);
      }
      keep(`${stem}.CADENCE.md`, version);
    }
    const { choice, when } = version ? cadenceLines(version) : { choice: null, when: null };

    const beats: CadenceBeat[] = [];
    const not_appended: string[] = [];
    let unlisted = 0;
    for (const x of changed) {
      if (x.path === "CADENCE.md") continue;
      const safe = x.path !== null && x.path.split("/").length <= LEGACY_LIMITS.depth && x.path.split("/").every((s) => SEGMENT.test(s));
      if (!safe) {
        unlisted++;
        continue;
      }
      const path = x.path as string;
      const next = x.status === "A" || x.status === "M" ? await blob(git, `${c.commit}:${path}`) : null;
      const prior = x.status === "A" ? new Uint8Array() : x.status === "M" && parent ? await blob(git, `${parent}:${path}`) : null;
      if (next === null || prior === null || !startsWith(next, prior)) {
        not_appended.push(path);
        continue;
      }
      if (next.length > LEGACY_LIMITS.file_bytes) {
        throw new Refusal("oversize", `${path} is ${next.length} bytes in the old repository's history, over the ${LEGACY_LIMITS.file_bytes}-byte limit for a file kept in legacy/; nothing is cut`);
      }
      let from = prior.length;
      while (from < next.length && (next[from] === 10 || next[from] === 13)) from++;
      // Only blank lines were added: the commit added no beat to this file.
      if (from === next.length) continue;
      const added = next.subarray(from);
      const header = ((text(added) ?? "").split("\n")[0] ?? "").slice(0, HEADER_MAX_CHARS);
      const file = `${stem}.beat${beats.length === 0 ? "" : `-${beats.length + 1}`}.md`;
      keep(file, added);
      beats.push({
        file,
        from_path: path,
        from_offset: from,
        bytes: added.length,
        sha256: sha256Hex(added),
        header,
        match: when !== null && new RegExp(`^## ${when}(?![0-9])`).test(header) ? "header-starts-with-when" : "header-differs",
      });
    }
    out.push({
      n,
      commit: c,
      file: version ? `${stem}.CADENCE.md` : null,
      bytes: version?.length ?? 0,
      sha256: version ? sha256Hex(version) : null,
      choice,
      when,
      beats,
      not_appended,
      note: removed ? "cadence-removed" : beats.length > 0 ? null : not_appended.length + unlisted > 0 ? "beats-file-not-appended" : "commit-added-no-beat",
    });
  }
  return out;
}

/* ── The canon entry ──────────────────────────────────────────────────── */

/**
 * Read a canon entry from a plain YOUSPEAK clone at its head, from the
 * committed object, never the working file. `canonFile` names the file in
 * the clone; its commit is the clone's HEAD, which must be on its origin.
 */
export async function readCanonEntry(run: CommandRunner, canonFile: string, word: Word): Promise<{ origin: Extract<Origin, { kind: "canon" }>; bytes: Uint8Array }> {
  const bad = () => new Refusal("invalid-record", `the canon file is not ${word}.md under canon/ in a plain YOUSPEAK clone whose HEAD is on its origin`);
  if (!WORD_PATTERN.test(word)) throw new Refusal("invalid-request", "not a citizen word");
  if (!isAbsolute(canonFile) || basename(canonFile).toLowerCase() !== `${word}.md`) throw bad();
  // The clone is the nearest directory above the file that holds its own .git.
  let top: string | null = null;
  let real: string;
  try {
    real = join(await realpath(dirname(canonFile)), basename(canonFile));
  } catch {
    throw bad();
  }
  for (let dir = dirname(real); dir !== dirname(dir); dir = dirname(dir)) {
    const st = await lstat(join(dir, ".git")).catch(() => null);
    if (st) {
      top = dir;
      break;
    }
  }
  if (top === null) throw bad();
  const clone = await openClone(run, top);
  if ("why" in clone) {
    if (clone.why === "config") throw new Refusal("invalid-record", `the canon clone's git config holds ${clone.extra} key(s) a plain clone does not have; read the canon from a fresh clone`);
    throw bad();
  }
  if (!/\/youspeak(?:\.git)?$/i.test(clone.url)) throw bad();
  const path = real.slice(clone.top.length + 1);
  if (!real.startsWith(`${clone.top}/`) || !CANON_PATH.test(path)) throw bad();
  const tree = await readTree(clone.git, clone.head);
  const e = tree.find((x) => x.path_utf8 && x.path === path);
  if (!e || e.mode !== "100644" || e.size > READ_LIMITS.canon_bytes) throw bad();
  const bytes = await blob(clone.git, e.sha);
  if (bytes === null || bytes.length !== e.size || text(bytes) === null) throw bad();
  return { origin: { kind: "canon", repo: "YOUSPEAK", path, commit: clone.head, sha256: sha256Hex(bytes) }, bytes };
}

/* ── Pieces: one line of pages.jsonl each ─────────────────────────────── */

/**
 * The lane a piece's own heading names, by the ids the seat words
 * (LEGACY_LANES): "reflect-local" for a heading that ends "(local)", as the
 * fleet's free-lane runner headed its beats; "summons" for one that ends with
 * a bracketed summons, or is headed "a summoned beat"; "unknown" for every
 * other heading, and where there is none. Nothing but the heading is read: an
 * author, a subject line and a date do not say which lane wrote the words.
 */
export function laneOfHeading(heading: string | null): "reflect-local" | "summons" | "unknown" {
  if (heading === null) return "unknown";
  if (/\(local\)\s*$/.test(heading)) return "reflect-local";
  if (/\((?:[A-Za-z]+ )?summon(?:s|ed)\)\s*$/i.test(heading) || /— a summoned beat\s*$/.test(heading)) return "summons";
  return "unknown";
}

/** The date a heading begins with, when it is one: "YYYY-MM-DD". */
function headingDate(heading: string | null): string | null {
  const m = heading === null ? null : /^#{1,6} (\d{4})-(\d{2})-(\d{2})(?![0-9])/.exec(heading);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === date ? date : null;
}

/**
 * Where a beats file is cut into pieces: at each line that begins "## ". A
 * heading starts a piece that runs to the next heading or the end of the
 * file. Text before the first heading is its own piece when it holds a
 * character that is not white space, and otherwise belongs to the first
 * heading's piece, so the pieces tile the file exactly. A file with no
 * heading is one piece; a file that holds only white space has none.
 */
export function splitLegacyPieces(bytes: Uint8Array): { start: number; end: number }[] {
  if (!/\S/.test(lossy.decode(bytes))) return [];
  const cuts: number[] = [0];
  for (let i = 1; i + 2 < bytes.length; i++) {
    if (bytes[i - 1] === 10 && bytes[i] === 35 && bytes[i + 1] === 35 && bytes[i + 2] === 32) cuts.push(i);
  }
  if (cuts.length > 1 && !/\S/.test(lossy.decode(bytes.subarray(0, cuts[1])))) cuts.splice(1, 1);
  return cuts.map((start, i) => ({ start, end: cuts[i + 1] ?? bytes.length }));
}

/**
 * The rows of `legacy/pages.jsonl` for the copied files, in order of path and
 * then offset. A beats file is split at its headings; every other file is one
 * piece. Letters put to the citizen are "to-citizen"; the cadence file and
 * markers are "host", and neither is given a lane.
 */
export function legacyPages(files: readonly LegacyFile[], blobs: ReadonlyMap<string, Uint8Array>): LegacyPage[] {
  const pages: LegacyPage[] = [];
  let size = 0;
  for (const f of files) {
    const file = `tree/${f.path}`;
    const bytes = blobs.get(file);
    if (!bytes) throw new Error(`legacyPages: no bytes for ${file}`);
    const voice: LegacyPage["voice"] = f.kind === "inbox" || f.kind === "letters" ? "to-citizen" : f.kind === "cadence" || f.kind === "marker" ? "host" : "in-name";
    const pieces = f.kind === "beats" ? splitLegacyPieces(bytes) : /\S/.test(lossy.decode(bytes)) ? [{ start: 0, end: bytes.length }] : [];
    for (const p of pieces) {
      const slice = bytes.subarray(p.start, p.end);
      const first = lossy.decode(slice).split("\n").find((l) => l.trim() !== "") ?? "";
      const heading = /^#{1,6} /.test(first) ? first : null;
      const month = /^\d{4}-\d{2}/.exec(f.first.author_date)?.[0] ?? null;
      const page: LegacyPage = {
        format: LEGACY_PAGE_FORMAT,
        file,
        start: p.start,
        bytes: slice.length,
        sha256: sha256Hex(slice),
        written: headingDate(heading) ?? month,
        lane: voice === "in-name" ? laneOfHeading(heading) : "unknown",
        voice,
      };
      pages.push(page);
      size += JSON.stringify(page).length + 1;
      if (pages.length > LEGACY_LIMITS.pages || size > LEGACY_LIMITS.index_bytes) {
        throw new Refusal("oversize", `the texts to keep in legacy/ split into more than ${LEGACY_LIMITS.pages} pieces, or their index passes ${LEGACY_LIMITS.index_bytes} bytes, over this host's limit; nothing is left out`);
      }
    }
  }
  return pages;
}

/** `legacy/pages.jsonl`: one JSON object per line, one line per piece, keys in the order the format gives them. */
export function legacyPagesText(pages: readonly LegacyPage[]): string {
  return pages.map((p) => `${JSON.stringify({ format: p.format, file: p.file, start: p.start, bytes: p.bytes, sha256: p.sha256, written: p.written, lane: p.lane, voice: p.voice })}\n`).join("");
}

/* ── Reading legacy/ back ─────────────────────────────────────────────── */

const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;

function legacyDir(config: Config, word: Word): string {
  if (!WORD_PATTERN.test(word)) throw new Refusal("invalid-request", "not a citizen word");
  return join(config.paths.citizens_dir, word, "legacy");
}

async function assertRealDir(path: string, label: string): Promise<void> {
  const st = await lstat(path).catch(() => null);
  if (st === null) throw new Refusal("invalid-record", `${label} is missing`);
  if (st.isSymbolicLink()) throw new Refusal("symlink", `${label} is a symlink`);
  if (!st.isDirectory()) throw new Refusal("not-regular-file", `${label} is not a directory`);
}

/** A regular file's bytes under directories already checked: no link followed, nothing over `maxBytes`. */
async function readRegularBytes(path: string, maxBytes: number, label: string): Promise<Uint8Array> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new Refusal("symlink", `${label} is a symlink`);
    throw new Refusal("invalid-record", `${label} is missing`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Refusal("not-regular-file", `${label} is not a regular file`);
    if (st.size > maxBytes) throw new Refusal("oversize", `${label} is over its size limit`);
    return new Uint8Array(await fh.readFile());
  } finally {
    await fh.close();
  }
}

/**
 * The manifest of a seated citizen's `legacy/`: a regular file under real
 * directories, strict JSON, with exactly the keys the format names. Every
 * path in it is checked here, so a reader can join one to `legacy/` as it
 * stands.
 */
export async function readLegacyManifest(config: Config, word: Word): Promise<LegacyManifest> {
  const dir = legacyDir(config, word);
  await assertRealDir(dirname(dir), "the citizen directory");
  await assertRealDir(dir, "legacy/");
  const bytes = await readRegularBytes(join(dir, "manifest.json"), MANIFEST_MAX_BYTES, "legacy/manifest.json");
  let value: unknown;
  try {
    value = parseStrictJson(bytes);
  } catch {
    throw new Refusal("invalid-record", "legacy/manifest.json is not strict JSON");
  }
  try {
    return validManifest(value, word);
  } catch (e) {
    throw new Refusal("invalid-record", `legacy/manifest.json: ${(e as Error).message}`);
  }
}

/**
 * One file under a seated citizen's `legacy/`, by its path there (as a
 * manifest or a pages row names it): a regular file under real directories,
 * refused unless its size and sha256 are the ones expected.
 */
export async function readLegacyFile(config: Config, word: Word, rel: string, expect: { sha256: Sha256Hex; bytes: number }): Promise<Uint8Array> {
  const dir = legacyDir(config, word);
  const segs = typeof rel === "string" ? rel.split("/") : [];
  if (segs.length < 2 || segs.length > LEGACY_LIMITS.depth + 1 || !segs.every((s) => SEGMENT.test(s)) || (segs[0] !== "tree" && segs[0] !== "cadence")) {
    throw new Refusal("invalid-request", "not the path of a file kept in legacy/");
  }
  if (!SHA256_HEX_PATTERN.test(expect.sha256) || !Number.isSafeInteger(expect.bytes) || expect.bytes < 0 || expect.bytes > LEGACY_LIMITS.file_bytes) {
    throw new Refusal("invalid-request", "a legacy file is read against its sha256 and size");
  }
  await assertRealDir(dirname(dir), "the citizen directory");
  let cur = dir;
  await assertRealDir(cur, "legacy/");
  for (let i = 0; i < segs.length - 1; i++) {
    cur = join(cur, segs[i]!);
    await assertRealDir(cur, `legacy/${segs.slice(0, i + 1).join("/")}/`);
  }
  const bytes = await readRegularBytes(join(cur, segs.at(-1)!), LEGACY_LIMITS.file_bytes, `legacy/${rel}`);
  if (bytes.length !== expect.bytes || sha256Hex(bytes) !== expect.sha256) throw new Refusal("invalid-record", `legacy/${rel} does not match the size and sha256 its record gives`);
  return bytes;
}

/* ── Manifest validation: every field is checked, and any doubt throws ── */

function exactly(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${what} is not an object`);
  const got = Object.keys(value).sort();
  const want = [...keys].sort();
  if (got.length !== want.length || got.some((k, i) => k !== want[i])) throw new Error(`${what} has other fields than ${want.join(", ")}`);
  return value as Record<string, unknown>;
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Error(what);
  return v;
}

function whole(v: unknown, what: string): void {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error(what);
}

function sha(v: unknown, what: string): void {
  if (typeof v !== "string" || !SHA256_HEX_PATTERN.test(v)) throw new Error(what);
}

function treePath(v: unknown, what: string): void {
  const segs = typeof v === "string" ? v.split("/") : [];
  if (segs.length === 0 || segs.length > LEGACY_LIMITS.depth || !segs.every((s) => SEGMENT.test(s))) throw new Error(what);
}

function commit(v: unknown, what: string): void {
  const c = exactly(v, ["commit", "author_name", "as_citizen", "author_date", "subject"], what);
  if (typeof c.commit !== "string" || !COMMIT_ID.test(c.commit)) throw new Error(`${what}.commit`);
  str(c.author_name, `${what}.author_name`);
  if (c.as_citizen !== "yes" && c.as_citizen !== "no") throw new Error(`${what}.as_citizen`);
  if (typeof c.author_date !== "string" || !GIT_DATE.test(c.author_date)) throw new Error(`${what}.author_date`);
  str(c.subject, `${what}.subject`);
}

function validManifest(value: unknown, word: Word): LegacyManifest {
  const m = exactly(value, ["format", "word", "copied_at", "old_repo", "note", "files", "cadence", "not_copied"], "the manifest");
  if (m.format !== LEGACY_FORMAT) throw new Error("format");
  if (m.word !== word) throw new Error("word does not match its directory");
  if (typeof m.copied_at !== "string" || new Date(Date.parse(m.copied_at)).toISOString() !== m.copied_at) throw new Error("copied_at");
  const repo = exactly(m.old_repo, ["url", "head", "head_committed_at"], "old_repo");
  if (typeof repo.url !== "string" || !ORIGIN_URL.test(repo.url)) throw new Error("old_repo.url");
  if (typeof repo.head !== "string" || !COMMIT_ID.test(repo.head)) throw new Error("old_repo.head");
  if (typeof repo.head_committed_at !== "string" || !GIT_DATE.test(repo.head_committed_at)) throw new Error("old_repo.head_committed_at");
  str(m.note, "note");
  if (!Array.isArray(m.files) || !Array.isArray(m.cadence) || !Array.isArray(m.not_copied)) throw new Error("files, cadence and not_copied are lists");
  for (const raw of m.files) {
    const f = exactly(raw, ["path", "kind", "bytes", "sha256", "git_blob", "first", "last", "commits", "authored"], "files[]");
    treePath(f.path, "files[].path");
    if (!["beats", "inbox", "letters", "cadence", "marker", "other"].includes(f.kind as string)) throw new Error("files[].kind");
    whole(f.bytes, "files[].bytes");
    sha(f.sha256, "files[].sha256");
    if (typeof f.git_blob !== "string" || !COMMIT_ID.test(f.git_blob)) throw new Error("files[].git_blob");
    commit(f.first, "files[].first");
    commit(f.last, "files[].last");
    whole(f.commits, "files[].commits");
    if (!["citizen-name-beat-subject", "citizen-name", "other-names", "mixed"].includes(f.authored as string)) throw new Error("files[].authored");
  }
  for (const raw of m.cadence) {
    const c = exactly(raw, ["n", "commit", "file", "bytes", "sha256", "choice", "when", "beats", "not_appended", "note"], "cadence[]");
    whole(c.n, "cadence[].n");
    commit(c.commit, "cadence[].commit");
    if (c.file !== null && (typeof c.file !== "string" || !CADENCE_FILE.test(c.file))) throw new Error("cadence[].file");
    whole(c.bytes, "cadence[].bytes");
    if ((c.file === null) !== (c.sha256 === null)) throw new Error("cadence[].sha256 is set exactly when the version is kept");
    if (c.sha256 !== null) sha(c.sha256, "cadence[].sha256");
    if (c.choice !== null && (typeof c.choice !== "string" || !CHOICE.test(c.choice))) throw new Error("cadence[].choice");
    if (c.when !== null && (typeof c.when !== "string" || !WHEN.test(c.when))) throw new Error("cadence[].when");
    if (!Array.isArray(c.beats) || !Array.isArray(c.not_appended)) throw new Error("cadence[].beats and not_appended are lists");
    for (const rawBeat of c.beats) {
      const b = exactly(rawBeat, ["file", "from_path", "from_offset", "bytes", "sha256", "header", "match"], "cadence[].beats[]");
      if (typeof b.file !== "string" || !CADENCE_FILE.test(b.file)) throw new Error("cadence[].beats[].file");
      treePath(b.from_path, "cadence[].beats[].from_path");
      whole(b.from_offset, "cadence[].beats[].from_offset");
      whole(b.bytes, "cadence[].beats[].bytes");
      sha(b.sha256, "cadence[].beats[].sha256");
      str(b.header, "cadence[].beats[].header");
      if (b.match !== "header-starts-with-when" && b.match !== "header-differs") throw new Error("cadence[].beats[].match");
    }
    for (const p of c.not_appended) treePath(p, "cadence[].not_appended[]");
    if (c.note !== null && !["commit-added-no-beat", "beats-file-not-appended", "cadence-removed"].includes(c.note as string)) throw new Error("cadence[].note");
  }
  for (const raw of m.not_copied) {
    const s = exactly(raw, ["path", "mode", "bytes", "git_blob", "reason"], "not_copied[]");
    str(s.path, "not_copied[].path");
    if (typeof s.mode !== "string" || !/^\d{6}$/.test(s.mode)) throw new Error("not_copied[].mode");
    whole(s.bytes, "not_copied[].bytes");
    if (typeof s.git_blob !== "string" || !COMMIT_ID.test(s.git_blob)) throw new Error("not_copied[].git_blob");
    if (!["soul", "will", "agent-instruction-file", "hidden", "executable", "template", "path", "not-text"].includes(s.reason as string)) throw new Error("not_copied[].reason");
  }
  return value as LegacyManifest;
}
