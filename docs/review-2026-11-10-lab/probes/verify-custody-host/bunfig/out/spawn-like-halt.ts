// Mirrors cli.ts spawnRunner: argv only, env PATH only, cwd not set (inherits the caller's).
const proc = Bun.spawn(["<BUN_BIN>/bun", "<SCRATCH>/probes/verify-custody-host/bunfig/app/src/cli.ts", "raise-beacons", "--config", "/x"], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
console.log((await new Response(proc.stdout).text()).trim());
