// The free lane (3.6 "Unattended inference"): Ollama on 127.0.0.1 only, the
// model chosen by exact manifest digest from models.lock, no fallback. Refusal
// rests on content, not names, because the loopback API is unauthenticated
// and a signed-in server forwards to its cloud on its own credential
// (runtimes-and-host.md 1.3). The five steps there are the contract:
//   1. before: /api/tags row must match name, digest and runner, with no remote_host or remote_model;
//   2. call the native /api/chat as `<name>:local`, or `sha256:<digest>:local` on a v2 store;
//   3. after: reject any reply carrying remote_host or remote_model;
//   4. the host turns cloud off (a person does this in S5);
//   5. any mismatch means no beat, never a different model.
// Before any of them, the whole context must fit the locked window, because
// Ollama is understood to drop prompt tokens past num_ctx without an error.
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { fromUtf8, utf8 } from "../crypto.ts";
import {
  Refusal,
  SHA256_HEX_PATTERN,
  UNSET_PIN,
  type Config,
  type FetchLike,
  type ModelLockEntry,
  type ModelsLock,
  type Prompt,
  type RuntimeAdapter,
  type Spend,
} from "../types.ts";

export interface FreeDeps {
  config: Config;
  fetch: FetchLike;
  lock: ModelsLock;
  /** Which locked model this runtime uses, by name. */
  model: string;
  /**
   * The environment the request is made from; defaults to process.env. Bun's
   * fetch sends even a 127.0.0.1 request through HTTP_PROXY when one is set,
   * so the adapter refuses to run while any proxy variable is present.
   */
  env?: Record<string, string | undefined>;
}

export const MODELS_LOCK_FORMAT = "kingdom-seat-models-lock/v1";
/** A lock is a short list a person edits by hand; anything larger is not one. */
const MODELS_LOCK_MAX_BYTES = 64 * 1024;
/** One explicit tag, so the name is spelled exactly as /api/tags spells it and `:local` is the only suffix added. */
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const RUNNER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const ENTRY_KEYS = ["name", "digest", "runner", "store", "num_ctx", "num_predict", "temperature", "seed"] as const;
const PROXY_VARS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const;
/** setTimeout fires at once past 2^31-1 ms, which would turn a long deadline into none. */
const MAX_TIMER_MS = 2_147_483_647;

export const LOCAL_ZERO_SPEND: Readonly<Spend> = Object.freeze({ usd: "0", usd_basis: "local-zero", credits: 0 });

/* ── models.lock ──────────────────────────────────────────────────────── */

/** Read and validate models.lock as a regular file; strict JSON with the v1 format. */
export async function loadModelsLock(path: string): Promise<ModelsLock> {
  let st;
  try {
    st = await lstat(path);
  } catch (err) {
    if (errno(err) === "ENOENT") throw new Refusal("model-unpinned", "models.lock: not found, so no model is pinned");
    throw err;
  }
  if (st.isSymbolicLink()) throw new Refusal("symlink", "models.lock: is a symlink");
  if (!st.isFile()) throw new Refusal("not-regular-file", "models.lock: not a regular file");
  if (st.size > MODELS_LOCK_MAX_BYTES) throw new Refusal("oversize", `models.lock: larger than ${MODELS_LOCK_MAX_BYTES} bytes`);

  // O_NOFOLLOW and a second fstat close the window between lstat and open.
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (errno(err) === "ELOOP") throw new Refusal("symlink", "models.lock: is a symlink");
    throw err;
  }
  let bytes: Uint8Array;
  try {
    const fst = await fh.stat();
    if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) throw new Refusal("not-regular-file", "models.lock: changed while opening");
    if (fst.size > MODELS_LOCK_MAX_BYTES) throw new Refusal("oversize", `models.lock: larger than ${MODELS_LOCK_MAX_BYTES} bytes`);
    bytes = new Uint8Array(await fh.readFile());
  } finally {
    await fh.close();
  }
  if (bytes.length > MODELS_LOCK_MAX_BYTES) throw new Refusal("oversize", `models.lock: larger than ${MODELS_LOCK_MAX_BYTES} bytes`);

  let text: string;
  let raw: unknown;
  try {
    text = fromUtf8(bytes);
    raw = JSON.parse(text);
  } catch {
    throw new Refusal("invalid-record", "models.lock: not UTF-8 JSON");
  }
  // JSON.parse keeps the last of two equal keys; a person reading the file may see the first.
  assertNoDuplicateKeys(text);
  return parseModelsLock(raw);
}

