# Performance work

This pass covers macOS terminal CPU and latency, long-session/streaming work,
startup, and runtime/package footprint.
Changes must preserve cancellation, ownership checks, stream ordering,
durable history and the full product loop. A fast isolated benchmark alone
does not establish overall application performance.

## 2026-09-23: a settings read no longer recomposes the profile once per plugin

A CPU profile of the full installed TUI/headless E2E on the DSH 0.1.7-alpha.2
tuple ranked two runtime functions above module compilation, the previous top
item: `inherited` in `dsh-config-editor` (15.3s, 11.8% of leader non-idle
samples) and `structuredClone` beneath it (11.0s, 8.5%). Both sit under
`settings.describe()`. For every active plugin entry, the config editor
recomposed all bundle layers and profile patches to find that entry's
inherited configuration, and cloned the result. Across every profiled process,
`describe()` was 33.8s, 21.8% of all non-idle CPU in the run; `inherited()` was
29.4s of it.

The bridge called `describe()` for the `llm-pi-ai` provider section on every
catalog refresh, discovery check and discovery write. An instrumented plugin
recorded 327 such calls across the run's 52 leader processes, each blocking the
leader's event loop for a median of 43.9ms (p90 60.4ms): 14.9s in total, about
287ms per leader, much of it during startup and model listing.

Two changes remove it:

- **Runtime backport** (`dsh-config-editor`, in
  `patches/dsh-00102833….patch`): every entry without its own profile
  configuration shares one composition, and only entries with a profile
  override compose separately. Stripping a config key an entry's patches do not
  carry leaves the patch list unchanged, so the values are identical. On a real
  108-entry dscode profile with three overrides, inheritance for all entries
  took 39.6ms upstream and 1.4ms shared, with no mismatch across the 108
  entries (`perf/inherited-bench.mjs`). A settings test pins one shared
  composition plus one per override. The existing inheritance, reset, group
  and inherited-secret tests pass unchanged.
- **Bridge**: the model catalog keeps one snapshot of the provider section
  for display reads (`refreshCatalog`, `scheduleDynamicCatalogRefresh`). It is
  keyed on the settings instance beneath the Cordis lookup wrappers and dropped
  on `settings/document-updated` for `llm-pi-ai`, on `app-boot/config-reload`,
  and after every write of its own. Writes, unshared-credential cleanup and the
  guard that forwards a resolved secret only to an already persisted endpoint
  still read fresh. An absent section is never kept.

| Full E2E, 52 leaders | Bridge `describe()` calls | Median per call | Total blocked | Per leader |
| --- | ---: | ---: | ---: | ---: |
| Before | 327 | 43.9ms | 14.9s | 287ms |
| Bridge snapshot only | 160 | 55.5ms | 9.9s | 190ms |
| Snapshot and runtime backport | 160 | 5.5ms | 0.96s | 18ms |

Profiled whole runs, before and after: non-idle samples across all Node
processes fell from 154.6s to 96.2s, and in leader processes from 129.4s to
77.1s. `describe()` fell from 33.8s (21.8%) to 3.1s (3.2%). The leader's top
frames are now module compilation, GC and Cordis service lookups. File writes
in the profile come from the test-only E2E observer. These figures are sampled
CPU from one host (macOS arm64, Node 24.19.0) running a mock model, not a
general daily-use percentage or wall-clock speedup.

Evidence is under `/Users/hqzhao/AI/dsh-alpha172/run-20260922/perf`: the
profiles `profiles-base/` and `profiles-v2/` with their summaries, the
instrumented call logs `describe-calls{,-after,-v2}.jsonl`, and the caller and
inclusive-time scripts. The instrumented plugins were scratch builds and were
never installed or committed. Verification results are recorded below.

### Verification for this section

- Source backport: settings suites 5 files, 42 passed (including the new
  composition-count test, which failed with 5 compositions before the change);
  the app-boot, settings-controller and speech-to-text suites that use the
  editor, 18 files, 5463 passed, 1 skipped; 20 documentation gates passed. The
  runtime was rebuilt from the pinned source with the new patch digest
  `f3fe5695ed2260428f2fe45108650144ba583d62b6371545838af765d10b71b0`
  (`payload-v2/`, consumer `consumer-v2/`); the official `build:official`
  typecheck passed.
- Bridge: four catalog interface tests (shared display reads and every
  invalidation signal, keying through stacked lookup wrappers and a replaced
  instance, fresh write paths, no cached absence) and one socket test of the
  event wiring. The socket test fails without the wiring. Full suites on the
  patched runtime: Node 24.19.0 and 22.19.0, 66 files, 1034 passed each.
- Installed product on payload v2 (macOS): managed update, provider UI (run
  12602), 15 update-channel cases and the full TUI/headless E2E (run 15211)
  passed. The profiled run (79319) also passed. The payload audit
  (`payload-v2-audit.json`) matched sidecars, the runtime descriptor and 61
  packed bridge files. Consumer provenance, `scripts/check.sh` and
  `git diff --check` passed.
- The changed runtime has not been through Linux acceptance. Its backport
  touches only platform-independent configuration code, but the project repeats
  acceptance for every runtime payload change, and swoop needs its own approval.

## 2026-09-20: both spellings of the profile in the update lane, and a launcher that outwaits a hidden one

A review pass over this checkout's working tree, before it was committed, found
two defects in the update lane and a set of bridge contract gaps. The launcher
one is why this section exists: the tree had an unguarded
`realpathSync(profile)` inside `bin/bootstrap.mjs`'s 60-second retry loop, so a
profile that an in-flight directory swap had hidden for a moment ended the
launcher instead of being outwaited — `dscode: ENOENT: no such file or
directory, lstat '<profile>'`, exit 1, and the retry loop the entrypoint exists
for never ran. A/B against an absent profile (`/tmp/dscode-probe-20260920/`;
`probe2.mjs` runs both variants, `bootstrap-regressed.mjs` and
`bootstrap-fixed.mjs`): the unguarded variant exits 1 after 24ms with that
message, while the fixed variant is still retrying when the 5s probe kills it —
the same behaviour the committed entrypoint has. The fix keeps the unresolved
spelling as the fallback (`let canonical = profile; try { canonical =
canonicalProfile() } catch {}`), where `canonicalProfile()` resolves the
profile when it exists and otherwise resolves its parent and re-joins the
basename, and the stage scan covers both spellings of the parent, deduped, so
the retry window is intact either way.

The updater had the mirror-image bug. `installationStages(profile)` scanned
`dirname(profile)` while comparing `transaction.profile` against the canonical
profile, and `installRelease` staged beside `dirname(profile)` while journaling
the canonical spelling. Where those two spellings differ — a profile reached
through a symlink, or macOS's `/var` against `/private/var` for the same
directory — a stage written beside one was invisible to the scan of the other,
so an interrupted update was never recovered, and a stage reachable under both
was recovered twice, the second rollback retrying against a backup the first
had already moved away. `installationStages` now resolves both spellings of the
parent, dedupes stages by `realpathSync(stage, { throwIfNoEntry: false })`, and
`installRelease` stages beside `dirname(canonical)` (creating it) with the
canonical profile in the journal, so the journal, the scan and the stage agree
on one spelling. Negative proof: the new `recovers an interrupted update when
the profile path is a symlink in another directory` fails on the committed
`bin/` — 1 failed | 25 passed, `doctor --runtime --json` exiting 1 with
`Cannot find module .../symlink-parent/active/node_modules/@hqzhao95/dscode/bin/dscode.mjs`,
i.e. the stage beside the link's parent was never recovered — and passes on the
fixed tree (26 passed). That test also pins that a sibling `.dscode-update-`
directory whose journal is not ours is left byte-for-byte alone.

The bridge gaps the same pass found, each with its spec:

- `src/mcp.ts` derived a server name with `/^mcp__([A-Za-z0-9_-]+)__(.+)$/`
  and invented a server for every tool whose name matched but no fiber owned.
  `mcp__team__tools__list` was split off the mounted `team`, and an unmounted
  name was listed as a server that does not exist. Tools are now attributed to
  the longest mounted `serverName` that prefixes them (`team__tools` beats
  `team`) and a tool no fiber claims is dropped rather than listed.
- `src/session-input.ts`: `session/cancel` cancelled the queue and the goal but
  not a composer request that had not reached the queue yet, which is exactly
  the window a prompt-targeted cancel already covered. It now aborts every
  unqueued request for the session.
- `src/session-lifecycle.ts`: `fork` read a malformed `targetPromptIndex`
  (non-integer, or a string) as absent and copied the whole source history,
  and read a relative `newCwd` as absent and silently inherited the source
  workspace. Both are now rejected with `invalidParams` when supplied.
- `src/session-presets.ts`: the live preset switch appended the selection and
  then flushed outside the `try`, so a durable-write failure left the
  composition on the new preset with the append already committed. The flush
  moved inside the same `try`, so a failed write restores the previous
  composition like a failed append.
- `src/native-asides.ts`: `/btw` joined whatever text an aside produced however
  it ended, so an aborted aside answered with partial output. A stop reason
  other than `completed` now raises `/btw did not complete (<reason>)`.
- `src/native-children.ts`: `listDescendants` ran without a signal on every
  path, so a descendant listing outlived both its session operation and host
  shutdown; every call now passes
  `AbortSignal.any([scope.signal, shutdown.signal])`. A row's native `activity`
  also participates in the `running` verdict, so a descendant with no live
  agent no longer reads as `cancelled` while it is still running.

Two launcher-facing selection bugs are worth their own lines. `scripts/install.sh`
let the ambient `DSC_CHANNEL` and `DEEPSEEK_CODE_TUI_RELEASE` override the
command line: a no-arg run with `DSC_CHANNEL` set was pushed onto a remote lane
instead of building the checkout's VERSION, and `DEEPSEEK_CODE_TUI_RELEASE`
appended a second `--version` behind an explicit one. CLI flags now win and the
ambient variables only fill a lane that is already remote;
`scripts/install-selection.test.mjs` pins all three cases. And
`configure_dsh_launch` skipped the DSH leader synthesis for `dscode dashboard`
because it read the soft subcommand as standalone; the dashboard is a
session-producing launch, so it now synthesizes the leader and
`--no-leader dashboard` fails closed. `acp::connect_via_leader` maps the
leader's version mismatch to the same leader-log hint as a spawn failure, and
that mismatch is terminal — never retried, and it cancels the registered client
before returning instead of leaving it on the leader.

### Verification for this section

- macOS arm64, Node 24.19.0, source tree: `npx tsc -b tsconfig.json` exit 0;
  bridge suites `npx vitest run` in `bridge/grok-leader` 47 files passed, 959
  tests passed; `node --test scripts/*.test.mjs` 47 cases (46 passing, 1
  skipped); `bash scripts/check.sh` PASS; `bash scripts/check-rust.sh` PASS
  Rust product contracts.
- `scripts/dev-bridge-tests.sh` (built payload on the pinned runtime): 46 files
  passed / 1 skipped, 955 passed / 4 skipped.
- Launcher A/B and the updater's negative proof: `/tmp/dscode-probe-20260920/`
  (both bootstrap variants, `probe2.mjs`, `saved/` with the restored files and
  their SHA-256) and `tests/launcher-transaction.spec.ts` run against the
  committed `bin/` (1 failed | 25 passed) and against this tree (26 passed).
- Run the suites from `bridge/grok-leader`, not the repository root: a root
  `npx vitest run` also globs `scripts/*.test.mjs`, which are `node:test`
  files, so vitest reports four "No test suite found" failures and
  `scripts/e2e-gateway-hold.test.mjs` leaves its mock gateway running.
- Every change here is production code that ships in the plugin tarball, so the
  macOS lanes say nothing about Linux: this reopens the Linux acceptance
  threshold, and the re-run on swoop (the 15-case built-provider matrix,
  `check.sh`, the script and bridge suites on Node 22.19.0 and 24.19.0) is
  pending at this revision.

## 2026-09-19: the picker's later ticks reuse one settled listing

The TUI session selector calls `x.ai/session/list`, and every one of those
calls was a full store listing: at 10000 stored sessions a warm picker pass
pays 1.50-1.53s, of which 1.49-1.52s is the store's own listing, for rows
that change only when a session is created or a durable artifact moves. The
roster (`x.ai/sessions/list`) has answered its ticks from one settled
listing for `LISTING_REUSE_MS` (10s) since `57fe2e0f`; the picker was
left out deliberately, because its rows fold the logs behind the listing's
revisions rather than the immutable header alone.

That reason does not hold for the rows such a window would answer. The
picker folds each row from the header the listing carried and the revision
it carried, and the resident `SessionListIndex` answers an unchanged
revision from its own projection and re-reads a changed one, so a row is at
most as stale as the listing behind it — the staleness the deadline already
bounds, and the same trade the roster already makes. `listStore(store,
reuse)` becomes `listStore(store)`: every list shares the in-flight
listing and reuses the settled one, and the three callers differ only in the
rows they fold from the snapshots they are handed.

Two 10000-session runs of the same harness over the same store shape, the
accepted main (`c9d91869`) against this change (macOS arm64, Node 24.19.0):

| 10000 stored sessions | cold | warm 1 | warm 2 | after write | past window |
| --- | ---: | ---: | ---: | ---: | ---: |
| wall clock ms, accepted main | 6930.3 | 1532.1 | 1500.0 | 1449.6 | 1549.6 |
| durable listings, accepted main | 1 | 1 | 1 | 1 | 1 |
| wall clock ms, this change | 7026.5 | 13.0 | 11.6 | 13.7 | 1520.8 |
| durable listings, this change | 1 | 0 | 0 | 0 | 1 |

`warm 1` and `warm 2` are the same picker call again; `after write` is
that call right after another process wrote one stored session; `past
window` repeats it after the reuse deadline. The cold pass is unmoved: one
listing, 10000 opens, 6930.3ms against 7026.5ms, inside the run-to-run
spread of a shared host, and 1.40-1.46s of each is the store's listing.
Everything after it moves. The two warm passes pay 1532.1ms and 1500.0ms on
the accepted main, 1.49-1.52s of it store listing, and 13.0ms and 11.6ms
here with zero listings, zero opens and zero reads, because each row is
folded from the header and revision that listing already carried and the
projection the resident index already holds. The third column prices the
trade: the accepted main folds an external write on the next call (1449.6ms,
one listing, one open, the new title on the row); this change answers rows up
to one deadline old (13.7ms, zero listings, zero opens) and carries that
title only in the last column, where the tick past the deadline pays one
listing (1504.3ms of its 1520.8ms) and re-opens exactly the one session whose
revision moved.

The rows a window cannot answer stay unanswered: the harness's late phases
still withhold a session another process created without an announcement and
still serve it on the first tick after one (0 listings, then 1 carrying the
row, then 0 from the window the announcement opened). The roster's contract
is untouched — five ticks at 0.4-1.1ms on the accepted main and 1.7-2.5ms
here, zero listings both sides, with a three-caller burst at 1.2ms and 4.4ms
and zero listings — as are the announcement, remount and unreadable-artifact
behaviours the spec files pin. Peak RSS is 336.7 MiB against 304.8 MiB, which
follows the two 1.5s fold passes the run no longer performs rather than
anything the change retains, and both runs report 40964096 root bytes, 10000
candidates and 120 events per session.

The benchmark now pins this contract instead of only recording it: picker
phases carry their `listings` and `retitles`, `--reuse=true` requires
every tick inside the window to take none of them, and the phase past the
deadline to take exactly one listing and carry exactly `--touch` retitles.
Its `--touch` also works past one session now: each touched session carries
the template's events, so the append cursor is the template's length rather
than an offset per index.

### Verification for this section

- Evidence: `/tmp/dscstress-scale/picker-window-20260919/` (`before.json`,
  `after.json`, `before.err`, `after.err`, `ab.sh`,
  `session-discovery.reuse.ts`). `after.json`'s `violations` is empty and
  `before.json`'s six are the reverted source failing the new contract at
  10000: three ticks took a listing inside the window, the post-write tick
  opened a log and carried a title only a listing can carry, and the
  post-deadline tick had nothing left to re-read.
- Reproduction: `bash ab.sh` runs each side in turn — it restores the
  accepted `src/session-discovery.ts`, runs `before`, restores this change
  and runs `after` — so both sides are the same command on the same host:
  `node --experimental-transform-types --expose-gc
  scripts/bench-session-list.mjs 10000 --events=120 --projects=1
  --roster=5 --concurrent=3 --titles=hit --reuse=true`, each seeding its own
  store first (~181s).
- Negative proof below the benchmark: with only `src/session-discovery.ts`
  reverted, `npx vitest run tests/session-discovery.spec.ts
  tests/leader.spec.ts` fails 8 of 317 cases (2 failed files, 309 passed),
  among them `serves the picker from one settled listing and pays its own
  only past the window`, `ends the picker window when the process announces
  a session` and `refreshes picker metadata after an external durable
  revision changes`.
- Tests here: `npx tsc -b tsconfig.json` passes; `npx vitest run` 47
  files, 950 passed; `bash scripts/dev-bridge-tests.sh` 46 files passed / 1
  skipped (946 passed / 4 skipped); `node --test scripts/*.test.mjs` 44
  cases (43 passing, 1 skipped); `bash scripts/check.sh` passes.
- The window must not weaken the controls around it, and each is pinned in
  `tests/session-discovery.spec.ts`: an announcement still ends the window,
  a listing that began before one never opens it, an unreadable artifact is
  never cached and still re-arms its retry inside the window, and a remounted
  service still refuses both the settled listing and the picker index keyed
  on the old service.
- This section ships a production change and the module ships inside the
  plugin tarball, so the macOS lanes here say nothing about Linux: the
  acceptance threshold reopened, and the re-run at `cd7380f7` repeated the
  15-case built-provider matrix, the script cases, the bridge suite and
  `check.sh` on Node 22.19.0 and 24.19.0, recorded in
  `docs/linux-acceptance-2026-09-17-main.md`.
