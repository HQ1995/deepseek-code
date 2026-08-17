# Harness updates

The DeepSeek Harness backend lives in the `deepseek-harness/` git submodule,
pinned to a commit on the `HQ1995/deepseek-harness` fork. This repo carries no
harness source; an upgrade is a pointer bump plus a rebuild.

## Mechanism

The fork is a clone of `deepseek-ai/deepseek-harness` plus the dscode patches
listed below. Updating the backend is two moves:

1. Update the fork: clone it, `git merge upstream/main`, resolve the
   divergence list, push a new fork commit.
2. Bump the pointer here:

```sh
git submodule update --remote deepseek-harness
git add deepseek-harness
git commit -m "chore: bump deepseek-harness submodule"
```

Then re-run `bash scripts/install.sh` — it rebuilds and re-registers the
bridge against the official npm dsh.

## Why the fork exists

Installation uses the official npm dsh (`@deepseek-ai/dsh@next`); the fork is
never built or required by `scripts/install.sh`. It stays because the
published 0.1.0-rc.6 set lacks the EMFILE/ENOSPC watch-capacity degradation,
and the fork tracks that fix for an upstream PR; see the divergence list
below.
## Fork divergences from upstream (review each fork update)

- `packages/boot/app-boot/src/index.ts` — watch-capacity degradation
  (`isWatchCapacityError`, `installUncaughtWatchCapacityGuard`, EMFILE/ENOSPC
  swallow in `watchUserPatches`/`installFailLoud`). Prefer an equivalent
  upstream fix when one lands.
- `apps/cli/src/profile-boot.ts` — scoped uncaught-watch-capacity guard around
  the watcher setup window.
- `packages/boot/app-boot/src/profile.ts` — `deepseek-leader` profile template
  (`@deepseek-ai/dsh-base` only; the grok-leader bridge is out-of-tree).
  Note: the official npm dsh does not ship this template; `scripts/install.sh`
  creates the same composition through the profile plugin mechanism.
- `.agents/notes/implemented/bug-fix/2026-08-15-watch-capacity-degrades-hot-reload.*`
  — the agent note for the watch-capacity fix.

## Compatibility contract

- The TUI (`third_party/grok-build/`, vendored grok-build, Apache-2.0) only
  speaks the leader wire protocol (`docs/grok-leader-protocol.md`); it never
  depends on harness internals.
- The bridge (`bridge/grok-leader/`) is the only harness-side surface. It is
  an out-of-tree plugin installed with
  `dsh plugin --profile deepseek-leader add file:<repo>/bridge/grok-leader`;
  it resolves its `@deepseek-ai/dsh-*` peers at the same pinned 0.1.0-rc.6
  line the npm dsh ships (installed as devDependencies for the standalone
  tsc build).
- After a submodule bump, re-run the TUI e2e suites (`scripts/e2e-add-provider.sh`, `scripts/e2e-provider-manage.sh`)
  and the bridge tests; if the protocol changed, re-check
  `docs/grok-leader-protocol.md`.
