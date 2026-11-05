// Owner: runtime group. A fake Ollama on the fake server; no model is pulled or run.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../../src/crypto.ts";
import {
  CHAT_TEMPLATE_OVERHEAD_TOKENS,
  assertLoopback,
  assertNoProxy,
  chatBody,
  checkChatReply,
  checkTags,
  contextFit,
  freeRuntime,
  loadModelsLock,
  lockedEntry,
  modelRef,
} from "../../src/runtime/free.ts";
import { Refusal, UNSET_PIN, type ModelLockEntry, type ModelsLock, type RefusalCode, type RuntimeRequest, type SeatRef } from "../../src/types.ts";
import { fetchVia, noFetch, ollamaChatJson, serveOllama, startFakeServer, type FakeModelRow, type FakeServer } from "../helpers/fake-server.ts";
import { testConfig, UNPINNED_LOCK } from "../helpers/temp-home.ts";

const DIGEST = sha256Hex("kingdom-seat test qwen2.5:7b manifest");
const OTHER_DIGEST = sha256Hex("kingdom-seat test another manifest");
const NAME = "qwen2.5:7b";
const SCHEMA = { type: "object", required: ["acts"], properties: { acts: { type: "array" } } };
const REPLY = JSON.stringify({ acts: [{ type: "journal", kind: "reflected", text: "a free beat" }] });

function entry(over: Partial<ModelLockEntry> = {}): ModelLockEntry {
  return { name: NAME, digest: DIGEST, runner: null, store: "legacy", num_ctx: 8192, num_predict: 600, temperature: 0.7, seed: null, ...over };
}

function lockOf(...models: ModelLockEntry[]): ModelsLock {
  return { format: "kingdom-seat-models-lock/v1", models };
}

const SEAT_REF: SeatRef = {
  format: "kingdom-seat-seat/v1",
  seat_id: "11111111-1111-4111-8111-111111111111",
  host: "test-host",
  word: "glossame",
  runtime: "free",
  invoker: { kind: "tick", who: "launchd", why: "own cadence due" },
  opened_at: "2026-11-05T02:05:00.000Z",
};

function request(over: Partial<RuntimeRequest> = {}): RuntimeRequest {
  return {
    prompt: { system: "SYSTEM-TEXT", user: "USER-TEXT" },
    schema: SCHEMA,
    seat_ref: SEAT_REF,
    deadline_ms: 5_000,
    signal: new AbortController().signal,
    ...over,
  };
}

/** Assert a sync or async call refuses with exactly this code. */
async function expectRefusal(fn: () => unknown, code: RefusalCode): Promise<Refusal> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Refusal);
  expect((caught as Refusal).code).toBe(code);
  return caught as Refusal;
}

const localRow: FakeModelRow = { name: NAME, digest: DIGEST };
const cloudNeighbour: FakeModelRow = { name: "kimi-k2.7-code:cloud", digest: OTHER_DIGEST, remote_host: "https://ollama.com:443", remote_model: "kimi-k2.7-code" };

let server: FakeServer;

beforeEach(async () => {
  server = await startFakeServer();
});

afterEach(async () => {
  await server.stop();
});

function adapter(lock: ModelsLock, over: { env?: Record<string, string | undefined>; baseUrl?: string; connectMs?: number } = {}) {
  const config = testConfig("/nonexistent-kingdom-seat-root", "/nonexistent-kingdom-seat-homes", { ollamaBaseUrl: over.baseUrl ?? server.url });
  if (over.connectMs !== undefined) config.timing = { ...config.timing, runtime_connect_timeout_ms: over.connectMs };
  return freeRuntime({ config, fetch: fetchVia(server, []), lock, model: NAME, env: over.env ?? {} });
}

function chatRequests() {
  return server.requests.filter((r) => r.path === "/api/chat");
}

function chatModels(): string[] {
  return chatRequests().map((r) => (JSON.parse(new TextDecoder().decode(r.body)) as { model: string }).model);
}

