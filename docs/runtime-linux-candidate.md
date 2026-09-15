# Linux cancellation candidate — 2026-09-15

Candidate `5922e6a2134dd2ad14fbc5a054e56b7938340c98` adds the Linux subprocess
settlement fixes to [image candidate `079a0d76`](runtime-image-candidate.md).
It is an isolated local backport over pinned DSH `fb2c4b9e` (`0.1.5-rc.2`), not
an adopted SDK pin or published runtime. Main product code and daily profiles
are unchanged. Real Linux/user-systemd acceptance remains pending.

## Refreshed scope

The initial assessment named `b79a227c` and `aaa02a39`. Refreshing official
master to `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720` exposed later corrections
in the same owner; stopping at the original pair would omit known races.
The candidate selectively follows these commits:

| Upstream commit | Included behavior |
| --- | --- |
| [`b79a227c`](https://github.com/deepseek-ai/deepseek-harness/commit/b79a227cec941405c9b368524446145298e9d48d) | Preserve an observed requested termination before bootstrap consumption; retain genuine startup failures. |
| [`aaa02a39`](https://github.com/deepseek-ai/deepseek-harness/commit/aaa02a39709893ea45ac220aa87194d8522325fe) | Settle an active empty scope after termination and launcher exit; unknown process counts remain unknown. |
| [`18a1955b`](https://github.com/deepseek-ai/deepseek-harness/commit/18a1955b7e3b940c002144ea377313d408f1d123) | Discard state observations invalidated by a termination signal and query again. |
| [`dafff8e5`](https://github.com/deepseek-ai/deepseek-harness/commit/dafff8e51cbd309237dc486a467a283fd1668898) | Accept a consumed request plus zero scope processes before the delayed direct-exit notification. |
| [`4b99ace8`](https://github.com/deepseek-ai/deepseek-harness/commit/4b99ace8fb5ce7b1e057b23b119f92ebf2d2dd5c) | Join acknowledged direct termination once before deciding a failed final scope kill; wire the PTY's independent settlement. |
| [`c07df5aa`](https://github.com/deepseek-ai/deepseek-harness/commit/c07df5aa65fc37f822b211e27ddc51b6e1e7d6ce) | Require direct-PID SIGKILL acknowledgement or absence, not merely process-group delivery. |
| [`71334b9c`](https://github.com/deepseek-ai/deepseek-harness/commit/71334b9c7813cad301739433ccc84297bcedfa85) | Keep denied signal delivery separate from a child's launch-error event and eventual direct outcome. |
| [`dd55f386`](https://github.com/deepseek-ai/deepseek-harness/commit/dd55f38614d89615b4825fc306a8609f400ab2b2) | Preserve the signal-error rationale and isolate every fake PID from real host signals in the tests. |

Relative to the image candidate, production changes touch only
`subprocess-local/src/linux-scope.ts` and its PTY binding in `src/index.ts`.
The Linux owner matches the refreshed upstream implementation except for the
deliberately excluded control-pipe feature. No package manifest, dependency,
lockfile, public subprocess spec, terminal resize/type/backpressure API, CI
runner or vendor source changes are included. No bridge timeout workaround or
command replay was added.

Tests also retain the upstream platform-selection and cancelled-start fixture
corrections: a fake PTY cannot enter a real host scope, and disposal may win
before a startup failure is recorded. A new early-bootstrap fixture and the
authored `bash-startup-timeout` recorded Session accompany the change.
The final-kill matrix in newer upstream tests used the control-pipe API; this
backport checks the existing stdout and stderr instead. Both remain open while
direct settlement and scope observation complete, preserving the assertion
that cleanup does not depend on draining output. It does not add a dummy
control implementation or skip the matrix.

The source repository's `dsh-prose-standard` and `dsh-doc` skills kept the
caller-visible facts in the paired README and the existing containment note.
The note retains the distinction between direct exit and empty scope, signal
failure and startup failure, and a missing process count and a proven zero.
A confirmed empty scope is stopped best-effort; failure to remove that unit
does not invent surviving processes. Direct exit can still wait indefinitely
in uninterruptible kernel I/O; the patch does not promise an absolute shutdown
deadline or improve macOS's weaker process-group containment guarantee.

## Executed local checks

All evidence below is from macOS arm64. Systemd behavior tests inject the
manager and process operations; they are not observations of Linux kernel or
manager behavior.

- Node 22.19.0 and 24.19.0 each passed 440 tests across the subprocess provider,
  subprocess service, bash-local and terminal-bash selection: 18 files passed,
  3 skipped; 17 cases skipped for platform or optional-tool availability.
  The 106 direct owner/provider cases are included in those totals, not extra.
- Four negative controls temporarily restored obsolete decisions in the
  isolated source: early-cancel classification failed 2 cases, accepting a stale
  query failed 1, requiring the delayed exit for a consumed empty scope timed
  out 1, and omitting direct settlement failed all 16 final-kill matrix cases.
  Each mutation was restored; the 106-case focused suite passed again. These
  are targeted mutation controls, not a full old-runtime Linux reproduction.
- The first focused attempt failed the 16 matrix cases only on their excluded
  control-pipe expectation. Adapting the fixture to current stdout/stderr
  resolved that incompatibility without changing the production fix or its
  ordering, signal, outcome and scope-state assertions.
- Host native-addon build, all 16 `test:docs` checks and all 34 `doc-sync`
  checks passed. After doc-sync's host build, `lint:contracts-ready` passed.
  Normal commit hooks passed pairing, staged lint, whitespace and vendor checks;
  staged lint retained an existing unused-suppression warning.
- The owner selection emitted an exit-listener warning. A trace located the
  unchanged provider constructor; the same warning reproduced against the
  image-only baseline with bash-local/terminal-bash (126 passed, 4 skipped).
  It was not hidden by increasing the listener limit or claimed fixed here.

Source checkout: `/tmp/dscode-linux-follow.YzBIHE/source`, retained by
`candidate/images-linux`. The self-contained local backup is
`.git/integration-backups/dsh-images-linux-5922e6a2.bundle`, verified by
`git bundle verify`, SHA-256
`7b6e31d71ec3b1efb5fa51eb08dfc8cf633c67354a63398a94297fe82c33558c`.
The image-only backup remains intact.

Logs are under `/tmp/dscode-linux-follow.YzBIHE/`: `owners22.log`,
`owners24.log`, `focused24-final.log`, `mutation-early-cancel.log`,
`mutation-stale-query.log`, `mutation-consumed-empty.log`,
`mutation-direct-settlement.log`, `docs.log`, `doc-sync.log`, `lint.log`,
`commit.log`, `warning-trace24.log`, and `warning-baseline24.log`.

## Packaged macOS validation

The standard release builder rebuilt the official packages with the candidate
source fingerprint, using a temporary product clone of `e3ac23b`. That clone's
only tracked change selects `5922e6a2` in its plugin manifest. Its assets are in
`/tmp/dscode-linux-follow.YzBIHE/packages/`:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `dscode-plugin.tgz` | 1,447,600 | `27b9c47c1672c46031c5ccec771303657d261f1f7016d103b1e9233db9ea6f21` |
| `dscode-runtime-macos-aarch64.tar.gz` | 288,554,054 | `37ac5ac652101944d943cd7f036480cb68e0a6719c80d59fdfe0f0043e0720e7` |

The runtime descriptor identifies `5922e6a2`, `darwin/arm64` and the preserved
`0.1.5-rc.2` metadata. The existing consumer verifier checked the entire
extracted dependency tree against its source-build record (`runtime-digest.log`).
The candidate-SDK bridge TypeScript build passed, followed by all 47 files /
923 bridge tests on each of Node 22.19.0 and 24.19.0 (`bridge22.log`,
`bridge24.log`).

The new `bash-startup-timeout` snapshot passed against built libraries through
the shipped headless profile with `DSH_EXAMPLE_MODE=lib` and
`DSH_SNAPSHOT=replay`; the other 138 recorded scenarios were unselected, not
additional passes (`snapshot.log`). This proves the model-visible timeout
result on macOS, not Linux's native scope path.

The retained image migration probe also passed through the combined packaged
runtime: sixteen concurrent reads and cache regeneration preserve durable
image/file bytes, explicit-home precedence, legacy-cache retention and the
native pricing vectors (`image-baseline.json`, `image-candidate.json`). It uses
only isolated fixture data and makes no live billing or image-quality claim.

Full installed TUI/DSH/bridge acceptance passed on Node 24.19.0 without
scenario-only flags, run 88327: `e2e.log` and
`e2e/contracts-88327/PASS.json`. It includes image submission/rejection,
resume/fork/reload, goals, workflows, reminders, native history, permissions,
presets/LSP, archives, real shell/Python, terminal interruption and owner
isolation. Interactive rewind restores a draft without resending and retains
the shortened transcript after a fresh leader. All 135 installed plugin
source/compiled/bin/preset files and its DSH metadata match the candidate-SDK
test build (`installed-files.log`); `packaging.json` in the contracts directory
records the actual dependency paths. The TUI binary is unchanged from the
[verified image-candidate run](runtime-image-candidate.md#packaged-runtime-and-product-validation).

The installed run uses a controlled provider, not a real DeepSeek billing
measurement. Graphical Kitty, physical Cmd-click, nonempty compaction and Linux
native containment are outside its coverage. Main-checkout `scripts/check.sh`
and `git diff --check` passed. Re-review found no additional failure within the
executed coverage; it does not waive the Linux or source-distribution gates.

## Remaining adoption gates

The user selected `swoop`, whose user systemd manager was verified running.
Its login notice reserves the server for interference-sensitive evaluations
and requires prior workload approval; that confirmation remains outstanding.
No remote build, scope probe that launches a payload, cancellation test or
cleanup job has been started. The last read-only disk check reported only about
3.4 GB free on the root filesystem, so an approved run must also choose adequate
scratch storage without deleting unrelated data.

On an approved Linux host, validate the actual native selection, ordinary and
PTY early cancellation, genuine pre-exec failure, repeated immediate disposal,
independent direct outcomes, escaped-descendant cleanup, and shutdown through
the built/runtime entry. Inspect the owned scope and processes externally after
each run; a passing mock suite or fallback run cannot satisfy this gate.

Exact-source distribution is also unresolved. This local backport is not an
official remotely fetchable revision; changing the main pin without supplying
its source would make a clean release build unreproducible. The candidate must
not be relabeled as the published `0.1.5-rc.2` artifact merely because version
strings match. No push, release or daily-profile replacement is authorized by
these validation results alone.
