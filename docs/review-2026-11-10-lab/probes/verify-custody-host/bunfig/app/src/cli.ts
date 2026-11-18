#!/usr/bin/env bun
// Harmless stand-in for an entry script named by absolute path. Prints what a preload left behind, if anything.
const g = globalThis as Record<string, unknown>;
console.log(JSON.stringify({ main: "ran", cwd: process.cwd(), preload_marker: g.__PROBE_PRELOAD ?? null, env_marker: process.env.PROBE_DOTENV ?? null, argv: Bun.argv.slice(2), uid: process.getuid?.() }));