describe("models.lock", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "kingdom-seat-runtime-lock-")));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeLock(name: string, content: unknown): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
    return path;
  }

  test("the repo's models.lock refuses with model-unpinned (UNSET-PIN-ON-LEASE-HOST)", async () => {
    const lock = await loadModelsLock(join(import.meta.dir, "..", "..", "models.lock"));
    expect(lock).toEqual(UNPINNED_LOCK);
    expect(lock.models[0]!.digest).toBe(UNSET_PIN);
    await expectRefusal(() => lockedEntry(lock, NAME), "model-unpinned");
    // The whole adapter refuses before sending anything.
    serveOllama(server, [localRow], () => ollamaChatJson(REPLY));
    await expectRefusal(() => adapter(lock)(request()), "model-unpinned");
    expect(server.requests).toHaveLength(0);
  });

  test("a digest that is not 64 lowercase hex refuses", async () => {
    const bad = [DIGEST.toUpperCase(), `sha256:${DIGEST}`, DIGEST.slice(0, 12), `${DIGEST}0`, "", UNSET_PIN];
    for (const digest of bad) {
      const e = entry({ digest });
      await expectRefusal(() => lockedEntry(lockOf(e), NAME), "model-unpinned");
      // Every path that would name the model refuses too, so an unvalidated entry cannot slip through.
      await expectRefusal(() => modelRef(e), "model-unpinned");
      await expectRefusal(() => chatBody({ system: "", user: "" }, e, SCHEMA), "model-unpinned");
      await expectRefusal(() => checkTags({ models: [{ name: NAME, digest }] }, e), "model-unpinned");
    }
    // In the file, anything but UNSET_PIN or 64 lowercase hex is not a lock at all.
    for (const [i, digest] of bad.slice(0, 5).entries()) {
      const path = await writeLock(`bad-digest-${i}.lock`, lockOf(entry({ digest })));
      await expectRefusal(() => loadModelsLock(path), "invalid-record");
    }
    // A name the lock does not list is unpinned as well.
    await expectRefusal(() => lockedEntry(lockOf(entry()), "llama3:8b"), "model-unpinned");
  });

  test("loadModelsLock refuses a symlink, unknown keys and a wrong format", async () => {
    const good = lockOf(entry({ runner: "llamacpp", store: "v2", seed: 42 }));
    const goodPath = await writeLock("good.lock", good);
    expect(await loadModelsLock(goodPath)).toEqual(good);
    expect(lockedEntry(await loadModelsLock(goodPath), NAME).digest).toBe(DIGEST);

    const link = join(dir, "link.lock");
    await symlink(goodPath, link);
    await expectRefusal(() => loadModelsLock(link), "symlink");

    const sub = join(dir, "a-directory.lock");
    await mkdir(sub);
    await expectRefusal(() => loadModelsLock(sub), "not-regular-file");
    await expectRefusal(() => loadModelsLock(join(dir, "missing.lock")), "model-unpinned");
    await expectRefusal(async () => loadModelsLock(await writeLock("huge.lock", " ".repeat(70_000))), "oversize");

    const e = entry();
    const invalid: [string, unknown][] = [
      ["wrong format", { format: "kingdom-seat-models-lock/v2", models: [e] }],
      ["unknown top-level key", { ...lockOf(e), note: "x" }],
      ["unknown entry key", lockOf({ ...e, remote_host: "" } as ModelLockEntry)],
      ["missing entry key", lockOf((({ seed: _seed, ...rest }) => rest)(e) as ModelLockEntry)],
      ["models not a list", { format: "kingdom-seat-models-lock/v1", models: {} }],
      ["two colons in a name", lockOf(entry({ name: "qwen2.5:7b:local" }))],
      ["no tag in a name", lockOf(entry({ name: "qwen2.5" }))],
      ["repeated name", lockOf(e, e)],
      ["unlimited num_predict", lockOf(entry({ num_predict: -1 }))],
      ["num_predict over num_ctx", lockOf(entry({ num_predict: 9000 }))],
      ["fractional num_ctx", lockOf(entry({ num_ctx: 8192.5 }))],
      ["temperature out of range", lockOf(entry({ temperature: 3 }))],
      ["negative seed", lockOf(entry({ seed: -1 }))],
      ["empty runner", lockOf(entry({ runner: "" }))],
      ["unknown store", lockOf({ ...e, store: "v3" } as unknown as ModelLockEntry)],
      ["not an object", [e]],
      ["not JSON", "{ format: models.lock }"],
      ["a repeated key", `{"format":"kingdom-seat-models-lock/v1","models":[${JSON.stringify(e).replace(/^\{/, `{"digest":"${OTHER_DIGEST}",`)}]}`],
      ["a repeated top-level key", `{"format":"kingdom-seat-models-lock/v1","models":[],"models":[${JSON.stringify(e)}]}`],
    ];
    for (const [i, [why, content]] of invalid.entries()) {
      const path = await writeLock(`invalid-${i}.lock`, content);
      const r = await expectRefusal(() => loadModelsLock(path), "invalid-record");
      expect(r.message.length, why).toBeGreaterThan(0);
    }
  });
});

