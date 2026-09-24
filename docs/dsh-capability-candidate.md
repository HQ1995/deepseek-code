# DSH capability candidate

## Product integration — 2026-09-24

Branch **`dsh-integration`**, on `dsh-capabilities-rc.1` (`0050882d`). The
capability experiments become product features. Each is off, or a separate
choice, until the user picks it:

| Commit | Feature |
| --- | --- |
| `e06bf64e` | `/provider` adds the official DeepSeek adapter (`deepseek-official`, Messages API) and reconciles it live |
| `c7b8c5f1`, `6973b4ea` | `/browser`: a private headless browser per top-level session, with origin limits, approvals, `/doctor` findings and a Linux AppArmor sandbox warning |
| `e737b8c1` | The `teams` preset beside the other seven, `/team`, teammate names on child rows, and refusal of switches, copies and inbox edits that would break Team bookkeeping |
| `b46ebf7f` | TUI divergence ledger entry for the native provider template |
| `5e9e13f9` | Remote workspace over SSH: `dscode remote`, a fail-closed TUI for remote paths, and the leader socket published without a process-wide umask |

Details, limits and acceptance scripts are in the
[upgrade notes](upgrade-strategy.md#browser).

### Verification

**macOS arm64** (rc.1 runtime, evidence root `/Users/hqzhao/AI/dsh-rc171/run-20260923`):
- Bridge suite on Node 24.19.0 and 22.19.0: 71 files, 1,099 tests each (4 compiled-CLI skips).
- `scripts/check-rust.sh` passes, as do the remote-world and trust unit tests.
- `control/int-verify-all.sh s2` (logs `all-*-s2`), on both Node versions:
  - the SDK browser smoke, whose any-origin negative control fails at the outside-origin check;
  - the installed browser smoke;
  - the Teams smoke, whose host-row negative control fails at the isolation check;
  - the installed Inspector smoke.
- The same run passed the provider E2E and full TUI E2E run **19869**.
- The native provider E2E passed on both Node versions with the final plugin.
- Remote workspace against swoop:
  - `e2e-remote-installed.mjs`: 5 checks;
  - `e2e-remote-tui.mjs`: headless, then interactive in tmux;
  - SDK `ssh-smoke.mjs` (8 checks) and `ssh-integrity-smoke.mjs` (2 checks).
  - A TUI binary without the gates fails at the host-cwd refusal.

**Linux** (swoop, Ubuntu 24.04.3, `nice -n 15`, one worker, private caches and
homes, no sudo, run root `/home/hanqing/dscode-int-acceptance.a9plOe`). Pass 1
at `c7b8c5f1` passed:
- on both Node versions: setup, plugin build, bridge suites, script tests,
  native provider E2E, and the browser SDK smoke with its negative control;
- the installed browser smoke, with executable discovery through a private
  `PLAYWRIGHT_BROWSERS_PATH`;
- the TUI build, the provider E2E and the full TUI E2E.

A Chrome for Testing 153 renderer was measured in its own user namespace under
seccomp-bpf mode 2 (swoop has the AppArmor restriction off).

Pass 2 at `5e9e13f9` covered everything above plus Teams and the remote
workspace code. It ran all 15 gates, and all passed:
- the clone update from a verified bundle, and the plugin build;
- on each Node version: bridge suites (1,103 tests, compiled-CLI tests
  included), script tests and the native provider E2E;
- on each Node version: the browser smokes and the Teams smoke, whose negative
  controls failed as designed;
- the incremental TUI build, provider E2E run **3881589** and full TUI E2E run
  **3883762**.

Not covered: live model accounts, a second remote host, and remote Phase 2 (a
remote read API for `@` completion, the line viewer, full-file highlighting and
the git branch display). The pager test
`dragging_image_while_scrollback_focused_attaches_to_composer` fails with and
without these changes, and is outside the release gate's filter.

## Port to DSH 0.1.7 — 2026-09-23

Branch **`dsh-capabilities-rc.1`**, rebased without conflicts onto the
`dsh-0.1.7-rc.1` tip `411b30eb` (source-built rc.1, commit `46a7f68b`,
patch `f3fe5695…`). It was first ported and accepted on alpha.2; the
verification below covers both runtimes. The 0.1.6 candidate
`candidate/dsh-capabilities` remains the historical record (below).

Bridge changes, active in every dscode profile:

| Commit | Behavior | Candidate origin |
| --- | --- | --- |
| `9378a964` | Resource-only MCP servers are no longer labelled disconnected; durable `image/offload` shows a system notice live, on replay and in paged child history | `a28655b` |
| `a9891362`, `77614bd0` | A cancelled prompt settles only after its aborted native activity ends (for example, MCP browser cleanup); a failed drain rejects instead of reporting success. The wait ends at that activity's idle transition, not at a turn woken during the unwind, and disposal never waits | `7310a64` (bridge half); `77614bd0` is a review fix |
| `beb0548e` | `/doctor` reports an explicitly mounted Inspector with its DevTools URL and a full-debugger warning | `2160060` (bridge half) |

Opt-in bundles and keyless acceptance scripts under `experiments/`, referenced
by no dscode bundle, preset, launcher or release builder: `native-messages/`,
`teams/`, `ssh/`, `inspector/`, `playwright/` and `capabilities/`. On
`dsh-integration`, `playwright/` is replaced by the product `/browser`,
`teams/` by the shipped `teams` preset and `ssh/` by the shipped remote
workspace (`dscode remote`); all three are removed. Candidate
commits `fa1b5b9` and `5aa44f1` needed no port: main's alpha.2 adoption already
carries `workflow-ptc`, `agent/created`, the session-log opt-out and Ralph in
the owned presets.

### What alpha.2 changed

- `llm-deepseek` speaks only Messages and rejects a `protocol` key; the native
  overlay and Messages smoke no longer set one.
- `dsh-agent-presets` roots are gone. Teams is now a `preset-teams`
  `@deepseek-ai/dsh-agent-preset` row derived from dscode's history preset
  without delegation. Its bundle makes `teams` the registry default and disables
  the seven dscode preset rows. That is required, not cosmetic:
  `tool-subagent-control` registers the same `send_message`, `list_agents` and
  `interrupt_agent` names as the Team tools. The Team rows keep the ids of
  upstream's `dsh-experimental-agent-team-profile`; never install both.
- Team member views expose `target` (the name) and no session id; the policy
  prompt wording changed.
- Permission presets refuse to activate when the composed sandbox and approval
  defaults match no preset. The loopback fixture patch declares a fixture-only
  `workspace-write` + `never` preset. Installed smokes now fail on any
  `did not activate` warning.
- Session format V4 stores tool results flat; the Playwright smoke's projected
  screenshot event follows it.
- The alpha.2 SSH helper imports new subprocess modules, so the remote closure
  must be redeployed and both digests recomputed.
- Profile plugin installation needs `pnpm` (the smokes use corepack).
- rc.1 enforces exact `@deepseek-ai/dsh*` peers: a bundle still pinned to
  alpha.2 is refused by `dsh plugin add` and skipped at boot. Every experiment
  now pins `0.1.7-rc.1`. Beyond that pin, rc.1 needed no change here.

### Verification (macOS arm64)

rc.1 evidence root `/Users/hqzhao/AI/dsh-rc171/run-20260923`, logs `logs/cap-*`;
alpha.2 evidence root `/Users/hqzhao/AI/dsh-alpha172/run-20260922`.

- Bridge suites against the source-built SDK, Node 24.19.0 and 22.19.0: rc.1
  66 files, 1,050 tests each after the review fix (1,044 before it); alpha.2
  1,040 each. Ported queue tests fail
  without the drain fix (8 failures). `scripts/check-rust.sh` passes.
- Full installed TUI E2E with plugin and TUI rebuilt from this branch
  (`payload-cap`): rc.1 run **54701** after the review fix (**36271** before it),
  alpha.2 run **88800**, all PASS.
- Node 22.19.0 and 24.19.0, every keyless smoke on both runtimes
  (`control/cap-node22.sh`, `cap-node24.sh`). The Playwright smoke imports the
  compiled bridge, so build `bridge/grok-leader/lib/` first. After the review
  fix all eight pass on both Node versions (`rv-cap-smokes-node*.log`):
  - MCP resource-only via native and PTC calls.
  - Native Teams: tools, task CAS, isolation, Lead authority, messaging and resume.
  - Native Messages/Files: reuse, durable offload, resume and inline fallback.
  - Inspector: Host tree/CDP, no default fetch capture, teardown restoration.
  - Playwright: unit tests, and real Chromium approvals, screenshot, sibling
    isolation, cancel/timeout cleanup, PTC cancellation and unload.
  - Installed Teams: nine unique tools, `teams` as the only preset, one
    loopback Messages turn.
  - Installed browser + Inspector: disabled by default, approvals,
    rejection/cancel without late page effects, resume with fresh storage.

**Not run for this port:** SSH (requires redeploying the rc.1 helper on the
approved swoop directories), Linux, physical TUI presentation of browser or
Teams flows, child inheritance, and external real-model acceptance. These, with
the gates below, keep the bundles experimental.

## 0.1.6-alpha.1 candidate — 2026-09-15

Implemented and locally preserved on **`candidate/dsh-capabilities`**:

- `a28655b`: resource-only MCP status and durable image-offload system notices,
  including paged child history.
- `74be939`: explicit native Messages/Files, isolated Teams profile, remote SSH
  filesystem/subprocess/sandbox/PTC composition and reproducible acceptance scripts.
- `2160060`: opt-in Host Inspector, default fetch capture off, `/doctor` URL
  and full-debugger-access warning; no Web app dependency.
- `7310a64`: browser cancellation/timeout cleanup through native resource owners,
  bridge terminal completion waits for native drain, and installed ACP acceptance.

The branch is imported into this repository; its original working copy is
`/tmp/dscode-alpha16.c6NG8h/product`. Full details are committed on that branch:

```sh
git show candidate/dsh-capabilities:docs/dsh-capability-acceptance.md
git show candidate/dsh-capabilities:docs/dsh-browser-inspector-acceptance.md
```

Node 22.19.0 and 24.19.0 each passed the source-built release-SDK bridge suite:
**931 passed, 4 compiled-CLI tests skipped** after the browser/Inspector batch.
Pager coverage from the preceding batch: 137 MCP/extensions
tests plus the new child-history notice test. Both Node versions passed native
MCP Resources/PTC, Messages/Files/offload persistence, native Teams lifecycle and
installed Teams catalog/turn tests.

The user-approved **swoop** directories were used for real remote filesystem,
read-only enforcement, PTC, subprocess, PTY, cancellation, abrupt transport-loss
cleanup and installed headless → native Messages → remote bash acceptance.
Incorrect helper/bootstrap hashes were rejected. The test workspace is empty;
two earlier fixture files are recoverably retained under the isolated runtime's
`acceptance-artifacts/`. No existing remote project or daily installation changed.

The browser and Inspector bundles are both installed-but-disabled by default.
Both Node versions passed actual installed native Messages/Files → ACP approval
→ Chromium screenshot/cancel/resume tests against a private loopback fixture.
Real SDK native/PTC cancellation and timeout tests verified owned process exit
before returning, no delayed page request and a usable sibling Session. Inspector
Host tree/CDP, explicit fetch capture and teardown restoration passed on both.
The earlier browser cancellation gate is repaired: native MCP scope cleanup and
the bridge's premature terminal notification were separate issues, both fixed.

**Not merged into the main runtime pin or released:** interactive SSH TUI work is
paused per the user's revised priorities; Auto review remains deferred. Browser
physical TUI presentation, Linux browser lifecycle/sandbox, child inheritance and
external real-model acceptance remain promotion gates. Inspector binds loopback
but grants unauthenticated full host debugging; never forward its port. Browser
state isolation does not confine network or host access. Teams has native tools/state but no
new task-board UI, file locking or automatic conflict resolution. This candidate
is not a claim of complete production support for every experimental DSH feature.

Backup: `.git/integration-backups/dsh-capabilities-74be939.bundle`, verified by
`git bundle verify`. It requires the already-present base `db43b24`.
SHA-256: `43e412e008d19c88cf41014fae696564329dd10745fbf4689d4ddd87164bc90c`.
Latest full candidate backup:
`.git/integration-backups/dsh-capabilities-7310a64.bundle`, also verified, with
the same base prerequisite. SHA-256:
`3d3912625ea6d09b16d200b1befe9a7026a516d961986dcddc0419fa4010441b`.
No credentials, installed dependencies or absolute temporary dependency symlinks
are committed. No remote Git push or package publication was performed.
