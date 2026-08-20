# Upgrade strategy

dscode = a vendored/modified grok-build TUI (our code, in-repo) + the
out-of-tree grok-leader bridge + the official npm dsh runtime. The only
contract between TUI and harness is the grok leader protocol
(docs/grok-leader-protocol.md) plus its version handshake. Each side upgrades
through its own pipeline; the other side does not change.

## TUI (third_party/grok-build) — selective manual sync

- The vendored code is OUR code. We edit it in place; there is no subtree,
  no submodule, no upstream remote for it.
- Upstream sync is manual and selective: clone the new upstream release to a
  scratch dir, diff it against third_party/grok-build, and port what we want.
- Never touch upstream's core engine (rendering, input, mouse, scroll) unless
  there is a product reason; our edits stay in branding, leader mode, icons,
  slash commands, and preset defaults.
- Record keeping:
  - third_party/grok-build/UPSTREAM_REV — the upstream commit we last synced
    from (determines the diff window for the next sync).
  - third_party/grok-build/TUI-DIVERGENCE.md — every change we made, the file,
    the reason, and its class (patch / feature / branding). Patches that fix
    generic bugs should be offered upstream; accepted upstream patches get
    removed from our divergence list.
- Sync gate: fetch/diff -> port by hand -> cargo build --release ->
  fake-leader replay -> one real turn against deepseek-v4-flash. Only the
  green run counts. Wrap in scripts/update-tui.sh.
- Cadence: every upstream release, small batches. Upstream security fixes are
  cherry-picked on a fast path.

## dsh npm release — pin and bump

- End-user installs use the official npm dsh, pinned to the exact version
  recorded in `bridge/grok-leader/package.json` -> `dsh.testedVersion`
  (currently `0.1.0-rc.8`).
- The same manifest also records `dsh.supportedRange`
  (`>=0.1.0-rc.8 <0.2.0`): versions in that range are allowed to run, while
  `testedVersion` is the one we actually validated in CI.
- Do not switch `scripts/install.sh` or the launcher back to `@next`/`latest`.
  A dsh upgrade is a deliberate release step:
  1. bump `dsh.testedVersion`;
  2. run the bridge test suite and the dscode e2e suites;
  3. update the launcher/installer if the CLI invocation changes;
  4. cut a new dscode release.

## Linux and macOS

Sit on one machine. Do not bounce Linux/macOS for every change.

Portable by construction: the TUI is Rust (`cfg!(target_os)`), the launcher
maps `process.platform` to a GitHub asset, and `scripts/platform.sh` hides
`sha256sum` vs `shasum` / GNU vs BSD `stat`. `numactl` is optional host
policy, never required.

CI is the other OS:
- `.github/workflows/ci.yml` — every PR, Ubuntu + macOS: script smoke +
  bridge vitest. Run the same locally with `bash scripts/check.sh`.
- `.github/workflows/release.yml` — tags only: compile both TUI binaries.

Eyeball the TUI on the other OS only when you change startup, install, or
the leader spawn path.

## Bridge (bridge/grok-leader)

- Owned by dscode, out-of-tree from the harness. It implements the leader
  protocol version the TUI speaks; the version handshake fails fast when an
  upstream TUI bumps the protocol, so a sync never silently half-breaks.
- Bridge tests are part of every sync gate on both sides.