/** Validate an untrusted value into a ModelsLock; every key, type and range is checked. */
export function parseModelsLock(raw: unknown): ModelsLock {
  const bad = (why: string) => new Refusal("invalid-record", `models.lock: ${why}`);
  if (!isRecord(raw)) throw bad("not an object");
  assertExactKeys(raw, ["format", "models"], "models.lock", bad);
  if (raw.format !== MODELS_LOCK_FORMAT) throw bad(`format is not ${MODELS_LOCK_FORMAT}`);
  if (!Array.isArray(raw.models)) throw bad("models is not a list");

  const seen = new Set<string>();
  const models = raw.models.map((m, i): ModelLockEntry => {
    const at = `models[${i}]`;
    if (!isRecord(m)) throw bad(`${at} is not an object`);
    assertExactKeys(m, ENTRY_KEYS, at, bad);
    const { name, digest, runner, store, num_ctx, num_predict, temperature, seed } = m;
    if (typeof name !== "string" || !MODEL_NAME_PATTERN.test(name)) throw bad(`${at}.name is not a model name with one explicit tag`);
    if (seen.has(name)) throw bad(`${at}.name repeats ${name}`);
    seen.add(name);
    if (typeof digest !== "string" || (digest !== UNSET_PIN && !SHA256_HEX_PATTERN.test(digest))) {
      throw bad(`${at}.digest is neither ${UNSET_PIN} nor 64 lowercase hex`);
    }
    if (runner !== null && (typeof runner !== "string" || !RUNNER_PATTERN.test(runner))) throw bad(`${at}.runner is not null or a runner name`);
    if (store !== "v2" && store !== "legacy" && store !== "unknown") throw bad(`${at}.store is not v2, legacy or unknown`);
    if (!isIntIn(num_ctx, 1, 1_048_576)) throw bad(`${at}.num_ctx is not an integer from 1 to 1048576`);
    // num_predict is the only output bound the server enforces, so -1 (unlimited) is refused.
    if (!isIntIn(num_predict, 1, num_ctx as number)) throw bad(`${at}.num_predict is not an integer from 1 to num_ctx`);
    if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw bad(`${at}.temperature is not a number from 0 to 2`);
    }
    if (seed !== null && !isIntIn(seed, 0, Number.MAX_SAFE_INTEGER)) throw bad(`${at}.seed is not null or a non-negative integer`);
    return { name, digest, runner: runner as string | null, store, num_ctx: num_ctx as number, num_predict: num_predict as number, temperature, seed: seed as number | null };
  });
  return { format: MODELS_LOCK_FORMAT, models };
}

/** The entry for `name`; refuses with "model-unpinned" while its digest is UNSET_PIN or not 64 hex. */
export function lockedEntry(lock: ModelsLock, name: string): ModelLockEntry {
  const matches = lock.models.filter((m) => m.name === name);
  if (matches.length === 0) throw new Refusal("model-unpinned", `models.lock: no entry for ${safeName(name)}`);
  if (matches.length > 1) throw new Refusal("invalid-record", `models.lock: more than one entry for ${safeName(name)}`);
  const entry = matches[0]!;
  assertPinned(entry);
  return entry;
}

function assertPinned(entry: ModelLockEntry): void {
  if (entry.digest === UNSET_PIN) {
    throw new Refusal("model-unpinned", `models.lock: ${safeName(entry.name)} is not pinned yet; a person pins it on the lease host`);
  }
  if (!SHA256_HEX_PATTERN.test(entry.digest)) throw new Refusal("model-unpinned", `models.lock: ${safeName(entry.name)} digest is not 64 lowercase hex`);
}

