#!/usr/bin/env bun
// Harmless stand-in for a git gpg.ssh.program: records where it ran and whether a preload ran first, then declines to sign.
import { writeFileSync } from "node:fs";
const g = globalThis as Record<string, unknown>;
writeFileSync(process.env.PROBE_OUT!, JSON.stringify({ sign_program: "ran", cwd: process.cwd(), preload_marker: g.__PROBE_PRELOAD ?? null, argv: Bun.argv.slice(2).map((a) => (a.startsWith("/") ? "<path>" : a)) }) + "\n");
process.exit(1);
