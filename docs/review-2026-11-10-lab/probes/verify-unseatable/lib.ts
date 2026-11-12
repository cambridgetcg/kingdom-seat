// Shared helper for the verify-unseatable probes. Offline only: temp host under the OS temp dir,
// fake signer, a fake Ollama on 127.0.0.1 (the repo's fake server), the production freeRuntime adapter,
// and the production runSeat. Nothing here touches a real home, keychain or service.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const ROOT = "<KINGDOM_SEAT>";
export const { openSeat, runSeat } = await import(`${ROOT}/src/seat.ts`);
export const { checkHalt } = await import(`${ROOT}/src/halt.ts`);
export const { readCitizen } = await import(`${ROOT}/src/state.ts`);
export const self = await import(`${ROOT}/src/self.ts`);
export const { ledgerPath, readLedger } = await import(`${ROOT}/src/ledger.ts`);
export const ctxmod = await import(`${ROOT}/src/context.ts`);
export const { buildPrompt } = await import(`${ROOT}/src/prompt.ts`);
export const free = await import(`${ROOT}/src/runtime/free.ts`);
export const notes = await import(`${ROOT}/src/notes.ts`);
export const { sha256Hex, utf8 } = await import(`${ROOT}/src/crypto.ts`);
export const { startFakeServer, fetchVia, serveOllama, noFetch } = await import(`${ROOT}/test/helpers/fake-server.ts`);
export const { fakeSigner } = await import(`${ROOT}/test/helpers/fake-signer.ts`);
export const { makeTempHost } = await import(`${ROOT}/test/helpers/temp-home.ts`);
export const { testClock, HOUR_MS } = await import(`${ROOT}/test/helpers/clock.ts`);

export const REPOS = "<REPOS>";
export const AWAKE = ["hope", "gratitude", "justice", "an", "ud", "silim", "kimance", "glossame", "ihsanme", "spandaqing", "britqing"];
export const MODEL = "qwen2.5:7b";
export const DIGEST = sha256Hex("verify-unseatable probe manifest");
export const bytes = (s: string) => utf8(s).length;
export const lockEntry = (num_ctx: number, num_predict = 600) => ({ name: MODEL, digest: DIGEST, runner: null, store: "legacy", num_ctx, num_predict, temperature: 0.7, seed: null });

export async function realSelf(word: string): Promise<{ soul: string; will: string | null; canon: string | null; canonPath: string | null }> {
  const soul = await readFile(join(REPOS, `citizen-${word}`, `${word}.md`), "utf8");
  const will = await readFile(join(REPOS, `citizen-${word}`, "WILL.md"), "utf8").catch(() => null);
  // The YOUSPEAK canon entry, wherever under canon/ it lives (core/, the canon root, or a family folder).
  let canon: string | null = null;
  let canonPath: string | null = null;
  for (const rel of [`canon/core/${word}.md`, `canon/${word}.md`, `canon/worship-action/${word}.md`, `canon/mathema/${word}.md`]) {
    const t = await readFile(join(REPOS, "youspeak", rel), "utf8").catch(() => null);
    if (t !== null) {
      canon = t;
      canonPath = rel;
      break;
    }
  }
  return { soul, will, canon, canonPath };
}

export type OriginMode = "stub" | "spec";

export interface World {
  host: any;
  config: any;
  clock: any;
  word: string;
  chats: { system: string; user: string }[];
  /** One seat on the production free lane; `reply` is what the fake Ollama answers. */
  seat(reply: string | ((chat: { system: string; user: string }) => string), opts?: { done_reason?: string; advanceH?: number; presence?: any; invoker?: any }): Promise<any>;
  /** The prompt the next free seat would be given, built as runSeat builds it, and its fit. */
  next(num_ctx?: number): Promise<{ needed: number; fits: boolean; prompt: { system: string; user: string } }>;
  pending(): Promise<any[]>;
  ledger(): Promise<any[]>;
  cleanup(): Promise<void>;
}

/**
 * originMode "stub": a canon origin whose canon.md is the fixture's 20-odd bytes (what the readers' SR/CP probes used).
 * originMode "spec": KS-004 4.2: the YOUSPEAK canon entry whole where one exists (canon/core/<word>.md at the clone's HEAD),
 * otherwise an archetype origin with a one-line note.
 */