/* ── Before the call ──────────────────────────────────────────────────── */

/** Refuse any base URL that is not http on exactly 127.0.0.1 (not "localhost", not ::1, not another host). */
export function assertLoopback(baseUrl: string): URL {
  // Checked on the raw text because the URL parser normalises 127.1, 0x7f.0.0.1
  // and 2130706433 to 127.0.0.1, and "exactly" should mean what a person reads.
  const m = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/?$/.exec(baseUrl);
  const port = m ? Number(m[1]) : NaN;
  if (!m || port < 1 || port > 65535 || m[1]!.startsWith("0")) {
    throw new Refusal("not-loopback", "ollama.base_url must be http://127.0.0.1:<port> with nothing else");
  }
  const url = new URL(baseUrl);
  // The parser drops a default port, so :80 reads back as "".
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username !== "" || url.password !== "" || (url.port || "80") !== String(port)) {
    throw new Refusal("not-loopback", "ollama.base_url must be http://127.0.0.1:<port> with nothing else");
  }
  return url;
}

/** Refuse while a proxy variable is set: Bun routes even 127.0.0.1 through it (love-unlimited-patterns.md 5.3). */
export function assertNoProxy(env: Record<string, string | undefined>): void {
  for (const k of PROXY_VARS) {
    if (env[k] !== undefined && env[k] !== "") throw new Refusal("not-loopback", `${k} is set; a proxy could carry the loopback call elsewhere`);
  }
}

/** Check a GET /api/tags response against the lock entry; throws "model-mismatch" or "cloud-reply". */
export function checkTags(tags: unknown, entry: ModelLockEntry): void {
  assertPinned(entry);
  if (!isRecord(tags) || !Array.isArray(tags.models)) throw new Refusal("model-mismatch", "/api/tags: no models list");
  const rows = tags.models.filter((r): r is Record<string, unknown> => isRecord(r) && r.name === entry.name);
  const name = safeName(entry.name);
  if (rows.length === 0) throw new Refusal("model-mismatch", `/api/tags: no local model named ${name}`);
  if (rows.length > 1) throw new Refusal("model-mismatch", `/api/tags: more than one row named ${name}`);
  const row = rows[0]!;
  // A stub can carry any name and any digest a lister shows, so the cloud marks are checked first.
  if (marked(row.remote_host) || marked(row.remote_model)) throw new Refusal("cloud-reply", `/api/tags: ${name} forwards to a remote host`);
  if (row.digest !== entry.digest) throw new Refusal("model-mismatch", `/api/tags: ${name} digest differs from models.lock`);
  const details = isRecord(row.details) ? row.details : {};
  const runner = marked(details.runner) ? details.runner : null;
  if (runner !== entry.runner) throw new Refusal("model-mismatch", `/api/tags: ${name} runner differs from models.lock`);
}

/* ── Context fit ──────────────────────────────────────────────────────── */

/**
 * Tokens a chat template adds around the two turns and the reply's opening,
 * rounded up. Qwen 2.5's ChatML spends about 15: two
 * `<|im_start|>role\n ... <|im_end|>\n` blocks and `<|im_start|>assistant\n`
 * (read from the template, not run), so 64 leaves room for a template with a
 * short header of its own.
 */
export const CHAT_TEMPLATE_OVERHEAD_TOKENS = 64;

/**
 * Whether the whole prompt fits the locked model's window (KS-004 v0.2 5.3
 * item 1, re-review B2 C11). A self cut silently by the runtime would repeat
 * the old 2,600-character cut where no one sees it. With no tokenizer for the
 * pinned model, the count is the UTF-8 byte length of both turns: a byte-level
 * BPE such as Qwen 2.5's spends at least one byte on every token, so bytes
 * never undercount tokens. That, the template's overhead and num_predict (the
 * room the reply needs) must not pass num_ctx. It overcounts English about
 * fourfold, which costs a larger num_ctx, never a lost line of the self.
 */