describe("before the call", () => {
  test("assertLoopback refuses localhost, ::1, https, other hosts and userinfo; accepts http://127.0.0.1:<port>", async () => {
    expect(assertLoopback("http://127.0.0.1:11434").port).toBe("11434");
    expect(assertLoopback("http://127.0.0.1:11434/").hostname).toBe("127.0.0.1");
    expect(assertLoopback("http://127.0.0.1:80").hostname).toBe("127.0.0.1");
    const refused = [
      "http://localhost:11434",
      "http://[::1]:11434",
      "https://127.0.0.1:11434",
      "http://127.0.0.2:11434",
      "http://192.168.1.10:11434",
      "http://ollama.example:11434",
      "http://user@127.0.0.1:11434",
      "http://user:pw@127.0.0.1:11434",
      "http://127.0.0.1:11434@ollama.example",
      // The URL parser turns each of these into 127.0.0.1; a person reading the config would not.
      "http://127.1:11434",
      "http://2130706433:11434",
      "http://0x7f.0.0.1:11434",
      "http://127.0.0.1",
      "http://127.0.0.1:0",
      "http://127.0.0.1:011434",
      "http://127.0.0.1:70000",
      "http://127.0.0.1:11434/api",
      "http://127.0.0.1:11434?x=1",
      "http://127.0.0.1:11434#x",
      " http://127.0.0.1:11434",
      "not a url",
    ];
    for (const url of refused) await expectRefusal(() => assertLoopback(url), "not-loopback");

    // The adapter refuses a non-loopback config before any request.
    const config = testConfig("/nonexistent-kingdom-seat-root", "/nonexistent-kingdom-seat-homes", { ollamaBaseUrl: "http://localhost:11434" });
    const run = freeRuntime({ config, fetch: noFetch, lock: lockOf(entry()), model: NAME, env: {} });
    await expectRefusal(() => run(request()), "not-loopback");
  });

  test("a proxy variable in the environment refuses, because Bun would route 127.0.0.1 through it", async () => {
    serveOllama(server, [localRow], () => ollamaChatJson(REPLY));
    for (const k of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
      await expectRefusal(() => assertNoProxy({ [k]: "http://127.0.0.1:9" }), "not-loopback");
      await expectRefusal(() => adapter(lockOf(entry()), { env: { [k]: "http://127.0.0.1:9" } })(request()), "not-loopback");
    }
    expect(server.requests).toHaveLength(0);
    expect(() => assertNoProxy({ HTTP_PROXY: "", PATH: "/usr/bin" })).not.toThrow();
  });

  test("a context that does not fit num_ctx by the byte rule is refused before any request; one that fits exactly is sent", async () => {
    serveOllama(server, [localRow], () => ollamaChatJson(REPLY));
    // UTF-8 bytes, not characters: "àṣẹ" is 3 characters and 8 bytes.
    const prompt = { system: "àṣẹ", user: "x".repeat(92) };
    expect(contextFit(prompt, entry({ num_ctx: 8192, num_predict: 600 }))).toEqual({ fits: true, needed: 8 + 92 + CHAT_TEMPLATE_OVERHEAD_TOKENS + 600, num_ctx: 8192 });
    const exact = 8 + 92 + CHAT_TEMPLATE_OVERHEAD_TOKENS + 600;
    expect(contextFit(prompt, entry({ num_ctx: exact })).fits).toBe(true);
    expect(contextFit(prompt, entry({ num_ctx: exact - 1 })).fits).toBe(false);

    const refusal = await expectRefusal(() => adapter(lockOf(entry({ num_ctx: exact - 1 })))(request({ prompt })), "context-too-large");
    expect(refusal.message).toContain(`num_ctx is ${exact - 1}`);
    // Nothing reached Ollama: not the tags check, and no chat call that could drop part of the self.
    expect(server.requests).toHaveLength(0);
    expect((await adapter(lockOf(entry({ num_ctx: exact })))(request({ prompt }))).raw_output).toBe(REPLY);
    expect(chatRequests()).toHaveLength(1);
  });

  test("checkTags refuses a missing row, a different digest, a different runner, and any row with remote_host or remote_model", async () => {
    const tags = (...rows: Record<string, unknown>[]) => ({ models: rows });
    const row = (over: Record<string, unknown> = {}) => ({ name: NAME, model: NAME, digest: DIGEST, details: { format: "gguf" }, ...over });

    // The exact local row passes, even beside a cloud stub under another name (as on the Air).
    expect(() => checkTags(tags(row(), { ...cloudNeighbour }), entry())).not.toThrow();
    expect(() => checkTags(tags(row({ details: { runner: "mlx" } })), entry({ runner: "mlx" }))).not.toThrow();

    await expectRefusal(() => checkTags(tags(), entry()), "model-mismatch");
    await expectRefusal(() => checkTags(tags(row({ name: "qwen2.5:7b-instruct" })), entry()), "model-mismatch");
    await expectRefusal(() => checkTags({}, entry()), "model-mismatch");
    await expectRefusal(() => checkTags("not tags", entry()), "model-mismatch");
    await expectRefusal(() => checkTags(tags(row({ digest: OTHER_DIGEST })), entry()), "model-mismatch");
    await expectRefusal(() => checkTags(tags(row({ digest: `sha256:${DIGEST}` })), entry()), "model-mismatch");
    await expectRefusal(() => checkTags(tags(row(), row()), entry()), "model-mismatch");
    await expectRefusal(() => checkTags(tags(row({ details: { runner: "mlx" } })), entry()), "model-mismatch");
    await expectRefusal(() => checkTags(tags(row()), entry({ runner: "llamacpp" })), "model-mismatch");
    await expectRefusal(() => checkTags(tags(row({ details: { runner: "mlx" } })), entry({ runner: "llamacpp" })), "model-mismatch");
    await expectRefusal(() => checkTags(tags(row({ remote_host: "https://ollama.com:443" })), entry()), "cloud-reply");
    await expectRefusal(() => checkTags(tags(row({ remote_model: "qwen2.5:7b" })), entry()), "cloud-reply");
    await expectRefusal(() => checkTags(tags(row({ remote_host: { host: "x" } })), entry()), "cloud-reply");
  });

  test("a cloud stub renamed to qwen2.5:7b (remote_host set) is refused", async () => {
    // A stub made with `ollama create qwen2.5:7b --from x:cloud`; even showing the pinned digest, its content gives it away.
    const stub: FakeModelRow = { name: NAME, digest: DIGEST, remote_host: "https://ollama.com:443", remote_model: "gpt-oss:120b" };
    await expectRefusal(() => checkTags({ models: [{ ...stub }] }, entry()), "cloud-reply");
    serveOllama(server, [stub], () => ollamaChatJson(REPLY));
    await expectRefusal(() => adapter(lockOf(entry()))(request()), "cloud-reply");
    expect(chatRequests()).toHaveLength(0);
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/tags"]);
  });
});

