# Current-main Linux acceptance — 2026-09-16

Target: product commit `20b6c5467c48298584505d144f715e64a3616af2`, version
`0.0.14-alpha.12`, pinned DSH `fb2c4b9e698e30edb738bca4cf0618587db7d203`
(`0.1.5-rc.2`) plus patch SHA-256
`5d5ffa359d9e44e2280846a65e99638b39a4484672d7f4bbc0b4d34a7684f505`.
The earlier [Linux candidate acceptance](runtime-linux-candidate.md) validates
`5922e6a2`, not this main revision.

## Status

**Not accepted: native early cancellation fails.** All planned gates have
finished. The fresh Linux build, bridge regression, managed updater and full
installed-product E2E passed, but do not clear the native cancellation failure.
This result covers the current main revision above, not the unmerged
`candidate/dsh-capabilities` branch.

## Executed checks

- Fresh official-source Linux runtime and plugin builds passed, including the
  exact patch checksum, installed-consumer tree and packaged native-artifact
  validators. The built CLI reports `0.1.5-rc.2`.
- The cold Rust release build passed in 51m 14s with the pinned 1.94.0 toolchain.
  The resulting TUI reports `dscode 0.0.14-alpha.12 (20b6c546) [alpha]`.
- Node 22.19.0 and 24.19.0 each passed 399 source cases, with 13 platform or
  optional-tool skips, inside an isolated PID namespace with an init reaper.
  The three real Linux user-systemd containment cases ran separately on the
  host and passed on each Node version; no containment case was skipped there.
- The built-provider 15-case matrix failed on both Nodes: 6 passed / 9 failed
  on Node 22, and 3 passed / 12 failed on Node 24. Each completed case was
  followed by observed collection of all scopes owned by that test process.
  Matrix failures remain failures; aggregation only permits checking later
  independent cases instead of stopping after the first assertion.
- Node 22.19.0 and 24.19.0 each passed all 44 release/runtime/gateway script
  cases, with no skips, and all 931 bridge cases in 47 files, including the
  four compiled-CLI cases. Each run selected that Node version on PATH as well
  as for the parent process, and checked TypeScript against the fresh SDK.
- Managed-update E2E passed on Node 24: install, explicit and startup repair
  of missing/corrupt native artifacts, legacy-overlay repair, composed profile,
  same-version no-op, corrupt-asset rejection and preservation of user files.
- Full TUI → DSH → bridge E2E passed on Node 24, run `656036`, without
  scenario-only flags. Coverage includes headless and interactive prompts,
  image submission/rejection, worktree lifecycle, editor failure recovery,
  wrapped links/table copy, draft stashing, live display switching, durable
  resume/fork/rewind, goals/tasks/workflows/reminders, native history and skills,
  presets, real TypeScript LSP, archives, persistent shell, Python REPL,
  terminal interruption and owner isolation. This uses the real product with
  a controlled provider, not a live paid-model session.
- `scripts/check.sh` passed on Linux. The remote product clone remained clean
  at the exact input commit and retained only its main worktree after E2E.

## Blocking finding: requested early cancellation becomes startup failure

Ordinary spawn followed immediately by provider disposal fails all five
attempts on each Node version. Immediate AbortSignal cancellation also fails;
PTY cancellation fails when it wins before request consumption. The observed
error is `scope exited before its bootstrap consumed the launch request`,
instead of a cancelled outcome. Genuine ENOENT/EACCES checks still pass.

In the pinned source's `subprocess-local/src/linux-scope.ts`, `directOutcome`
and the PTY outcome resolver reject whenever the launch request still exists,
without distinguishing a requested termination from a genuine startup failure.
These Linux branches are unchanged by the current macOS patch. The older
candidate has the requested-signal distinction, but is not adopted on main.

The matrix's PTY case labelled "after readiness" observes scope membership,
not target stdout: its failure is further early-cancellation evidence, not
proof of failure after the target is ready. The ordinary ready-output case
and direct-exit/escaped-descendant cleanup both pass on each Node version.
No production code or assertions have been changed to hide these failures.
This establishes a built-provider outcome error; it does not establish a TUI
crash or surviving commands. Scope collection was observed even for the failed
cases. The separate installed-product checks passed, but do not exercise every
early-start ordering in the built-provider matrix.

