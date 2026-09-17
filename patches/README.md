# Source runtime backports

The release manifest pins the official DSH commit and, when present, the SHA-256
of `dsh-<sourceCommit>.patch` in this directory. The builder verifies the clean
base and patch bytes, applies the patch in its own temporary clone, then runs
the official source build. It never patches an installed runtime or the source
checkout passed with `--source`.

`sourcePatchSha256` is part of consumer provenance, the runtime descriptor and
installed-package matching. Unpatched and differently patched consumers are not
reusable, even if their DSH versions and upstream commits match. To regenerate
a consumer, select a new `--consumer` directory; do not relabel an old one.

The current `fb2c4b9e...` backport reads macOS kernel process observations through
the existing Koffi dependency instead of spawning `ps`. Full tree scans remain
fresh; identity and foreground queries select one PID. Failed/partial reads
throw, and pre-signal checks retain second-precision identities without a cache.
The patch includes regression tests, a two-architecture SDK layout oracle,
paired README contracts and decision notes. No native helper artifact is added.
See [performance evidence](../docs/performance.md).

The same patch carries the Linux scope-settlement correction in
`subprocess-local/src/linux-scope.ts` and its PTY binding in `src/index.ts`.
A requested termination observed before the launch request is consumed resolves
as cancellation; genuine startup failures and signal-delivery failures still
reject. An empty but active scope owned by the terminated client settles and is
released best-effort, a state observation invalidated by a termination signal is
discarded and re-queried, and the final scope signal waits once for acknowledged
direct settlement. A new early-bootstrap test fixture and the authored
`bash-startup-timeout` recorded session accompany the change. This half is not
an upstream-adopted pin either: it is a local backport whose real user-systemd
acceptance is recorded in
[the combined Linux settlement acceptance](../docs/linux-acceptance-2026-09-17.md).

When upgrading the upstream source, review whether the change is already
included. Remove the patch digest if it is; otherwise rebase the source change,
regenerate and review the patch, update its digest, rebuild both platform
payloads and repeat the relevant acceptance tests. A matching version string
alone is not proof that the backport is present.
