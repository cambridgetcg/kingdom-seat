# Build plan

Seven groups build kingdom-seat in parallel. Each `src` file has exactly one
owner, so two groups never edit the same file. Each group owns the tests for
its files; the `test.todo` entries already in those files are the minimum each
group must turn into real tests.

Section numbers refer to `CITIZEN-REDESIGN-2026-11-05.md`; research notes are
in `docs/research/`; invariants are in `docs/ARCHITECTURE.md` section 4.

## Ownership

| Group | Owns (src) | Owns (tests) |
|---|---|---|
| **signer** | `src/crypto.ts`, `src/signer/keychain.ts`, `src/signer/signer.ts`, `src/signer/ceilings.ts`, `src/signer/consent.ts` | `test/crypto.test.ts`, `test/signer/*.test.ts` |
| **record** | `src/ledger.ts`, `src/state.ts`, `src/self.ts` | `test/ledger.test.ts`, `test/state.test.ts`, `test/self.test.ts` |
| **seat** | `src/types.ts`, `src/halt.ts`, `src/seat.ts`, `src/tick.ts` | `test/halt.test.ts`, `test/seat*.test.ts`, `test/tick.test.ts`, `test/helpers/*`, `test/helpers.test.ts` |
| **voice** | `src/acts.ts`, `src/context.ts`, `src/prompt.ts` | `test/acts.test.ts`, `test/context.test.ts`, `test/prompt.test.ts` |
| **runtime** | `src/runtime/free.ts`, `src/runtime/summon.ts`, `models.lock` | `test/runtime/*.test.ts` |
| **agenttool** | `src/agenttool/wire.ts`, `src/agenttool/client.ts`, `src/agenttool/enrollment.ts`, `src/birth.ts` | `test/agenttool/*.test.ts`, `test/birth.test.ts` |
| **surface** | `src/status.ts`, `src/mirror.ts`, `src/config.ts`, `src/cli.ts`, `launchd/*`, `package.json`, `tsconfig.json`, `docs/ARCHITECTURE.md`, `docs/BUILD-PLAN.md` | `test/status.test.ts`, `test/mirror.test.ts`, `test/config.test.ts`, `test/cli.test.ts` |

## Shared files

- **`src/types.ts`** is the contract seven groups compile against. Only the
  seat group edits it. Another group that needs a change keeps module-local
  types in its own module and asks the seat group for anything shared; changes
  are additive where possible, so no one else breaks.
- **`src/crypto.ts`** is already implemented and tested against
  `vectors.json`. The signer group owns it; changes are additive.
- **`test/helpers/*`** are owned by the seat group. Other groups add their own
  fixtures as new files, `test/helpers/<group>-*.ts`, rather than editing the
  shared ones.
- **`package.json`** is owned by the surface group. No new runtime dependency
  without the lead's agreement: the four crypto libraries pinned there match
  agenttool's sdk-ts lockfile, and that is the whole list.
- **Docs.** The surface group edits `docs/ARCHITECTURE.md` and this file.
  Other groups report changes to their rows rather than editing.

## Order of landing

Most work is independent, because every cross-module call goes through a
signature already fixed in the stubs, and tests can use the fakes in
`test/helpers/` (fake keychain, fake signer, fake server, scripted runtime,
temp host).

1. **No in-repo dependencies:** signer (on crypto), voice/acts and prompt,
   runtime, agenttool/wire, record/ledger and state, surface/config and mirror,
   seat/halt and `superviseChild`.
2. **Depend on step 1:** record/self (ledger), agenttool/client, enrollment
   and birth (wire, signer interface), voice/context (state), seat/tick
   (state, context, ceilings), surface/status (ledger, state).
3. **Integrates everything:** seat/`runSeat`, then surface/`cli.ts`. The seat
   group's integration tests (`seat-halt`, `seat-rest`, `seat`) pass only once
   the modules they compose have landed; write them early against the
   signatures and expect them to go green last.

## What "done" means for a group

