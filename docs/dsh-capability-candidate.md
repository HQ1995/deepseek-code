# DSH capability candidate

## UX audit — 2026-09-24

A hands-on audit of the four integrated features in a real TUI (a scripted
loopback model, real Chrome, and swoop over SSH) found problems that blocked or
misled users. Commit `d83b56ec` fixes them, `6f80fb80` trims what the approval
recorder keeps, and `62e9b7b6` updates the contract E2E for the renamed preset:

- **Browser:** approvals now name the action and list its arguments. In
  always-approve mode, DSH's `danger-full-access` preset had rejected every
  browser call silently; the plugin now refuses with a reason, and the TUI
  never auto-approves a browser prompt. An origin added after a session
  started is refused with that reason instead of `net::ERR_BLOCKED_BY_CLIENT`.
  The 11 always-refused tools leave the model's list, results lose private
  paths and colour codes, and `/browser` replies render line by line.
- **Teams:** `/team` renders line by line with teammate ids, and `/subagents`
  takes teammate names. A preset pick for a session with history opens a new
  session instead of blanking the transcript. Children stay out of `/resume`,
  settled children stop counting in `/tasks`, and `/btw` explains its refusal.
- **Remote workspace:** `dscode remote init --dsh DIR` takes the digests from
  this dscode's runtime and checks the host before writing. A failed or lost
  connection refuses turns with the reason and the next step, and a broken
  leader exits at once so a restart reconnects. The header shows
  `ssh HOST:PATH`, and `@` explains why nothing completes.
- **Provider:** the native DeepSeek template sits beside the
  OpenAI-compatible one, with a distinct name and fixed fields. After the
  first provider, the toast and footer point to `/model`.

### Verification

**macOS arm64** (rc.1 runtime, evidence root `/Users/hqzhao/AI/dsh-rc171/run-20260923`):
- The same scenarios by hand in tmux, against a scripted loopback model, real
  Chrome and swoop. Each fix was checked in the new TUI, including a dropped
  SSH master and an unreachable host.
- Bridge suite on Node 24.19.0 and 22.19.0: 71 files, 1,120 tests each (4
  compiled-CLI skips). `scripts/check-rust.sh` passes. The full pager suite
  fails the same 49 upstream tests as before these changes (one timing test
  passes alone).
- `control/int-verify-all.sh s3` on both Node versions:
  - the SDK and installed browser smokes, the Teams smoke and the Inspector
    smoke;
  - the browser and Teams negative controls, which failed at the
    outside-origin and isolation checks.
- Provider E2E run **3040** and full TUI E2E run **94902**, the latter after
  `62e9b7b6`.
- Remote workspace against swoop: `e2e-remote-installed.mjs` and
  `e2e-remote-tui.mjs` pass. `dscode remote init` refused a missing package
  directory (with the install command), a missing workspace and an unknown
  host, and accepted the rc.1 directory.

**Linux** (swoop, the same isolation as before). Pass 4 at `62e9b7b6` ran all
15 gates, and all passed:
- the bundle update and the plugin build;
- on each Node version: bridge suites (1,124 tests, compiled-CLI tests
  included), script tests and the native provider E2E;
- on each Node version: the browser smokes and the Teams smoke, whose negative
  controls failed as designed;
- the TUI build, provider E2E run **638558** and full TUI E2E run **642755**.

Pass 3 at `d83b56ec` passed every gate but the full TUI E2E, which still
expected the old Teams preset label.

### Follow-up

Three commits resolve the audit's leftovers and what re-testing them found:
- `6c003140`: the welcome menu is built from one list that rendering, the row
  count and Enter/click dispatch all read. "New worktree" and Ctrl+W appear
  only in a git checkout on this computer that is not a remote workspace;
  before, the row opened the name dialog and then failed. The remote welcome
  bar also stops showing the launch directory's branch and worktree badge.
- `ebfc330c`: the bridge describes the native Flash model, which DSH lists
  without a description. The native route is now "DeepSeek (native)": the
  longer name had pushed the Flash row past the picker's 40-column label cap,
  which cut it to "DeepSeek-V41-F…". `/model` also drops the provider prefix
  when only one provider has models.
- `15861549`: a teammate spawn reads "Ran 1 teammate", not "Ran 1 subagent".

Each was checked in the TUI lab: from a git checkout (row shown), from a
directory outside git and a remote home (row and branch hidden), in the
first `/model` pick, and on a Teams spawn.

**macOS arm64:**
- The full pager suite fails the same 49 upstream tests as the baseline, none
  new, and `scripts/check-rust.sh` passes.
- `control/int-verify-all.sh s4` passes every gate on both Node versions.
  Bridge suites run 1,120 tests each. The browser and Teams negative controls
  fail at their outside-origin and isolation checks.
- Provider E2E run **76188** and full TUI E2E run **77175**.

**Linux:** pass 5 at `15861549` ran all 15 gates, and all passed. Bridge
suites ran 1,124 tests on each Node version. Provider E2E run **1122288** and
full TUI E2E run **1129433**.

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
