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

Then rebuild and reinstall. The installer does this for a release tag; a manual
bump needs the same three steps:

```sh
( cd deepseek-harness && CI=true pnpm install --frozen-lockfile && pnpm run build:lib:host )
( cd bridge/grok-leader && pnpm install && pnpm run build )
dsh plugin --profile deepseek-leader add bridge/grok-leader
```

## Why the fork (not npm)

The launcher builds dsh from the submodule, not npm, because the published
`@deepseek-ai/dsh-*` 0.1.0-rc.6 set lacks the EMFILE/ENOSPC watch-capacity
degradation and its `latest` tags are incoherent across the package set. The
fork carries that fix; see the divergence list below.

## Fork divergences from upstream (review each fork update)

- `packages/boot/app-boot/src/index.ts` — watch-capacity degradation
  (`isWatchCapacityError`, `installUncaughtWatchCapacityGuard`, EMFILE/ENOSPC
  swallow in `watchUserPatches`/`installFailLoud`). Prefer an equivalent
  upstream fix when one lands.
- `apps/cli/src/profile-boot.ts` — scoped uncaught-watch-capacity guard around
  the watcher setup window.
- `packages/boot/app-boot/src/profile.ts` — `deepseek-leader` profile template
  (`@deepseek-ai/dsh-base` only; the grok-leader bridge is out-of-tree).
- `.agents/notes/implemented/bug-fix/2026-08-15-watch-capacity-degrades-hot-reload.*`
  — the agent note for the watch-capacity fix.

## Compatibility contract

- The TUI (`third_party/grok-build/`, vendored grok-build, Apache-2.0) only
  speaks the leader wire protocol (`docs/grok-leader-protocol.md`); it never
  depends on harness internals.
- The bridge (`bridge/grok-leader/`) is the only harness-side surface. It is an
  out-of-tree plugin installed with
  `dsh plugin --profile deepseek-leader add bridge/grok-leader`, and it resolves
  every `@deepseek-ai/dsh-*` peer from the built submodule tree (not npm), so
  the bridge and the dsh CLI share one build.
- After a submodule bump, re-run the built-bin e2e (`scripts/e2e-deepseek.sh`)
  and the bridge tests; if the protocol changed, re-check
  `docs/grok-leader-protocol.md`.
