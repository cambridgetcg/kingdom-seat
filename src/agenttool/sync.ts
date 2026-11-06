// A registered citizen's self on agenttool (KS-004 4.3, 9.3): the private
// expression, brought to the self each time a change binds, and one
// encrypted strand thought per applied change as its off-host backup. This is
// the production ExpressionSync (self.ts), built on the client, so every
// request goes through the signer: the expression PUT is root-signed, the
// strand and its thoughts pass the credit ceiling, and nothing here holds a
// key, a bearer or a thought's plaintext past the signer's sealing.
//
// Why both: the expression keeps no history, and the ledger lives on one
// host. The expression holds the current self; the strand holds, off the
// host, every change that made it, in a form only the citizen's own mnemonic
// can read (K_master, STRAND_KEY_ID).
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson, randomBytes, toHex, utf8 } from "../crypto.ts";
import { syncDir, writeAll } from "../ledger.ts";
import { readCitizenRecord } from "../state.ts";
import { readTarget, type BackupResult, type ExpressionSync, type SelfBackup } from "../self.ts";
import { SignerNotSent, type Signer } from "../signer/signer.ts";
import { Refusal, UUID_PATTERN, WORD_PATTERN, type Clock, type Config, type ExpressionSyncState, type FetchLike, type RefusalCode, type SelfTarget, type Word } from "../types.ts";
import { createStrand, postThought, putExpression, readExpression, type ClientDeps } from "./client.ts";
import { EXPRESSION_LIMITS, isCanonicalIso, validateExpression, type Expression } from "./wire.ts";

/**
 * The fixed headings under which wake_text carries the soul as the citizen
 * now understands it, its WILL, its name readings and its own wake text, in
 * this order (KS-004 4.3). A section whose file is absent or empty is left
 * out; the soul is always there.
 */
export const WAKE_TEXT_HEADINGS = Object.freeze({
  soul: "# Soul",
  will: "# WILL",
  name: "# Name readings",
  wake_text: "# Wake text",
});

/** The self targets the private expression holds; a change to any other (cadence, a skill, a file) leaves it as it is. */
export const EXPRESSION_TARGETS: ReadonlySet<SelfTarget> = new Set<SelfTarget>(["soul", "will", "name", "expression.register", "expression.walls", "expression.wake_text"]);

/** The strand's topic, stored by agenttool in plaintext, so it names nothing but what the strand is for. */
export const SELF_STRAND_TOPIC = "kingdom-seat self-change backups, encrypted";

/** The thought format inside the ciphertext. */
export const SELF_BACKUP_FORMAT = "kingdom-seat-self-backup/v1";

/** The texts the private expression is built from, as the self files hold them ("" for an absent one). */
export interface SelfTexts {
  soul: string;
  will: string;
  name: string;
  register: string;
  walls: string;
  wake_text: string;
}

const TEXT_FOR: Readonly<Record<string, keyof SelfTexts>> = {
  soul: "soul",
  will: "will",
  name: "name",
  "expression.register": "register",
  "expression.walls": "walls",
  "expression.wake_text": "wake_text",
};

/** wake_text: each section under its heading, a blank line between them. */
export function wakeText(t: Pick<SelfTexts, "soul" | "will" | "name" | "wake_text">): string {
  const sections: string[] = [];
  for (const key of ["soul", "will", "name", "wake_text"] as const) {
    const text = t[key];
    if (key !== "soul" && text.trim() === "") continue;
    sections.push(`${WAKE_TEXT_HEADINGS[key]}\n\n${text.replace(/\n+$/, "")}\n`);
  }
  return sections.join("\n");
}

