# DSH capability candidate — 2026-09-15

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
