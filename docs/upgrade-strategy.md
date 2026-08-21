# Upgrade and release

`dscode` ships three versioned parts: the vendored Rust TUI, the
`grok-leader` bridge, and a tested npm `dsh` runtime. Upgrade them deliberately;
never follow an unpinned `latest` runtime at user launch.

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

To upgrade dsh:

1. bump the tested version and range when needed;
2. update the `@deepseek-ai/dsh-*` development dependencies and lockfile;
3. mirror that pinned dsh dependency tree's Node floor in the launcher and npm
   metadata, but never install or switch the user's Node runtime;
4. rebuild the bridge and run the complete E2E suite;
5. update launcher arguments only if the dsh CLI contract changed.

The launcher may reuse an exact matching `dsh` from `PATH`; otherwise it owns a
private runtime under the dscode profile. It never upgrades a global install.

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
```

CI runs script, bridge, and Rust checks on Ubuntu and macOS. Tagged releases
build `dscode-linux-x86_64` and `dscode-macos-aarch64` in
`.github/workflows/release.yml`.

## Release

1. Keep `VERSION` and `bridge/grok-leader/package.json` versions equal.
2. Start with `scripts/release.sh --dry-run` and inspect the staged binaries,
   checksums, plugin tarball, license bundle, and version banner.
3. Commit a clean tree, then run `scripts/release.sh`.
4. Wait for both platform assets before publishing the release and npm package.
