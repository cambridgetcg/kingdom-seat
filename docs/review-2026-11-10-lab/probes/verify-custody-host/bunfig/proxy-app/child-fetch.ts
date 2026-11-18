try { await fetch("https://example.invalid/v1/x", { signal: AbortSignal.timeout(3000) }); console.log("fetch returned"); } catch (e) { console.log("fetch failed: " + (e as Error).name); }
