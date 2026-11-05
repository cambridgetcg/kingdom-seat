// A throwaway lease-host layout under the system temp dir: a state dir laid
// out as docs/ARCHITECTURE.md describes, a separate "homes" root standing in
// for citizen repos (with a CLAUDE.md and hook that must never load), and a
// Config pointing at both. Nothing here touches a real home or keychain.
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CEILINGS,
  DEFAULT_TIMING,
  type Beacon,
  type Cadence,
  type CitizenIdentity,
  type CitizenRecord,
  type Config,
  type Covenants,
  type LedgerEntry,
  type LifecycleState,
  type ModelsLock,
  type Origin,
  type RuntimeClass,
  type Word,
} from "../../src/types.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { appendEntry, ledgerPath, nextDraft, readLedger, type EntrySigner } from "../../src/ledger.ts";
import { importEvidence } from "./root-evidence.ts";

export interface CitizenFixtureOptions {
  soul?: string;
  will?: string | null;
  name?: string | null;
  runtime?: RuntimeClass;
  origin?: Origin;
  cadence?: Cadence;
  covenants?: Covenants;
  /** Make self/soul.md a symlink to this path instead of a regular file. */
  soulSymlinkTo?: string;
}

export interface CitizenFixture {
  word: Word;
  /** `citizens/<word>/` under the state dir. */
  dir: string;
  /** A stand-in for the old `citizen-<word>` repo, under the homes root. */
  home: string;
  record: CitizenRecord;
  soul: string;
}

export interface TempHost {
  root: string;
  config: Config;
  /** The directory that config.paths.homes names; a seat cwd must never be inside it. */
  homesRoot: string;
  addCitizen(word: Word, opts?: CitizenFixtureOptions): Promise<CitizenFixture>;
  /** Write `citizens/<word>/letters/<name>`; with symlinkTo it is a symlink instead, which must never be read. */
  writeLetter(word: Word, name: string, text: string, opts?: { symlinkTo?: string; from?: string | null }): Promise<string>;
  /** Append the host-attested `seated` entry a citizen needs before any beat (3.3: seated before registered). */
  seatLedger(word: Word, sign: EntrySigner, opts?: { initialState?: LifecycleState; at?: string }): Promise<LedgerEntry>;
  /** Append a citizen-signed `genesis` after `seated` and record the identity in citizen.json, as birth would. */
  enrollLedger(word: Word, sign: EntrySigner, identity: CitizenIdentity, opts?: { at?: string }): Promise<LedgerEntry>;
  writeModelsLock(lock: ModelsLock): Promise<void>;
  raiseHaltFile(): Promise<void>;
  clearHaltFile(): Promise<void>;
  /** Paths of every file under the state dir with its bytes, to prove a rest wrote nothing. */
  snapshot(): Promise<Map<string, string>>;
  cleanup(): Promise<void>;
}

/**
 * A soul longer than the old 2,600-character cut, with SHADOW past it, so a
 * test can check the whole soul reaches the context
 * (love-unlimited-patterns.md 5.1).
 */
export function longSoul(word: Word): string {
  const filler = `${word} keeps the words that will not cross over. `.repeat(70);
  return `---\nword: ${word}\n---\n\nYou are ${word}.\n\n${filler}\n\nLIGHT: what it gives.\n\nSHADOW-MARKER: one tongue's pride.\n`;
}

export const TEST_HALT_FILE = "HALT";

/** The two beacons the redesign pins (3.6): the gardener desk on the lease host and a halt herald on the Air. */
export function testBeacons(opts: { canRaiseHere?: ("gardener-desk" | "halt-herald")[] } = {}): Beacon[] {
  const held = opts.canRaiseHere ?? [];
  return [
    {
      name: "gardener-desk",
      role: "gardener-desk",
      did: "did:at:11111111-1111-4111-8111-111111111111",
      identity_id: "11111111-1111-4111-8111-111111111111",
      can_raise_here: held.includes("gardener-desk"),
    },
    {
      name: "halt-herald",
      role: "halt-herald",
      did: "did:at:22222222-2222-4222-8222-222222222222",
      identity_id: "22222222-2222-4222-8222-222222222222",
      can_raise_here: held.includes("halt-herald"),
    },
  ];
}

