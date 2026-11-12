import { uptime } from "node:os";
const up = uptime();
const p = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.boottime"]);
const txt = new TextDecoder().decode(p.stdout);
const m = /sec = (\d+)/.exec(txt);
const boot = m ? Number(m[1]) * 1000 : NaN;
const byUptime = Date.now() - up * 1000;
console.log(JSON.stringify({ bun: Bun.version, os_uptime_s: Math.round(up), kern_boottime: new Date(boot).toISOString(), boot_by_os_uptime: new Date(byUptime).toISOString(), difference_s: Math.round((byUptime - boot) / 1000) }));