The focused follow-up is to integrate the Linux owner and PTY settlement
correction from the earlier candidate, preserving genuine startup errors and
signal-delivery failures. It needs a reproducible source patch/provenance and
revalidation alongside the current macOS changes; this report does not adopt
the candidate pin or its unrelated capabilities.
The settlement correction was merged into the backport as `f5052559` and
accepted the next day in [the combined settlement
acceptance](linux-acceptance-2026-09-17.md); the revision main carries today
was re-accepted over the two later production commits as [the current-main
re-acceptance](linux-acceptance-2026-09-17-main.md).

## Fixture correction

The original pinned source has fake-PID signal tests, so those suites cannot
safely run in the host PID namespace. Initial private-namespace runs used Node
as PID 1 and failed four (Node 22) / five (Node 24) host-exit assertions because
orphan zombies were not reaped. A small independent probe observed `Z` with
Node as init, and absence with the host's `docker-init` (tini 0.19.0).
Following the upstream `dsh-ci-test-reliability` isolation guidance, adding
that init inside the private namespace made all 399 cases pass without
editing source, assertions, timeouts or normalizers. Real systemd tests remain
outside this namespace and use the actual user manager.

## Isolation and evidence

The user approved swoop (Ubuntu 24.04.3 LTS, Linux x86_64, systemd 255).
This does not validate older glibc distributions or Linux ARM64. The new root is
`/home/hanqing/dscode-main-linux-acceptance.5LA3OP`; original candidates and daily
profiles are untouched. Node 22/24 and package-manager copies, dependency
caches, build outputs, fake providers and test homes are private to this root.
Builds use nice 15 and one worker each, with at most two concurrent build jobs.
Rust uses the already installed pinned 1.94.0 toolchain, without changing the
host default. No sudo, paid model, push or release is involved.
The full upstream Rust/DSH suites, graphical Kitty interactions and unmerged
experimental browser/Inspector capabilities are outside this run's coverage.

The independent post-run audit at `2026-09-16T08:16:21Z` found no new user
scopes and no surviving processes owned by the test root. All four recorded
process identities were absent. Per-case scope collection and the final
audit agree; no unrelated process or scope was stopped. Inactive build and
test artifacts remain in the private root for reproduction.

The transferred product bundle SHA-256 is
`e4221357da0b0f0ddd38aa6c7b29e2fd3215e3520196c1c64f4ee5db49eac414`.
Fresh clones checked the exact product revision and clean tracked tree.

| Built asset | SHA-256 |
| --- | --- |
| `dscode-plugin.tgz` | `52f05eb8aaa8582f056e6f250ae3f3114e26f7024739e114ef1ed27523b7bf11` |
| `dscode-runtime-linux-x86_64.tar.gz` | `1fa1fe5de87279d0a642f666f73d389f324c76da67647659adadfa069fef5484` |
| `dscode` | `4c083ffbbb138144eecec49640561f28a1e8e72d2926288d8f000bc3a34ecd31` |

Remote evidence includes `logs/runtime-build.log`, `logs/source-reaper-*.log`,
`logs/source-native-*.log`, `matrix-*/results.json` and `logs/matrix-*.log`.
Initial failures remain in `logs/built-*.log` and `logs/source-namespace-*.log`;
the init comparison is `logs/reaper-{negative,positive}.json`.
Product evidence includes `logs/tui-build.log`, `logs/bridge-*.log`,
`logs/scripts-*.log`, `update/update-PASS.json`,
`e2e/contracts-656036/PASS.json`, `logs/check.log` and
`logs/post-run-audit.json`. Initial failures are retained, not overwritten.
Scripts, logs, matrix results and product evidence are archived in
`.git/integration-backups/linux-main-20b6c546-evidence.tar.gz`, SHA-256
`e880a35c896539e6bf3e83aea8f5bce8c1bd491c77cbf2b4d38eab27e1eb8f50`.
The local and remote archive hashes match. Bulky test homes, dependencies and
build outputs are excluded from this evidence archive.
Local working evidence is `/tmp/dscode-linux-main.Gx0Kto`.
