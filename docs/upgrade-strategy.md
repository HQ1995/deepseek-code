# Upgrade strategy

dscode = a forked grok-build TUI (our own code, in-repo) + a pinned
deepseek-harness submodule + the out-of-tree grok-leader bridge. The only
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
    deleted from our fork.
- Sync gate: fetch/diff -> port by hand -> cargo build --release ->
  fake-leader replay -> one real turn against deepseek-v4-flash. Only the
  green run counts. Wrap in scripts/update-tui.sh.
- Cadence: every upstream release, small batches. Upstream security fixes are
  cherry-picked on a fast path.

## Harness (deepseek-harness submodule) — pin and bump

- Pinned to our fork HQ1995/deepseek-harness at the commit recorded by the
  submodule pointer. Zero patches is the goal; the EMFILE watcher fix is the
  only known divergence until it is accepted upstream.
- Upgrade = advance the submodule SHA -> rebuild dsh from the submodule ->
  reinstall the bridge plugin -> rerun the bridge tests and one real turn.
  See docs/harness-updates.md for the runbook.

## Bridge (bridge/grok-leader)

- Owned by dscode, out-of-tree from the harness. It implements the leader
  protocol version the TUI speaks; the version handshake fails fast when an
  upstream TUI bumps the protocol, so a sync never silently half-breaks.
- Bridge tests are part of every sync gate on both sides.
