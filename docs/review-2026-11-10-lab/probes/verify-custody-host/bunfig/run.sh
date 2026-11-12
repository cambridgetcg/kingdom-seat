#!/bin/bash
# Probe: does Bun 1.4.2 load bunfig.toml / .env from the working directory (or $HOME) when the entry
# script is elsewhere and named by absolute path? Harmless stand-in script only; run as my own user.
P=<SCRATCH>/probes/verify-custody-host/bunfig
BUN=<BUN_BIN>/bun
APP=$P/app/src/cli.ts
BASEPATH=<BUN_BIN>:/usr/bin:/bin:/usr/sbin:/sbin
t() { # label, cwd, HOME, then command
  local label="$1" cwd="$2" home="$3"; shift 3
  echo "--- $label"
  ( cd "$cwd" && env -i PATH="$BASEPATH" HOME="$home" "$@" 2>&1 ); echo "(exit $?)"
}
t "T1 clean cwd; bun <abs script>"                         $P/cwd-clean $P/cwd-clean $BUN $APP raise-beacons --config /x
t "T2 cwd has bunfig.toml; bun <abs script>"                $P/cwd-evil  $P/cwd-clean $BUN $APP raise-beacons --config /x
t "T3 cwd has bunfig.toml; shebang exec of abs script"      $P/cwd-evil  $P/cwd-clean $APP raise-beacons --config /x
t "T4 clean cwd; HOME has .bunfig.toml; bun <abs script>"   $P/cwd-clean $P/home-evil $BUN $APP raise-beacons
t "T5 clean cwd; HOME has .bunfig.toml; shebang"            $P/cwd-clean $P/home-evil $APP raise-beacons
t "T6 cwd bunfig; bun --config=<empty.toml> <abs script>"   $P/cwd-evil  $P/cwd-clean $BUN --config=$P/empty.toml $APP raise-beacons
t "T8 cwd has .env only; bun <abs script>"                  $P/cwd-env   $P/cwd-clean $BUN $APP raise-beacons
t "T9 cwd has .env only; shebang"                           $P/cwd-env   $P/cwd-clean $APP raise-beacons
t "T10 cwd bunfig; bun run <abs script>"                    $P/cwd-evil  $P/cwd-clean $BUN run $APP raise-beacons
t "T11 cwd .env; bun --env-file=/dev/null? (no-env-file flag) <abs script>" $P/cwd-env $P/cwd-clean $BUN --no-env-file $APP raise-beacons
