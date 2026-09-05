# Upgrade and release

`dscode` ships three versioned parts: the vendored Rust TUI, the
`grok-leader` bridge, and a pinned DSH runtime. A product release identifies one
complete tuple; never follow an unpinned `latest` runtime at user launch.

## TUI sync

The TUI lives in `third_party/grok-build` and is maintained as in-repo source,
not a submodule.

1. Run `scripts/update-tui.sh <upstream-ref>` to prepare a scratch diff.
2. Port selected upstream changes by hand; do not replace the tree wholesale.
3. Update `third_party/grok-build/UPSTREAM_REV`.
4. Record every local difference in
   `third_party/grok-build/TUI-DIVERGENCE.md`.
5. Build and run the full product suite.

Generic fixes should go upstream when practical. Remove their divergence entry
after the upstream baseline contains the fix.

## dsh runtime

The supported runtime is declared in `bridge/grok-leader/package.json`:

- `dsh.testedVersion`: exact runtime used by the launcher
- `dsh.supportedRange`: compatibility range for profile plugins
- `dsh.sourceCommit`: full upstream revision for a source-built SDK/runtime

To upgrade dsh:

1. bump the tested version and range when needed;
2. update the entire `@deepseek-ai/dsh-*` SDK family; update the registry lockfile
   only when that family is published, otherwise build the pinned source family;
3. mirror that pinned dsh dependency tree's Node floor in the launcher and npm
   metadata, but never install or switch the user's Node runtime;
4. rebuild the bridge and run the complete E2E suite;

The current source pin is `0.1.3-alpha.1` at
`d347e703908d0406b7a7ef80e3a0e594d86b2215`. The builder uses the official upstream
package build, compiles the bridge against that installed SDK, bundles ordinary
plugin dependencies without duplicating host peers, and packages the private
runtime including native helpers. Users install those artifacts, not unpublished
SDK packages from npm. Never mix SDK families or duplicate Cordis/service scope
identities.

Source-runtime descriptors record the source revision, DSH version, platform,
and architecture; the launcher validates them and the CLI/native helper before
activation. An explicit `DSH_BIN` must report the exact pin. Registry-backed
releases may reuse an exact PATH runtime. Neither path upgrades a global install.

Stable, beta, and alpha are independent product channels. Beta and alpha each
include their own prereleases plus stable releases. Unmarked historical
`channel = "alpha"` resolves beta; canonical settings carry `channel_format = 1`.
Checks never write that migration. The installer commits the channel only after
the exact tuple is ready, restoring moved entries after ordinary commit errors.

## Bridge changes

- Keep `docs/grok-leader-protocol.md`, the captured handshake fixture, and
  codec/socket tests in sync with wire changes.
- Fail fast on protocol-version mismatches and unsupported CLI metadata.
- After local bridge edits, run `scripts/update-bridge.sh` before manual TUI
  testing; a live leader keeps its already-loaded code until the last client
  exits.

## Validation matrix

```sh
scripts/check.sh
scripts/e2e-product.sh
scripts/e2e-product.sh --full --provider-ui
scripts/e2e-release-lifecycle.sh
node scripts/e2e-update-channels.mjs --plugin dist/dscode-plugin.tgz \
  --runtime dist/dscode-runtime-linux-x86_64.tar.gz --tui dist/dscode-linux-x86_64
```

CI runs script, bridge, and Rust checks on Ubuntu and macOS. Tagged releases
build `dscode-linux-x86_64` and `dscode-macos-aarch64` in
`.github/workflows/release.yml`.

## Release

1. Keep `VERSION` and `bridge/grok-leader/package.json` versions equal.
2. Start with `scripts/release.sh --dry-run` and inspect the staged binaries,
   checksums, plugin tarball, license bundle, and version banner. Reuse an exact
   source checkout/SDK consumer via `DSCODE_SOURCE_DIR` and `DSCODE_RUNTIME_CONSUMER`.
3. Commit a clean tree, then run `scripts/release.sh`.
4. Wait for both platforms' TUI assets and, for source releases, runtime archives
   and checksums, plus the plugin and its checksum, before making the release public.
5. Stable publishes to npm `latest`; beta and alpha use their matching npm tags
   and GitHub prereleases. Release selection never treats alpha as beta.