- macOS arm64 on a shared host, page cache warm on both sides, one store per
  run; the absolute milliseconds are upper bounds and only the comparisons
  inside this section hold.
- Measured on macOS only; this production change reopens the Linux acceptance threshold.

## 2026-09-19: the cold picker folds on the store's two-entry decode handoff

The first picker call walks every stored session, and each walk is a pair:
`open()` parses the log, `read()` serves the page, and both halves scan the
session's directories for the id they name. Those pairs run on a fixed pool of
concurrent lanes (`SessionListIndex.inspectionTails`), four of them, sized for
overlap. The pinned JSONL store answers that shape badly: it hands the log it
decoded in `open()` to the `read()` that follows it through a two-entry memo
(`COLD_LOG_MEMO_MAX_ENTRIES = 2` in
`dsh-session-persistence-jsonl` 0.1.5-rc.2, whose `readStoredLog` re-reads and
re-decodes on a miss), so a lane whose handoff has been evicted parses,
validates and directory-walks its own log a second time, and the lanes beyond
the memo's width buy that re-decode instead of overlap.

One store of 2000 sessions × 120 events, one cold pass per lane width, the
width overridden in the working tree (macOS arm64, Node 24.19.0):

| 2000 stored sessions, one cold pass | 1 lane | 2 lanes | 4 lanes | 8 lanes | 16 lanes |
| --- | ---: | ---: | ---: | ---: | ---: |
| wall clock | 1653.4 | 1371.2 | 1478.0 | 1850.8 | 1849.0 |
| summed read time | 277.1 | 619.5 | 1546.2 | 6059.6 | 13004.1 |
| peak RSS MiB | 265.0 | 271.5 | 280.3 | 288.0 | 293.8 |

One lane pays no overlap at all (1653.4ms of wall) and only its own reads;
two lanes cut the wall to 1371.2ms, and past two it rises again. The read
column is summed over lanes, so it can exceed the wall clock — it prices the
work, not the critical path — and it grows severalfold with every doubling
past the memo's width: 0.62s at two lanes, 1.55s at four, 6.06s at eight,
13.0s at sixteen, the extra lanes decoding logs a neighbour already decoded.
Three lanes (1355.1ms wall) sit inside the two-lane noise. The instrumented
repeats price the effect at the store's own seam: `open()` takes 1.53s on two
lanes, 2.41s on three and 3.24s on four, for 2.41s, 2.56s and 2.89s of
process CPU.

Ten thousand sessions × 120 events, one cold pass per column: the four-lane
tree before the change, a paired A/B on two lanes and on four, and the
shipped revision.

| 10000 stored sessions, cold pass | four before | two (A) | four (B) | shipped |
| --- | ---: | ---: | ---: | ---: |
| wall clock | 7368.2 | 6893.1 | 7342.7 | 6952.6 |
| CPU in the pass | — | 13908.1 | 15737.1 | 14246.1 |
| store `open()` time | — | 7904.4 | 15979.5 | 7953.6 |
| summed read time | 7559.8 | 2921.6 | 7599.4 | 2864.1 |
| store listing | 1437.0 | 1410.4 | 1401.6 | 1474.7 |
| warm pass 1 | 1466.7 | 1454.3 | 1437.7 | 1413.0 |
| peak RSS MiB | 345.0 | 352.7 | 356.0 | 344.5 |

The four-lane columns spend 16.0s opening 10000 logs where the two-lane pair
spends 7.9s, and the pair pays 13.9s of process CPU in the pass against
15.7s, on a wall clock that moves 7342.7ms → 6893.1ms. Every column returns
its 30 rows per phase with no `violations`, and the warm pass is unmoved: its
~1.4s is the store's own listing (1.40-1.47s), which this change does not
touch (zero opens, zero reads). The shipped revision carries the width as a
named constant, `INSPECTION_LANES = 2` in
`bridge/grok-leader/src/session-list.ts`, with the handoff written down beside
it, and its run reproduces the two-lane column.

### Verification for this section

- Evidence: `/tmp/dscstress-scale/bench-lanes/` (`lanes-1` to `lanes-16`,
  `cpu-2` to `cpu-4`, `m-2-8`, `m-3-4`, `m-4-8`, `split-2`, `split-4`)
  and `/tmp/dscstress-scale/bench-10k-window/` (`before.json`,
  `lane2-a.json`, `lane4-b.json`, `after.json`, their `.err` logs and
  `lane-ab.sh`). Each run seeds its own store under `$TMPDIR`; the four
  10000-session runs all report 40964096 root bytes, 10000 candidates and 120
  events per session, and every run's `violations` is empty.
- Reproduction: `node --experimental-transform-types --expose-gc
  scripts/bench-session-list.mjs 10000 --events=120 --projects=1
  --roster=5 --concurrent=3 --titles=hit --reuse=true`, one run per column,
  each seeding its store first (~181s); the A/B pair's width came from a
  working-tree override of the lane array, and the shipped run uses the
  constant.
- The handoff is the pin's own: `COLD_LOG_MEMO_MAX_ENTRIES = 2` in the
  runtime's `@deepseek-ai/dsh-session-persistence-jsonl` 0.1.5-rc.2, under
  `~/.dsh/profiles/dscode/runtime/node_modules/`, where `readStoredLog`
  re-reads and re-decodes on a miss and `memoizeStoredLog` evicts past the
  bound; the 1000-turn section above reached the same bound from the other
  side, as the reason pages cannot be read piecemeal.
- The bench now also counts `open()` time and per-phase process CPU, which
  is how the re-decode shows up as store time instead of fold time; nothing
  pins those fields (`node --test scripts/*.test.mjs` and
  `bash scripts/check.sh` both pass).
