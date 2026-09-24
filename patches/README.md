# Source runtime backports

The release manifest pins the official DSH commit and, when present, the SHA-256
of `dsh-<sourceCommit>.patch` in this directory. The builder verifies the clean
base and patch bytes, applies the patch in its own temporary clone, then runs
the official source build. It never patches an installed runtime or the source
checkout passed with `--source`. Only the patch for the pinned commit lives
here; earlier backports are in Git history.

`sourcePatchSha256` is part of consumer provenance, the runtime descriptor and
installed-package matching. Unpatched and differently patched consumers are not
reusable, even if their DSH versions and upstream commits match. To regenerate
a consumer, select a new `--consumer` directory; do not relabel an old one.

The current `46a7f68b...` backport reads macOS kernel process observations
through the existing Koffi dependency instead of spawning `ps`. Full tree scans
remain fresh; identity and foreground queries select one PID. Failed/partial
reads throw, and pre-signal checks retain second-precision identities without a
cache. The patch includes regression tests, a two-architecture SDK layout
oracle, paired README contracts and decision notes. No native helper artifact is
added. See [performance evidence](../docs/performance.md).

The JSONL change extracts its historical-restore construction into one private
instance method. The bridge wraps it only for the two legacy model-selection
names, preserving native child facts, validation and V4 publication.

The Settings change exposes `ready`, a promise for Loader startup and the
one-time legacy settings import. Initial model-catalog consumers await it
outside plugin activation. Import document I/O failures reject the promise;
individual rejected settings sections retain native diagnostics and archival
behavior. This prevents a first-launch catalog from racing imported providers.

The config-editor change composes inherited form bases once per settings
`describe()`: every entry without its own profile configuration shares one
composition of the profile layers and patches, and only entries with a profile
override compose separately. Upstream composed once per active entry, which
dominated `describe()` (about 40ms of each 44ms call on a 108-entry dscode
profile) and blocked the leader for every catalog, preset and settings read.
The results are identical: removing a config key an entry's patches do not
carry leaves the patch list unchanged. A settings test pins the composition
count; the existing inheritance, reset, group and secret tests cover values.

Earlier revisions also carried a Linux scope-settlement correction; it is
upstream since `0.1.6-alpha.2`, so the backport no longer touches Linux. The
patch moved from `0.1.7-alpha.1` through `0.1.7-alpha.2` to `46a7f68b...`
(`0.1.7-rc.1`) with no source, test or decision-note changes (only README
context); the rc.1 bytes, and so `sourcePatchSha256`, equal alpha.2's. Settings readiness, the macOS
kernel process table, the JSONL helper extraction and the shared config-editor
composition are still not upstream. The rc.1 Linux acceptance is recorded in
[the DSH 0.1.7 adaptation](../docs/dsh-upstream-refresh-2026-09-22.md#linux-acceptance)
and is re-run for every payload that bumps the runtime.

When upgrading the upstream source, review whether the change is already
included. Remove the patch digest if it is; otherwise rebase the source change,
regenerate and review the patch, update its digest, rebuild both platform
payloads and repeat the relevant acceptance tests. A matching version string
alone is not proof that the backport is present.
