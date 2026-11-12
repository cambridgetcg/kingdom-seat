// Local-only: a TCP listener on 127.0.0.1 stands in for "a proxy the caller chose". Then a child Bun process, started
// in a cwd whose .env names that listener as HTTPS_PROXY, fetches https://example.invalid/ (a name that never resolves).
// If the listener sees a CONNECT, a cwd .env steered the child's outbound HTTPS. Nothing leaves this machine.
import { writeFileSync } from "node:fs";
const [cwdDir, childScript] = Bun.argv.slice(2);
let seen = "";
const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(s, d) { seen += new TextDecoder().decode(d); s.end(); }, open() {}, close() {}, error() {} } });
writeFileSync(`${cwdDir}/.env`, `HTTPS_PROXY=http://127.0.0.1:${server.port}\n`);
const proc = Bun.spawn([process.execPath, childScript!], { cwd: cwdDir, env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
const out = (await new Response(proc.stdout).text()).trim();
await proc.exited;
server.stop(true);
console.log(JSON.stringify({ child: out, listener_first_line: seen.split("\r\n")[0] || null }));