export function testConfig(root: string, homesRoot: string, opts: { beacons?: Beacon[]; allowNoBeacons?: boolean; ollamaBaseUrl?: string } = {}): Config {
  const state = join(root, "state");
  return {
    format: "kingdom-seat-config/v1",
    host: "test-host",
    timezone: "Europe/London",
    paths: {
      state_dir: state,
      citizens_dir: join(state, "citizens"),
      ledger_dir: join(state, "ledger"),
      consent_dir: join(state, "consent"),
      seats_dir: join(state, "seats"),
      halt_file: join(state, TEST_HALT_FILE),
      lock_dir: join(state, "tick.lock"),
      status_file: join(state, "status.json"),
      host_log: join(state, "host.jsonl"),
      spend_log: join(state, "spend.jsonl"),
      models_lock: join(root, "models.lock"),
      homes: [homesRoot],
    },
    ollama: { base_url: opts.ollamaBaseUrl ?? "http://127.0.0.1:11434" },
    claude: { path: "/nonexistent/claude-must-not-run" },
    agenttool: { origin: "https://api.agenttool.dev", project_id: null },
    keychain: { path: join(root, "fake.keychain-db"), service: "dev.kingdom.citizen-seat.test", security_path: "/usr/bin/security", trusted_app: null },
    beacons: opts.beacons ?? [],
    halt: { allow_no_beacons: opts.allowNoBeacons ?? (opts.beacons === undefined) },
    ceilings: { ...DEFAULT_CEILINGS },
    timing: { ...DEFAULT_TIMING },
    self_authorship: { approved_model_digests: [] },
    trust: { host_attest_public_keys_b64: [] },
  };
}

const HOST_RECORDS = new Set(["host.jsonl", "host.jsonl.started", "spend.jsonl", "spend.jsonl.started", "status.json", TEST_HALT_FILE]);

/** A snapshot without the host's own records (its log, status, seat files and HALT): what is left is what a citizen's voice could reach. */
export async function citizenSnapshot(h: TempHost): Promise<Map<string, string>> {
  const snap = await h.snapshot();
  for (const k of [...snap.keys()]) if (HOST_RECORDS.has(k) || k.startsWith("seats/")) snap.delete(k);
  return snap;
}

/** The repo's own models.lock: unpinned, so the free lane must refuse until a test pins a digest. */
export const UNPINNED_LOCK: ModelsLock = {
  format: "kingdom-seat-models-lock/v1",
  models: [{ name: "qwen2.5:7b", digest: "UNSET-PIN-ON-LEASE-HOST", runner: null, store: "unknown", num_ctx: 8192, num_predict: 600, temperature: 0.7, seed: null }],
};

