# Repository maintenance review

Scope: small refactors, macOS regressions and local build-cache reduction after
the upstream integration. Product, SDK and runtime source pins are unchanged.
The existing bridge ownership modules and performance changes are preserved.

## Changes and re-review

- Two product E2Es now use one runtime-preparation interface. It owns artifact
  selection, missing-half builds, fresh extraction and pin/layout checks. The
  callers receive two literal paths; errors propagate without `eval`. The
  obsolete unpinned/global-CLI fallback was removed from these source-pinned
  test harnesses, not from the user launcher or release builder.
- Wrong plugin name/version/release/SDK, runtime descriptor/CLI/architecture,
  missing artifacts and failed builds now fail before product installation.
  Metadata checks do not authenticate arbitrary payload bytes; release
  checksums and source/archive comparisons remain separate requirements.
- Checkout paths are passed as Node arguments instead of interpolated into JS.
  tmux commands preserve literal arguments, and trust-store keys are escaped.
  Regression tests cover spaces, both quote types, newlines and substitutions
  across macOS Bash 3.2, sh and zsh. The same fixture suite is wired into the
  Linux/macOS CI gate and release preflight.
- The architecture plan is reduced from 892 to 77 lines, retaining all six
  requirements and links to reviews. Superseded checkpoints remain recoverable
  from Git. README no longer incorrectly says uninstall deletes the profile.

The shared helper is a local filesystem/process boundary, not a new framework
or dependency-injection layer. Tests call its actual CLI and shell interface
with small real archives. The distinct isolated bridge-test runner is left
alone: its staging/compilation contract is not identical to product installation.
No vendored source, licenses, tests or source lockfiles were removed for size.

## Validation

Local checkpoint: `/tmp/dscslim.ceos2u` (temporary, not a permanent download).

- Forced TypeScript builds and full bridge suites on Node 22.19.0 and 24.19.0:
  **46 files / 846 tests each**, no skipped bridge tests.
- Node 22/24 script suites: **37 passed, 1 Linux-only skipped** each, including
  21 new runtime/quoting cases.
- Provider-management product flow passes with ordinary paths (run 89132), and
  again with quoted checkout/TUI paths (run 93630). This includes both boots,
  model-preserving provider selection, edits and current-provider delete refusal.
- Fresh plugin SHA-256:
  `6284565cca9877da05552ece6d955331ea80281ac1791bb473b172d4793d9fa6`.
  All 132 archived source/compiled/launcher/preset files match the tested copy
  and checkout. Five host-provided SDK peers remain unbundled.
- The first full Mac run (89074) failed the real LSP definition assertion with
  TypeScript 7.0.2 / language-server 6.0.0 installed in the temporary fixture.
  The documented/CI pair is 6.0.3 / 5.0.0; no assertion was weakened. The failed
  run and tool results are retained for comparison, not counted as a pass.
- The full Mac rerun with that fixed pair passes, run **18120**, script exit
  **0**. Report: `mac2/contracts-18120/PASS.json` under the checkpoint above.
  It includes four real LSP queries, 14 history-isolation cases, private
  clipboard, workflows, Python REPL, terminal controls and actual child-process
  reaping (PID 51611). Logs: `macos-pinned.log` and `provider-quoted.log`.
  The initial LSP tool response reported no valid TypeScript installation;
  compatibility with the unpinned 7/6 toolchain is not established by this run.

## Local size and Git cleanup

- Cargo's verbose dry run listed only paths inside the real, non-symlink
  `third_party/grok-build/target/debug`; Git tracks no files under `target`.
  No Cargo/rustc process was running when cleanup began. Ran Cargo's own
  `clean --profile dev --locked --offline` with explicit manifest/target paths.
- Removed **472,280 generated files**. Cargo reports **140.5 GiB logical size**;
  the pre-clean `du -sk` allocation was **114,576,888 KiB (109.27 GiB)**.
  The remaining target directory is **20,063,424 KiB (19.13 GiB)**. These are
  directory-size measurements, not a claim about APFS snapshot space recovery.
  Debug artifacts are not retained in Trash; rebuild the dev profile to
  regenerate them. Source and source lockfiles are unchanged.
- The release cache and runnable TUI are preserved. Before/after TUI SHA-256:
  `700b1fc6ed2a32cd3eb2bd302bb4cf4dad2c1577c39be996dfe63b3fd2ab1ed2`.
  The binary still reports `dscode 0.0.14-alpha.12`. A separate copy was made
  before cleanup in the temporary checkpoint.
- Remote fetch found no new unmerged commits. The integration is already in
  `f29716a`; this round's script refactor is `2f35006`. Only the main worktree
  remains; no stash or stale worktree registration needs removal. The existing
  `.git/integration-backups/pre-pull-2026-09-13.bundle` is retained for recovery.

## Boundaries

This round changes test/release scripts and documentation, not Rust or product
runtime code. Rust tests are not claimed re-run. No Linux execution, physical
Cmd-click, Kitty rendering or live external-model certification is inferred
from macOS tests. The historical intermittent table-copy observation remains
documented in [architecture-review.md](architecture-review.md#coverage-limits).

No daily profile was changed, and no push, release or global installation was
performed. An isolated copy of the already source-pinned local runtime supplies
the SDK; this is not a fresh source rebuild of that upstream runtime.
