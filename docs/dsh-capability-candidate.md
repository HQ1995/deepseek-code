# DSH capability candidate — 2026-09-15

Implemented and locally preserved on **`candidate/dsh-capabilities`**:

- `a28655b`: resource-only MCP status and durable image-offload system notices,
  including paged child history.
- `74be939`: explicit native Messages/Files, isolated Teams profile, remote SSH
  filesystem/subprocess/sandbox/PTC composition and reproducible acceptance scripts.

The branch is imported into this repository; its original working copy is
`/tmp/dscode-alpha16.c6NG8h/product`. Full details are committed on that branch:

```sh
git show candidate/dsh-capabilities:docs/dsh-capability-acceptance.md
```

Node 22.19.0 and 24.19.0 each passed the source-built release-SDK bridge suite:
**929 passed, 4 compiled-CLI tests skipped**. Pager coverage: 137 MCP/extensions
tests plus the new child-history notice test. Both Node versions passed native
MCP Resources/PTC, Messages/Files/offload persistence, native Teams lifecycle and
installed Teams catalog/turn tests.

The user-approved **swoop** directories were used for real remote filesystem,
read-only enforcement, PTC, subprocess, PTY, cancellation, abrupt transport-loss
cleanup and installed headless → native Messages → remote bash acceptance.
Incorrect helper/bootstrap hashes were rejected. The test workspace is empty;
two earlier fixture files are recoverably retained under the isolated runtime's
`acceptance-artifacts/`. No existing remote project or daily installation changed.

**Not merged into the main runtime pin or released:** interactive SSH TUI paths
still need adaptation; the earlier Playwright cancellation promotion gate remains
red; Auto review/Inspector remain deferred. Teams has native tools/state but no
new task-board UI, file locking or automatic conflict resolution. This candidate
is not a claim of complete production support for every experimental DSH feature.

Backup: `.git/integration-backups/dsh-capabilities-74be939.bundle`, verified by
`git bundle verify`. It requires the already-present base `db43b24`.
SHA-256: `43e412e008d19c88cf41014fae696564329dd10745fbf4689d4ddd87164bc90c`.
No credentials, installed dependencies or absolute temporary dependency symlinks
are committed. No remote Git push or package publication was performed.
