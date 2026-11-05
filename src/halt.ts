// HALT (3.6). One verb raises it; only Yu lowers it, by hand, so this module
// has no lower function. HALT is the local file plus every pinned beacon,
// and it fails closed: a raised or unreadable source halts. A beacon is a
// `quiet_until` on a pinned operator identity, read from
// `GET /public/agents/:did` (agenttool-wire.md section 4).
//
// The verb spans two users (KS-004 B2 R5): the operator writes the file, in a
// directory the seat user cannot write, and the signer, as the seat user,
// raises the beacons whose keys only it reads. raiseHalt is the operator's
// half and raiseBeacons the signer's.
import { lstatSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { DID_PATTERN, UUID_PATTERN, type Beacon, type CommandRunner, type Config, type FetchLike, type HaltReading, type HaltStatus } from "./types.ts";
import type { Signer } from "./signer/signer.ts";

/** An explicit far-future `until` so a raised beacon never lapses on its own; the API does not cap it. */
export const BEACON_UNTIL = "2999-12-31T00:00:00.000Z";

export interface HaltDeps {
  config: Config;
  fetch: FetchLike;
  now: () => Date;
}

export interface RaiseResult {
  file: "written" | "already-present" | "failed";
  /** The errno when the file could not be written, e.g. EACCES when the verb was not run as the operator. */
  file_detail?: string;
  /** `halt.also_files`, each written the same way; detail is the errno when it failed. */
  also_files: { path: string; file: RaiseResult["file"]; detail: string }[];
  beacons: { name: string; result: "raised" | "not-held-here" | "failed"; detail: string }[];
}

/** The id a missing beacon list reads under, so status can name why it halted. */
export const NO_BEACONS_ID = "no-beacon-pinned";

function errCode(e: unknown): string {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "error";
}

/** Read the local HALT file: any entry at the path, of any type, is raised; a stat error other than ENOENT is unreadable. */
export function readHaltFile(path: string, now: Date): HaltReading {
  const base = { source: "file" as const, id: path, quiet_until: null, checked_at: now.toISOString() };
  try {
    // lstat, so a dangling symlink still counts: someone put something at the path on purpose.
    const st = lstatSync(path);
    const kind = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "directory" : st.isFile() ? "file" : "entry";
    return { ...base, state: "raised", detail: `${kind} present` };
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT") return { ...base, state: "lowered", detail: "absent" };
    return { ...base, state: "unreadable", detail: `stat failed: ${code}` };
  }
}

/** Read one beacon: a future quiet_until is raised; null is lowered; 404, non-200, memorial, bad JSON or timeout is unreadable. */
export async function readBeacon(deps: HaltDeps, beacon: Beacon, signal?: AbortSignal): Promise<HaltReading> {
  const reading = (state: HaltReading["state"], detail: string, quietUntil: string | null = null): HaltReading => ({
    source: "beacon",
    id: beacon.name,
    state,
    quiet_until: quietUntil,
    detail,
    checked_at: deps.now().toISOString(),
  });
  if (!DID_PATTERN.test(beacon.did) || !UUID_PATTERN.test(beacon.identity_id) || beacon.did !== `did:at:${beacon.identity_id}`) {
    return reading("unreadable", "pinned beacon DID is malformed");
  }
  const timeout = AbortSignal.timeout(deps.config.timing.beacon_timeout_ms);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  let body: unknown;
  try {
    // The origin is the pinned config value, never anything a response or the environment says.
    const res = await deps.fetch(`${deps.config.agenttool.origin}/public/agents/${beacon.did}`, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      signal: combined,
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return reading("unreadable", `HTTP ${res.status}`);
    }
    const text = await res.text();
    // A profile is a few hundred bytes; anything far larger is not the route we pinned.
    if (text.length > 64 * 1024) return reading("unreadable", "response is too large");
    body = JSON.parse(text);
  } catch (e) {
    if (timeout.aborted) return reading("unreadable", `no answer within ${deps.config.timing.beacon_timeout_ms} ms`);
    if (signal?.aborted) return reading("unreadable", "read abandoned");
    return reading("unreadable", e instanceof SyntaxError ? "response is not JSON" : "request failed");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return reading("unreadable", "response is not an object");
  const o = body as Record<string, unknown>;
  if (o.did !== beacon.did) return reading("unreadable", "response names another DID");
  // A memorial has no quiet fields, and a revoked operator can never raise again: neither is a working beacon.
  if (o.status !== "active") return reading("unreadable", `identity status is ${typeof o.status === "string" ? o.status : "missing"}`);
  if (!("quiet_until" in o)) return reading("unreadable", "response has no quiet_until field");
  const q = o.quiet_until;
  if (q === null) return reading("lowered", "quiet_until is null");
  if (typeof q !== "string" || Number.isNaN(Date.parse(q))) return reading("unreadable", "quiet_until is not a time");
  // The server shows quiet_until only while it is in its future. A value our clock thinks
  // has passed is skew or a stale cache; the conservative reading is still raised.
  return reading("raised", "quiet_until is set", q);
}

/** Read every pinned beacon in parallel, each with its own timeout. */
export async function readBeacons(deps: HaltDeps, signal?: AbortSignal): Promise<HaltReading[]> {
  return Promise.all(deps.config.beacons.map((b) => readBeacon(deps, b, signal)));
}

/** The file and every beacon; halted when any is raised or unreadable, or when no beacon is pinned and allow_no_beacons is false. */
export async function checkHalt(deps: HaltDeps): Promise<HaltStatus> {
  const readings: HaltReading[] = [readHaltFile(deps.config.paths.halt_file, deps.now())];
  if (deps.config.beacons.length === 0) {
    if (!deps.config.halt.allow_no_beacons) {
      readings.push({
        source: "beacon",
        id: NO_BEACONS_ID,
        state: "unreadable",
        quiet_until: null,
        detail: "no beacon is pinned and allow_no_beacons is false",
        checked_at: deps.now().toISOString(),
      });
    }
  } else {
    readings.push(...(await readBeacons(deps)));
  }
  return { halted: readings.some((r) => r.state !== "lowered"), readings };
}

/**
 * Raise HALT as `citizen-seat halt` does, run by the operator, never by the
 * seat's user (KS-004 B2 R5). The local file first, because it needs no
 * network and no key, in a directory only the operator can write; then the
 * one fixed call (`halt.raise_beacons_argv`, a sudo line) that has the signer
 * raise this host's beacons as the seat user, whose keychain holds their keys.
 * The operator never reads that keychain. A beacon the signer did not report
 * raised, because the call is not configured, could not run or failed, is
 * "failed": the file alone still halts this host.
 */
export async function raiseHalt(deps: { config: Config; now: () => Date; run: CommandRunner }): Promise<RaiseResult> {
  const { file, detail } = await raiseHaltFile(deps.config, deps.now());
  // Another runner's HALT, such as the KS-003 fleet's, so one verb still stops everything on this host.
  const also_files: RaiseResult["also_files"] = [];
  for (const path of deps.config.halt.also_files) also_files.push({ path, ...(await raiseHaltFileAt(path, haltText(deps.config.host, deps.now()), deps.now())) });
  const held = deps.config.beacons.filter((b) => b.can_raise_here);
  const argv = deps.config.halt.raise_beacons_argv;
  let raised = new Set<string>();
  let why = "";
  if (held.length > 0 && argv === null) why = "no signer call is configured (halt.raise_beacons_argv)";
  else if (held.length > 0 && argv !== null) {
    try {
      const timeoutMs = Math.max(30_000, 3 * held.length * deps.config.timing.beacon_timeout_ms);
      const r = await deps.run(argv, { timeoutMs });
      raised = raisedIn(new TextDecoder().decode(r.stdout));
      if (r.code !== 0) why = `the signer call exited ${r.code}`;
    } catch {
      why = "the signer could not be reached";
    }
  }
  const beacons: RaiseResult["beacons"] = deps.config.beacons.map((b) => {
    if (!b.can_raise_here) return { name: b.name, result: "not-held-here", detail: "this host holds no key for it" };
    if (raised.has(b.name)) return { name: b.name, result: "raised", detail: `by the signer, until ${BEACON_UNTIL}` };
    return { name: b.name, result: "failed", detail: why || "the signer did not report it raised" };
  });
  return { file, ...(file === "failed" ? { file_detail: detail } : {}), also_files, beacons };
}

/** The beacon names a `raise-beacons` run reported raised, read only from lines in its own fixed form. */
function raisedIn(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    const m = /^beacon ([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?): raised \(/.exec(line);
    if (m) names.add(m[1]!);
  }
  return names;
}

function haltText(host: string, now: Date): string {
  return `raised ${now.toISOString()} on ${host}\n`;
}

/** Write the local HALT file if nothing is at the path yet; "failed" carries the errno, so a person sees EACCES or ENOENT. */
export async function raiseHaltFile(config: Config, now: Date): Promise<{ file: RaiseResult["file"]; detail: string }> {
  return raiseHaltFileAt(config.paths.halt_file, haltText(config.host, now), now);
}

/** Write a HALT file at `path` if nothing is there yet, with `text` saying who raised it and when. */
export async function raiseHaltFileAt(path: string, text: string, now: Date): Promise<{ file: RaiseResult["file"]; detail: string }> {
  if (readHaltFile(path, now).state === "raised") return { file: "already-present", detail: "" };
  try {
    await writeFile(path, text, { flag: "wx", mode: 0o644 });
    return { file: "written", detail: "" };
  } catch (e) {
    const code = errCode(e);
    return code === "EEXIST" ? { file: "already-present", detail: "" } : { file: "failed", detail: code };
  }
}

/**
 * Raise every beacon this host can sign, with BEACON_UNTIL and no reason:
 * `citizen-seat raise-beacons`, which runs as the seat user through the
 * operator's one fixed call, because only the signer reads the beacon keys.
 */
export async function raiseBeacons(deps: { config: Config; signer: Signer | null }): Promise<RaiseResult["beacons"]> {
  const beacons: RaiseResult["beacons"] = [];
  for (const b of deps.config.beacons) {
    if (!b.can_raise_here) {
      beacons.push({ name: b.name, result: "not-held-here", detail: "this host holds no key for it" });
      continue;
    }
    if (!deps.signer) {
      beacons.push({ name: b.name, result: "failed", detail: "no signer available" });
      continue;
    }
    try {
      const res = await deps.signer.send({
        op: "quiet.start.beacon",
        word: null,
        operator: b.name,
        method: "POST",
        target: `/v1/quiet-hours/start?identity_id=${b.identity_id}`,
        // Neutral: quiet_reason is public on /public/agents and never names anyone.
        body: new TextEncoder().encode(JSON.stringify({ until: BEACON_UNTIL, reason: "" })),
        credits: 0,
        proposal: null,
        presence: null,
      });
      if (res.status === 200) beacons.push({ name: b.name, result: "raised", detail: `until ${BEACON_UNTIL}` });
      else beacons.push({ name: b.name, result: "failed", detail: `HTTP ${res.status}` });
    } catch (e) {
      beacons.push({ name: b.name, result: "failed", detail: e instanceof Error ? e.name : "error" });
    }
  }
  return beacons;
}

/** One line for status and logs, e.g. "halted by beacon gardener-desk", never just "down". */
export function describeHalt(status: HaltStatus): string {
  if (!status.halted) return "not halted";
  const parts: string[] = [];
  for (const r of status.readings) {
    if (r.state === "lowered") continue;
    if (r.source === "file") parts.push(r.state === "raised" ? "halted by file" : `halted by file (unreadable: ${r.detail})`);
    else if (r.id === NO_BEACONS_ID) parts.push("halted: no beacon pinned");
    else parts.push(r.state === "raised" ? `halted by beacon ${r.id}` : `halted by beacon ${r.id} (unreadable: ${r.detail})`);
  }
  return parts.length > 0 ? parts.join("; ") : "halted";
}
