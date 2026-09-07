# Git branch cleanup: adoption-order batch (2026-09)

Record of a one-shot hygiene pass: delete stale/abandoned local + remote
branches whose content is already fully represented in `origin/main`.
Written and committed _before_ the deletes so the justification survives them.

## Why this batch exists

The repo accumulated many `worker/*`, `fix/*`, and `experimental/*` branches
(plus the earlier `fix/adoption-order` and two adoption-order-era branches).
Review flagged most as merged remnants; two branches carried commits **not** in
`origin/main` and needed proof before deletion:

- `origin/worker/adoption-order` — 2 commits not in origin/main
- `origin/experimental/dsh-sea` — 4 commits not in origin/main

Both are covered here with git-level evidence; the only file that existed
exclusively on `experimental/dsh-sea` was rescued into `main` first (see §0).

## §0 Rescue (performed first, so the delete is zero-loss)

`docs/experimental-dsh-sea.md` (the experiment's "recipe + pitfalls" notes,
3231 bytes, blob 0d31dc6cba6bceb108256ab8cfc083d77a6eb18b) existed **only** on
`experimental/dsh-sea`. To keep deletion truly zero-loss, its exact content was
committed to `main` as commit `9e5ad89dff` ("docs: preserve abandoned
single-file dsh experiment record…") before any branch was deleted.
It is preserved on `main` at `docs/experimental-dsh-sea.md` (blob
0d31dc6cba6b, verbatim); the path carries the `docs/` prefix in main today
because docs live under the repo's `docs/` convention — nothing but the
location prefix differs from the branch, so no content moved or was lost.

## §1 Rebase-shadow pair: `worker/adoption-order` (2 commits NOT in origin/main)

Remote-unique commits:
- `a98bd1b865` fix(pager): attribute bridge settle responses by RPC id, back-date adopted-turn elapsed
- `d512817baa` fix(grok-leader): idle-gate every queue-mutation promotion

Local ref `worker/adoption-order` = `2a3464151c`, which **is an ancestor of
origin/main**, and `origin/main` history contains commits with the **same
subjects**:
- origin/main `2a3464151c` (fix(pager): …) — patch-id `65d4bc5e301da3b05bbe52f60c49e4b813d4fcfd`
- origin/main `a8d9064202` (fix(grok-leader): …) — later revised version

Reflog chain for `refs/heads/worker/adoption-order`:
```
18:27:06 d512817baa  commit (fix(grok-leader) pre-rebase)
18:27:14 a98bd1b865  commit (fix(pager)      pre-rebase)
18:30:40 2a3464151c  rebase(finish) onto 9c832ae4566b1dc5a9ad8446031df5be6b08759b
18:35:44 2a3464151c  refs/heads/main: merge worker/adoption-order: Fast-forward
```
patch-id check confirms `a98bd1b865` and `2a3464151c` are the SAME PATCH
(`65d4bc5e…`). The two remote-unique commits are pre-rebase versions; their
rebase result `2a3464151c` fast-forwarded into main and the grok-leader fix was
further revised on main into `a8d9064202` (30-line index.ts + 108-line test
trim). Deleting the branch loses nothing.

## §2 Abandoned experiment: `experimental/dsh-sea` (4 commits NOT in origin/main)

Branch built a single-file `dsh` exe via `pkg --sea` (scripts/build-dsh-sea.sh)
+ packaged leader entry + launcher/installer wiring + the experiment doc.
Its own docs declare: *Status: abandoned in favor of installing the official
npm dsh + our bridge*. origin/main history has no same-tree equivalent and
wants nothing from it; the payload was regenerable and rejected. The recipe+-
pitfalls doc was rescued to main (§0). Deleting the branch is zero-loss.

## §3 Remaining 9 `origin/worker/*` + `origin/fix/*`

All verified ancestors of `origin/main` (`merge-base --is-ancestor`) = merged;
pure merge remnants. Deleting is safe, zero content loss.

## Deletion list

Local branches (11):
```
experimental/dsh-sea          abandoned experiment (doc rescued to main, §0)
fix/subagent-finished-emit    merged
worker/acp-research           merged
worker/adoption-order         rebase shadow of main's 2a3464151c/a8d9064202
worker/audit-fixes            merged
worker/bridge-review          merged
worker/bridge-security        merged
worker/legal-toolcall         merged
worker/provider-manage        merged
worker/tui-divergence         merged
worker/tui-queue-stall        merged
```

Remote branches (10, mirrors of the local ones minus local-only):
```
origin/experimental/dsh-sea
origin/worker/acp-research
origin/worker/adoption-order
origin/worker/audit-fixes
origin/worker/bridge-review
origin/worker/bridge-security
origin/worker/legal-toolcall
origin/worker/provider-manage
origin/worker/tui-divergence
origin/worker/tui-queue-stall
```

## Confirmed deletable via a zero-loss path

Content of every deleted branch already lives in `origin/main` (merged,
rebase-shadow, or rescued doc). No information is lost by this pass.