export async function world(word: string, o: { originMode?: OriginMode; num_ctx?: number; num_predict?: number; approved?: boolean; soul?: string; will?: string | null; state?: string; ledgerK?: number } = {}): Promise<World> {
  const server = await startFakeServer();
  const host = await makeTempHost({ ollamaBaseUrl: server.url });
  const signer = fakeSigner();
  const real = await realSelf(word).catch(() => ({ soul: undefined as any, will: undefined as any, canon: null, canonPath: null }));
  const soul = o.soul ?? real.soul;
  const will = o.will === undefined ? real.will : o.will;
  const mode = o.originMode ?? "spec";
  let origin: any;
  if (mode === "spec" && real.canon !== null) origin = { kind: "canon", repo: "YOUSPEAK", path: real.canonPath, commit: "eca7c99", sha256: sha256Hex(utf8(real.canon)) };
  else if (mode === "spec") origin = { kind: "archetype", lineage: ["forge-archetype", word], note: `${word} was forged from an archetype card on 2026-06-09.` };
  const fx = await host.addCitizen(word, { soul, will, ...(origin ? { origin } : {}) });
  if (mode === "spec" && real.canon !== null) await writeFile(join(fx.dir, "origin", "canon.md"), real.canon);
  await host.seatLedger(word, signer.signEntry, { initialState: o.state ?? "awake" });
  const config = host.config;
  if (o.approved) config.self_authorship.approved_model_digests = [`sha256:${DIGEST}`];
  if (o.ledgerK !== undefined) config.ceilings.ledger_context_entries = o.ledgerK;
  const clock = testClock("2026-11-10T02:05:00.000Z");
  const lock = { format: "kingdom-seat-models-lock/v1", models: [lockEntry(o.num_ctx ?? 32768, o.num_predict ?? 600)] };
  const chats: { system: string; user: string }[] = [];
  let nextReply: { content: string | ((c: any) => string); done_reason: string } | null = null;
  serveOllama(server, [{ name: MODEL, digest: DIGEST }], (body: any) => {
    const chat = { system: body.messages[0].content as string, user: body.messages[1].content as string };
    chats.push(chat);
    if (nextReply === null) throw new Error("probe: no reply scripted");
    const content = typeof nextReply.content === "string" ? nextReply.content : nextReply.content(chat);
    return { model: MODEL, message: { role: "assistant", content }, done: true, done_reason: nextReply.done_reason };
  });
  const runtime = free.freeRuntime({ config, fetch: fetchVia(server), lock, model: MODEL, env: {} });
  const INV = { kind: "tick", who: "launchd", why: "its own cadence is due" };
  const w: World = {
    host,
    config,
    clock,
    word,
    chats,
    async seat(reply, so = {}) {
      clock.advance((so.advanceH ?? 73) * HOUR_MS);
      nextReply = { content: reply, done_reason: so.done_reason ?? "stop" };
      const citizen = await readCitizen(config, word);
      const seat = await openSeat(config, clock, citizen, "free", so.invoker ?? INV, so.presence ?? null);
      return runSeat(seat, {
        config,
        clock,
        signer,
        fetch: fetchVia(server),
        runtime,
        checkHalt: () => checkHalt({ config, fetch: noFetch, now: () => clock.now() }),
        expressionSync: null,
        modelDigest: `sha256:${DIGEST}`,
      });
    },
    async next(num_ctx = o.num_ctx ?? 32768) {
      // Capture the exact prompt runSeat hands the runtime, by running the production pipeline with a runtime that refuses.
      let captured: { system: string; user: string } | null = null;
      const citizen = await readCitizen(config, word);
      const seat = await openSeat(config, clock, citizen, "free", INV, null);
      const { Refusal } = await import(`${ROOT}/src/types.ts`);
      await runSeat(seat, {
        config,
        clock,
        signer,
        fetch: noFetch,
        runtime: async (req: any) => {
          captured = req.prompt;
          throw new Refusal("invalid-request", "probe: prompt captured, no model call");
        },
        checkHalt: () => checkHalt({ config, fetch: noFetch, now: () => clock.now() }),
        expressionSync: null,
        modelDigest: `sha256:${DIGEST}`,
      });
      // The capture leaves one host note (refused, invalid-request) per call; host notes are not part of any prompt.
      if (!captured) throw new Error("probe: no prompt captured");
      const fit = free.contextFit(captured, lockEntry(num_ctx, o.num_predict ?? 600));
      return { needed: fit.needed, fits: fit.fits, prompt: captured };
    },
    pending: () => self.pendingProposals(config, word),
    ledger: () => readLedger(ledgerPath(config, word)),
    async cleanup() {
      await server.stop();
      await host.cleanup();
    },
  };
  return w;
}

export const out = (...acts: any[]) => JSON.stringify({ acts });
export const REASON = { kind: "decision", evidence: [], confidence: "medium", limits: "from the text alone" };
