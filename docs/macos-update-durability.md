# macOS updater durability cost — 2026-09-15

The release-shaped acceptance follow-up for [runtime candidate `5922e6a2`](runtime-linux-candidate.md)
exposed a slow staged-tree flush in the existing product updater. This is a
product-side correction independent of adopting that runtime candidate.

## Evidence and minimal change

With the unchanged updater, Node 24.19.0's managed-update acceptance exceeded
its existing 180-second subprocess limit while normal startup was repairing a
missing native helper. Downloads and integrity checks had completed. The
parallel Node 22.19.0 run eventually passed, as did Node 24's 15 channel cases;
this is a load-sensitive latency failure, not proof of an unconditional deadlock.
A live sample of the slow Node 22 installation found the main thread repeatedly
inside `fsync`/`fcntl` during the staged-tree walk. Node 24's libuv 1.52.1
[uses `F_FULLFSYNC` on macOS, with fallbacks](https://github.com/libuv/libuv/blob/v1.52.1/src/unix/fs.c),
so serial per-file durability requests carry a substantial cost here.

Only `bridge/grok-leader/bin/update.mjs` changes in the shipped payload:

- At most four staged descriptors flush concurrently. Every non-symlink file
  and directory still receives `fsync`; children finish before their parents.
- All staged flushes finish before the pending journal and active installation
  renames. The existing profile lock remains held across the asynchronous work.
- A failed flush stops admission, drains every already-admitted operation and
  closes its descriptor before rejecting. No journal or active tuple cutover is
  started on that failure. Commit, rollback and directory journal barriers keep
  their existing sequence.

The `codebase-design` skill kept this behind the existing transaction interface;
there is no new public configuration, native dependency or alternate updater.
No integrity check, durability call or test timeout was removed or relaxed.

An ABBA comparison called the old and new real `commitInstallation` interfaces
on a freshly written private tree for every sample (2,000 files / 41 directories):
old **12.172 s**, new **2.610 s**, new **3.000 s**, old **12.860 s** on Node 24.19.0.
Both variants verified the committed content and cleaned only their own fixture.
Other local acceptance work was running; these four samples establish the
targeted flush improvement, not a general installation or startup speedup.

## Verification

The transaction selection passed all 19 tests. Two new subprocess fixtures
exercise the existing commit interface with controlled asynchronous flushes:
bounded descriptors, child-before-parent completion, symlink exclusion,
pre-journal ordering, failure drain, descriptor closure and untouched old data.
Existing real native-lock, concurrent commit, interrupted-update and rollback
tests remain enabled. Full candidate-SDK bridge suites on Node 22.19.0 and
24.19.0 each passed all 47 files / 925 tests, including the compiled TUI CLI.

The standard plugin-only release builder produced a 1,447,976-byte archive,
SHA-256 `3b6f942cbb7a48a4b501abdbc1af08d1dbaf92c6b56fa6acdfd3b00a8a9bb80a`.
The 604-file inventory is identical to the original candidate plugin; exactly
`bin/update.mjs` differs, and its bytes match the main working tree. The runtime
archive is unchanged, SHA-256
`37ac5ac652101944d943cd7f036480cb68e0a6719c80d59fdfe0f0043e0720e7`.

The builder initially rejected the test consumer after Vitest wrote its `.vite`
cache. No provenance record or verifier was weakened: the preserved extracted
runtime passed the original complete consumer digest, and a separate packaging
consumer reuses that verified dependency tree. Final bridge tests disable their
cache. The initially omitted compiled-TUI test path was corrected before the
full 925-test runs; the earlier 921-pass/4-skip runs are not the final gate.

Updated-package managed-update acceptance passed on both Node 22.19.0 and
24.19.0: initial install, same-version native repair, missing/corrupt-helper
startup repair, legacy overlay repair, composed profile, same-version no-op,
forced bad-checksum rejection and user-file preservation. Every doctor check
passed. The existing 180-second subprocess limit is unchanged; the Node 24
startup-repair failure above no longer occurred in this run.

All 15 channel cases passed on Node 24: read-only checks, stable/beta/alpha
selection, digest fallback, checksum/TUI/source mismatch rejection, exact target
selection, preserved configuration/sessions/unrelated plugins, and offline npm
cold bootstrap with the real compiled TUI and matching source runtime. Channel
selection uses controlled version banners; the cold bootstrap uses the actual
binary. The optional historical beta.13 launcher-delegation case was not run.
The full TUI/runtime run 88327 predates this updater-only change and was not
repeated; the real managed-launcher and cold-bootstrap checks above are new.

Main `scripts/check.sh` and `git diff --check` passed. Re-review found no further
issue within this change and its executed coverage. Test-owned managed-update
profiles were automatically removed; reports and the channel fixtures remain.
No daily profile, DSH pin, version, remote branch or release has changed. This
local updater work does not satisfy the separately pending real Linux/user-systemd
gate on `swoop`.

Evidence root: `/tmp/dscode-linux-follow.YzBIHE/`. Relevant files are
`update24.log`, `update22.log`, `channels24.log`,
`update22-initial.sample.txt`, `flush-benchmark.mjs`, `flush-benchmark24.log`,
`bridge-fsync-final22.log`, `bridge-fsync-final24.log`,
`runtime-provenance-fsync.log`, `package-fsync-r2.log`,
`plugin-fsync-diff-final.log`, `packages-fsync/`, `update-fsync22.log`,
`update-fsync24.log`, `update-fsync22/update-PASS.json`,
`update-fsync24/update-PASS.json`, and `channels-fsync24.log`. The channel report
is `/var/folders/f5/rv0zdz_15ljcbs0v40qtns8r0000gn/T/dscode-channel-e2e-fSJDfl/PASS.json`.
