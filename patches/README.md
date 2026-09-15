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

When upgrading the upstream source, review whether the change is already
included. Remove the patch digest if it is; otherwise rebase the source change,
regenerate and review the patch, update its digest, rebuild both platform
payloads and repeat the relevant acceptance tests. A matching version string
alone is not proof that the backport is present.