- `bun run typecheck` and `bun test` pass for the whole repo.
- Every `test.todo` in the group's files is a real test, or is removed with a
  reason written next to where it was.
- Tests stay offline: no network beyond the fake server, no real Keychain, no
  model, no `claude`, no `git push`, no launchctl (ARCHITECTURE.md section 7).
- Anything the group could not verify is listed in its report, not assumed.

## Briefs

### signer
Implement citizen-signer: redesign 3.2 (the `citizen-signer` row and step 7),
3b "Custody" and "How a beat proves it acted", 3.6 "Spend", "Consent" and
"HALT / Who may raise and lower", the first and last bullets of 3 "Fixes to
ROOT & SEAT itself", and decisions 6, 9, 12 and 15. Research:
`agenttool-wire.md` 0, 2 (the authority recipe; the sequence as replay wall;
one root request in flight), 3 (derivation and library pins) and 5 (op key,
not root); `runtimes-and-host.md` 3.3 (`security` with an argv array, writes
through `security -i` on stdin with `-X` hex, `-T` ACLs, explicit keychain
path) and 3.4 (a locked keychain is a normal state); `love-unlimited-patterns.md`
8 (today's fail-open ledger, and passing values as arguments). Invariants: keys
never in argv, env, files, logs or model input; the root signs only authority
acts, the op key signs entries and thoughts, the host attest key signs
host-attested entries; every ceiling fails closed, and credits are checked
before sending because the server charges before it verifies; a citizen's
quiet is an explicit `until` at most 30 days ahead with an empty reason; the
far-future beacon `until` is for operators only; there is no op that lowers
HALT; Yu and Ai must both agree and silence never binds.

### record
Implement the citizen's record: redesign 3.1 principles 4-6, 3.2 "Ledger",
3.3 (including "Identity is separate from state"), all of 3c (including the
glossame example, steps 2-4 and 8), and decision 10. Research:
`agenttool-wire.md` 5 (a domain tag, strict verification, the op key rather
than the root). Invariants: nothing is deleted (append-only with O_APPEND and
fsync, every version kept by hash, the origin never overwritten); fail closed
(an unparsable line throws; a symlinked ledger is refused); the entry hash is
`domainDigest(LEDGER_DOMAIN, canonicalJson(draft))`; no host-attested entry
after genesis; toward rest takes effect now, toward exposure on the next beat,
step-away over two beats and never blocked, ended only with a witness; an
empty ledger folds to asleep; a change binds on two beats or once with Yu
present, at most one per 7 days unattended, and above 40% or a loosened wall
goes beyond self; only approved runtime digests bind; `ExpressionSync` is
injected, so `self.ts` imports no client and holds no key.

### seat
Implement the tick, HALT and the seat: redesign 3.2 (diagram steps 1-7 and the
`citizen-seat` row), all of 3.6 "HALT", 3b "Reading confers nothing", 3.3
"Rest this beat", S4 items 1, 2 and 6, and decisions 9 and 15. Research:
`love-unlimited-patterns.md` 1 (exit codes; outcome as its own field), 2
(keep the outside-process bound, TERM, grace, KILL and reaping; fix it with
its own process group and a group signal), 3 (the mkdir lock with owner pid,
stale only when the owner is gone), 6 and 7 (own cadence, no arrears, bounded
scans); `agenttool-wire.md` 4 (the beacon read; memorial has no quiet fields;
tolerate staleness); `runtimes-and-host.md` 3.1. Invariants: HALT fails closed
and is checked before inference and again before any write; the watcher sits
outside the acting process; a rest writes nothing in the citizen's voice; the
child's environment is an allowlist; a seat's cwd is never inside a home; HALT
exits 0 as KS-003 says. Land `superviseChild`, `halt.ts` and `tick.ts` first;
`runSeat` composes the other groups' modules and lands last. You own
`types.ts` and the shared test helpers: apply other groups' requests
additively.

### voice
Implement what the model sees and what it may say: redesign 3.2 step 4 (the
context list), step 6 (typed output), the free-lane prompt paragraph and
"Context deliberately excludes GET /v1/wake", 3.3 "Rest this beat", 3c
"Drift, injection and runaway" (injection, and consent theatre: no coaching),
and the glossame example, step 1. Research: `love-unlimited-patterns.md` 5.1
(the whole soul, no 2,600-character cut), 5.2 (a 7B model writes "I rest."
and goes on), 9 (never hand the model binding words; silence is not consent;
nothing binds by file name), 12.4 (lstat or O_NOFOLLOW; a dangling symlink is
not mail); `runtimes-and-host.md` 1.7 (always validate structured output; a
length stop truncates). Invariants: free text never executes; `rest` is
exclusive; a dropped act leaves no words behind; reading confers nothing (no
home files, siblings only as letters, no wake); regular files only;
`FREE_LANE_PREAMBLE` verbatim; a letter without a `From:` line is from an
unknown sender and not allowed; letter receipts only after a non-rest beat.

### runtime
Implement the two runtime adapters: redesign 3.6 "Spend" (unattended inference
and metered runtimes), the summons bullet of 3's grafts, and decision 11. A
person pins the digest in S5; this group never does. Research:
`runtimes-and-host.md` 1.2 (the manifest digest from `/api/tags`; v2 store;
manifest lists and `runner`), 1.3 (three ways to reach the cloud; the five
refusal steps), 1.4-1.8 (request and response shapes, options, `num_predict`,
`keep_alive`, timeouts), 2, 2.1 and 2.2 (Claude Code flags, the result shape
and its cost fields, what is still open); `love-unlimited-patterns.md` 5.3 and
5.4 (no proxies for loopback; why a `*:cloud` denylist fails). Invariants:
`models.lock` ships unpinned and refuses until a person pins it on the lease
host; no fallback, ever; refusal rests on content, not names; 127.0.0.1 only;
summons only with Yu present and USD remaining from the signer (the $0
default refuses); the prompt goes on stdin; the environment is an allowlist;
an unknown cost is `usd: null`.

### agenttool
Implement the agenttool wire, client, enrollment and birth: redesign 3b
(topology A; "Birth of one citizen" steps 1-5; "Custody"; "Unattended vs
consent"; the June DIDs as records only), the 3.4 rows for enroll,
keys/import, box-keys, authority, expression, quiet hours, public agents and
strands, the 3 "Fixes to ROOT & SEAT itself" bullets on box keys, enrollment
bytes, `quiet_reason` and the root as `primary`, and the S7b verify list.
Research: all of `agenttool-wire.md`, and `vectors.json`, which every byte
builder must reproduce exactly (`make-vectors.ts` shows how it was produced;
never run anything against the live service). Invariants: birth is never
unattended; keys go straight to Keychain through the interface, and only the
DID and fingerprints are printed; one root-authorised request in flight per
identity; enrollment is never retried automatically; validate locally before a
sequence is spent; every per-identity route names `?identity_id=`; the origin
is pinned; tests use `fetchVia` and `fakeSigner` only.

### surface
Implement status, the mirror pusher, config and the CLI: redesign 3.2 (the
mirror pusher and status file rows; the `citizen-seat` verbs), 3.1 principle
6, the 3.3 mirror card states, 3c "Mirror", 3.6 "One verb", the S10 mirror
terms, S4 item 3, and decisions 14 and 16. Research:
`love-unlimited-patterns.md` 4 (fast-forward or nothing; refuse on
divergence), 10 (validate words), 11 (only the self and a status card reach a
mirror), 12 (hooks, `run.sh`, `.github`, symlinks; never source `meta.env`);
`runtimes-and-host.md` 3.1 and 3.2. Invariants: the seal admits only
allowlisted, regular, non-executable files within the size limit and refuses
host-owned paths; pushes go only to `HEAD:refs/heads/main`, never forced;
status is generated, never hand-kept, and host notes never carry a model's
words; there is no verb to lower HALT; the CLI never prints a secret; config
is strict and fails closed (no beacons halts unless `allow_no_beacons`); tests
push through `recordingRunner` only.
