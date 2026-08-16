# Harness updates

How deepseek-harness upstream releases flow into this repository.

## Mechanism

The repo ships as one squashed initial commit, so there is no shared ancestry
with upstream. Updating the backend is a repeated unrelated-histories merge
(the conflict surface is exactly the divergence list below, verified small):

```sh
git fetch upstream main
git merge --allow-unrelated-histories --no-edit upstream/main
# resolve only the divergences below, then commit
```

The only conflicts are the places where this repo deliberately diverges. Keep
that list short and reviewed; everything else merges automatically. Long-term
target: move the bridge out of the fork entirely (out-of-tree plugin) so this
merge stops being necessary.

## Known divergences from upstream (review each when updating)

- `packages/boot/app-boot/src/index.ts` — watch-capacity degradation
  (EMFILE/ENOSPC watcher failures no longer kill the surface). Upstream may
  adopt an equivalent fix; prefer theirs over ours when it lands.
- `apps/cli/src/profile-boot.ts` — scoped uncaught-watch-capacity guard.
- `packages/bridge/` — deepseek-build's own grok-leader server (new packages,
  never conflicts).
- Root identity: `package.json` name `deepseek-build`, README header block
  (README.md + README.zh.md).
- `third_party/grok-build/` — vendored grok TUI (Apache-2.0), out of the
  harness tree entirely.

## Update checklist

1. `git fetch upstream main && git merge upstream/main`.
2. Resolve the divergences above (verify the EMFILE fix against the merged
   app-boot; if upstream fixed it differently, drop ours).
3. `pnpm install && pnpm run build:lib:host`.
4. Run the built-bin e2e and the bridge tests; re-run the TUI probe smoke.
5. If upstream's protocol expectations changed, re-check against
   `docs/grok-leader-protocol.md`.

## Compatibility contract (deepseek-build)

This repo is a TUI, not a harness fork feature set. The compatibility promise:

- The TUI (vendored grok-build, `third_party/`) never depends on harness internals;
  it only speaks the leader wire protocol (docs/grok-leader-protocol.md).
- The bridge (`packages/bridge/grok-leader`) is the only harness-side surface. Its
  target shape is an OUT-OF-TREE plugin installed with
  `dsh plugin --profile deepseek-leader add ...`, so a harness update is a
  package upgrade plus a re-test, not a rebase.
- Harness updates flow as a plain `git merge upstream/main` (ancestry is
  grafted at the real upstream commit 47f9438). The known divergence list above
  is the entire conflict surface; keep it from growing.

## Migration plan (out-of-tree bridge)

1. Enumerate the bridge's imports of internal harness packages (dsh-agent,
   dsh-session, dsh-llm, dsh-user-questions, dsh-user-approval,
   dsh-agent-default-model, dsh-agent-presets, dsh-session-persistence).
2. Pin each to its published npm peer surface; drop any non-published internal
   usage (or add a thin published wrapper).
3. Package the bridge standalone (pnpm project outside the workspace) with those
   peerDependencies; keep a `dsh.profile.bundles` profile definition.
4. Test `dsh plugin --profile deepseek-leader add <bridge>` against a pristine
   published `@deepseek-ai/dsh` install; the TUI is untouched.
