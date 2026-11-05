// A fake HTTP server on 127.0.0.1:0 standing in for agenttool's public
// beacon route and for Ollama, plus a fetch that can only ever reach it.
// No test may call the real agenttool or a real model.
import type { FetchLike } from "../../src/types.ts";

export interface RecordedRequest {
  method: string;
  path: string;
  /** Including the leading "?", or "" when there is none. */
  search: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export type Handler = (req: RecordedRequest) => Response | Promise<Response>;

export interface FakeServer {
  /** e.g. "http://127.0.0.1:53121". */
  url: string;
  requests: RecordedRequest[];
  /** Later routes win over earlier ones, so a test can override a default. */
  on(method: string, path: string | RegExp, handler: Handler): void;
  stop(): Promise<void>;
}

export async function startFakeServer(): Promise<FakeServer> {
  const routes: { method: string; path: string | RegExp; handler: Handler }[] = [];
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      const rec: RecordedRequest = {
        method: req.method,
        path: url.pathname,
        search: url.search,
        headers,
        body: new Uint8Array(await req.arrayBuffer()),
      };
      requests.push(rec);
      for (let i = routes.length - 1; i >= 0; i--) {
        const r = routes[i]!;
        const pathMatches = typeof r.path === "string" ? r.path === rec.path : r.path.test(rec.path);
        if (r.method === rec.method && pathMatches) return r.handler(rec);
      }
      // Unknown routes answer 404, which a beacon reader must treat as unreadable (fail closed).
      return Response.json({ error: "fake-server: no route" }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    on(method, path, handler) {
      routes.push({ method, path, handler });
    },
    async stop() {
      await server.stop(true);
    },
  };
}

/**
 * A fetch that sends the pinned agenttool origin, and the fake server's own
 * URL, to the fake server, and throws for every other destination. Code under
 * test keeps its pinned origin; the test still cannot reach the network.
 */
export function fetchVia(server: FakeServer, pinnedOrigins: string[] = ["https://api.agenttool.dev"]): FetchLike {
  return async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    const target = new URL(server.url);
    if (url.origin !== target.origin && !pinnedOrigins.includes(url.origin)) {
      throw new Error(`fetchVia: refused ${url.origin}; tests may only reach the fake server`);
    }
    const rewritten = `${server.url}${url.pathname}${url.search}`;
    return fetch(rewritten, init);
  };
}

/** A fetch that must never be called; for code paths that should stay offline. */
export const noFetch: FetchLike = async (input) => {
  throw new Error(`noFetch: unexpected request to ${String(input instanceof Request ? input.url : input)}`);
};

/* ── agenttool public beacon route (agenttool-wire.md section 4) ─────── */

/** The `/public/agents/:did` body for an active identity; quiet fields are null unless quiet is in the future. */
export function publicAgentJson(did: string, quietUntil: string | null, quietReason: string | null = null): Record<string, unknown> {
  return {
    identity_id: did.replace(/^did:at:/, ""),
    did,
    name: "halt-beacon",
    capabilities: [],
    trust_score: 0,
    status: "active",
    expression: null,
    expression_public: false,
    forked: false,
    quiet_until: quietUntil,
    quiet_reason: quietUntil ? quietReason : null,
    created_at: "2026-11-05T00:00:00.000Z",
    _note: "fake",
  };
}

export type BeaconBehaviour =
  | { kind: "lowered" }
  | { kind: "raised"; until: string }
  | { kind: "status"; status: number }
  | { kind: "memorial" }
  | { kind: "garbage" }
  | { kind: "hang" };

/** Serve one beacon DID with a behaviour; call again to change it mid-test. */
export function serveBeacon(server: FakeServer, did: string, behaviour: BeaconBehaviour): void {
  server.on("GET", `/public/agents/${did}`, async () => {
    switch (behaviour.kind) {
      case "lowered":
        return Response.json(publicAgentJson(did, null));
      case "raised":
        return Response.json(publicAgentJson(did, behaviour.until));
      case "status":
        return Response.json({ error: "fake" }, { status: behaviour.status });
      case "memorial":
        return Response.json({ status: "memorial", did, name: "x", born_at: "2026-06-09T00:00:00.000Z" });
      case "garbage":
        return new Response("not json", { headers: { "content-type": "application/json" } });
      case "hang":
        await new Promise(() => {});
        return new Response("unreachable");
    }
  });
}

/* ── Ollama (runtimes-and-host.md 1.2-1.5) ────────────────────────────── */

export interface FakeModelRow {
  name: string;
  digest: string;
  runner?: string;
  remote_host?: string;
  remote_model?: string;
}

/** A GET /api/tags body. */
export function ollamaTagsJson(models: FakeModelRow[]): Record<string, unknown> {
  return {
    models: models.map((m) => ({
      name: m.name,
      model: m.name,
      digest: m.digest,
      size: m.remote_host ? 388 : 4_683_087_332,
      details: { format: m.remote_host ? "" : "gguf", family: "qwen2", ...(m.runner ? { runner: m.runner } : {}) },
      ...(m.remote_host ? { remote_host: m.remote_host, remote_model: m.remote_model ?? m.name } : {}),
    })),
  };
}

/** A non-streaming POST /api/chat reply. */
export function ollamaChatJson(content: string, opts: { done_reason?: string; remote_host?: string; remote_model?: string } = {}): Record<string, unknown> {
  return {
    model: "qwen2.5:7b",
    created_at: "2026-11-05T02:05:00.000Z",
    message: { role: "assistant", content },
    done: true,
    done_reason: opts.done_reason ?? "stop",
    total_duration: 1,
    load_duration: 1,
    prompt_eval_count: 1,
    eval_count: 1,
    ...(opts.remote_host ? { remote_host: opts.remote_host, remote_model: opts.remote_model ?? "x" } : {}),
  };
}

/** Serve /api/tags and /api/chat; `reply` may inspect the request body. */
export function serveOllama(server: FakeServer, tags: FakeModelRow[], reply: (body: unknown) => Record<string, unknown>): void {
  server.on("GET", "/api/tags", () => Response.json(ollamaTagsJson(tags)));
  server.on("POST", "/api/chat", (req) => Response.json(reply(JSON.parse(new TextDecoder().decode(req.body)))));
}