/** The walls, one per non-empty line, as self.ts reads them when it asks whether a change loosens one. */
export function wallsOf(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * The expression to PUT: the private fields (register, walls, wake_text)
 * from the self, and the stored expression's other fields as they are, since
 * a PUT replaces the whole object. The porch and the village are public and
 * beyond self, so they are kept, never written; a porch invitation that has
 * already closed is left out, because agenttool refuses one in the past.
 * `lags` when the self does not fit agenttool's limits: then nothing is sent,
 * and the expression is left as it was (KS-004 4.3: never cut).
 */
export function nextExpression(current: Expression, t: SelfTexts, nowMs: number): { expression: Expression } | { lags: string } {
  const out: Expression = {};
  if (current.subagents !== undefined) out.subagents = current.subagents;
  if (current.cli_overrides !== undefined) out.cli_overrides = current.cli_overrides;
  if (current.village !== undefined) out.village = current.village;
  const porch = current.porch?.invited_until;
  if (isCanonicalIso(porch) && Date.parse(porch) > nowMs && Date.parse(porch) <= nowMs + EXPRESSION_LIMITS.porch_ms) out.porch = { invited_until: porch };
  const register = t.register.replace(/\s+$/, "");
  if (register !== "") out.register = register;
  const walls = wallsOf(t.walls);
  if (walls.length > 0) out.walls = walls;
  out.wake_text = wakeText(t);
  try {
    validateExpression(out, nowMs);
  } catch (e) {
    return { lags: e instanceof Refusal ? e.message : "does not fit" };
  }
  return { expression: out };
}

/** The self's texts with one target at `text`, the text a change is about to bind. */
export async function readSelfTexts(config: Config, word: Word, override: { target: SelfTarget; text: string } | null): Promise<SelfTexts> {
  const t: SelfTexts = { soul: "", will: "", name: "", register: "", walls: "", wake_text: "" };
  for (const [target, key] of Object.entries(TEXT_FOR)) {
    t[key] = override && override.target === target ? override.text : await readTarget(config, word, target as SelfTarget);
  }
  return t;
}

/**
 * The thought a backup posts, before the signer encrypts it: the change as
 * the ledger's apply entry names it, with its diff, so the strand alone can
 * rebuild the self's history from the origin.
 */
export function backupPlaintext(word: Word, b: SelfBackup): string {
  return canonicalJson({
    format: SELF_BACKUP_FORMAT,
    word,
    ref: b.ref,
    target: b.target,
    prior_hash: b.prior_hash,
    new_hash: b.new_hash,
    via: b.via,
    diff: b.diff,
    reason: b.reason,
    strand_key: b.strand_key,
  });
}

/** The thought's kind, which agenttool keeps in plaintext and the signature covers: it names the key the thought is encrypted under. */
export function backupKind(strandKey: string): string {
  return `self-backup ${strandKey}`;
}

/** Whether a failed call may have left the host, and so may have been charged: anything but a wall or a definite not-sent. */
function mayHaveSent(e: unknown): boolean {
  return !(e instanceof Refusal || e instanceof SignerNotSent);
}

function codeOf(e: unknown): RefusalCode | "error" {
  return e instanceof Refusal ? e.code : "error";
}

export interface SyncDeps {
  config: Config;
  clock: Clock;
  client: ClientDeps;
}

/** The ClientDeps a host builds for its registered citizens: the signer, and each identity read from its citizen.json. */
export function hostClient(config: Config, signer: Signer, fetch: FetchLike): ClientDeps {
  return {
    signer,
    fetch,
    async identity(word) {
      const record = await readCitizenRecord(config, word);
      if (!record.identity) throw new Refusal("not-registered", `${word} has no agenttool identity yet`);
      return record.identity;
    },
  };
}

/** The production ExpressionSync: the expression through a root-signed PUT, the backup through the citizen's own strand. */
export function agenttoolSync(deps: SyncDeps): ExpressionSync {
  const { config, clock, client } = deps;
  return {
    async putPrivateExpression(word, target, text): Promise<ExpressionSyncState | null> {
      if (!EXPRESSION_TARGETS.has(target)) return null;
      const texts = await readSelfTexts(config, word, { target, text });
      // A PUT replaces the whole object, so read what is stored first and keep what is not the self's.
      const current = await readExpression(client, word);
      const next = nextExpression(current, texts, clock.now().getTime());
      if ("lags" in next) return "lags";
      // Already what the self says: nothing to send, and no authority sequence spent on it.
      if (canonicalJson(next.expression) === canonicalJson(current)) return "updated";
      await putExpression(client, word, next.expression);
      return "updated";
    },

    async postBackup(word, backup): Promise<BackupResult> {
      let credits = 0;
      const deferred = (e: unknown): BackupResult => ({ thought_id: null, deferred: codeOf(e), credits });
      let strand: string | null;
      try {
        const record = await readCitizenRecord(config, word);
        if (!record.identity) return deferred(new Refusal("not-registered", "no identity"));
        strand = record.identity.self_strand_id;
      } catch (e) {
        return deferred(e);
      }
      if (strand === null) {
        // Created once, on first need, and only together with the thought it exists for (KS-004 4.3).
        try {
          strand = (await createStrand(client, word, SELF_STRAND_TOPIC, { then: 1 })).strand_id;
          credits += 1;
        } catch (e) {
          if (mayHaveSent(e)) credits += 1;
          return deferred(e);
        }
        try {
          await recordSelfStrand(config, word, strand);
        } catch (e) {
          // The strand exists and was paid for, but without its id on record no thought may go to it.
          return deferred(e);
        }
      }
      try {
        const posted = await postThought(client, word, strand, backupPlaintext(word, backup), backupKind(backup.strand_key));
        credits += 1;
        return { thought_id: posted.thought_id, credits };
      } catch (e) {
        if (mayHaveSent(e)) credits += 1;
        return deferred(e);
      }
    },
  };
}

/**
 * Keep the citizen's strand id in its citizen.json, `identity.self_strand_id`,
 * once: the record the client and the signer both read before a thought may
 * go to that strand and no other. Replaced by rename from a sibling temp
 * file, so a reader never sees half a record. A record that already names
 * another strand is refused, never overwritten.
 */
export async function recordSelfStrand(config: Config, word: Word, strandId: string): Promise<void> {
  if (!WORD_PATTERN.test(word)) throw new Refusal("invalid-request", "not a citizen word");
  if (typeof strandId !== "string" || !UUID_PATTERN.test(strandId)) throw new Refusal("invalid-request", "a strand id is a lowercase UUID");
  const record = await readCitizenRecord(config, word);
  if (!record.identity) throw new Refusal("not-registered", `${word} has no agenttool identity yet`);
  if (record.identity.self_strand_id === strandId) return;
  if (record.identity.self_strand_id !== null) throw new Refusal("invalid-record", `${word} already keeps another strand; it is never replaced`);
  const path = join(config.paths.citizens_dir, word, "citizen.json");
  const tmp = join(dirname(path), `.citizen.json.${toHex(randomBytes(8))}.tmp`);
  const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    try {
      await writeAll(fh, utf8(`${JSON.stringify({ ...record, identity: { ...record.identity, self_strand_id: strandId } }, null, 2)}\n`));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  await syncDir(dirname(path));
}