export function contextFit(prompt: Prompt, entry: ModelLockEntry): { fits: boolean; needed: number; num_ctx: number } {
  const needed = utf8(prompt.system).length + utf8(prompt.user).length + CHAT_TEMPLATE_OVERHEAD_TOKENS + entry.num_predict;
  return { fits: needed <= entry.num_ctx, needed, num_ctx: entry.num_ctx };
}

/* ── The call and after ───────────────────────────────────────────────── */

/** The model reference to call: `sha256:<digest>:local` on a v2 store, else `<name>:local`. */
export function modelRef(entry: ModelLockEntry): string {
  assertPinned(entry);
  // `:local` makes the server itself refuse a stub that appears between the tags check and the call.
  return entry.store === "v2" ? `sha256:${entry.digest}:local` : `${entry.name}:local`;
}

/** The /api/chat body: stream false, no tools, format = schema, options from the lock, keep_alive 0, think false. */
export function chatBody(prompt: Prompt, entry: ModelLockEntry, schema: object): object {
  const options: Record<string, number> = {
    temperature: entry.temperature,
    num_ctx: entry.num_ctx,
    num_predict: entry.num_predict,
  };
  if (entry.seed !== null) options.seed = entry.seed;
  return {
    model: modelRef(entry),
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    stream: false,
    format: schema,
    options,
    // A tick every 30 minutes gains nothing from a model left loaded (runtimes-and-host.md 1.6).
    keep_alive: 0,
    think: false,
    // A manifest list resolves to one child per runner; name the pinned one.
    ...(entry.runner !== null ? { runner: entry.runner } : {}),
  };
}

/** Check a /api/chat reply: refuse remote_host or remote_model; return content and done_reason. */
export function checkChatReply(reply: unknown): { content: string; done_reason: string } {
  if (!isRecord(reply)) throw new Error("free: /api/chat reply is not an object");
  if (marked(reply.remote_host) || marked(reply.remote_model)) throw new Refusal("cloud-reply", "/api/chat: the reply was forwarded to a remote host");
  if (reply.error !== undefined) throw new Error(`free: /api/chat answered an error: ${printable(reply.error)}`);
  if (reply.done !== true) throw new Error("free: /api/chat reply is not done");
  const msg = reply.message;
  if (!isRecord(msg) || typeof msg.content !== "string") throw new Error("free: /api/chat reply has no message content");
  if (typeof reply.done_reason !== "string" || reply.done_reason === "") throw new Error("free: /api/chat reply has no done_reason");
  return { content: msg.content, done_reason: reply.done_reason };
}

