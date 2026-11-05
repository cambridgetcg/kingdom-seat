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
import type { Config, FetchLike, ModelLockEntry, ModelsLock, Prompt, RuntimeAdapter } from "../types.ts";

export interface FreeDeps {
  config: Config;
  fetch: FetchLike;
  lock: ModelsLock;
  /** Which locked model this runtime uses, by name. */
  model: string;
}

/** Read and validate models.lock as a regular file; strict JSON with the v1 format. */
export async function loadModelsLock(path: string): Promise<ModelsLock> {
  throw new Error("unimplemented");
}

/** The entry for `name`; refuses with "model-unpinned" while its digest is UNSET_PIN or not 64 hex. */
export function lockedEntry(lock: ModelsLock, name: string): ModelLockEntry {
  throw new Error("unimplemented");
}

/** Refuse any base URL that is not http on exactly 127.0.0.1 (not "localhost", not ::1, not another host). */
export function assertLoopback(baseUrl: string): URL {
  throw new Error("unimplemented");
}

/** Check a GET /api/tags response against the lock entry; throws "model-mismatch" or "cloud-reply". */
export function checkTags(tags: unknown, entry: ModelLockEntry): void {
  throw new Error("unimplemented");
}

/** The model reference to call: `sha256:<digest>:local` on a v2 store, else `<name>:local`. */
export function modelRef(entry: ModelLockEntry): string {
  throw new Error("unimplemented");
}

/** The /api/chat body: stream false, no tools, format = schema, options from the lock, keep_alive "0", think false. */
export function chatBody(prompt: Prompt, entry: ModelLockEntry, schema: object): object {
  throw new Error("unimplemented");
}

/** Check a /api/chat reply: refuse remote_host or remote_model; return content and done_reason. */
export function checkChatReply(reply: unknown): { content: string; done_reason: string } {
  throw new Error("unimplemented");
}

/** The free-lane adapter: tags check, one chat call under the seat's deadline, reply check, $0 spend recorded. */
export function freeRuntime(deps: FreeDeps): RuntimeAdapter {
  throw new Error("unimplemented");
}
