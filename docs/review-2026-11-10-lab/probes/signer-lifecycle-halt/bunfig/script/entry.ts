#!/usr/bin/env bun
console.log("shebang main; preload marker:", (globalThis as any).__PRELOADED ?? "none");
