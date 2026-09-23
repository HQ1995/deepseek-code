# DSH capability candidate

## Port to DSH 0.1.7 — 2026-09-23

Branch **`dsh-capabilities-rc.1`**, rebased without conflicts onto the
`dsh-0.1.7-rc.1` adoption `b362cbc9` (source-built rc.1, commit `46a7f68b`,
patch `f3fe5695…`). It was first ported and accepted on alpha.2; the
verification below covers both runtimes. The 0.1.6 candidate
`candidate/dsh-capabilities` remains the historical record (below).

Bridge changes, active in every dscode profile:

| Commit | Behavior | Candidate origin |
| --- | --- | --- |
| `6399f3f8` | Resource-only MCP servers are no longer labelled disconnected; durable `image/offload` shows a system notice live, on replay and in paged child history | `a28655b` |
| `9a09f76b` | A cancelled prompt settles only after the native owner drains (for example, MCP browser cleanup); a failed drain rejects instead of reporting success | `7310a64` (bridge half) |
| `eafc3aa3` | `/doctor` reports an explicitly mounted Inspector with its DevTools URL and a full-debugger warning | `2160060` (bridge half) |

Opt-in bundles and keyless acceptance scripts under `experiments/`, referenced
by no dscode bundle, preset, launcher or release builder: `native-messages/`,
`teams/`, `ssh/`, `inspector/`, `playwright/` and `capabilities/`. Candidate
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
  66 files, 1,044 tests each; alpha.2 1,040 each. Ported queue tests fail
  without the drain fix (8 failures). `scripts/check-rust.sh` passes.
- Full installed TUI E2E with plugin and TUI rebuilt from this branch
  (`payload-cap`): rc.1 run **36271**, alpha.2 run **88800**, both PASS.
- Node 22.19.0 and 24.19.0, every keyless smoke on both runtimes
  (`control/cap-node22.sh`, `cap-node24.sh`). The Playwright smoke imports the
  compiled bridge, so build `bridge/grok-leader/lib/` first (`cap-playwright-*.log`):
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