describe("the call and after", () => {
  test("modelRef is sha256:<digest>:local on a v2 store and <name>:local otherwise", () => {
    expect(modelRef(entry({ store: "v2" }))).toBe(`sha256:${DIGEST}:local`);
    expect(modelRef(entry({ store: "legacy" }))).toBe("qwen2.5:7b:local");
    expect(modelRef(entry({ store: "unknown" }))).toBe("qwen2.5:7b:local");
  });

  test("chatBody has stream false, no tools, the schema as format, num_predict and num_ctx from the lock, keep_alive 0, think false", async () => {
    const prompt = { system: "SYSTEM-TEXT", user: "USER-TEXT" };
    const body = chatBody(prompt, entry(), SCHEMA) as Record<string, unknown>;
    expect(body).toEqual({
      model: "qwen2.5:7b:local",
      messages: [
        { role: "system", content: "SYSTEM-TEXT" },
        { role: "user", content: "USER-TEXT" },
      ],
      stream: false,
      format: SCHEMA,
      options: { temperature: 0.7, num_ctx: 8192, num_predict: 600 },
      keep_alive: 0,
      think: false,
    });
    expect("tools" in body).toBe(false);
    expect("runner" in body).toBe(false);

    const pinned = chatBody(prompt, entry({ store: "v2", runner: "llamacpp", seed: 42, num_ctx: 4096, num_predict: 300, temperature: 0 }), SCHEMA) as Record<string, unknown>;
    expect(pinned.model).toBe(`sha256:${DIGEST}:local`);
    expect(pinned.options).toEqual({ temperature: 0, num_ctx: 4096, num_predict: 300, seed: 42 });
    expect(pinned.runner).toBe("llamacpp");

    // What reaches the server is that body, byte for byte.
    serveOllama(server, [localRow], () => ollamaChatJson(REPLY));
    await adapter(lockOf(entry()))(request({ prompt }));
    const sent = JSON.parse(new TextDecoder().decode(chatRequests()[0]!.body));
    expect(sent).toEqual(body);
    expect(chatRequests()[0]!.headers["content-type"]).toBe("application/json");
  });

  test("a reply carrying remote_host or remote_model is refused (cloud-reply)", async () => {
    await expectRefusal(() => checkChatReply(ollamaChatJson(REPLY, { remote_host: "https://ollama.com:443" })), "cloud-reply");
    await expectRefusal(() => checkChatReply({ ...ollamaChatJson(REPLY), remote_model: "qwen2.5:7b" }), "cloud-reply");
    expect(checkChatReply(ollamaChatJson(REPLY))).toEqual({ content: REPLY, done_reason: "stop" });
    expect(() => checkChatReply({ error: "boom" })).toThrow(/error/);
    expect(() => checkChatReply({ ...ollamaChatJson(REPLY), done: false })).toThrow(/not done/);
    expect(() => checkChatReply({ ...ollamaChatJson(REPLY), message: { role: "assistant" } })).toThrow(/content/);

    // The tags row was local, but the reply says it went to the cloud: refused after one call, never retried.
    serveOllama(server, [localRow], () => ollamaChatJson(REPLY, { remote_host: "https://ollama.com:443", remote_model: "qwen2.5:7b" }));
    await expectRefusal(() => adapter(lockOf(entry()))(request()), "cloud-reply");
    expect(chatRequests()).toHaveLength(1);
  });

  test("done_reason length is reported, never silently accepted as complete", async () => {
    const cut = REPLY.slice(0, 30);
    serveOllama(server, [localRow], () => ollamaChatJson(cut, { done_reason: "length" }));
    const result = await adapter(lockOf(entry()))(request());
    expect(result.done_reason).toBe("length");
    expect(result.raw_output).toBe(cut);
  });

  test("no fallback: any refusal means no second request to a different model", async () => {
    // The locked model's digest moved; another local model is right there, and is not used.
    serveOllama(server, [{ name: NAME, digest: OTHER_DIGEST }, { name: "llama3:8b", digest: DIGEST }, cloudNeighbour], () => ollamaChatJson(REPLY));
    await expectRefusal(() => adapter(lockOf(entry()))(request()), "model-mismatch");
    expect(chatRequests()).toHaveLength(0);

    // Each failure at the call is answered once and never retried.
    const answers: [number, RefusalCode | null][] = [
      [404, "model-mismatch"], // `:local` refusing a stub that appeared after the tags check
      [403, "cloud-reply"], // the server's cloud switch refusing a remote model
      [500, null],
      [503, null],
    ];
    for (const [status, code] of answers) {
      server.requests.length = 0;
      serveOllama(server, [localRow], () => ollamaChatJson(REPLY));
      server.on("POST", "/api/chat", () => Response.json({ error: "fake failure" }, { status }));
      const run = adapter(lockOf(entry()))(request());
      if (code) await expectRefusal(() => run, code);
      else await expect(run).rejects.toThrow(new RegExp(`answered ${status}`));
      expect(chatModels()).toEqual(["qwen2.5:7b:local"]);
    }

    // A redirect is not followed anywhere.
    server.requests.length = 0;
    server.on("POST", "/api/chat", () => new Response(null, { status: 307, headers: { location: `${server.url}/v1/chat/completions` } }));
    await expect(adapter(lockOf(entry()))(request())).rejects.toThrow();
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/tags", "POST /api/chat"]);
  });

  test("the deadline aborts the request; spend is recorded as $0 local-zero", async () => {
    serveOllama(server, [localRow], () => ollamaChatJson(REPLY));
    const result = await adapter(lockOf(entry({ store: "v2" })))(request());
    expect(result).toEqual({
      runtime: "free",
      model: NAME,
      model_digest: `sha256:${DIGEST}`,
      raw_output: REPLY,
      spend: { usd: "0", usd_basis: "local-zero", credits: 0 },
      done_reason: "stop",
      duration_ms: result.duration_ms,
    });
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(chatModels()).toEqual([`sha256:${DIGEST}:local`]);

    // A generation that never finishes is cut off at the deadline.
    server.requests.length = 0;
    server.on("POST", "/api/chat", () => new Promise<Response>(() => {}));
    const t0 = performance.now();
    const err = await adapter(lockOf(entry()))(request({ deadline_ms: 150 })).catch((e: unknown) => e);
    expect((err as Error).name).toBe("TimeoutError");
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(chatRequests()).toHaveLength(1);

    // The seat's own signal (HALT, or the watcher) aborts it too, with the seat's reason.
    const seat = new AbortController();
    setTimeout(() => seat.abort(new Error("SEAT-ABORT")), 50);
    await expect(adapter(lockOf(entry()))(request({ signal: seat.signal }))).rejects.toThrow("SEAT-ABORT");

    // A tags endpoint that hangs is bounded by the connect timeout, and no chat follows.
    server.requests.length = 0;
    server.on("GET", "/api/tags", () => new Promise<Response>(() => {}));
    await expect(adapter(lockOf(entry()), { connectMs: 100 })(request())).rejects.toThrow(/did not answer within 100 ms/);
    expect(chatRequests()).toHaveLength(0);

    // A deadline that is not a duration refuses before anything is sent.
    server.requests.length = 0;
    for (const deadline_ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Date.now()]) {
      await expect(adapter(lockOf(entry()))(request({ deadline_ms }))).rejects.toThrow(/deadline_ms/);
    }
    expect(server.requests).toHaveLength(0);
  });
});
