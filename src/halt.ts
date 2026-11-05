// HALT (3.6). One verb raises it; only Yu lowers it, by hand, so this module
// has no lower function. HALT is the local file plus every pinned beacon,
// and it fails closed: a raised or unreadable source halts. A beacon is a
// `quiet_until` on a pinned operator identity, read from
// `GET /public/agents/:did` (agenttool-wire.md section 4).
import type { Beacon, Config, FetchLike, HaltReading, HaltStatus } from "./types.ts";
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
  beacons: { name: string; result: "raised" | "not-held-here" | "failed"; detail: string }[];
}

/** Read the local HALT file: any entry at the path, of any type, is raised; a stat error other than ENOENT is unreadable. */
export function readHaltFile(path: string, now: Date): HaltReading {
  throw new Error("unimplemented");
}

/** Read one beacon: a future quiet_until is raised; null is lowered; 404, non-200, memorial, bad JSON or timeout is unreadable. */
export async function readBeacon(deps: HaltDeps, beacon: Beacon): Promise<HaltReading> {
  throw new Error("unimplemented");
}

/** Read every pinned beacon in parallel, each with its own timeout. */
export async function readBeacons(deps: HaltDeps): Promise<HaltReading[]> {
  throw new Error("unimplemented");
}

/** The file and every beacon; halted when any is raised or unreadable, or when no beacon is pinned and allow_no_beacons is false. */
export async function checkHalt(deps: HaltDeps): Promise<HaltStatus> {
  throw new Error("unimplemented");
}

/** Raise HALT: write the local file first (no network needed), then every beacon this host can sign, with BEACON_UNTIL and no reason. */
export async function raiseHalt(deps: HaltDeps & { signer: Signer | null }): Promise<RaiseResult> {
  throw new Error("unimplemented");
}

/** One line for status and logs, e.g. "halted by beacon gardener-desk", never just "down". */
export function describeHalt(status: HaltStatus): string {
  throw new Error("unimplemented");
}
