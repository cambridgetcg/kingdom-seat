# Probes for the 2026-11-10 lab review

These are the probe scripts and saved outputs that the readers and skeptics
of the 2026-11-10 lab review ran against `kingdom-seat` at `f21c360`. The
findings they support are in `docs/REVIEW-2026-11-10-lab.md`, and on the
spec side in kingdom-standards,
`specs/KS-004-reviews/review-E-lived-record.md`.

They are a record of what was run. They are not part of this repository's
test suite, and nothing here is imported by `src/` or `test/`.

## How they were run

- Against `kingdom-seat` at `f21c360`, on bun 1.4.2, on the reviewer's Mac.
- With the build's own fakes only: the fake signer and keychain, the scripted
  runtime, the repository's fake Ollama and fake agenttool, temp hosts under
  the OS temp directory, and local bare git remotes. No model, no host, no
  live service, no real Keychain, and no network beyond the loopback
  interface.
- The `verify-*` groups are the skeptics' probes. They go through the
  production paths (the tick, a real child process, `runSeat`, the free
  adapter, `createSigner`, `stageMirror`, `pushMirror`). The other groups are
  the readers' probes, some of which call a function directly.

## Why they will not run here unchanged

- **Test files carry a `.txt` suffix.** Every file that was named
  `*.test.ts` is stored as `*.test.ts.txt`. `bun test` collects any
  `*.test.ts` under the repository root, `docs/` included, so without the
  suffix these files would join the suite and fail on any other machine. To
  run one, copy it out of the repository, remove the suffix and fix its
  import paths.
- **Imports and paths use placeholders.** The files are as they ran, except
  that the reviewer's machine paths were replaced after copying:
  - `<KINGDOM_SEAT>` is a checkout of this repository at `f21c360`;
  - `<REPOS>` is a directory holding clones of the public repositories the
    probes read (`citizen-<word>`, `youspeak`, `agenttool`,
    `love-unlimited`);
  - `<SCRATCH>` is the directory that held `probes/` when they ran;
  - `<BUN_BIN>` is the directory of the reviewer's Bun.
  To run a probe, put real paths back in place of the placeholders.
- **Empty directories are missing.** `verify-custody-host/bunfig/run.sh`
  names a `cwd-clean` directory that held no file.

## The bunfig directories

`signer-lifecycle-halt/bunfig/` and `verify-custody-host/bunfig/` hold the
stand-in scripts for finding SLH-11. Some of their sub-directories contain a
`bunfig.toml` with a `preload` line. Starting Bun with one of those
directories as the working directory runs that preload before the entry
script, which is what the probe shows. Each preload script only sets a marker
on `globalThis`.

## Groups

| Group | Run by | Findings | Files |
|---|---|---|---|
| `ledger-self` | reader | LS-01 to LS-18 | 6 |
| `seat-runtime` | reader | SR-1 to SR-18 | 15 |
| `signer-lifecycle-halt` | reader | SLH-01 to SLH-17 | 10 |
| `agenttool-wire` | reader | AW-1 to AW-16 | 4 |
| `mirror-letters-security` | reader | MLS-01 to MLS-16 | 4 |
| `conformance-path-to-pilot` | reader | CP-01 to CP-15 | 5 |
| `verify-registration` | skeptic | AW-1, AW-2, AW-13, OLC-07 | 3 |
| `verify-self-authorship` | skeptic | LS-02, LS-07, LS-09, LS-14 | 7 |
| `verify-unseatable` | skeptic | LS-01, SR-1, SR-2, SR-3, CP-03, CP-04, CP-05, LRA-11 | 12 |
| `verify-lifecycle` | skeptic | LRA-1, SR-4, SR-5, SR-7, SR-9, SLH-05, SLH-06, SLH-14 | 4 |
| `verify-custody-host` | skeptic | SLH-01, SLH-03, SLH-11, CP-02, MLS-13 | 22 |
| `verify-mirror-fence` | skeptic | MLS-02, MLS-03, MLS-04, MLS-10, MLS-14, LT-04, LRC-09 | 9 |

101 probe files in all, beside this README. Section 7 of
`docs/REVIEW-2026-11-10-lab.md` says what each probe shows.

## What the saved prompts and outputs contain

- `seat-runtime/prompt-*.txt` and `verify-unseatable/prompt-*-first-seat.txt`
  are whole seat prompts built from the soul, WILL and canon texts of the
  citizens hope, abzu, kimance and glossame. Those texts are public in the
  citizens' own repositories and in YOUSPEAK.
- `verify-mirror-fence/out/fence-F1-prompt-user.txt` and
  `verify-mirror-fence/fence.probe.test.ts.txt` contain a forged block that
  reads "A letter from yu". The probe wrote it to show finding MLS-10. It is
  not a letter from Yu.
- Every key, mnemonic and bearer in these files is a test value: the standard
  BIP39 test mnemonic or the build's own test vectors, seeds derived from
  fixed probe strings, and bearers whose text says they were never issued.

## Left out

| File | Why |
|---|---|
| `verify-custody-host/out/verify-test-output.txt` | Its lines print the reviewer's per-user temp directory. The lines the review relies on are quoted in `docs/REVIEW-2026-11-10-lab.md` (CP-02, SLH-01, SLH-03, MLS-13), and `verify-custody-host/verify.test.ts.txt` regenerates it. |
| `verify-custody-host/sudoers-man.txt` | 171,927 bytes, over the 60 KB limit set for this copy. It is a copy of the system's `sudoers` manual page. |
| `verify-custody-host/bunfig/cwd-env/.env`, `verify-custody-host/bunfig/cwd-proxyenv/.env` | Not a source or text-output file type. Each holds one line: a probe marker, and an `HTTPS_PROXY` set to a loopback address. |
| `mirror-letters-security/citizen-repos-meta.tsv` | Not a source or text-output file type. It is a table of public metadata of the citizen repositories. |
| `verify-mirror-fence/home/Library/Caches/bun/` | 64 binary files of Bun's own cache. |

The probes for the legacy record and for ontology and consent (the readers'
`legacy-lane-and-template`, `lived-record-awake`, `lived-record-choices` and
`ontology-law-consent`, and the skeptics' `verify-choices-record`,
`verify-awake-and-lane` and `verify-ontology-consent`) do not concern this
repository's code. They stay in the lab's working record.