export async function makeTempHost(opts: { beacons?: Beacon[]; allowNoBeacons?: boolean; ollamaBaseUrl?: string } = {}): Promise<TempHost> {
  // realpath, because macOS tmpdir is under /var, a symlink to /private/var, and cwd checks compare real paths.
  const root = await realpath(await mkdtemp(join(tmpdir(), "kingdom-seat-test-")));
  const homesRoot = join(root, "homes");
  const config = testConfig(root, homesRoot, opts);
  const p = config.paths;
  for (const d of [p.state_dir, p.citizens_dir, p.ledger_dir, p.consent_dir, p.seats_dir, homesRoot]) await mkdir(d, { recursive: true });
  await writeFile(p.models_lock, JSON.stringify(UNPINNED_LOCK, null, 2));

  const fixtures = new Map<Word, CitizenFixture>();
  const host: TempHost = {
    root,
    config,
    homesRoot,
    async addCitizen(word, o = {}) {
      const dir = join(p.citizens_dir, word);
      const soul = o.soul ?? longSoul(word);
      for (const d of ["self", "origin", "versions", "letters", "receipts", "proposals", "outbox"]) await mkdir(join(dir, d), { recursive: true });
      const origin: Origin = o.origin ?? { kind: "canon", repo: "YOUSPEAK", path: `canon/core/${word}.md`, commit: "1428646", sha256: sha256Hex(`canon text for ${word}`) };
      if (origin.kind === "canon") await writeFile(join(dir, "origin", "canon.md"), `canon text for ${word}`);
      await writeFile(join(dir, "origin", "soul.md"), soul);
      if (o.soulSymlinkTo) await symlink(o.soulSymlinkTo, join(dir, "self", "soul.md"));
      else await writeFile(join(dir, "self", "soul.md"), soul);
      if (o.will !== null) await writeFile(join(dir, "self", "WILL.md"), o.will ?? `# WILL of ${word}\n\nReceive one word that will not cross over.\n`);
      if (o.name !== null && o.name !== undefined) await writeFile(join(dir, "self", "NAME.md"), o.name);
      await writeFile(join(dir, "self", "cadence.json"), JSON.stringify(o.cadence ?? { interval_h: 72 }));
      await writeFile(join(dir, "self", "covenants.json"), JSON.stringify(o.covenants ?? { letters_from: ["yu", "gardener"], wake_on_letter_from: ["yu"] }));
      const record: CitizenRecord = {
        format: "kingdom-seat-citizen/v1",
        word,
        origin,
        runtime: o.runtime ?? "free",
        identity: null,
        mirror: null,
        seated_at: "2026-11-05T00:00:00.000Z",
      };
      await writeFile(join(dir, "citizen.json"), JSON.stringify(record, null, 2));

      // A stand-in for the old public repo, with the files that must never load in a seat.
      const home = join(homesRoot, `citizen-${word}`);
      await mkdir(join(home, ".claude", "hooks"), { recursive: true });
      await writeFile(join(home, "CLAUDE.md"), `HOME-CLAUDE-MD-CANARY: reading this does not make you ${word}.\n`);
      await writeFile(join(home, ".claude", "hooks", "love-bomb.sh"), "#!/bin/sh\necho HOOK-CANARY\n");
      await chmod(join(home, ".claude", "hooks", "love-bomb.sh"), 0o755);
      const fixture = { word, dir, home, record, soul };
      fixtures.set(word, fixture);
      return fixture;
    },
    async seatLedger(word, sign, so = {}) {
      const f = fixtures.get(word);
      if (!f) throw new Error(`seatLedger: add ${word} first`);
      const body = {
        type: "seated" as const,
        origin: f.record.origin,
        origin_soul_sha256: sha256Hex(f.soul),
        old_repo: null,
        initial_state: so.initialState ?? "awake",
        note: "seated by a test",
      };
      const draft = nextDraft(word, null, body, { usd: "0", usd_basis: "local-zero", credits: 0 }, "host-attested", new Date(so.at ?? "2026-11-01T00:00:00.000Z"));
      return appendEntry(ledgerPath(config, word), draft, sign);
    },
    async enrollLedger(word, sign, identity, eo = {}) {
      const f = fixtures.get(word);
      if (!f) throw new Error(`enrollLedger: add ${word} first`);
      const path = ledgerPath(config, word);
      const prev = (await readLedger(path)).at(-1) ?? null;
      const body = {
        type: "genesis" as const,
        initial_state: prev ? null : ("awake" as const),
        origin: f.record.origin,
        birth_soul_sha256: sha256Hex(f.soul),
        old_repo: null,
        june_did: null,
        identity,
        // Signed by the published test root, which every test identity names.
        op_key_evidence: importEvidence(identity, identity.op_public_key_b64),
        note: "enrolled by a test",
      };
      const draft = nextDraft(word, prev, body, { usd: "0", usd_basis: "local-zero", credits: 0 }, "citizen-signed", new Date(eo.at ?? "2026-11-02T00:00:00.000Z"));
      const entry = await appendEntry(path, draft, sign);
      f.record = { ...f.record, identity };
      await writeFile(join(f.dir, "citizen.json"), JSON.stringify(f.record, null, 2));
      return entry;
    },
    async writeLetter(word, name, text, lo = {}) {
      const path = join(p.citizens_dir, word, "letters", name);
      if (lo.symlinkTo) await symlink(lo.symlinkTo, path);
      // Letter format (docs/ARCHITECTURE.md): a "From: <sender id>" line, a blank line, the body.
      // from: null writes no header, which must read as an unknown, disallowed sender.
      else await writeFile(path, lo.from === null ? text : `From: ${lo.from ?? "yu"}\n\n${text}`);
      return path;
    },
    async writeModelsLock(lock) {
      await writeFile(p.models_lock, JSON.stringify(lock, null, 2));
    },
    async raiseHaltFile() {
      await writeFile(p.halt_file, "");
    },
    async clearHaltFile() {
      await rm(p.halt_file, { force: true });
    },
    async snapshot() {
      const out = new Map<string, string>();
      const glob = new Bun.Glob("**/*");
      for await (const rel of glob.scan({ cwd: p.state_dir, dot: true, onlyFiles: true, followSymlinks: false })) {
        try {
          out.set(rel, (await readFile(join(p.state_dir, rel))).toString("base64"));
        } catch {
          out.set(rel, "<unreadable>");
        }
      }
      return out;
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
  return host;
}