- Tests: both helpers pinned the peak concurrent load at four ("four handle
  lanes"), and each now fails on the four-lane tree — `Tests 2 failed | 58
  passed (60)` across `tests/session-list.spec.ts` and
  `tests/session-discovery.spec.ts`, the list case at its
  `expect(peak).toBe(2)` — and passes here. From `bridge/grok-leader`:
  `npx tsc -b tsconfig.json` passes; `npx vitest run` 47 files, 948
  passed; `bash scripts/dev-bridge-tests.sh` 46 files passed / 1 skipped
  (944 passed / 4 skipped); `node --test scripts/*.test.mjs` 44 cases (43
  passing, 1 skipped); `bash scripts/check.sh` passes.
- This section ships a production change and the module ships inside the
  plugin tarball, so the Linux acceptance threshold reopens: the macOS lanes
  here say nothing about Linux. The re-run at `bd4e79da` repeated the
  15-case built-provider matrix, the script cases, the bridge suite and
  `check.sh` on Node 22.19.0 and 24.19.0, and is recorded in
  `docs/linux-acceptance-2026-09-17-main.md`.
- macOS arm64 on a shared host, page cache warm on both sides, one store per
  run; the absolute milliseconds are upper bounds and only the comparisons
  inside this section hold.

## 2026-09-19: a cordis lookup wraps the service, so the caches key on the instance

The two sections above landed their reuse against the bench, which hands
`createSessionDiscovery` a stable store object. The host reads the service
out of cordis, and cordis answers every `ctx.get('sessionPersistence')` with
a fresh traceable proxy over the same instance (`@deepseek-ai/cordis` 4.0.2,
`src/utils.ts` `createTraceable`: `if (prop === symbols.original)` then
`return target`). Every identity this module cached — the settled listing's
`store`, the in-flight listing's, and `indexFor`'s `indexedStore` — was one
of those wrappers, so in the product both caches missed on every call. At
3000 stored sessions in the real product home, one real TUI client and the
real leader:

| Real product, 3000 stored sessions | Before | After |
| --- | ---: | ---: |
| roster listings in the sampled window | 66 / 74.7s | 7 / 66.7s |
| store list per roster tick | 447-659ms | 432-451ms |
| picker warm call, on the wire | 2801ms | 496ms |
| picker warm call, durable log opens | 3001 | 0 |
| picker warm call, store time in opens | 6275ms | 0ms |
| leader CPU, mean of 50 steady samples | 67.0% | 8.7% |
| leader RSS, mean of 50 steady samples | 405894KiB | 362606KiB |

`serviceIdentity` in `bridge/grok-leader/src/session-discovery.ts` walks that
symbol chain to the instance and the new `lookupPersistence` returns it, so
the settled window, the shared listing and the picker's resident index now
compare one live service with one live service — a remount still brings a
different instance and still invalidates, and `persistence()` keeps the
`session persistence is not configured` error for a host that answers
`undefined`. The symbol is read structurally, the way this file reads every
other host capability: `tests/architecture.spec.ts` forbids the cordis
import in this module, and importing it broke that gate before the
structural read replaced it.

Nothing else moved. The picker still lists per call, because its rows are
folded from the logs behind the listing's revisions, and a cold pass still
pays its 3001 opens (6526ms of store time) before the resident index answers
the later calls. The rows are unchanged: the cold roster wire documents of
the two bundles are byte-identical (3001 rows, 3000 titled, 816043 bytes),
both panes render `Inactive 3000` under the section marker, and the picker
answers 50 titled rows either way.

The bench cannot see this bug. It builds the host around the object it keeps
in scope, so `settled.store === store` holds there whatever cordis does with
the lookup the product makes. `tests/session-discovery.spec.ts` now has a
fixture that hands out stacked wrappers (`wrapLookups()`) and the pair that
pins both directions: three in-flight lookups share the one listing they
paid for and the settled window answers the roster call after them (listings
stay 1, and the second pick opens nothing), while a remount behind the
wrappers still refuses both (the roster lists again, the picker folds
again). The first case fails on the tree before this change (`Tests 1 failed
| 39 skipped`).

### Verification for this section

- Evidence: `/tmp/dscstress-scale/ab/scale-run-a` and `scale-run-b` (the
  roster: `ticks.jsonl`, `samples.jsonl`, `roster-wire-cold.json`, the pane
  captures) and `/tmp/dscstress-scale/ab/picker-run-a` and `picker-run-b`
  (the picker: `ticks.jsonl`, `windows.txt`, `picker-*.stdout`), with the run
  logs beside them in `/tmp/dscstress-scale/ab/*.log`. The store probe is the
  external `/tmp/dscstress-picker/roster-probe`; the local proof that one
  lookup is a fresh wrapper over one instance is
  `/tmp/dscstress-scale/proxy-identity-probe.mjs`, run against the
  checkout's own cordis and JSONL store.
- Reproduction: `bash /tmp/dscstress-scale/ab/picker-scale-a.sh` and
  `scale-dashboard-a.sh`, then the `-b` pair after copying the built
  `lib/types/session-discovery.js` into the scratch home's deployed bundle:
  one seeded store, one TUI, one leader, and `diff -rq` over the two payloads
  shows that file as the only difference. A keeps the payload build's bytes,
  archived at `/tmp/dscstress-scale/deployed/session-discovery.js.prefix`,
  so the two sides differ only by this change.
- Suites: `./node_modules/.bin/tsc -b tsconfig.json` passes from
  `bridge/grok-leader`; `npx vitest run` (47 files, 948 passed);
  `bash scripts/dev-bridge-tests.sh` (46 files passed / 1 skipped; 944
  passed / 4 skipped); `node --test scripts/*.test.mjs` (44 cases: 43
  passing, 1 skipped); `bash scripts/check.sh` and `git diff --check` pass.
- This section ships a production change, so it reopens the Linux acceptance
  threshold: the macOS lanes above say nothing about Linux, and the next
  swoop run must repeat the 15-case built-provider matrix, `check.sh` and the
  script/bridge suites on Node 22.19.0 and 24.19.0 at the new head.
- macOS arm64 on a shared host, warm page cache on both sides, the before run
  taken first; the absolute milliseconds are upper bounds and only the
  comparisons inside this section hold.

## 2026-09-19: the roster's settled listing answers the next ten seconds of ticks

Leader mode's dashboard polls `x.ai/sessions/list` once per second, and the
previous section removed only the repeat between the windows that land on the
same second. Every later tick still paid its own read, for rows that change
only when a session is created or the store set moves. At 3000 stored sessions
(`node --experimental-transform-types --expose-gc scripts/bench-session-list.mjs
3000 --events=120 --projects=1 --roster=5 --concurrent=3 --titles=hit
--reuse=true`, Node 24.19.0 / Darwin ARM64, one JSONL root, 54.7s and 55.3s of
seeding) five consecutive roster ticks took 433.6/421.8/475.1/438.4/435.8ms
and performed five listings — 421.2-474.5ms of store work each, for 600,025
bytes and 0.6-0.8ms of encoding per answer, and no log opened or read.

`listStore` in `bridge/grok-leader/src/session-discovery.ts` now keeps the
settled listing (`{ store, snapshots, settledAt }`) and answers the two
header-shaped calls — `session/list` and `x.ai/sessions/list` — from it for
`LISTING_REUSE_MS` (10s). Those rows are the immutable header the listing
carried plus the projection cache's current title, so the only row a settled
listing cannot answer is a session it never saw, and both ways such a row
appears are handled: `ctx.on('session/created')` — wired in `index.ts`
through the host's new `onCreated` — clears the window and bumps the
announcement count, and a listing that started before an announcement never
opens one, because it compares the count taken before `store.list` with the
count at settle and cannot prove which side of its own store read the new
session's durable artifact fell on. The deadline bounds what no local event
covers: a store another process writes, and a durable artifact that lands
after the listing's read.

| Roster phase | Listings | Store list | Wall | Rows | Opens | Reads |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| five ticks, before | 1 each | 421.2-474.5ms | 433.6-475.1ms | 3000 | 0 | 0 |
| five ticks, after | 0 each | 0ms | 0.2-0.5ms | 3000 | 0 | 0 |
| three-window burst, before | 1 | 413.5ms | 414.4ms | 3000 | 0 | 0 |
| three-window burst, after | 0 | 0ms | 0.4ms | 3000 | 0 | 0 |

The burst is the one the previous section already shared: three callers that
land during one in-flight listing still take one listing between them
(413.5ms), and the settled window now answers them too (0 listings, 0.4ms).
The picker keeps listing per call — its rows fold the logs behind the listing's
revisions — so its warm passes in the same run still paid 399.1-400.4ms of
`storeListMs`; a remounted service is a different store instance with
incomparable revisions and never reuses one; and disposal clears the window
with the rest (`[unsubscribe, unsubscribeCreated, close]`, the second
unsubscribe's failure retained in `cleanupFailures` like the first).

The row a window cannot carry stays honest. The bench writes a session straight
through the bare backend — a store another process wrote — and polls without an
announcement: the settled window answers in 0.5ms from the rows it has (3000,
not 3001), which is the price of the ten seconds the deadline bounds.
Announcing it the way `session/created` does ends the window, so the next poll
pays its own 422.0ms listing that carries the row (3001 rows,
`carriesLate: true`), and the tick after that is reused again in 0.2ms with
the row intact.

| Late-session poll | Listings | Wall | Rows | Carries the row |
| --- | ---: | ---: | ---: | --- |
| unannounced, before | 1 | 416.4ms | 3001 | yes |
| unannounced, after | 0 | 0.5ms | 3000 | no |
| announced, after | 1 | 422.0ms | 3001 | yes |
| announced then reused, after | 0 | 0.2ms | 3001 | yes |

Both ends are pinned. `tests/session-discovery.spec.ts` gained four cases: a
settled listing answers the roster until its window expires; an announcement
ends the window and the next listing reopens it; a listing that started before
an announcement never opens one; and a remounted service never reuses one. Its
share case now also drives the settled window and the picker behind it
(`session/list` and the roster are served, the picker lists).
`tests/leader.spec.ts` drives the contract over the real socket with two
registered windows: the second window's next-second tick is served from the
settled listing (listings stays 1), and the tick past the 10s deadline lists
again (2), with `Date.now` stubbed for the deadline only. Reverting only
`bridge/grok-leader/src/session-discovery.ts` and `bridge/grok-leader/src/index.ts`
fails 6 of the 313 tests across the two files — the wire case (`expected 2 to
be 1`), the share case (3 listings where it pins 1), three of the four reuse
cases (window expiry, announcement, and the pre-announcement listing, which
fails with `announced is not a function` and its 10s hook timeout), and the
disposal case's error list (the reversed tree registers no second unsubscribe,
so `creation unsubscribe failed` is missing) — while the remount case passes
in both trees. Restoring the two files reproduces the reviewed diff byte for
byte.

### Verification for this section

- Evidence: `/tmp/dscstress-picker/roster3000-reuse-old.json` and
  `roster3000-reuse-after.json` (the same 3000-session run on this head and
  with only the two source files reverted), with the `--reuse=true` contract's
  8 violations in `roster3000-reuse-old.err` and none in the after run
  (`--strict` exits 0).
- Reproduction: the command above with `--reuse=true --strict` on this tree
  and on a tree with only `bridge/grok-leader/src/session-discovery.ts` and
  `bridge/grok-leader/src/index.ts` reverted, ~55s of seeding per run. The
  decisive numbers are the ticks' listings (1 each -> 0), the unannounced late
  poll's rows (3001 -> 3000) and the announced poll that pays its own listing
  and carries the row.
- Suites: `npx tsc -b tsconfig.json` passes; `tests/session-discovery.spec.ts`
  (38 passed), `tests/leader.spec.ts` (275 tests, 313 passed together),
  `npx vitest run` (47 files, 946 passed), `bash scripts/dev-bridge-tests.sh`
  (46 passed / 1 skipped files; 942 passed / 4 skipped tests),
  `node --test scripts/*.test.mjs` (44 cases: 43 passing, 1 skipped),
  `bash scripts/check.sh` and `git diff --check` pass.
- This section ships a production change, so it reopens the Linux acceptance
  threshold: the macOS lanes above say nothing about Linux, and the next swoop
  run must repeat the 15-case built-provider matrix, `check.sh` and the
  script/bridge suites on Node 22.19.0 and 24.19.0 at the new head.
- macOS arm64 on a shared host, one JSONL root per run; the absolute
  milliseconds are upper bounds and only comparisons inside this section hold.

## 2026-09-19: a roster row carries its durable title, so a leader dashboard lists stored sessions

Leader mode's dashboard shows what the bridge answers to
`x.ai/sessions/list`, and the pinned pager keeps a stored session only when
the row has something to show: `append_roster_rows` in
`crates/codegen/xai-grok-pager/src/views/dashboard/row.rs` skips every entry
that carries no title, is neither working nor awaiting input, and is not
pinned (`if !has_title && !active && !pinned.contains(&id) { continue; }`).
The bridge's row never carried a `title`, so every stored session was dropped,
the Inactive section that would hold them starts collapsed, and a profile with
stored sessions showed `No agents yet, type a prompt to start one.` — the
rows were on the wire all along; only the label was missing.

`bridge/grok-leader/src/session-discovery.ts` now fills that label from the
persisted projection cache (`ctx.sessionProjectionCache`), the same
synchronous zero-I/O listing read the runtime gives its own
`x.ai/sessions/list` in
`dsh-api-session-controller/lib/types/list.js`: the current lifecycle's cut
first, then the format-invariant predecessor title, both read under the
unseeded listing's exact zero inherited count
(`cachedSnapshot(header, SessionLogOffset(0), ['title']) ??
cachedPredecessorTitle(header, SessionLogOffset(0))`).

- Nothing new is opened or folded. One tick still lists the store once and
  opens and reads no log (`opens: 0`, `reads: 0` in both rows below), and the
  title read is a synchronous cache row, not a log walk.
- The hint is exact rather than approximate: an unseeded listing knows its
  inherited cut is zero and can prove the cache identity, while a
  `header.isSeeded` listing — a header-only record that cannot name its cut —
  stays titleless until an authoritative read supplies one, which is what the
  runtime's own listing does in the same place.
- The field appears only when the cache answers a non-empty title after
  trimming, so an uncheckpointed store emits exactly the JSON it emitted
  before (465,025 bytes, unchanged) and pays one `cachedSnapshot` plus one
  `cachedPredecessorTitle` probe per row.
- A cache that throws is reported through the host's `log` (wired to the
  bridge logger) and the row is served without the title the way an unseeded
  header is: a hint can never fail the listing.

| Titles | Rows | Titled | Title reads | Store list | Tick | JSON bytes | Encode |
| --- | ---: | ---: | ---: | --- | --- | ---: | --- |
| miss | 3000 | 0 | 6000 | 396.2-443.4ms | 396.7-444.0ms | 465,025 | 0.5-0.6ms |
| hit | 3000 | 3000 | 3000 | 396.7-527.8ms | 418.8-528.2ms | 600,025 | 0.7-0.8ms |

`scripts/bench-session-list.mjs` gained `--titles=hit|miss`, which answers
the roster's cache reads as a warm or a cold store would, and now wires the
host's `projectionCache` at all (the module is required, so the bench would
otherwise throw). At 3000 stored sessions (`--roster=5 --concurrent=3`,
Node 24.19.0 / Darwin ARM64, 53.0s and 55.1s of seeding) the titles cost
nothing measurable in the tick — 396.7-444.0ms without them, 418.8-528.2ms
with every row answering — and 135,000 bytes on the wire, exactly the 3,000
rows at 45 bytes each. The burst still shares one listing across three
callers (`listings: 1`, `opens: 0`, `reads: 0`) with the titles on every
row.

End to end, on a fixture profile whose store holds one session with a cached
`rows.title` (`SOAK Session`) and one session with no cache row, the leader's
answer to the roster poll carries `"title": "SOAK Session"` on the titled row
and no `title` field at all on the untitled one, and the same pager pane goes
from `No agents yet, type a prompt to start one.` to `▸ Inactive 1`, which
expands to `▾ Inactive 1` with `◇ SOAK Session` under it.

The row's other columns are untouched: `lastChangeUnixMs` still reports
`header.createdAt` rather than the projection's last-change time, so the
roster's ordering and relative times are unchanged by this section.

### Verification for this section

- Evidence: `/tmp/dscstress-picker/roster3000-titles-miss.json` and
  `roster3000-titles-hit.json` (the same 3000-session run with the cache cold
  and warm), and the probe lane in `/tmp/dscstress-picker/roster-probe/`:
  `roster-wire-after.json` (the leader's own answer), `pane-dashboard-no-title.txt`
  against `pane-dashboard-after.txt` and `pane-dashboard-after-expanded.txt`
  (the same pager pane either side of the change).
- Reproduction: the command above with `--titles=miss` and `--titles=hit`,
  then the probe lane's leader over a fixture HOME whose
  `storages/session_projcache/sessions/*.json` carries `rows.title`. The
  decisive numbers are the 0 -> 3000 titled rows, the unchanged 465,025 bytes
  when the cache is cold, and the wire row that gains `"title"`.
- Suites: `npx tsc -b tsconfig.json` passes; `tests/session-discovery.spec.ts`
  (34 passed, including the three title cases), `tests/leader.spec.ts`
  (275 tests, including the wire case over the real socket),
  `npx vitest run` (47 files, 942 passed),
  `bash scripts/dev-bridge-tests.sh` (46 files passed / 1 skipped; 938 passed
  / 4 skipped), `node --test scripts/*.test.mjs` (44 cases: 43 passing, 1
  skipped), `bash scripts/check.sh` and `git diff --check` pass.
- The cases pin the change and nothing else: reverting only
  `bridge/grok-leader/src/session-discovery.ts` fails exactly the four new
  cases (4 failed | 305 passed across the two files) and restoring the file
  reproduces the reviewed diff byte for byte.
- This section ships a production change, so it reopens the Linux acceptance
  threshold: the macOS lanes above say nothing about Linux, and the next swoop
  run must repeat the 15-case built-provider matrix, `check.sh` and the
  script/bridge suites on Node 22.19.0 and 24.19.0 at the new head.
- macOS arm64 on a shared host, one JSONL root per run, loopback leader; the
  absolute milliseconds are upper bounds and only comparisons inside this
  section hold.

## 2026-09-19: the dashboard roster poll pays the store listing once per burst

Leader mode's dashboard asks the bridge for `x.ai/sessions/list` once per
second for as long as a dashboard view is open (`ROSTER_POLL_INTERVAL` in the
pinned pager's `app/event_loop.rs`, armed only on `ActiveView::AgentDashboard`;
non-leader mode instead polls `x.ai/session/list` through
`Effect::FetchDashboardSessions`). The bridge never emits the pager's
`x.ai/sessions/changed` broadcast — a search for `notify|notification` under
`bridge/grok-leader/src` finds only `x.ai/session_notification` and
`x.ai/models/update` — so this poll is the roster's only refresh and it stays.
Its answer folds no log: it maps stored snapshot headers, and the whole tick is
the pinned `store.list()` behind them.

At 3000 stored sessions (`node --experimental-transform-types --expose-gc
scripts/bench-session-list.mjs 3000 --events=120 --projects=1 --roster=5`, Node
24.19.0 / Darwin ARM64, one JSONL root, 55.0s of seeding) one tick costs
394.9-461.0ms and 394.5-460.6ms of that is the store listing; the JSON the
transport then writes is 465,025 bytes and encodes in 0.5-0.6ms. The tick opens
and reads no logs, and the event-loop delay it inflicts stays at 5.0-5.4ms max
/ 5.0-5.1ms p99, because the store's per-session work is directory and header
I/O rather than a synchronous walk. The picker in the same run pays the same
listing: 406.7ms of its 411.2ms warm pass is `storeListMs`.

| Burst | Calls | Listings | Store list | Wall | Rows | Opens | Reads | Peak RSS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| before | 3 | 3 | 1930.1ms | 644.2ms | 3000 | 0 | 0 | 291.2MiB |
| after | 3 | 1 | 386.6ms | 387.3ms | 3000 | 0 | 0 | 296.3MiB |

One leader serves every window of a profile, so each open dashboard's tick
lands on the same second: three calls used to take three listings and 1930.1ms
of store work to answer the same 3000 rows, and the last caller waited 644.2ms
for a read the other two had already paid for. `listStore` in
`bridge/grok-leader/src/session-discovery.ts` keeps the in-flight listing and
hands it to callers that arrive before it settles, the way one inspection
already serves every pass over one session: the burst becomes 1 listing /
386.6ms / 387.3ms. The share is bounded by construction.

- The entry is cleared in the settled promise's own handlers, so only callers
  in flight during that listing use it; the next caller lists again and pays
  its own read, which the bench confirms one call later.
- It is keyed by the store instance, so a remounted service — a different
  persistence with incomparable revisions — never picks up the old listing.
- The snapshot array is shared read-only. Every caller maps or filters it into
  its own rows and none touches it: the picker builds `rows` from a fresh
  `candidates.map`, and both minimal methods map into new objects.
- A rejection is shared too: every in-flight caller sees the same failure
  instead of one of them re-listing a store that just failed.

Both ends are pinned. `tests/session-discovery.spec.ts` drives three callers
into one gated listing (they share it, and the next caller lists again) and a
remounted service (it lists on its own); `tests/leader.spec.ts` fires the same
burst from two registered windows over the real socket and reads both answers
back through the pager's `result` envelope. Reverting only
`bridge/grok-leader/src/session-discovery.ts` fails the first discovery case
(two callers of one gated listing deadlock and it times out at 10s) and turns
the wire case into `expected 1, received 2`, while the remount case still
passes, so the cases pin the share and only the share.

A single dashboard still pays one listing per second, so this only removes the
repeat between windows. Spending less per tick needs a listing that outlives
the call that paid for it, which needs a change signal the bridge does not have
for stored sessions; that direction is not started.

### Verification for this section

- Evidence: `/tmp/dscstress-picker/roster3000.json` (single-caller roster
  phases with the picker in the same run), `roster3000-before.json` and
  `roster3000-after.json` (the three-call burst either side of the change).
- Reproduction: the command above with `--roster=5 --concurrent=3` on a tree
  with and without the `listStore` share. The decisive numbers are the
  listings a burst takes (3 -> 1) and the store work it repeats
  (1930.1ms -> 386.6ms); the wall times follow from them.
- Suites: `tests/session-discovery.spec.ts` (31 passed), `tests/leader.spec.ts`
  (274 tests, including the two-window roster burst over the real socket),
  `bash scripts/dev-bridge-tests.sh` (47 files, 938 tests: 934 passing, 4
  skipped), `node --test scripts/*.test.mjs` (44 cases: 43 passing, 1
  skipped), `bash scripts/check.sh` and `git diff --check` pass.
- This section ships a production change, so it reopens the Linux acceptance
  threshold: the macOS lanes above say nothing about Linux, and the next swoop
  run must repeat the 15-case built-provider matrix, `check.sh` and the
  script/bridge suites on Node 22.19.0 and 24.19.0 at the new head.
- macOS arm64 on a shared host, loopback synthetic gateway, one JSONL root per
  run; the absolute milliseconds are upper bounds and only comparisons inside
  this section hold.

## 2026-09-19: the 1000-turn soak, three-window cancellation, picker scale and descriptor attribution

The sustained product-loop soak was extended to 1000 consecutive turns
(`SOAK_TURNS=1000 bash scripts/soak-product-loop.sh`, the default tool step
every fifth turn). It ran 26.5 minutes of wall clock (1588s between the first
and the last turn, median inter-turn gap 1778ms) and every row passed.

| Turns | Windows | Rows | Errors | p50 | p90 | max | first 5 | last 5 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1000 | 1 | 1000 | 0 | 83ms | 169ms | 371ms | 307, 55, 60, 57, 88 | 83, 65, 63, 65, 120 |

Latency does not drift over a thousand turns: the last five sit between 63 and
120ms around the run's 83ms p50, and the first turn is again the only outlier.
Split by step, the 800 plain turns ran 77ms p50 / 165ms p90 / 340ms max and
the 200 tool turns 118ms / 306ms / 371ms; provider wait (keypress to the
gateway receiving the request) was 40ms p50 / 87ms p90 / 269ms max.
`leaderExit` read `exited-after-1900ms` with `alive-with-1-of-1-client(s)`, and
cross-talk was 0 rows.

Leader RSS is a plateau here too, and this run reaches it inside the first 250
turns: the 50-turn means run 248.0, 305.5, 322.1, 337.2, 350.3 and 353.0MiB
over turns 1-300, then hold between 343.6 and 355.9MiB for the remaining 700
(233.0MiB at turn 1, 356.4MiB at turn 1000, 358.4MiB max). TUI RSS went 71.3
to 83.1MiB. Descriptors did not grow: leader 41 -> 40 with a maximum of 41,
TUI 34 -> 35.

The cancellation lane runs with three windows as well as one:
`SOAK_TURNS=200 SOAK_WINDOWS=3 SOAK_CANCEL_EVERY=10 bash
scripts/soak-product-loop.sh` rendered 580 rows across three concurrent
clients with 0 errors and 0 cross-talk rows, and all 20 probes passed.

| Turns | Windows | Cancel every | Probes | Statuses | Step sighted | Hold p50/max | Cancel p50/max | Cross-talk | Leader exit |
| ---: | ---: | ---: | ---: | --- | ---: | --- | --- | ---: | --- |
| 200 | 3 | 10 | 20 | 20 ok | 20 | 86ms / 128ms | 61ms / 88ms | 0 | exited-after-1900ms |

`holdMs` is keypress-to-marker and `cancelMs` is Ctrl+C-to-`Turn cancelled by
user`. Turn latency was 80ms p50 / 128ms p90 / 562ms max, with the worst rows
the tool turns of windows 2 and 3, and the leader stayed with its clients and
exited on its own (`exited-after-1900ms`, `alive-with-3-of-3-client(s)`).
Leader RSS followed the same shape as the 1000-turn run (240.2 -> 353.8MiB,
358.4MiB max), while descriptors grew 47 -> 64.

That descriptor growth is the run's own marker files. A hook on the leader
that records every `fs.watch` (`hook-open.js`, log `hook-open.log`) shows 13
watches at boot: the home directory itself, each regular file directly inside
it (`settings.yaml`, `settings.yaml.lock`, `runtime-paths`,
`soak-gateway.mjs`, `soak-model.mjs`, `tmux-soak.conf`) and `profiles/dscode`
with its five files. Every one of them arrives through chokidar's
`_handleFile`/`_handleDir` -> `_watchWithNodeFs` -> `createFsWatchInstance`,
which on Darwin is one libuv FSEvents `O_EVTONLY` descriptor per path. When the
probe's marker appears, the log shows readdirp's `lstat`/`stat` on
`.soak-run-w1-t6` followed by one more `WATCH` on that path, which is the
per-file descriptor the summaries count. The root is registered by the profile
boot for the home patch layer `$DSH_HOME/cordis.patch.yml` through
`registerConfig` in `@deepseek-ai/cordis-plugin-hmr/lib/index.js`, whose
`findWatchRoot` resolves to `$DSH_HOME` at depth 0, so the growth is bounded by
the number of files sitting directly in the home rather than by turn count, and
`watcher.close()` releases them (a standalone probe of the same watch shape
held one descriptor per file and none after close, `chokidar-probe.mjs`). The
control lanes track that shape: 41 -> 42 for a single probe file, 41 -> 45 for
four, 41 -> 48 when eight tool markers are written, and 41 -> 60 for nineteen
(the 80-turn `cancel-fd` lane, whose three `lsof` snapshots show 4, 11 and 19
read-only rows on exactly those marker files). The 1000-turn lane, which
creates no file in the home at all, stays at 41 -> 40; the only file added
there is the harness's own summary generator, written after cleanup.

Session-list scale was re-measured on the bench behind the 2026-09-17 picker
numbers, now with the two changes that landed after them: the retention cap
`9bd0d4a0` and the pinned-id point query `c556e079`.

| Stored sessions | Cold list | Warm list | Snapshot (all stored) | Point query stored / absent | Peak RSS | Index retained |
| ---: | ---: | ---: | ---: | --- | ---: | ---: |
| 1000 | 779.7-828.9ms, 1000 opens | 137-147ms, 0 opens | 173-176ms | 0.2ms / 0.1ms | 249.3-256.5MiB | 1.5MiB |
| 3000 | 2654.9-2856.7ms, 3000 opens | 590.7-1089.9ms, 0 opens | 478.7-495.9ms | 0.2-0.3ms / 0.1ms | 270.1-287.3MiB | 2.3MiB |

Each run is two cold lists, two to three warm lists and one list after an
external change, on Node 24.19.0 darwin-arm64 with 120 events per session, one
project and `--limit 30`; `violations` was empty in all four runs, which is
the bench's own contract: the cold list opens exactly one log per candidate, a
warm list opens none, and only the touched session re-opens after a change.
The warm path's zero opens is the retention cap holding at 3000 stored
sessions, and a pinned id answers in 0.2-0.3ms for a stored session and 0.1ms
for an absent one. Cost per stored session is 0.83 and 0.88ms on the cold
list, so the first list is linear in stored sessions, and the warm list cost
137-147ms at 1000 and 590-1090ms at 3000. A control run with `--lists=8` (seven
warm passes instead of two or three) left the cold list where it was (974.8ms
at 1000 stored sessions, 2805.8ms at 3000 against 2654.9ms) and only warmed the
3000-session replay (404.8-436.3ms), so the first list stays the one a picker
actually pays for.

The events-heavy rows of the 2026-09-17 section were re-measured with this
bench at the same 30-row limit, at 2,000 and 400 events per session:

| Stored sessions | Events per session | Stored events | Cold list | Warm lists | Changed session | Peak RSS | Index retained |
| ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |
| 300 | 2,000 | 600,000 | 2077.7ms, 300 opens | 42.8-45.3ms, 0 opens | 50.1ms, 1 open, 2,001 events | 438.4MiB | 5665.3KiB |
| 900 | 400 | 360,000 | 1419.2ms, 900 opens | 127.8-128.0ms, 0 opens | 138.7ms, 1 open, 401 events | 282.8MiB | 2234.5KiB |

`violations` was empty in both runs, the cold list again opened exactly one
log per candidate, and the warm and changed-session columns stayed at the
stored-session price. The cold fold paid about 3.5µs per stored event (600,000
events in 2077.7ms), the same rate as the 2026-09-17 rows: a first list costs
what the directory stores, not what it returns.

That cost is not removable from the bridge. The pinned backend's
`readStoredLog` reconstructs and validation-scans the complete event array
before a `read` slices it, so a page-and-project read would still walk the
whole artifact for each page, and its `coldLogMemo` — the only place a
decoded log survives a call — holds just two entries
(`COLD_LOG_MEMO_MAX_ENTRIES = 2`), so pages from interleaved sessions would
miss it and re-walk. The decode and scan yield to the event loop but still run
in the process's JS thread, where the picker's fold follows. One full walk and
one validation pass per stored session is what the persistence seam imposes on
a first observation; the retention cap above already removed the repeats, and
the measured peak RSS (438.4MiB at 600,000 stored events) and retained index
(5.7MiB at 300 sessions) bound the memory this leaves. No production change
followed from this re-measurement.

### Verification for this section

- Evidence: `/tmp/dscode-stress/endurance` (1000 turns), `cancel3` (200 turns
  x 3 windows), `cancel-fd`, `attrib2`-`attrib7`, `toolfd` and `variants` hold
  `turns-*.jsonl`, `samples-*.jsonl`, `cancels-*.jsonl`, `crosstalk-*.jsonl`
  and the summary JSON; `hook-open.js` with `hook-open.log` is the descriptor
  hook and its log, `chokidar-probe.mjs` the standalone watch probe, and
  `scaling/` the four picker runs with their `--lists` controls; `deep/`
  holds the two events-heavy picker runs.
- Reproduction: `SOAK_TURNS=1000 bash scripts/soak-product-loop.sh`;
  `SOAK_TURNS=200 SOAK_WINDOWS=3 SOAK_CANCEL_EVERY=10 bash
  scripts/soak-product-loop.sh`; `node --experimental-transform-types
  --expose-gc scripts/bench-session-list.mjs 3000 --events=120 --projects=1
  --lists=3 --touch=1`, and the same command at `300 --events=2000` or
  `900 --events=400` for the events-heavy pair (the bench prints an
  `ExperimentalWarning` line ahead of its JSON).
- `scripts/check.sh` and `git diff --check` pass. This section records
  measurements only; no production code changed with it, so the Linux
  acceptance threshold is not reopened.
- macOS arm64 on a shared host, loopback synthetic gateway, whole-process RSS;
  the absolute milliseconds are upper bounds and only comparisons inside this
  section hold.

## 2026-09-18: the launch gap between `connect finished` and `app_init`

The TUI's own startup phases leave a fixed window between the connect result
and `app_init`: 197, 201, 204, 206, 207, 243 and 254ms in seven fresh-process
launches against an isolated profile and a loopback gateway, while total
startup ranged 876-1943ms with machine load. A 5-second `sample` at 3ms run
time between samples, taken from the process that reported the 254ms gap,
shows the window is synchronous main-thread work that all lands before the
first frame: 68 of its 358 main-thread samples sit inside `init_tracing`
(204ms), 17 in the startup-warning tmux probes (51ms) and 7 in
`display_refresh_startup` (21ms).

| Work inside the window | Main-thread samples (3ms each) | Paid by |
| --- | ---: | --- |
| `AuthManager::force_reload_from_disk` re-read budget (two 50ms sleeps) | 31 (93ms) | a profile with no readable `auth.json` at init |
| `otlp_http::build_blocking_client_with_identity` (thread + `join`) | 35 (105ms) | every launch while trace export is enabled, which is the default |
| startup-warning tmux probes (three queries, one 15ms poll tick each) | 17 (51ms) | a tmux-backed pane (`is_tmux_backed()`) |
| `display_refresh_startup::start` (SkyLight `SLSMainDisplayID`, TCC preflight) | 7 (21ms) | macOS |

The two OTLP items arrive through `init_tracing` → `build_otel_layer` →
`build_tracer_provider` → `build_server_provider`, which snapshots the
credential provider and builds the exporter's HTTP client before the first
frame is drawn. Three earlier samples of the same launcher show the same shape
(173ms in `init_tracing`, 80ms of it the client build, 93ms the auth budget,
51ms the tmux probes).

The same pass settled an instrumentation question that made the first runs
hard to read: `GROK_INSTRUMENTATION` and `GROK_INSTRUMENTATION_LOG` cannot
reach a dscode launch at all. `isolate_dscode_environment()` removes every
inherited `GROK_*` variable before configuration or threads start and
re-maps only five `DSCODE_*` aliases (`DSCODE_CONFIG`,
`DSCODE_CONFIG_PATH`, `DSCODE_CONNECT_UI_TIMEOUT_SECS`,
`DSCODE_CLIPBOARD_NO_NATIVE_READ`, `DSCODE_CLIPBOARD_NO_OSC52`), so the TUI
always runs in the default `Server` mode. The four launches that set `off`
or `log` plus a log path are therefore four samples of that one path: no log
file appeared, the window did not move, and the spread between them is host
noise. `ps eww` does print the variables for a pane — that is the exec-time
copy in the kernel's argument area, not the environment the process runs with.

Adopted in this pass: the OTLP client build, the one item on that list every
launch paid for (next section). The other two were left open here because
their win is bounded by their conditions — the auth budget is only paid where
`auth.json` is missing or unreadable, the tmux probes only in tmux-backed
panes — and both are product code under `third_party/grok-build` that needs
its own cycle against the Linux acceptance threshold. Both were measured and
adopted later the same day (the last section of this date).

### Verification for this section

- Seven launches of the real launcher over a loopback gateway with an isolated
  `DSCODE_HOME`, phases read from the profile's `unified.jsonl`; the
  `ab-*.out.json` files are in the archive below.
- Stack attribution: `/usr/bin/sample` by process name, 5 seconds at 3ms run
  time between samples, main thread filtered, from the launch that reported
  the 254ms gap (`absample3-s3a/`); `absample-off2/`, `absample-offsample/`
  and `run5/` are the earlier trees.
- The bench-side read of the same window was exercised end to end with the
  accompanying bench patch: `node scripts/bench-launch-compile-cache.mjs`
  with one pair completed on Node 24.19.0 with its cache assertions intact and
  reports the per-request timeline now (`bench-cc-validate/launch-ab.json`).
- `scripts/check.sh`, `node --test scripts/*.test.mjs` and `git diff --check`
  passed. macOS arm64 under sustained foreign load (load average 9.4-13.5
  throughout), so these milliseconds are upper bounds and only same-session
  comparisons hold.
- Raw evidence: `.git/integration-backups/perf-launch-gap-2026-09-18-evidence.tar.gz`,
  SHA-256
  `a97c8c7d5b001492123f7d3b8ae0b16d07e8f66fb1dd3f26b1d7c01356c90a3e`.

## 2026-09-18: the OTLP client build leaves the startup window

`otlp_http::build_blocking_client` was 105ms of the window sampled above, and
every launch with trace export enabled — the default — paid it in
`init_tracing`, ahead of the first frame, whether or not the session ever
sent a batch. The traces exporter now resolves its HTTP client on first use
(`otlp_http::DeferredOtlpClient`): the build lands on the OTLP batch
processor's own std thread at the first export, and a launch that never
exports never builds the client at all.

| Pair | Before: window / `startup complete` | After: window / `startup complete` |
| --- | ---: | ---: |
| `base-0b` / `lazy-0` | 202ms / 1527ms | 116ms / 901ms |
| `base-0c` / `lazy-1` | 193ms / 839ms | 107ms / 756ms |
| `base-0d` / `lazy-2` | 242ms / 1845ms | 108ms / 1139ms |
| `base-0e` / `lazy-3` | 209ms / 979ms | 110ms / 872ms |

Window is the launcher's own `connect finished` → `app_init` gap, read from
the profile's `unified.jsonl`; four interleaved before/after pairs on the
same harness and profile, macOS arm64 under sustained foreign load (load
average 14.05/15.46/13.60). The ranges do not overlap — 193-242ms before,
107-116ms after — and the pairs differ by 86, 86, 134 and 99ms. The first two
launches of each session ran against a cold page cache, and their totals sit
above the warm pair that follows, so the pairs are what compare. Pairs 1-2
use the pre-refactor build of the same change, which differs only in where
the failure warning is emitted; pairs 3-4 use the final revision. All four
runs report an empty OTLP request list: the isolated profile carries no
credential, the export gate is off, and the client is now never built. That
is the case the change targets.

The client is still built on the calling thread, and the one-shot exporter
still constructed there, before the async export body runs: the blocking
client must not be built or dropped inside an async executor. The deferred
cell keeps the connection-pooled client alive
for the process, the per-export clones that reach each one-shot exporter have
the same lifetime structure as before, and the build closure runs at most
once with a failed build cached — so a host that cannot build a client warns
once and then degrades to "no spans exported" for the rest of the process
instead of retrying, and logging, on every flush.

### Verification for this section

- Four interleaved before/after launches of the real launcher over a loopback
  gateway with an isolated `DSCODE_HOME`, ports 8931-8947; the binaries are
  the release build at the revision before this change (`dscode-base`,
  SHA-256
  `6e6f2b00161cf632451cf6a2bd3a0f4f951bc967683c8933fb7edb9094fafc02`) and at
  the revision after (`c76cbcf45295a7da2803f79ba46c8d464f2b1e9dd3dbf41c51291d7621bf8c8a`,
  built with `scripts/build-deepseek-tui.sh`). The `ab-*.out.json` files and
  the harness are in the archive below.
- The export path itself is covered end to end by
  `crates/codegen/xai-grok-telemetry/tests/otel_traces_export.rs`: a plain
  `#[test]` — the blocking client must not be dropped inside an async
  executor, so deliberately no Tokio — runs `client::init` in
  `SessionMetrics` mode, builds the layer against a loopback `traces_url`,
  emits one span through the global tracer, flushes with `shutdown_otel()`
  and asserts that a raw `TcpListener` collector got `POST /v1/traces` with
  the provider's `Authorization: Bearer` header and a protobuf body that
  decodes to that span.
- `cargo test -p xai-grok-telemetry`: 227 unit tests and all 11 integration
  binaries pass, including the new `otel_traces_export`; `cargo fmt -p
  xai-grok-telemetry -- --check`, `scripts/check.sh`, `node --test
  scripts/*.test.mjs` (43 pass, 1 skip) and `git diff --check` pass.
- Raw evidence: `.git/integration-backups/perf-otlp-lazy-client-2026-09-18-evidence.tar.gz`,
  SHA-256
  `1ded98a9b621c6b3edb1347b2a31592018758ce5c804c6c911ee100be70733ac`.

This section changes product code under `third_party/grok-build`, so it
reopened the Linux acceptance threshold. The re-run at `243e2616`, the head
that contains it, executed the approved threshold green (15-case
built-provider matrix, `check.sh`, script and bridge suites on Node 22.19.0
and 24.19.0) with a supplementary Linux compile and test of the changed
crate, so `243e2616` became the last accepted Linux revision
(`docs/linux-acceptance-2026-09-17-main.md`).

## 2026-09-18: the auth budget and the tmux probes leave the startup window

The window sample above charged two more items to specific code: the
`AuthManager::force_reload_from_disk` reload budget (93ms of 3ms samples) and
the startup-warning tmux probes (51ms). Both are now out of the launch path.

`AuthCredentialProvider::cached_snapshot()` is a new trait method that
defaults to `snapshot()`; `OtelAuthCredentialProvider` implements it as an
in-memory-only read, so a cold, missing or unreadable `auth.json` no longer
spends the reload budget (`RELOAD_RETRY_TRIES` x `RELOAD_RETRY_BACKOFF`)
inside the launch window. Its only startup caller is `build_server_provider`,
which uses the snapshot just to seed the exporter's `last_token` fallback;
the export path (`prepare_export` and the 401 retry) still calls `snapshot()`,
so a credential rotated by a sibling process is still observed at the first
export.

The tmux wait loop slept a fixed 15ms per tick, so a healthy query — client
spawn plus one server round trip returns in single-digit milliseconds on a
warm server — paid the tick itself as padding. It now starts at 1ms and
doubles to a 15ms cap (`TMUX_QUERY_POLL_MIN` / `TMUX_QUERY_POLL_MAX`): fast
queries are not padded, and a slow or wedged server keeps the same bounded,
low-CPU cadence.

| Run (interleaved) | Binary | `connect finished` → `app_init` | `startup complete` | Prompt rendered |
| --- | --- | ---: | ---: | ---: |
| b1 / b2 / b3 / b4 | before | 120 / 114 / 117 / 115ms | 820 / 801 / 802 / 793ms | 1041 / 1019 / 1017 / 1011ms |
| c1 / c2 (control) | before | 126 / 118ms | 827 / 804ms | 1075 / 1038ms |
| a1 / a2 / a3 / a4 | after | 1 / 1 / 1 / 0ms | 592 / 590 / 602 / 596ms | 810 / 806 / 833 / 807ms |

Medians: the gap 116ms → 1ms, with the control pair — the same before binary
run later in the session — at 122ms, so the floor is not drift; `startup
complete` 801.5 → 594.0ms; prompt rendered 1018 → 808.5ms. The phase
deltas between b2 and a2 are confined to the removed work: `acp_initialize`
422 → 416ms (host noise), `eager_auth` 455 → 450ms, `app_init` 569 →
451ms, `session_create` 645 → 484ms.

The sampler pins the attribution to those two functions: in the before run
`OtelAuthCredentialProvider::snapshot_inner` holds 31 main-thread samples
(93ms at 3ms each), every one of them inside
`AuthManager::force_reload_from_disk`, and `collect_tmux` 18 samples (54ms);
in the after run there are no `snapshot_inner` or `force_reload_from_disk`
frames at all and `collect_tmux` is down to 4 samples (12ms) — the probes
still run in a tmux-backed pane, they just no longer pad every query.

### Verification for this section

- Ten interleaved launches of the real launcher (`b1 b2 a1 a2 b3 a3 c1 b4 a4
  c2`) over a loopback gateway and OTLP collector with an isolated
  `HOME`/`DSH_HOME`/`DSC_HOME`, ports 8731-8732; `series.log` and the
  `*.out.json` timelines are in the archive below. macOS arm64 under
  sustained foreign load (load average 9.14-9.69), so these milliseconds are
  upper bounds and only same-session comparisons hold.
- Binaries: before
  `49c2d330d53b99bf53ed2f4f62c740fc8bba6d8740bc73b7a605259fd8ab450a` (the
  four product files of this change stashed out of the working tree for the
  build), after
  `b6ffa93bd9a95f7e43a3f5c07b2c85dbd9e45335d4c3b6a73f9846046d06013b`; the
  tree was restored byte-identically between the two builds
  (`shas-worktree-edited.txt` / `shas-worktree-restored.txt`).
- Stack attribution: `/usr/bin/sample`, 5 seconds at 3ms run time between
  samples, main thread filtered, process held open past the sample window so
  the call graph is written (`bs.sample.txt` / `as.sample.txt`). The two runs
  sampled without the linger (`b2`/`a2`) exited inside the sample window and
  hold an empty call graph.
- Crate gates: `cargo test -p xai-grok-pager-render --lib` 1103 passed / 0
  failed / 2 ignored, against a pristine baseline of 1101 passed / 2 failed at
  this revision — the two failures are test-side expectations that lagged the
  product and are fixed in this change (the clipboard feedback contract wanted
  the old `grok wrap` literal at `clipboard/mod.rs:2149`, the product emits
  `dscode wrap` at line 378; the image-overlay transmission test wanted
  placement id 0, the product clears `clear_kitty_image(1)` for
  `KITTY_PLACEMENT_ID = 1` at `terminal/image.rs:485`); `cargo test -p
  xai-grok-auth --lib` 1 passed; `cargo test -p xai-grok-shell --lib
  credential_provider` 17 passed; `cargo test -p xai-grok-telemetry` 228 unit
  tests plus all 11 integration binaries pass.
- `scripts/check.sh`, `node --test scripts/*.test.mjs` (43 passed / 1 skipped,
  44 total) and `git diff --check` pass.
- Raw evidence:
  `.git/integration-backups/perf-tmux-auth-2026-09-18-evidence.tar.gz`,
  SHA-256
  `8a937d2e76adf3b1ae045cd54cbb1e29c8a22b7686a9defe7077bf57ce6768c7`.

This section changes product code under `third_party/grok-build`, so it
reopened the Linux acceptance threshold. The re-run at `6736f162`, the head
that contains it, executed the approved threshold green (15-case
built-provider matrix, `check.sh`, script and bridge suites on Node 22.19.0
and 24.19.0) with a supplementary Linux compile and test of the changed
crates, so `6736f162` is the last accepted Linux revision
(`docs/linux-acceptance-2026-09-17-main.md`).

## 2026-09-17: sustained product-loop soak

`scripts/soak-product-loop.sh` runs the real product loop for hundreds of
consecutive turns: the real TUI binary, a real pinned `dsh` profile, the real
bridge and leader, and a local streaming gateway that answers one
deterministic turn per prompt (a bash tool step every fifth turn by default,
so the loop under test includes the tool round trip). It records per-turn
latency next to TUI and leader RSS and descriptor counts, tags every reply per
window so a reply delivered to the wrong client fails the run, and checks that
the leader outlives its clients and then exits inside its 2000ms idle window.
A drift, leak, misroute or premature leader exit is a failing row rather than
an anecdote.

| Turns | Windows | Rows | Errors | p50 | p90 | max | first 5 | last 5 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 200 | 1 | 200 | 0 | 52ms | 84ms | 251ms | 251, 52, 51, 52, 85 | 50, 51, 48, 49, 79 |
| 200 | 1, 150ms pause | 200 | 0 | 50ms | 82ms | 205ms | 205, 52, 48, 48, 83 | 49, 50, 50, 48, 80 |
| 400 | 1 | 400 | 0 | 50ms | 83ms | 149ms | 149, 51, 49, 50, 80 | 50, 49, 53, 52, 82 |
| 60 | 2 | 120 | 0 | 69ms | 107ms | 371ms | 371, 370, 66, 75, 63 | 69, 65, 66, 108, 109 |

Latency does not drift. The last five turns of every run sit at its median,
including the 400-turn run whose final turn is 82ms; the first turn is the
outlier in all of them because it pays for the session's first request.
Provider wait (keypress to the gateway receiving the request) holds at 26ms
p50 / 29-31ms p90 for one client (27ms p50 in the loaded 200-turn run) and
32ms p50 / 39ms p90 for two. Per-step, a
tool turn costs about 33ms over a plain turn (83ms vs 50ms p50 at 400 turns),
which is the bash round trip plus its extra model request, and the two-client
run costs about 17ms per row because two clients poll one leader. Boot to the
leader socket and the model row was 1.5-2.3s for one client and 5.1s for two.

| Scope | Run | First | Last | Max | 25-turn segment averages (MiB) |
| --- | ---: | ---: | ---: | ---: | --- |
| leader | 400 turns | 234 | 303 | 310 | 240 268 296 298 299 302 304 306 308 300 299 299 300 300 302 302 |
| leader | 200 turns | 235 | 295 | 301 | 239 271 296 259 264 272 281 290 |
| leader | 200 turns, 150ms pause | 235 | 297 | 302 | 240 255 296 300 300 301 299 296 |
| leader | 60 turns x 2 clients | 231 | 306 | 308 | 249 296 306 |
| TUI | 400 turns | 73 | 83 | 83 | 74 74 75 76 76 76 77 79 80 80 80 82 83 83 83 83 |

Leader RSS is a plateau, not a leak. Growth is confined to the first ~75
turns, after which the 400-turn run stays inside 299-308MiB for the next 325
and the slower-paced 200-turn run oscillates around 296-301MiB. The third run
dips to 259MiB around turn 100 and climbs back to 290MiB, which is V8
collecting, not a second regime. Every request replays the accumulated
conversation, so the rise tracks transcript size: the request body grows from
36KB on turn 1 to 87.5KB on turn 400 and 98KB on the last request of the run.
TUI RSS climbs about 10MiB across 400 turns (74 -> 83MiB) and descriptor
counts stay flat throughout (leader 40-41, TUI 38-39, and 37 per client plus
43-46 for the leader in the two-client run).

The exit contract held in all four runs: `leaderExit` read
`exited-after-2000ms` and `lastClient` read `alive-with-N-of-N-client(s)`, so
the leader stayed up while any client was attached and exited on its own once
the last one was gone. Cross-talk was 0 rows everywhere, and no orphan
process or tmux server remained after any run; the harness fails the run when
a window renders another window's tagged reply.

Run it with `SOAK_TURNS=200 bash scripts/soak-product-loop.sh`, or
`SOAK_WINDOWS=2` for the concurrent-client lane. Knobs: `SOAK_TURNS`,
`SOAK_TOOL_EVERY`, `SOAK_WINDOWS`, `SOAK_PAUSE_MS`,
`SOAK_TURN_TIMEOUT_S`, `SOAK_SESSION_ID`, `SOAK_PORT`,
`DSCODE_E2E_OUT_DIR`; it reuses an existing payload through
`DSCODE_RELEASE_DIR` and otherwise builds the pinned runtime. Each window
gets its own session UUID, because `--session-id` rejects anything that is
not a bare UUID. Evidence: `/tmp/dscode-soak-f200`, `/tmp/dscode-soak-f200p`,
`/tmp/dscode-soak-f400` and `/tmp/dscode-soak-win4` hold `turns-*.jsonl`,
`samples-*.jsonl`, `crosstalk-*.jsonl` and the summary JSON. These are
loopback results against a synthetic gateway on Darwin arm64 with the pinned
runtime, taken while the host ran at load average ~6; they do not measure real
provider latency, daily CPU, Linux systemd behaviour, or retained heap (the
pinned launcher offers no `--expose-gc`), and RSS is whole-process, including
V8 heap growth and fragmentation.

## 2026-09-17: cancellation lane and descriptor attribution

`SOAK_CANCEL_EVERY` (default 0, off, so the sustained runs above are
unchanged) turns every Nth turn of window 1 into a cancel probe instead of a
measured turn. The window is asked for a step that never returns on its own:
the fixture's bash command writes this run's own marker path and then sleeps
600s, and the harness sends Ctrl+C only once that file exists, so the keystroke
cannot land on a turn that has not started yet. Immediately before the Ctrl+C
the probe proves the held `sleep` is alive inside this run's own process tree;
a cancel that could never have seen a survivor is recorded as `step-unseen`
and fails instead of passing as a clean one. A passing probe requires the
product's `Turn cancelled by user` marker, the held step reaped inside
`SOAK_CANCEL_TIMEOUT_S`, and the neighbouring windows still rendering their
own turns next to it. The failing statuses are `no-start`, `no-cancel`,
`ghost-ok` (the turn completed anyway), `failure-text` (a startup failure
such as `before its bootstrap consumed`), `step-alive`, `still-busy` and
`step-unseen`; each writes its row to `cancels-*.jsonl`, saves the pane
scrollback to `cancel-*-turn-<turn>-w<window>.txt`, and fails the run at the
end.

| Turns | Windows | Cancel every | Probes | Statuses | Step sighted | Hold p50/max | Cancel p50/max | Cross-talk | Leader exit |
| ---: | ---: | ---: | ---: | --- | ---: | --- | --- | ---: | --- |
| 10 | 2 | 2 | 5 | 5 ok | 5 | 69ms / 71ms | 47ms / 52ms | 0 | exited-after-2000ms |
| 200 | 2 | 10 | 20 | 20 ok | 20 | 64ms / 163ms | 51ms / 99ms | 0 | exited-after-2000ms |

`holdMs` is keypress-to-marker, `cancelMs` is Ctrl+C-to-`Turn cancelled by
user`, and `SOAK_CANCEL_DELAY_MS` (default 250) is the pause between the live
step and the keystroke. `SOAK_CANCEL_TIMEOUT_S` (default 30) bounds both the
wait for the marker and the wait for the step to be reaped. A probe that fails
mid-turn cancels its own window so the rest of the run still measures turns, and
any step it found alive is terminated from the run's cleanup.

The lane first reported a fixture bug, not a product one: the runtime appends a
context snapshot after the prompt it belongs to, and the fixture matched its
hold prompt against the last user message only, so the first probe of a run
reported `no-start` for a turn that had started (`/tmp/dscode-fd-dense`). The
fixture now scans user messages backwards for both prompt families, and answers
a hold prompt whose step already returned with a plain reply so a post-cancel
re-request cannot start a second `sleep`. The regression case is the
every-turn lane: 6 probes, 6 ok, first probe included (`/tmp/dscode-fd-attr`).

Descriptors in the loop are attributed to the HMR user-patch watcher, not to
the skill provider. A 120-turn tool-step run grew the leader from 42 to 160
descriptors with one descriptor per created file while the TUI stayed flat at
38 (`/tmp/dscode-touch-long`). An `fs` hook on the leader
(`/tmp/soak-hook-variant.sh`, log `/tmp/dsh-fd-hook.log`) put every new
handle in chokidar's `_handleDir`/`_handleFile` path on the turn's marker
file inside `$DSH_HOME`. The registering code is `dsh`'s profile boot: it
watches the home patch layer `$DSH_HOME/cordis.patch.yml` and the profile's
own `cordis.patch.yml` through `hmr.registerConfig`, which resolves an
existing directory with `findWatchRoot` (here `$DSH_HOME`, depth 0) and then
calls `chokidar.watch`, so the directory and every regular file directly
inside it each hold one descriptor
(`@deepseek-ai/dsh/lib/profile-boot-*.js`, `cordis-plugin-hmr/lib/index.js`
and `chokidar/esm/handler.js` in the pinned `0.1.5-rc.2` runtime). A
standalone reproduction of that watch shape holds one descriptor per direct
file and releases it on unlink (21 with the directory watch ready, 26 after five
files, 23 after three were removed, 21 after the rest,
`/tmp/dscode-chokidar-check`), so the growth is bounded by the files left in
that one directory rather than by turn count. The skill provider
is narrower: it watches `<project>/.dsh/skills`, `<project>/.agents/skills`,
custom directories, `$DSH_HOME/skills`, `$AGENTS_HOME/skills` and the
bundled directory at depth 1, and only while the root exists — a missing root
degrades to `fs.watchFile` stat polling, which holds no descriptor
(`dsh-skill-filesystem/lib/index.js`, same runtime). No watcher covers the
workspace root, so files an agent writes inside a repository consume no
descriptor; what this run measured is the soak writing one marker per turn
directly into `$DSH_HOME`, a directory a real host keeps to a handful of files
(`settings.yaml`, `settings.yaml.lock`, `runtime-paths`).

## 2026-09-17: terminal readiness polls under the kernel reader

The Darwin inspection cost that the "Profiling and deferred work" section below
left as a follow-up priority is discharged by the kernel reader at `20b6c546`;
that change and its source-level numbers are recorded under the 2026-09-15
kernel observation section below. Its contract is intact: every readiness poll
still reads the complete process table, every signal still rechecks its target
identity immediately, and no cache, polling interval, or adaptive schedule was
added.

The production path was re-measured on both sides with
`scripts/bench-macos-process.mjs`: a real `node-pty` bash with eight sleep
children, 20 foreground polls per run, Node 24.19.0 on Darwin arm64. The runs
alternate between the two implementations; four cover each quiet condition and
two each loaded condition. The load lane grew this host's table with detached
`sleep 600` children and reaped them afterwards (1,022 → 4,028 → 1,025, in
`meta.txt`; the `ps` lane loaded to 3,933).

| Live processes | Inspector | Poll median | Teardown median | Teardown full-table reads | Teardown point reads |
| --- | --- | ---: | ---: | ---: | ---: |
| ~1,020 | pinned `ps` | 21.0–21.6ms | 148–157ms | 18.5–19.7ms × 7 | 1.8–2.1ms × 8 |
| ~1,020 | kernel reader | 0.38–0.48ms | 28.7–29.6ms | 0.21–0.34ms × 8 | 0.03–0.05ms × 8 |
| ~4,000 | pinned `ps` | 51.5–51.7ms | 362–369ms | 48–49ms × 7 | 2.1–2.3ms × 8 |
| ~4,000 | kernel reader | 1.81–1.92ms | 13.9–14.4ms | 1.1–1.3ms × 7 | 0.24–0.29ms × 8 |

Poll figures are per-run medians of the 20 measured polls (middle pair
average), reported as the range across runs; read figures are per-call averages
over the reads a teardown performed. A poll is one full-table read plus one
selected-PID read, so the poll column tracks the full-table column: at the same
table the kernel reader's poll is roughly fifty times cheaper, and the gap
widens with the table — about 10ms per 1,000 further live processes for `ps`
(21 to 52ms) against about 0.3ms for the kernel reader (0.4 to 1.9ms). The
selected-PID read that identity rechecks use barely moves with the table on
either side, which is why the point-query backport already covered
signal-and-teardown rechecks. Teardown includes real process exits and is the
noisier column; it is reported for completeness, not as an independent query
cost. Absolute `ps` cost tracks host state, which is why this pass quotes a
fresh baseline instead of reusing the 33.7–36.7ms poll medians the 2026-09-15
pass recorded.

For the deferred note that named this priority, the consequence is direct: the
30 inspections a Python REPL operation paid at 200ms polling, measured then at
372–377ms of synchronous process-query time, now cost single-digit milliseconds
of query time at a quiet table. Readiness latency is still the poll interval,
which is unchanged, and every read remains a fresh kernel observation, so the
note's "keep fresh process identity checks" constraint holds without a cache.

The reader itself was cross-checked against the platform oracle after these
runs: over 11 passes on a live ~1,022 process table, `readMacProcessTable()`
and `/bin/ps -axo pid=,ppid=,tpgid=,etime=` agreed row for row, with zero
parent-PID or tpgid differences, `started` always within the same second as
the `ps`-derived start (worst drift 0.98s) and no row the reader reported that
`ps` did not; the single row `ps` saw that the kernel read did not was a
process created between the two reads.

Per-run JSONL, both source trees, both load lanes and `meta.txt` are in
`/tmp/dsc-termcheck.AOEarS`; the earlier session's quieter pair (20.1–20.6ms
before, 0.29–0.36ms after on the same harness) is retained in
`/tmp/dsc-termpoll.7HXYED`. Reproduce one side per run with:

```sh
node --experimental-transform-types scripts/bench-macos-process.mjs /path/to/dsh-source 4
```

No production code, polling setting, or cache policy changed in this pass.

## 2026-09-17: session-picker cost at store scale

`x.ai/session/list` answers thirty rows, but it folds every session in the
listed working directory before sorting and slicing, so a pass costs what the
directory stores rather than what it returns. The retention section below
fixed what a pass does to its own cached entries; this section measures what
one costs as the durable store grows, next to the store the picker reads on
this machine.

| Stored sessions | Cold pass | Warm passes | One changed session | Retained index | Peak RSS |
| ---: | --- | --- | --- | ---: | ---: |
| 22 | 27.9ms, 22 opens, 2,640 events | 3.9–4.9ms, 0 opens | 4.6ms, 1 open | below this method's noise | 130.7MiB |
| 300 | 248.4ms, 300 opens, 36,000 events | 44.8–46.3ms, 0 opens | 50.1ms, 1 open | 1141.4KiB | 202.2MiB |
| 900 | 701.2ms, 900 opens, 108,000 events | 131.0–132.7ms, 0 opens | 136.9ms, 1 open | 1492.8KiB | 271.4MiB |
| 1800 | 1383.9ms, 1800 opens, 216,000 events | 264.8–280.8ms, 0 opens | 284.7ms, 1 open | 1832.4KiB | 272.3MiB |
| 1800 (second run) | 1390.7ms, 1800 opens, 216,000 events | 255.5–263.7ms, 0 opens | 264.3ms, 1 open | 1843.1KiB | 266.3MiB |

Each row is one JSONL root in the product's own `session.v3.jsonl.zstd`
layout, 120 events per session, three lists and one changed session,
`--strict`, Node 24.19.0 on Darwin ARM64. The runs' `violations` lists are
empty, so the counting assertions and the timings come from the same passes:
a cold list opens and reads each candidate exactly once, every warm pass opens
nothing, and the changed session costs one open and its 121 events. The
retention result below therefore holds at all five sizes, and the second 1800
run repeats the first inside 1%.

A warm pass that opens no log is still not free, because it takes a fresh
store snapshot first. `scripts/bench-session-list.mjs` now reports that share
per pass, which is the pinned backend's own walk of every project and session
directory:

| Stored sessions | Warm pass | Inside the store snapshot | Everything else | Per stored session |
| ---: | ---: | ---: | ---: | ---: |
| 22 | 3.9–4.9ms | 3.7–4.9ms | under 1ms | 0.20ms |
| 300 | 44.8–46.3ms | 44.3–45.6ms | about 1ms | 0.150ms |
| 900 | 131.0–132.7ms | 129.5–131.3ms | about 1.5ms | 0.145ms |
| 1800 | 255.5–280.8ms | 253.1–277.9ms | 2–3ms | 0.145ms |

Warm cost is linear in stored sessions at about 0.15ms each, and the snapshot
is 95% of a pass at 22 stored sessions and 98–99% of one from 300 up, so that
growth is not removable from outside the persistence contract: a cached
listing would answer a pass with a store state a session created a moment ago
is missing from, which is the assertion the changed-session column above
carries. The point-query section below is the same trade taken where the
contract does allow it — one pinned id answered by its own directory and
header, 0.2–0.5ms against this walk's 253–278ms in the same runs.

The store this picker reads on this machine holds four project directories and
22 sessions in 820KiB under `~/.dsh/sessions`, all `session.jsonl.zstd`. Its
real row is the first one: 27.9ms to fold in a fresh leader and 3.9–4.9ms per
later pass. The larger rows are a boundary rather than a present problem.

Cold cost tracks stored events, not stored sessions. Same 900 sessions, same
900 cold opens, three and a third times the stored events:

| Stored sessions | Events per session | Stored events | Root | Cold pass | Warm passes | Changed session |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 300 | 2,000 | 600,000 | 15.23MiB | 2164.5ms | 47.8–50.1ms | 53.1ms |
| 900 | 120 | 108,000 | 3.52MiB | 701.2ms | 131.0–132.7ms | 136.9ms |
| 900 | 400 | 360,000 | 10.55MiB | 1592.2ms | 132.0–136.9ms | 144.5ms |

Across those points the fold grows by about 3.5µs per stored event and about
0.36ms per stored session, so the deepest row — three hundred sessions of two
thousand events each — first folds in about two seconds in a fresh leader,
while its warm passes stay at the 300-session price. Event size, line lengths
and compression all move that rate, so it describes these stores rather than
every store; the direction is what carries: the picker pays for the history in
the directory, not for the thirty rows it returns.

The picker also lists other working directories as the client switches between
them. 900 sessions across four working directories with `--sweep=true`: the
cold pass folds only the listed directory (225 opens, 27,000 events, 351.7ms),
a first pass over each of the other three folds its own 225 sessions
(338.7–371.7ms each), and the second pass over all four opens nothing
(128.5–133.0ms, all snapshot). Listing elsewhere evicts nothing, which is the
property the retention section below was written for.

No production change followed from this pass. At the store shapes this product
has, a picker pass costs single-digit milliseconds, and the term that grows
with the store is inside the pinned SDK's listing, where no contract-safe
cache exists. What the numbers buy is the boundary: the fold is paid on the
first listing of a directory in each fresh leader, so a machine whose history
reaches thousands of sessions or hundreds of thousands of events in one
directory would notice it on its first picker open after a launch rather than
in steady state.

Reproduce:

```sh
node --experimental-transform-types --expose-gc scripts/bench-session-list.mjs 1800
node --experimental-transform-types --expose-gc scripts/bench-session-list.mjs 300 --events=2000
node --experimental-transform-types --expose-gc scripts/bench-session-list.mjs 900 --projects=4 --sweep=true
```

Evidence: `/tmp/dscode-picker-scaling/bench-*.json` holds each run's summary
(`bench-22.json`, `bench-300.json`, `bench-900-a.json`, `bench-900-p4.json`,
`bench-900x400.json`, `bench-300x2000.json`, `bench-1800-a.json`,
`bench-1800-b.json`). `indexRetainedKiB` is a post-GC heap delta taken across
the fold, so at depth it also carries whatever the fold still holds rather
than a per-session constant. Measurements are local macOS numbers for one
module path against local stores, not a whole-application speedup, and peak
RSS is whole-process across a run, seeding included.

## 2026-09-17: pinned session ids answer with a point query

`session/new` and `session/fork` refuse a client-supplied id that a stored
session already owns, and that membership test ran the full store listing:
`(await store.list()).some(({ header }) => header.id === id)`. A pinned request
paid for every other session in the store — every project directory, every
session directory, and a header read per log — to compare one id, and it paid
again on each pinned create or fork. Over 300 stored sessions that snapshot
costs 49.7-56.2ms (`snapshotMs`, 52.0ms on Node 22.19.0) against the same
harness.

`persistedSessionIdInUse` now resolves the id's own directory and header
(`store.stat(id) !== undefined`): 0.2ms for a stored id and 0.1ms for a free
one in the same run, both reported by the `pointQueryMs` median-of-five that
`scripts/bench-session-list.mjs` now measures beside `snapshotMs`. The
substitution is exact against the pinned backend rather than merely narrower:
`stat` returns `undefined` only when the session does not exist, it sees
created-but-unmaterialized sessions through the same tracker as `list`, and it
verifies the stored header against the requested id before answering, so a match
still means the same thing. The narrower query also drops a failure mode the
listing carried: `list()` reads a header for every stored session, so one
unrelated session whose header cannot be read (a permission error, a retired
header field, a filename/version mismatch) failed the check for every pinned id,
where `stat` only touches the id in question.

| Question | Cost | Work |
| --- | ---: | --- |
| `list()` snapshot, 300 stored sessions | 49.7-56.2ms | every project and session dir, one header per log |
| `stat(id)`, stored id | 0.2ms | one id, one header |
| `stat(id)`, free id | 0.1ms | one id, one directory probe per project |

This is a per-request cost, not a per-keystroke one: the picker's listing path
is unchanged and still folds the store. Before is `9bd0d4a0`, after is this
change; every number above comes from one JSONL root per run, 120 events per
session, three lists, `--strict`, Node 24.19.0 on Darwin ARM64.

Regression coverage sits in `tests/session-lifecycle.spec.ts` ("answers one
pinned durable id with a point query instead of listing the store"): it closes a
session, pins its id through `session/new`, and requires `stat` called once
with that id while `list` is never called; it then checks that a live duplicate
is refused before persistence is consulted and that a free id still composes. On
the previous revision it fails with `Number of calls: 0`.

## 2026-09-17: session-picker retention past the first-prompt cap

`x.ai/session/list` folds every session it can see before sorting and slicing,
but the first-prompt LRU behind it was capped at 100 entries
(`DEFAULT_FIRST_PROMPT_CACHE_LIMIT`). A single pass over a working directory
taller than that cap evicted its own earliest entries, and because eviction also
drops the cached revision, every later pass re-opened and refolded them. The
retained set never converged, so the picker's warm cost grew with the store
instead of with the size of the answer.

`SessionListIndex.retainFirstPrompts(candidates)` now reserves room for one
pass before `list()` inspects its candidates. The cap grows monotonically to
the resident set plus that pass (`size + candidates`), which is exactly the
number of entries a pass can insert, so no entry a pass or a later pass may
reuse is evicted. Raising the cap preserves the existing revision semantics:
only eviction still clears a cached revision. `firstPromptCacheLimit` is no
longer `readonly`.

Before is `c7589a68`, after is this change. Both columns are the same harness
against the same pinned SDK: one JSONL root per run, 120 events per session,
three lists, `--strict`, Node 24.19.0 on Darwin ARM64.

| Stored sessions in cwd | Phase | Before | After |
| ---: | --- | ---: | ---: |
| 30 | warm passes | 0 opens | 0 opens |
| 100 | warm passes | 0 opens | 0 opens |
| 101 | warm passes | 1 open per pass | 0 opens |
| 300 | warm passes | 200 opens, 174.4–184.1ms | 0 opens, 43.6–47.1ms |
| 300 | after one changed session | 200 opens, 198.6ms | 1 open, 47.5ms |
| 300 across 8 cwds | second directory sweep | 300 opens | 0 opens |

The 101-session row is the cliff: one entry over the cap made every warm list
re-read a log. At 300 sessions each warm pass refolded 24,000 events and
re-validated them through `adoptSessionEvent`; the after column refolds none,
and a single changed session costs one open instead of the whole store. The
cold pass is unchanged (300 opens, 270.2ms after vs 273.5ms before), as are
stores at or below the old cap. Retention paid for this: at 300 sessions the
index holds 1167.9KiB above the pre-list heap (`indexRetainedKiB`, two GCs
before sampling) against 1228.4KiB before, and peak RSS was 222.1MiB against
211.2MiB — a range repeated across runs, so it is not a measured regression.
Growth is bounded by the union of the directories the picker has listed, not
by the whole store per pass, and each entry is a first-prompt string the row
would carry anyway.

`scripts/bench-session-list.mjs` gained the directory sweep (`--sweep=true`),
which lists every cwd twice and asserts a second pass re-opens nothing; it also
had a use-before-initialization crash on `counters` that made every run die at
module evaluation, now fixed. Regression coverage sits in two specs:
`tests/session-list.spec.ts` raises a cap below the pass and ignores a
non-positive reserve, and `tests/session-discovery.spec.ts` drives 150 stored
sessions through the real picker and requires warm passes to open nothing
(it fails on the previous revision with 250 opens instead of 150).

Full bridge suite: 934 tests in 47 files on Node 22.19.0 and 24.19.0; the 44
release/runtime/gateway script cases, `scripts/check.sh` and `git diff --check`
pass. Measurements are local macOS numbers for one module path, not a
whole-application speedup, and no product E2E was rerun for this change.

## 2026-09-17: workflow queries and macOS process reads under load

Two stress lanes checked the readers that long sessions and large process
trees actually scale against. Neither found a bottleneck, so no production
code changed. The pass also repaired the benchmark behind the historical
workflow numbers.

### Workflow projection queries

`scripts/bench-workflows.mjs` still drove the removed `WorkflowIndex` API, so
its documented reproduction threw `TypeError: Cannot read properties of
undefined (reading 'filter')` at `workflows.ts:35` (`d119625e` had moved
workflow history to the host-only `dscodeWorkflows` projection owned by the
pinned native registry). It now drives the production path: a real
`SessionStore` and `SessionProjectionRegistry` with `workflowProjection`
registered, one `workflowUpdates` query per transition, and every
`snapshotEvents`, `eventAt` and `ownEvents` call counted. The workload stays at
200 members and 402 workflow transitions behind the unrelated prefix, spread
over four phase titles instead of one.

| Prior unrelated events | Fold per transition | Query per transition | Warm history reads | Seeded rebuild, once |
| --- | ---: | ---: | ---: | ---: |
| 100,000 | 0.006ms | 0.029ms | 0 | 176.46ms |
| 1,000,000 | 0.006ms | 0.029ms | 0 | 1791.43ms |

Medians of three runs on Node 24.19.0 / Darwin ARM64, where the per-transition
columns are medians over the 402 transitions inside each run. Fold and render
cost do not grow with prior history, and the 402 warm queries read no history
at all, which is the property `tests/workflows.spec.ts` still asserts. The
seeded rebuild is the one-time resume fold a checkpoint-less session pays.
Appending the unrelated prefix cost 244.04ms and 2309.24ms (2.3–2.4µs per
event); those two figures are the registry's per-append fold, and this
benchmark does not separate this module's type guard from it. Node 22.15.0
with `--experimental-strip-types` (below the pinned 22.19.0 floor) reproduced
the same shape: 0.033ms per query, 187.96ms and 1997.05ms for the seeded
rebuilds. These are synthetic projection workloads, not whole-application
speedups.

### macOS process-table reads under load

The kernel `KERN_PROC_ALL` / `KERN_PROC_PID` reader was measured against a
process table grown by 1000 detached sleeps per level, then reaped.

| Live processes | Full-table median | Point-query median |
| ---: | ---: | ---: |
| 985 (baseline) | 0.223ms | 0.025ms |
| 1,983 | 0.847ms | 0.121ms |
| 2,983 | 1.234ms | 0.235ms |
| 3,982 | 1.971ms | 0.438ms |
| 4,981 | 2.864ms | 0.907ms |
| 5,981 | 2.780ms | 0.652ms |
| 6,981 | 3.268ms | 0.733ms |
| 981 (all 6000 children reaped) | 0.158ms | 0.024ms |

Medians of 11 reads per level on this 16-core host. Full-table reads cost
about 0.5ms per 1000 live processes and stayed under 3.3ms at roughly 7000
processes; point queries stayed under 1ms. Both fit the readiness-poll and
signal-recheck budgets this reader serves, so the macOS inspector keeps its
whole-table reads with no added cache or polling change. The harness left no
processes behind: `pgrep -f 'sleep 601'` matched nothing afterwards and the
table returned to its baseline size.

Raw JSONL and harness (`read-bench.mjs`, `load-stress.mjs`,
`sysctl-stress-24.jsonl`, `bench-workflows-{22,24}-runs.jsonl`) are in
`/tmp/dscstress.xsbh7c/`. The workflow benchmark runs where the bridge's
dependencies are installed; from a checkout without them, point it at an
installed bridge tree:

```sh
node scripts/bench-workflows.mjs 100000 200
node scripts/bench-workflows.mjs 1000000 200
node scripts/bench-workflows.mjs 100000 200 /path/to/installed/bridge/grok-leader/
```

### Session retained memory

A leader that keeps one session open holds three layers: the pinned DSH session
log itself, the two bridge projections the leader registers (`dscodeWorkflows`,
`dscodePresetHistory`), and the session-list index that observes every event
plus the readers that walk history. `scripts/bench-session-memory.mjs`
appends one coding turn (four tool round trips, a 3KB result per step, 12 events
including the periodic title update) and reports the heap the session still
retains after two forced collections, once per layer.

| Mode | Retained at 2,000 turns / 24,100 events | Per event | Per turn |
| --- | ---: | ---: | ---: |
| log | 37.874 MiB | 1647.9 B | 19,857 B |
| projections | 37.922 MiB | 1650.0 B | 19,882 B |
| leader | 38.158 MiB | 1660.2 B | 20,007 B |

Medians of two runs on Node 24.19.0 / Darwin ARM64, agreeing to 0.03 MiB; Node
22.15.0 (with `--experimental-strip-types`, which the harness needs for the
bridge's TypeScript sources) reproduced 1652.5 / 1655.6 / 1663.8 B/event. The
mid-run and final checkpoints keep the second-half slope within 1% of the first
half in every mode (log 1.568 to 1.578, projections 1.573 to 1.577, leader 1.573
to 1.580 MiB per 1,000 events), and the harness asserts that: retention is
linear in appended events, so none of these layers accumulates per-event state
beyond the log. The two projections add 2.1 B/event and the index with its
readers 10.2 B/event.

The first version of this harness reported the last two rows as 1802.6 and
1811.0 B/event. That gap is measurement, not retention. The SDK wraps every
listener dispatch in a containment `Promise.resolve(...).catch(...)`, so an
append loop that never yields leaves roughly 24,000 settled-but-undispatched
jobs parked in the microtask queue when the sample is taken; each parked job
keeps its closure alive and inflates the reading by about 155 B/event. Draining
the queue before the read removes it completely: the same three modes measured
1648.5 / 1650.6 / 1660.3 B/event with no explicit drain but awaits at the
checkpoints, and 1647.9 / 1650.0 / 1660.2 with the current `setImmediate` drain.
A controlled listener probe agreed. Before the drain, adding listeners moved the
reading from 1623.5 B/event (none) to 1777.4 (one), 1872.5 (two) and 1777.3 (the
full projection registry); after it, none, one, two and the registry all landed
between 1623.5 and 1624.7 B/event. The registry costs exactly one `session/event`
listener, and neither the containment promise nor the registration path retains
memory, so no SDK backport was made for it.

Both controls are recorded in
`/tmp/dsc-verify-mac.9f3q/bench-session-memory-controls-24.log`. The harness
needs the bridge's dependencies installed and `--expose-gc`:

```sh
node --expose-gc scripts/bench-session-memory.mjs 2000 /path/to/installed/bridge/grok-leader/ leader
# Node 22 additionally needs --experimental-strip-types for the bridge's TypeScript sources.
```

Verification for this pass: `scripts/check.sh`, 43 script tests with the one
Linux-only skip, and 7/7 `tests/workflows.spec.ts` cases against this
checkout's bridge source. The session-memory harness runs above were taken
after its drain fix. No production code changed in this pass, so the bridge,
Rust and product-E2E gates were not rerun for it; the packaged release and the
installed-product E2E of the same revision are recorded in
[the Linux acceptance document](linux-acceptance-2026-09-17.md).

## 2026-09-15: macOS kernel process observations

The runtime backport reads `KERN_PROC_ALL` / `KERN_PROC_PID` through the existing
Koffi dependency instead of spawning `ps`. Every readiness poll still observes
the complete process table. Every signal still rechecks its target immediately.
Failed, truncated, malformed, or empty full-table reads throw; they cannot prove
that the owned range is empty. No cache, polling reduction, new native artifact,
or lifecycle owner is introduced. Private identities encode epoch seconds with
the same precision; session omission and presence-only liveness remain unchanged.

Six alternating fresh-process pairs per Node version compare `76300cfe`'s
selected-PID `ps` implementation with this kernel reader. Each process uses a
real `node-pty` shell with eight sleep children, performs 20 foreground polls,
terminates it, and verifies all nine observed identities absent. Runs on this
Darwin arm64 host (~1100 processes) did not overlap our build/test jobs.

| Node | Foreground poll median, before → after | Teardown median, before → after | Benchmark CPU seconds, before → after |
| --- | ---: | ---: | ---: |
| 22.19.0 | 36.69 → 0.49ms | 259.18 → 29.09ms | 1.095 → 0.250s |
| 24.19.0 | 33.74 → 0.49ms | 238.73 → 29.00ms | 0.995 → 0.220s |

Poll figures are medians of six per-process medians, recomputed from the raw
20-value `polls` arrays by averaging the middle pair (the original JSONL's
`pollMedianMs` selected the upper middle value). `/usr/bin/time -lp` CPU
figures sum user and system time for the benchmark command and waited children,
including Node startup and teardown; these are not daily application CPU or
overall speedup claims. Reported maximum RSS increased 118.41 → 124.88MiB
(Node 22) and 113.81 → 119.15MiB (Node 24). This run trades about 5–6.5MiB of
measured peak RSS for fewer child processes; it does not attribute allocations
or measure retained heap or steady-state RSS.

Reproduce each side with the same installed source and Node version:

```sh
/usr/bin/time -lp node --experimental-transform-types scripts/bench-macos-process.mjs /path/to/dsh-source 1
```

The source suites passed 61 tests on each Node version, including real host-exit
cleanup. The SDK oracle compiled for arm64 and x64 and asserts every consumed
`kinfo_proc` offset, width and selector. Actual rows match `ps` for the owned
child, caller and another user's PID 1. x64 SDK compilation is not x64 runtime
validation. Documentation checks passed 16 quick and 34 full gates; source
build and lint passed. Fresh plugin/runtime payloads contain the verified patch;
installed-tree provenance validation passed, and the previous consumer at the
same upstream revision was rejected under the new patch identity.

The first full macOS run (**67179**) exposed an independent selection bug:
double-click copying blocks synchronously, so a slow clipboard helper exhausted
the 300ms multi-click window before a queued third click was handled. In the
retained session, the same three clicks with a private 400ms clipboard delay
copied only 77 bytes of a 233-byte URL. Starting the next-click window after
selection handling restores all 233 bytes under the same delay, without changing
the timeout, synchronous copy ordering, or source-preservation assertions. The
generic macOS product E2E now always injects that delay into its private `pbcopy`.

Final acceptance of the rebuilt TUI and new runtime:

- Node 22.19.0 and 24.19.0 each passed SDK TypeScript compilation and all 931
  bridge tests, including four compiled-CLI cases. Each passed 43 script tests
  with one Linux-only skip. Rust mouse/selection suites passed 59 tests;
  formatting, `scripts/check.sh` and whitespace checks passed.
- Full macOS TUI → DSH → bridge → private gateway passed, exit 0, run **92262**,
  with the 400ms clipboard fixture. It covers wrapped table source preservation,
  child history/quoting, native goals/workflows, real TypeScript LSP, persistent
  bash/Python REPL, cancellation/reuse, owner isolation, reaping and durable
  rewind/resume.
- Managed-update E2E passed install, same-version no-op, missing/corrupt native
  repair, legacy-overlay repair, corrupt-asset rejection, composed profiles,
  installed launcher and preservation of user files.

Raw measurements are `/tmp/dscode-mac-snapshot.fKs7LY/bench-final-{22,24}.jsonl`
and `cpu-final-{22,24}.log`; source, payloads and validation logs are in the same
directory. Product evidence is `mac2/contracts-92262/PASS.json`, `mac2-e2e.log`,
`bridge{22,24}-copy-fix.log` and `update-copy-fix.log`. The failed first run and
isolated delayed-copy reproduction remain there for inspection.
The pinned upstream revision remains DSH 0.1.5-rc.2
`fb2c4b9e698e30edb738bca4cf0618587db7d203`; patch SHA-256 is
`5c893b2efa320965d19efa64d33fc24c8d72621fe7a259004533bb29d642a748`.
The digest recorded here by the macOS pass, `5d5ffa35…`, was regenerated when
the Linux settlement correction was merged into the same patch.

Linux/systemd and Linux packaging were not rerun. Optional Kitty-image
acceptance, physical Cmd-click, IME and the host clipboard remain untested in
this pass. Fixtures stayed private. No push, release publication or daily-profile
installation was performed.

The subsequent [current-main Linux acceptance](linux-acceptance-2026-09-16.md)
found an early-cancellation failure in the unchanged pinned Linux scope owner;
the macOS pass does not clear that separate release gate. The
[combined Linux settlement acceptance](linux-acceptance-2026-09-17.md) merged
that correction into this backport at `f5052559`; the built-provider matrix
that failed on main then passed all 15 cases on both Node versions, together
with the source, script, bridge, snapshot, updater, E2E and audit gates.
Two production commits landed after that settlement; the same host
re-accepted the revision main carries today as [the current-main
re-acceptance](linux-acceptance-2026-09-17-main.md).

## 2026-09-15: macOS current-identity checks (76300cfe)

At `76300cfe`, the source runtime backport selects one PID for `isAlive` instead of reading
the full process table. It compares the same start timestamp immediately before
signalling, without a cache or polling change. Tree snapshots still enumerate
all processes. Only status 1 with empty stdout/stderr from a selected-PID query
means absence; other failures propagate. Existing macOS timestamp precision
and observational containment limits are unchanged.

Six alternating fresh-process pairs per Node version exercised the actual
`LocalTerminalHandle` with a real `node-pty` bash and eight sleep children.
All nine observed identities were checked absent after teardown in every run.
Baseline is official DSH `fb2c4b9e698e30edb738bca4cf0618587db7d203`; candidate
is that commit plus the source backport stored at `76300cfe`.

| Node | Teardown median, before → after | Full-table / point queries, before → after |
| --- | ---: | ---: |
| 22.19.0 | 351.59 → 182.81ms | 15 / 0 → 7 / 8 |
| 24.19.0 | 298.64 → 153.38ms | 15 / 0 → 7 / 8 |

These are local macOS adapter measurements, not overall application speedups
or sustained CPU claims. Host process count/load affects absolute timings;
the Node 22 run overlapped documentation/build checks. Full-table readiness
polls remain a separate cost. A 40-pair raw `ps` probe on this host (~1089 rows)
measured 19.11ms full-table versus 1.79ms selected-PID medians.

Reproduce with dependencies installed in both source checkouts:

```sh
node --experimental-transform-types scripts/bench-macos-process.mjs /path/to/dsh-source 6
```

Focused inspector/terminal suites passed 50 tests on each Node version.
Upstream documentation checks passed all 16 quick and 34 full gates; lint
passed. Fresh official-source plugin and macOS runtime builds include the
verified patch; the compiled runtime's identity check uses the selected PID.
An old, unpatched consumer at the same upstream revision was rejected.

Final acceptance:

- Node 22.19.0 and 24.19.0 each passed the SDK TypeScript build and all 931
  bridge tests, including the four compiled-CLI tests. Each passed 42 script
  tests with one Linux-only skip. `scripts/check.sh` and whitespace checks passed.
- Full macOS TUI → DSH → bridge → private mock gateway passed, exit 0,
  run **9848**. Coverage includes paged child history, quote/undo, native goals,
  workflows, real TypeScript LSP, persistent bash/Python REPL, cancellation,
  reuse, owner isolation, process reaping, rewind and durable history.
- Managed-update E2E passed installation, same-version no-op, native-file
  repair, corrupt-native repair, legacy-overlay repair, corrupt-asset rejection,
  installed launcher, composed profile and preservation of user fixture files.
- Earlier run **73548** also passed the complete product loop. Runs **60145**
  and **89820** stopped at child quotation: a collapsed group consumes the first
  viewer action as expansion. A retained-session reproduction confirmed
  `Enter:expand` → `Enter:open` → `Enter:quote`; acceptance now expands only
  when that state is shown, then separately asserts opening and quoting.
  An attempted selection-only test change did not fix it and was removed.
  No product key binding or quote assertion was weakened.

Evidence lives under `/tmp/dscode-mac-process.5yK4n1`: `bench22.jsonl`,
`bench24.jsonl`, source/build/test logs, the source-built `consumer` and
`packages`, `update-e2e.log`, and `mac4/contracts-9848/PASS.json`. Failed-run
artifacts remain available. The benchmark is separate from these functional
acceptance runs.

Linux/systemd and Linux packaging were not rerun in this macOS pass. Optional
Kitty-image acceptance was skipped; physical Cmd-click, IME and the host's
native clipboard were not exercised. Clipboard fixtures stayed isolated.
No remote push, publication or daily-profile installation was performed.

## 2026-09-15: long-session output replay

`session-output.ts` now drains one owned FIFO instead of building a Promise
chain for every replayed text update. Ordinary and nonvisual events do not
create per-event hydration promises; image hydration remains sequential.
Consumed queue slots are released immediately and compacted amortized-linearly.
The existing interface still owns replay/live deduplication, prompt and turn
stamps, socket backpressure, flush, and disposal. There is no protocol change,
text batching, extra scheduler, or runtime-pin change.

Local Darwin ARM64 measurements: 20,000 synthetic events through the real
output module and length-prefixed JSON encoder into a Writable sink. Each
median uses six alternating fresh processes per revision, without async-hooks
instrumentation; before is `4d7639bf`, after is this FIFO change.

| Node | Text completion, before → after | First update, before → after | Admission heap delta, before → after |
| --- | ---: | ---: | ---: |
| 22.19.0 | 75.30 → 44.45ms | 27.77 → 8.41ms | 34.24 → 16.24MiB |
| 24.19.0 | 74.05 → 46.58ms | 18.23 → 7.20ms | 40.33 → 13.93MiB |

Text completion decreased about 37–41%, and admission heap delta about
53–65%. The heap figure is the change in `heapUsed` immediately after replay
admission, with one GC before measurement; it is not retained heap, cumulative
allocation, or whole-process RSS. Slow-reader completion medians were 337.94 → 308.06ms
(Node 22) and 346.77 → 317.82ms (Node 24); maximum queued writable bytes stayed
16,926 with the same 16KiB high-water mark. Nonvisual replay completion was
9.21 → 3.95ms and 6.88 → 2.78ms, respectively.

All text and slow-reader runs produced the same 10,928,784 wire bytes and
SHA-256 `ac1b00dafa3a0765e230f11fc6f8878c5c35386e9c48776f4631ec552ccb4c02`.
A separate instrumented text run counted 160,014 → 16 Promise allocations.
Regression tests enforce constant-sized Promise overhead, full-history folding
before the first notification, ordered sequence/prompt ownership, and reentrant
successors behind a slow-reader replay across queue compaction. Existing tests
cover hydration, failures, early rejection observation, and disposal.

Reproduce against two SDK-linked source snapshots with Node >=22.19:

```sh
node --experimental-strip-types --expose-gc scripts/bench-session-output.mjs /path/to/bridge/src/session-output.ts 20000 text
node --experimental-strip-types --expose-gc scripts/bench-session-output.mjs /path/to/bridge/src/session-output.ts 20000 slow
node --experimental-strip-types --expose-gc scripts/bench-session-output.mjs /path/to/bridge/src/session-output.ts 20000 metadata
node --experimental-strip-types --expose-gc scripts/bench-session-output.mjs /path/to/bridge/src/session-output.ts 20000 text --count-promises
```

These are local synthetic replay/transport results, not a measurement of disk
loading, model response time, TUI painting, daily CPU use, or overall speedup.
Evidence is in `/tmp/dscode-output-perf.s3djRK/replay-interleaved.jsonl`.
Pinned-SDK TypeScript compilation passed; Node 22.19.0 and 24.19.0 each passed
925 bridge tests (4 skipped), plus 4 separately enabled compiled-CLI tests.
Release/runtime/gateway script tests passed 37 with one Linux-only skip.
The plugin and Darwin runtime were freshly source-built at the unchanged DSH
0.1.5-rc.2 pin `fb2c4b9e698e30edb738bca4cf0618587db7d203`.

The first full Mac E2E exposed a clipboard-isolation regression: TUI namespace
isolation scrubbed the harness's inherited `GROK_CLIPBOARD_*` switches, allowing
a host clipboard image into a synthetic draft sent to the local mock gateway.
The fix adds explicit `DSCODE_CLIPBOARD_NO_NATIVE_READ` and
`DSCODE_CLIPBOARD_NO_OSC52` aliases, updates the harness, and tests both explicit
alias preservation and ambient Grok-variable removal. This does not alter the
user's clipboard or the product's paste heuristic. Native clipboard/IME testing
remains separate from the generic isolated product suite.

The next full run exposed an existing child-lifecycle race, independent of the
output FIFO: an asynchronous history read fixed its event prefix while the
child was running, then combined that old prefix with a later idle status.
This could emit a false `cancelled` before the real `completed`; the TUI
correctly rejected the second finish as a duplicate and retained the wrong
terminal row. The history reader now captures activity at the same cut as
the event count. No TUI dedup relaxation, new polling, or timeout increase was
needed. A deterministic held-flush test first reproduced `cancelled, completed`
on the old code and now requires exactly one `completed` finish. Existing
latest-attempt interruption and durable-history tests still pass.

Final re-review: pinned-SDK compilation, both Node suites above, the 3 Rust
startup/alias tests, `scripts/check.sh`, Rust formatting, and `git diff --check`
passed. The freshly rebuilt TUI and final plugin passed the **full Mac product
E2E, run 89498**, with the owning process exiting 0:
`/tmp/dscode-output-perf.s3djRK/mac3/contracts-89498/PASS.json`.
This includes child stop/resume and history restart, workflows, real TypeScript
LSP, persistent Python REPL, terminal interrupt/reuse, owner isolation, process
cleanup, rewind, and durable headless history. Clipboard-contaminated failed
artifacts were moved to the local Trash (recoverable), not uploaded.
Native clipboard/IME, physical Cmd-click, optional Kitty rendering and Linux
systemd behavior were not validated by this Mac run. Nothing was published or
installed into the daily-use profile; the Inspector/browser candidate is
unchanged. The separate Darwin native process-inspection cost remains deferred.

## Historical results (2026-09-13)

The sections below record the earlier snapshots and their verification counts;
they are not measurements of the current checkout. Their implemented changes
have since been committed. Temporary evidence paths may no longer exist.

## Implemented: incremental workflow projection

Previously, every workflow transition copied and folded the entire transcript,
then constructed all historical workflow views before filtering the requested
run. `WorkflowIndex.updates` now reads only appended events in pages of at most
512, retains workflow state, and renders only the requested run. A per-session
weak map owns the index. Native session replacement or truncation rebuilds it.
Elapsed time, live phase and interrupted/cold state remain dynamic; returned
views cannot mutate the cached state.

The module interface centralizes read cursors and reconstruction, while the
stateless and incremental paths share their event-folding semantics. No new
protocol, timer, native runtime patch or output batching was introduced.

Observational Node 24.19.0 / Darwin ARM64 measurements, 200 parallel members
and 402 workflow transitions:

| Prior unrelated events | Full reconstruction | Incremental | Events read, before → after |
| --- | ---: | ---: | ---: |
| 100,000 | 192.53ms | 13.35ms | 40,281,003 → 100,402 |
| 1,000,000 | 3148.94ms | 18.36ms | 402,081,003 → 1,000,402 |

These are synthetic projection workloads, not whole-application speedups.
Timing varies with the host; regression tests enforce the event-read bound,
page size, output equivalence, no rereads of unchanged history, and correct
replacement/truncation behavior rather than a fragile timing threshold.

Reproduce with Node >=22.19:

```sh
node scripts/bench-workflows.mjs 100000 200
node scripts/bench-workflows.mjs 1000000 200
```

These numbers describe a bridge-owned `WorkflowIndex` that `d119625e` removed
when workflow history moved to the host-only `dscodeWorkflows` projection, so
the command above now runs the 2026-09-17 benchmark and no longer reproduces
this table.

Verification: pinned-SDK TypeScript compilation passed; Node 22.19.0 and
24.19.0 each passed **18 files / 368 tests**. Full Mac product E2E passed
with profiling enabled, run **11197**:
`/tmp/dscmac-perf/contracts-11197/PASS.json`. This includes live/repeated and
restarted workflows, real PTYs, interrupt/reuse, owner isolation and process
reaping. The existing optional Kitty/physical Cmd-click coverage limitations
still apply. That run did not publish or install the changes.

## Implemented: managed startup without duplicate probes

Healthy source-backed startup previously launched both the TUI and DSH twice
to check their versions. `installationFilesMatch` is now explicitly a file-only
preflight, allowing damaged native files to trigger staged repair before the
launcher tries to load their lock binding. The existing full
`installationMatches` check still probes actual executable versions, once,
inside the exclusive profile lock. Only that result permits reuse of the paths.
A version mismatch releases the lock before starting a repair transaction.
Explicit `DSH_BIN` overrides retain their independent version check; no cached
marker, expiry interval or trust shortcut was added. An unchanged profile
manifest also retains its bytes and modification time.

Six alternating fresh-process samples per version, with the same official Mac
TUI/runtime in isolated healthy profiles and Node's compile cache disabled:

| Node | Before median | After median | Reduction |
| --- | ---: | ---: | ---: |
| 22.19.0 | 132.36ms | 89.86ms | 32.1% |
| 24.19.0 | 138.16ms | 94.05ms | 31.9% |

This measures managed `dscode --version` including real startup validation,
not time to an interactive TUI or first model response. The command still
bootstraps a missing installation. Reproduce with stamped release packages:

```sh
node scripts/bench-launcher.mjs /path/to/before-package /path/to/after-package /path/to/runtime /path/to/tui
```

The new regression cases require exactly one probe per managed executable,
no executable probes/network requests while another process holds the lock,
preserved manifest bytes/mtime, wrong-version repair, and explicit override
validation. Compilation and all **18 files / 373 tests** passed on both Node
22.19.0 and 24.19.0. Logs and benchmark JSON: `/tmp/dscstart.HeRV2P`.

Re-review also exposed host clipboard contamination in the generic Mac E2E:
an ambient image was attached during synthetic bulk input, breaking the exact
CRLF text assertion. A temporary HOME/tmux server does not isolate NSPasteboard.
The harness now disables native image-content reads and OSC52 clipboard writes,
and gives `pbcopy`, `pbpaste` and clipboard AppleScript fallbacks private local
adapters. It does not clear the user's clipboard. Its adapter regression runs
without touching any host clipboard; native clipboard/IME acceptance remains a
separate isolated-user test, not coverage claimed by this suite. The product's
non-Otty synthetic-paste/image heuristic itself was not changed.

## Profiling and deferred work

The full product run produced 48 bridge profiles. Module compilation accounted
for about 10.3% of their non-idle self samples; synchronous child-process calls
accounted for 4.4%. This is a mixture of startup and active workloads, not a
representative daily-use CPU percentage. Native blocking calls can also accrue
non-idle samples. Results and raw evidence are in `/tmp/dscperf.N9nRTi`.

```sh
node scripts/summarize-cpu-prof.mjs /path/to/cpu-profiles
node scripts/bench-startup.mjs /path/to/compiled/bridge/lib/types/index.js
```

The startup benchmark tests Node's actual cache-enabled state and alternates
six fresh processes per condition. Warm compile-cache medians for importing
the bridge graph saved approximately 14ms of process lifetime on both Node
22 and 24 (about 110ms → 96ms). Initial cache population took about 156–157ms;
RSS was slightly higher.

Two later benchmarks closed the launch-level question that import times could
not answer. Both alternate fresh processes and **assert** the switch instead of
assuming it: a disabled boot must leave the cache directory untouched, a cold
boot must populate it, and every warm boot must reuse it without rewriting it.

- **Leader boot** (spawn → socket → `registered` reply), Node 24.19.0, 12 pairs,
  `scripts/bench-leader-compile-cache.mjs`: 369.6ms off → 348.3ms warm, so
  **21.3ms (5.8%)**. The first enabled boot starts from an empty directory and
  paid 25.8ms more than the disabled median, the slowest disabled boot being
  387.7ms; the run's later repeat population, taken after deleting the warm
  directory, ran 431.3ms while the warm boot right after it returned to
  352.7ms, so that late sample carries machine drift too. The population left
  **1483 files / 4.38MB**
  under a per-Node-version subdirectory (`v24.19.0-arm64-cf738c9d-501`) that
  Node creates inside whatever directory it is given.
- **Whole launch** (real TUI, real leader, loopback gateway, `dscode` printing
  one deterministic reply), Node 24.19.0, 8 pairs,
  `scripts/bench-launch-compile-cache.mjs`: the leader's listening moment moves
  459.4ms → 425.6ms (7.4%), but the user-visible milestones barely do — first
  painted frame 801.2ms → 794.2ms (0.9%) and first model reply 955.9ms →
  950.3ms (0.6%), both inside the per-launch spread. The cold first launch cost
  about 20ms more than the disabled one and cached **1756 files / 5.34MB**.

The launch path is what decides the tradeoff, and there the win is about one
percent against a 5.3MB per-Node-version directory plus a first-launch penalty.
The leader's own readiness is 7.4% faster, but the user waits on the session
startup between listening and the first frame, which the cache does not move.
**Not enabled by default**; the leader is an ordinary Node process that inherits
the launcher's environment, so `NODE_COMPILE_CACHE` remains available to anyone
who wants those milliseconds. The TUI itself is a Rust binary, so no default
could cover it anyway. The launch fixture answers from loopback, so its times
exclude provider latency, which dilutes the cache share further rather than
helping it. See the [Node compile-cache documentation](https://nodejs.org/download/release/v22.18.0/docs/api/module.html#module-compile-cache)
for invalidation, per-Node-version caches and coverage caveats.

```sh
node scripts/bench-leader-compile-cache.mjs /path/to/runtime/bin/dsh /path/to/dsh-home 12
node scripts/bench-launch-compile-cache.mjs /path/to/tui /path/to/runtime/bin/dsh /path/to/dsh-home 8
```

The launch benchmark writes the workspace, `dsc-tui` config and provider
settings it needs into its own scratch directory, uses a loopback gateway that
answers `GET /v1/models` and `POST /v1/chat/completions`, and removes the
session directories it created. It refuses to run against a home that already
has a `settings.yaml`.

Raw JSON from this host: `/tmp/dscode-cc/bench-12pairs.json` (leader) and
`/tmp/dscode-cc/fixture/evidence-final/launch-ab.json` (launch), both Node
24.19.0 on macOS arm64 against an isolated copy of a real installed profile;
the two files are archived as
`.git/integration-backups/perf-compile-cache-2026-09-17-evidence.tar.gz`,
SHA-256
`c4c3a307bb22b013ce2cf7f929baee65ae8f3193fc839db33f58bc0a53d00482`.

The terminal baseline was remeasured using the real pinned Bash backend:
200ms polling still costs approximately 30 `ps` calls / 372–377ms of synchronous
process-query time per Python REPL operation, with approximately 3.2s latency.
The 50ms baseline costs 82–84 calls / 1005–1026ms. Short shell commands take
about 250ms at 200ms polling versus 100ms at 50ms. Reducing native inspection
cost without this latency tradeoff is a follow-up priority. Keep fresh process
identity checks for signals/teardown; a stale cache is not an acceptable fix.
The kernel-reader backport recorded at the top of this document discharges that
priority: the same polls cost single-digit milliseconds of query time with
fresh identities and the unchanged interval.

The upstream source inspected at `c291e7961a515f6d7af9304e7fd1d257929aef26`
still uses the same synchronous Darwin `ps` inspection. Its current head is
not a ready-made performance upgrade. The supported configuration exposes a
poll interval, not an adaptive idle scheduler; a private test hook or patched
hashed bundle is not used in production. Any deeper terminal optimization
needs a tested source change with fresh foreground identity and teardown
semantics intact.

Streaming batching has not been introduced: the collected profiles do not yet
justify its event-ordering and cancellation complexity. Runtime/provider
splitting also remains open and needs dependency-closure, cold-install,
capability and footprint measurements; no providers have been removed.

## Final re-review and verification

- Pinned-SDK TypeScript build: passed. Node 22.19.0 and 24.19.0 each passed
  **18 files / 373 bridge tests**, none skipped.
- Script suites on each Node version: **13 passed / 1 Linux-only skipped**.
  System Bash 3.2 script smoke, changed JS syntax, CI YAML parsing and
  `git diff --check`: passed.
- Real managed update E2E passed, including normal-startup native-only repair
  before lock loading, explicit update repair, wrong checksum rejection,
  same-version no-op and preservation of user files. Report:
  `/tmp/dscstart.HeRV2P/update-final/update-PASS.json`.
- Full Mac product E2E passed with the final local package, run **35828**:
  `/tmp/dscmac-final3/contracts-35828/PASS.json`. It covers repeated workflow
  child navigation plus restart, failed-tool decoding, real LSP, Python REPL,
  interrupt/reuse, owner isolation, durable history and actual PTY PID reaping.
  The test worktree was removed and the owning test process exited 0. Log:
  `/tmp/dscstart.HeRV2P/e2e-final.log`.

No new blocking regression was found in this tested scope. The review checked
index ownership/reset semantics, returned-state isolation, notification order,
startup lock/probe ordering and repair-after-unlock behavior. Measurements are
local, not cross-machine benchmarks. Model responses are local fixtures.

Native clipboard content/IME, physical Cmd-click and optional Kitty graphics
are not covered by this generic run; the remaining host/version boundaries in
[macos-review.md](macos-review.md) still apply. The earlier clipboard-contaminated
failed-run artifacts were moved to the local Trash, not uploaded. No Rust or
DSH native source was changed or rebuilt. CI changes have not run remotely.

At that verification, these were uncommitted checkout changes in a temporary
test package. The installed `0.0.14-alpha.12` launcher did not include the
startup optimization; that run did not publish or install a patched release.

## Implemented: leader boot without the MCP SDK and updater

A module census of the dsh leader (`dsh --profile dscode`, official Mac
runtime, compile cache disabled) showed the bridge pulling two dependency
trees into every boot that no boot path uses:

- `mcp.ts` statically imported `@deepseek-ai/dsh-mcp-client`, which drags in
  the MCP SDK, zod's `v3`/`v4-mini` compatibility entry points, ajv,
  zod-to-json-schema and friends. dsh-base does not load this client; it is
  only needed once a client declares `mcpServers`.
- `package-location.ts` statically imported the launcher's `bin/update.mjs`
  (tar, smol-toml, native-runtime) only to reach `withProfileLock`, which is
  used solely by `/dsh add` and `/dsh remove`.

Both edges are now lazy and memoized. `mcp.ts` keeps a type-only import;
`resolveAcpMcpConfigs` is async and returns `[]` for absent/empty declarations
without loading anything, `mountMcpConfigs` returns early on an empty list,
and the two `session/new` / `session/load` call sites await the result. The
profile lock resolves `bin/update.mjs` from the package root on first use, in
both source and compiled installations. Validation semantics, error messages
and the lock protocol are unchanged; a failed lazy import is not cached.

Boot census, before → after (ESM files loaded before the first `registered`
reply; Node 24.19.0, same runtime, isolated profile homes):

| Package | Files before → after | Bytes before → after |
| --- | ---: | ---: |
| `@modelcontextprotocol/sdk` | 18 → 0 | 262K → 0 |
| `ajv` (+ `ajv-formats`, `fast-uri`) | 69 → 0 | 271K → 0 |
| `zod` `v3` / `v4-mini` entry points (MCP SDK only) | 21 → 0 | 185K → 0 |
| `zod-to-json-schema` | 39 → 0 | 53K → 0 |
| `tar` | 1 → 0 | 82K → 0 |
| `smol-toml` | 9 → 0 | 46K → 0 |
| `@deepseek-ai/dsh-mcp-client` | 1 → 0 | 33K → 0 |
| `bin/update.mjs` + `bin/native-runtime.mjs` | 2 → 0 | 24K → 0 |
| `cross-spawn`, `which`, `eventsource-parser`, `json-schema-traverse`, misc | 18 → 0 | 35K → 0 |
| **Total** | **1546 → 1378** | **9917K → 8937K** |

The remaining bridge-owned files rose by 10 (the concurrent module refactor's
new `lib/types/*.js`), so the net −168 files above already absorbs them; the
dependency reduction alone is −178 files / −992K.

Interleaved fresh-process leader boot, 8 pairs, spawn → first `registered`
reply, compile cache disabled, Node 24.19.0 (`ab-interleaved.log`):

| | Before median | After median | Before min/max | After min/max |
| --- | ---: | ---: | ---: | ---: |
| spawn → socket listening | 363.9ms | 330.0ms | 354.6 / 436.4 | 322.2 / 348.8 |
| spawn → `registered` | 370.4ms | 340.1ms | 360.4 / 443.4 | 332.9 / 360.5 |

That is about 30ms (≈8%) of leader boot, measured on one machine under normal
background load; it is not time to an interactive TUI or a first model reply.
A second 8-pair run through `scripts/bench-leader-boot.mjs` while a full E2E
had just finished reproduced the gap at a noisier baseline (388.7ms → 361.5ms
registered medians; `/tmp/dscperf-ws.Y9Q1pj/bench-leader-boot-8.json`).
Reproduce (each home must already contain an installed `profiles/dscode`):

```sh
node scripts/bench-leader-boot.mjs /path/to/runtime/bin/dsh /path/to/before-home /path/to/after-home 8 --census
```

Regression coverage: `mcp.spec.ts` asserts the import stays type-only, that
absent/empty declarations resolve without loading the client, and that an
empty mount never calls `ctx.plugin`. Interface tests for
`profile-plugins.ts` still exercise the locked mutation path.

## Implemented: host-provided SDK plugins are peers, not bundled copies

The same census showed the installed bridge loading a second copy of several
packages the pinned runtime already provides at the identical version. The
plugin manifest listed `@deepseek-ai/dsh-schedule`, `dsh-session-reference`,
`dsh-session-log-export`, `dsh-terminal` and `dsh-terminal-bash` as ordinary
`dependencies`, so the release builder bundled them (and their private
closure: `zod` 4.6.4, `fflate`, `@xterm/headless`, `dsh-pwsh-local`,
`dsh-session-format`) under the plugin's own `node_modules`. Every one of
them is also a direct dependency of the installed `@deepseek-ai/dsh`, and
`cordis.patch.yml` loads four of them as runtime plugins, so the runtime copy
was always loaded too. The duplicates were waste, not a correctness bug:
`dsh-brand` is duplicate-install-safe and the bridge only calls plain
functions (`foldScheduleEvents`, `TerminalSessionId`, `sessionLogExportDeps`)
on these modules — but they cost ≈105 files / 1.2MB of extra parsing per boot
and 2MB of tarball.

`bridge/grok-leader/package.json` now declares the five packages as
`peerDependencies` (mirrored in `devDependencies` at `0.1.5-rc.2` for the
pinned-SDK build and tests), matching the documented rule that SDK peers
share the host's Cordis and service identities and are never bundled as
independent copies. Resolution follows the same path as the fourteen existing
peers: `dsh-app-boot` links the installation closure into the shared
`profiles/node_modules`, and the release builder marks peers optional so a
registry install with `--legacy-peer-deps` does not fetch them. `dsh-lsp*`,
`dsh-tool-*`, `tar`, `smol-toml` and `js-yaml` stay bundled (the tool
plugins and LSP stack are not runtime-provided; the bundled `js-yaml` 5.x
differs from the runtime's 4.x). `pnpm-lock.yaml` moved the five importer
entries from `dependencies` to `devDependencies`; no package versions changed.

Plugin tarball: **3,396,468 → 1,407,629 bytes**; bundled `node_modules`
18.3MB → 7.0MB (`zod`, `@xterm/headless`, `fflate`, `dsh-pwsh-local`,
`dsh-session-format` and the five peers no longer ship).

Boot census, lazy-import package → peer package (same method as above):

| Package (plugin root copy) | Files | Bytes |
| --- | ---: | ---: |
| `zod` 4.6.4 | 95 → 0 | 852K → 0 |
| `fflate` | 1 → 0 | 92K → 0 |
| `@deepseek-ai/dsh-schedule` | 1 → 0 | 56K → 0 |
| `@deepseek-ai/dsh-session-log-export` | 1 → 0 | 23K → 0 |
| `@deepseek-ai/dsh-session-format` | 1 → 0 | 21K → 0 |
| `@deepseek-ai/dsh-terminal` | 1 → 0 | 14K → 0 |
| `@deepseek-ai/dsh-util-values`, `dsh-brand` | 2 → 0 | 9K → 0 |
| **Plugin-root loads** | **105 → 3** | **1231K → 163K** |
| **All non-`node:` loads** | **1365 → 1269** | **9047K → 8112K** |

Two files moved rather than disappeared: `dsh-session-log-export` and
`fflate` now load once from the runtime root (they were previously loaded
only from the plugin copy). The remaining plugin-root loads are `js-yaml`,
`schemastery` and `cosmokit` (dependencies of the still-bundled tool/LSP
plugins). The 1365 baseline is higher than the 1378 → 1365 drift would suggest
because the concurrent refactor added four new `lib/types/*.js` files.

Interleaved fresh-process leader boot, 8 pairs, spawn → first `registered`
reply, compile cache disabled, Node 24.19.0
(`/tmp/dscperf-ws.Y9Q1pj/bench-leader-boot-dedup.json`):

| | Lazy-import median | Peer median | min/max before | min/max after |
| --- | ---: | ---: | ---: | ---: |
| spawn → socket listening | 350.2ms | 328.6ms | 340.9 / 389.0 | 321.0 / 358.0 |
| spawn → `registered` | 362.5ms | 340.6ms | 351.1 / 401.3 | 333.4 / 369.8 |

About 22ms (≈6%) on this host, larger than the ≈13ms the redundant loads
alone accounted for in the earlier profile; single-machine numbers under
normal background load, so treat the direction, not the exact figure, as the
result. Cumulative against the original baseline the leader boot is now
≈370ms → ≈340ms in the first A/B and 362ms → 341ms in this one; the two runs
used different baselines (the first "after" home is this run's "before").

### Not adopted or deferred

- **Node compile cache for the leader.** Measured at both levels now: 21.3ms
  (5.8%) off the leader boot and 0.6% off time to the first reply, at the cost
  of a 5.3MB per-Node-version directory, a ≈20–26ms first-launch population and
  a cache to place, invalidate and clean up. Not enabled by default; the
  environment variable remains the escape hatch, see the compile-cache notes
  above.
- **Remaining duplicate packages across roots.** After the peer change,
  `js-yaml` (runtime 4.3.2 ×3, plugin 5.4.2 — different majors, so not a
  duplicate to remove), `schemastery` and `cosmokit` (≈34K, dependencies of
  the bundled `dsh-tool-*` / `dsh-lsp-stdio`) still load from both roots.
  Skipping runtime-provided packages inside the release builder's closure copy
  would couple the tarball to one runtime layout; not done.
- **Darwin process inspection.** The pinned `dsh-subprocess-local` Mac
  inspector answers `isAlive` / `snapshot` with a full `ps -axo
  pid=,ppid=,lstart=` table (≈23ms median on this host with ~1300 processes)
  while `foregroundPgid` uses a targeted `ps -o tpgid= -p <pid>` (≈1.2ms).
  Point-querying addresses fresh identity checks, not full-table readiness
  snapshots. This was an upstream/backport recommendation at that checkpoint;
  the subsequent source backport and its measured teardown gain are recorded
  at the top of this document. The polling interval remains unchanged.
- **cordis hot-path overhead.** Profiles did not surface it above module
  compilation and synchronous child-process calls; deprioritized.

### Verification for this section

- Pinned-SDK TypeScript build: passed. Bridge suites on Node 22.19.0 and
  24.19.0: **25 files passed / 1 skipped; 457 tests passed / 4 skipped** each
  (the totals now include the concurrent refactor's new spec files).
- After the peer change, rebuilt against the pinned runtime: TypeScript build
  passed; bridge suites on Node 22.19.0 and 24.19.0: **31 files passed; 537
  tests passed** each (the concurrent refactor added more spec files in the
  meantime); `scripts/release-payload.test.mjs` +
  `scripts/e2e-gateway-hold.test.mjs`: 13 passed / 1 skipped, including the
  "packed ordinary closure installs offline without unpublished host peers"
  contract; `corepack pnpm install --lockfile-only` accepted the manifest with
  no version changes.
- Managed update E2E with the peer package (`/tmp/dscperf-ws.Y9Q1pj/e2e-update-dedup.log`):
  `PASS managed update E2E` — the bundled-dependency guard in `bin/update.mjs`
  and the registry-free source install both accept the smaller closure.
- Fresh `dsh plugin --profile dscode add file:<peer tarball>` into an empty
  home (`/tmp/dscboot-dedup.joNZkr`): the leader boots and answers
  `registered`, with the five packages resolved through the shared
  `profiles/node_modules` links to the runtime copies.
- Full Mac product E2E with the peer package, run **96489**:
  `/tmp/dscmac-perf-dedup/contracts-96489/PASS.json` (`PASS real TUI + dsh +
  bridge E2E run 96489`), covering the bridge-owned plugin lifecycle, real
  LSP, Python REPL, schedules/tasks, terminal archive and durable resume —
  i.e. every consumer of the five now-peer packages. Peer tarball:
  `/tmp/dscperf-ws.Y9Q1pj/dscode-plugin.tgz` (1,407,629 bytes, rebuilt 04:10).
  `scripts/check.sh` and `git diff --check`: passed.
- `scripts/check.sh`, `scripts/e2e-gateway-hold.test.mjs`,
  `scripts/release-payload.test.mjs`: passed.
- Managed update E2E with the lazy-import package: `PASS managed update E2E`
  (install + repair, startup native repair, legacy overlay, composed profile,
  same-version no-op, corrupt-asset rejection, user files preserved).
- Full Mac product E2E with the lazy-import package, run **53073**:
  `/tmp/dscmac-perf-after/contracts-53073/PASS.json`, including the MCP stdio
  fixture, `/dsh add` plugin lifecycle through the lazy profile lock, real
  LSP, Python REPL and durable resume. A private `typescript-language-server@5.0.0`
  / `typescript@6.0.3` prefix was used for the LSP prerequisite; nothing was
  installed globally.
- Test package: `/tmp/dscperf-ws.Y9Q1pj/dscode-plugin.tgz` (3,396,468 bytes).
  Census/benchmark homes: `/tmp/dscboot.GXFtBc` (before),
  `/tmp/dscboot-after.W4JAWw` (after), log `ab-interleaved.log`.

At that verification, the source changes were uncommitted and neither the
installed `0.0.14-alpha.12` nor the published release contained them.