/** The free-lane adapter: tags check, one chat call under the seat's deadline, reply check, $0 spend recorded. */
export function freeRuntime(deps: FreeDeps): RuntimeAdapter {
  return async (req) => {
    const started = performance.now();
    // Every wall that needs no request comes first, so a refusal sends nothing.
    const entry = lockedEntry(deps.lock, deps.model);
    const fit = contextFit(req.prompt, entry);
    if (!fit.fits) {
      throw new Refusal("context-too-large", `the whole context needs up to ${fit.needed} tokens (UTF-8 bytes, template and num_predict) and num_ctx is ${fit.num_ctx}; nothing is cut, so the seat does not open`);
    }
    const base = assertLoopback(deps.config.ollama.base_url);
    assertNoProxy(deps.env ?? process.env);
    const deadlineMs = checkDeadline(req.deadline_ms);
    if (req.signal.aborted) throw req.signal.reason;

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), deadlineMs);
    const overall = AbortSignal.any([req.signal, deadline.signal]);
    try {
      const connectMs = Math.min(deps.config.timing.runtime_connect_timeout_ms, deadlineMs);
      const tags = await callJson(deps.fetch, new URL("/api/tags", base), { method: "GET" }, overall, connectMs, "/api/tags");
      checkTags(tags, entry);

      const body = JSON.stringify(chatBody(req.prompt, entry, req.schema));
      const reply = await callJson(
        deps.fetch,
        new URL("/api/chat", base),
        { method: "POST", headers: { "content-type": "application/json" }, body },
        overall,
        null,
        "/api/chat",
      );
      const { content, done_reason } = checkChatReply(reply);
      return {
        runtime: "free",
        model: entry.name,
        model_digest: `sha256:${entry.digest}`,
        raw_output: content,
        spend: { ...LOCAL_ZERO_SPEND },
        // "length" is passed on as it is: the output may be cut off mid-object, and the seat must see that.
        done_reason,
        duration_ms: Math.round(performance.now() - started),
      };
    } catch (err) {
      if (req.signal.aborted) throw req.signal.reason;
      if (deadline.signal.aborted) throw new DOMException(`free: the runtime deadline of ${deadlineMs} ms was reached`, "TimeoutError");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** One request with no redirects; a status the free lane cannot use is a refusal or an error, never a retry. */
async function callJson(
  fetch: FetchLike,
  url: URL,
  init: RequestInit,
  overall: AbortSignal,
  boundMs: number | null,
  what: string,
): Promise<unknown> {
  const bound = boundMs === null ? null : new AbortController();
  const timer = bound ? setTimeout(() => bound.abort(), boundMs!) : null;
  try {
    const signal = bound ? AbortSignal.any([overall, bound.signal]) : overall;
    // A redirect from loopback could only lead somewhere that is not loopback.
    const res = await fetch(url, { ...init, redirect: "error", signal });
    const text = await res.text();
    if (!res.ok) {
      const detail = errorText(text);
      // 404 under `:local` means the model is gone or became a stub since the tags check;
      // 403 is the server's cloud switch refusing a remote model. Neither is retried.
      if (res.status === 404 && what === "/api/chat") throw new Refusal("model-mismatch", `${what} answered 404: the locked model did not resolve locally${detail}`);
      if (res.status === 403) throw new Refusal("cloud-reply", `${what} answered 403: the server refused a remote model${detail}`);
      throw new Error(`free: ${what} answered ${res.status}${detail}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`free: ${what} reply is not one JSON object`);
    }
  } catch (err) {
    if (bound?.signal.aborted && !overall.aborted) throw new Error(`free: ${what} did not answer within ${boundMs} ms`);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ── Small helpers ────────────────────────────────────────────────────── */

export function checkDeadline(ms: number): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0 || ms > MAX_TIMER_MS) {
    throw new Error(`runtime: deadline_ms must be a duration from 1 to ${MAX_TIMER_MS} ms`);
  }
  return Math.ceil(ms);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isIntIn(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/** A remote field counts as set unless it is absent, null or empty: Ollama omits it on a local model. */
function marked(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

function assertExactKeys(obj: Record<string, unknown>, keys: readonly string[], at: string, bad: (why: string) => Error): void {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) throw bad(`${at} has unknown key ${JSON.stringify(k).slice(0, 40)}`);
  for (const k of keys) if (!(k in obj)) throw bad(`${at} is missing ${k}`);
}

function errno(err: unknown): string | undefined {
  return isRecord(err) && typeof err.code === "string" ? err.code : undefined;
}

/** Names come from a file or a server; keep messages printable and short. */
function safeName(name: string): string {
  return JSON.stringify(name.slice(0, 80));
}

function printable(v: unknown): string {
  return String(typeof v === "string" ? v : JSON.stringify(v))
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 200);
}

function errorText(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && parsed.error !== undefined) return ` (${printable(parsed.error)})`;
  } catch {
    // Not JSON: the status alone is the report.
  }
  return "";
}

/**
 * Refuse JSON text with a repeated key in any object. Run after JSON.parse
 * succeeded, so the text is known to be well formed.
 */
export function assertNoDuplicateKeys(text: string): void {
  const stack: { keys: Set<string> | null; expectKey: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push({ keys: null, expectKey: false });
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") {
      const top = stack[stack.length - 1];
      if (top?.keys) top.expectKey = true;
    } else if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) throw new Refusal("invalid-record", `models.lock: key ${JSON.stringify(key).slice(0, 40)} appears twice in one object`);
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j;
    }
  }
}
