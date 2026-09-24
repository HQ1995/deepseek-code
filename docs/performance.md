# Performance work

This log covers macOS terminal CPU and latency, long-session and streaming
work, startup, and runtime/package footprint. A change must preserve
cancellation, ownership checks, stream ordering, durable history and the full
product loop; a fast isolated benchmark alone does not establish application
performance. Figures are local (mostly macOS arm64, Node 24.19.0, a shared
host, a loopback or mock gateway), so only comparisons within one item hold.
A shipped change reopens
[Linux acceptance](upgrade-strategy.md#linux-acceptance).

## Current state

Optimizations still in the code, newest first. Bridge paths are relative to
`bridge/grok-leader/`, Rust crates to `third_party/grok-build/crates/codegen/`;
runtime items are in the source backport `patches/dsh-46a7f68b….patch`.

### 2026-09-23: a settings read no longer recomposes the profile once per plugin

- `settings.describe()` recomposed every bundle layer and profile patch per
  active plugin entry: 33.8s, 21.8% of all non-idle CPU in a profiled full
  E2E, called by the bridge on every catalog refresh and discovery step.
- Runtime (`dsh-config-editor` `inheritedConfigs`): entries without their own
  profile configuration share one composition. 108-entry profile: 39.6ms →
  1.4ms, identical values; `configuration-composition.spec.ts` pins the count.
- Bridge (`src/model-catalog.ts`, events in `src/index.ts`): display reads
  share one provider-section snapshot per settings instance, dropped on
  `settings/document-updated`, `app-boot/config-reload` and own writes.
  Writes, credential cleanup and the secret endpoint guard read fresh.
- Bridge `describe()` blocking 14.9s → 0.96s per E2E (287ms → 18ms per
  leader); leader CPU samples 129.4s → 77.1s; `describe()` 21.8% → 3.2%.

### 2026-09-20: both spellings of the profile in the update lane

- `bin/bootstrap.mjs`: an unguarded `realpathSync(profile)` exited the
  launcher (ENOENT after 24ms) when a directory swap hid the profile;
  `canonicalProfile()` now falls back, so the 60-second retry outwaits it.
- `bin/update.mjs`: `installationStages` scans both spellings of the parent
  (symlink, `/var` vs `/private/var`) deduped by realpath, and
  `installRelease` stages beside `dirname(canonical)`, so an interrupted
  update is recovered exactly once (`tests/launcher-transaction.spec.ts`).

### 2026-09-19: session listings share, settle and key on the instance

`listStore` in `src/session-discovery.ts` unless noted.

- In-flight share: callers during one `store.list()` share it. Three-window
  burst at 3000 sessions: 3 listings / 1930.1ms store work → 1 / 386.6ms.
- Settled window: a settled listing answers `session/list`,
  `x.ai/sessions/list` and the picker's `x.ai/session/list` for
  `LISTING_REUSE_MS` (10s); `session/created` (`onCreated`, `src/index.ts`)
  ends it and a remounted service never reuses it. Roster ticks at 3000:
  433.6-475.1ms → 0.2-0.5ms; picker warm calls at 10000: 1532.1/1500.0ms →
  13.0/11.6ms. Another process's write shows up to one deadline late.
- Instance keys: Cordis answers each lookup with a fresh proxy, so the caches
  key on `serviceIdentity` (`nativeInstance`, `src/native-seams.ts`). Real
  product, 3000 sessions: picker warm call 2801ms → 496ms; leader CPU 67.0% →
  8.7%.
- Cold-fold width: `INSPECTION_LANES = 2` (`src/session-list.ts`) matches the
  JSONL store's two-entry `open()` → `read()` handoff. 10000 × 120 events:
  6893.1ms / 13.9s CPU on two lanes vs 7342.7ms / 15.7s on four; at 2000,
  summed reads 0.62s (two), 1.55s (four), 6.06s (eight).
- Roster rows carry `title` from the projection cache (`cachedSnapshot`,
  `cachedPredecessorTitle`, zero I/O), so the dashboard keeps stored sessions.

### 2026-09-18: the startup window between `connect finished` and `app_init`

- 197-254ms of synchronous work before the first frame: OTLP client build
  (105ms), auth reload budget (93ms), tmux probes (51ms),
  `display_refresh_startup` (21ms).
- `xai-grok-telemetry` `otlp_http::DeferredOtlpClient` builds the client at
  first export on the batch thread, a failed build cached: 193-242ms →
  107-116ms (`tests/otel_traces_export.rs`).
- `AuthCredentialProvider::cached_snapshot()` (`xai-grok-auth`; in-memory in
  `OtelAuthCredentialProvider`) seeds the exporter without the
  `force_reload_from_disk` budget; export still calls `snapshot()`.
- `xai-grok-pager-render` `terminal/tmux_probe.rs` polls from 1ms doubling to
  15ms (`TMUX_QUERY_POLL_MIN`/`MAX`). With auth, medians: window 116ms → 1ms,
  `startup complete` 801.5 → 594.0ms, prompt rendered 1018 → 808.5ms.
- `GROK_INSTRUMENTATION*` cannot reach a launch: `isolate_dscode_environment()`
  strips `GROK_*` and re-maps only five `DSCODE_*` aliases.

### 2026-09-17: picker retention, point query, soak and readiness

- `SessionListIndex.retainFirstPrompts` (`src/session-list.ts`) grows the
  first-prompt cap (100) to the resident set plus one pass. 300 sessions,
  warm: 200 opens / 174.4–184.1ms → 0 opens / 43.6–47.1ms.
- `persistedSessionIdInUse` (`src/session-lifecycle.ts`) checks a pinned
  `session/new`/`fork` id with `store.stat(id)`, not `store.list()`: 300
  sessions, 49.7-56.2ms → 0.2ms stored / 0.1ms free.
- `scripts/soak-product-loop.sh`, 1000 turns (run 2026-09-19): 0 errors, p50
  83ms / p90 169ms, no drift; leader RSS plateaus; descriptors 41 → 40. Three
  windows, a cancel every 10 turns: 20 of 20 probes ok, 0 cross-talk.
- Readiness polls on the kernel reader (below): 21.0–21.6ms → 0.38–0.48ms at
  ~1,020 processes, 51.5–51.7ms → 1.81–1.92ms at ~4,000; interval unchanged.
- No bottleneck: workflow queries 0.029ms per transition at up to 1,000,000
  prior events; session retention linear at 1647.9–1660.2 B/event.

### 2026-09-15: macOS kernel process observations

- The runtime backport (`dsh-subprocess-local` `readMacProcessTable` in
  `src/mac-process-table.ts`, used by `src/process-inspector.ts`) reads
  `KERN_PROC_ALL` / `KERN_PROC_PID` through Koffi instead of spawning `ps`.
  Polls still read the full table; bad reads throw; no cache. Poll median
  36.69 → 0.49ms (Node 22), 33.74 → 0.49ms (Node 24); teardown 259.18 →
  29.09ms and 238.73 → 29.00ms; peak RSS up about 5–6.5MiB.
- Current-identity checks (`76300cfe`, same patch): `isAlive` and the
  pre-signal recheck select one PID. With `ps`, teardown 351.59 → 182.81ms
  (Node 22) and 298.64 → 153.38ms (Node 24).

### 2026-09-15: long-session output replay

- `src/session-output.ts` drains one owned FIFO instead of a Promise chain per
  text update; no protocol change or batching. 20,000 events, Node 22 / 24:
  text completion 75.30 → 44.45ms / 74.05 → 46.58ms; admission heap 34.24 →
  16.24MiB / 40.33 → 13.93MiB; Promise allocations 160,014 → 16.

### 2026-09-13: implemented items

- Incremental workflow projection: now the host-only `dscodeWorkflows`
  projection (`src/workflows.ts`); `d119625e` removed the bridge
  `WorkflowIndex` behind the original 192.53 → 13.35ms (100,000 events) and
  3148.94 → 18.36ms (1,000,000) figures.
- Managed startup without duplicate probes (`bin/update.mjs`): file-only
  `installationFilesMatch` preflight, one `installationMatches` probe inside
  the lock. `dscode --version` 132.36 → 89.86ms (Node 22), 138.16 → 94.05ms.
- Leader boot without the MCP SDK and updater: `src/mcp.ts` imports
  `dsh-mcp-client` lazily; `src/package-location.ts` loads `bin/update.mjs` on
  first `withProfileLock`. 1546 → 1378 files; `registered` 370.4 → 340.1ms.
- Host-provided SDK plugins as peers: `package.json` lists `dsh-schedule`,
  `dsh-session-reference`, `dsh-session-log-export`, `dsh-terminal` and
  `dsh-terminal-bash` as `peerDependencies`. Tarball 3,396,468 → 1,407,629
  bytes; `registered` 362.5 → 340.6ms.

## Decisions

- **`NODE_COMPILE_CACHE` stays off.** 21.3ms (5.8%) off leader boot but about
  one percent of the launch (first reply 0.6%), for a 5.3MB per-Node-version
  directory and a first-launch penalty. The variable remains the escape hatch.
- **No streaming batching.** The collected profiles do not justify its
  event-ordering and cancellation complexity.
- **Splitting providers out of the runtime is still open.** It needs
  dependency-closure, cold-install, capability and footprint measurements.
- **Descriptor growth is the Cordis HMR watcher, not a product defect.**
  `cordis-plugin-hmr` watches `$DSH_HOME` at depth 0, one descriptor per file
  directly in it; the soak's marker files grow it, bounded by those files, not
  turns. The skill provider and workspace root hold none.
- **No macOS process-table cache or polling change.** Signals and teardown
  keep fresh identity checks; a stale cache is not an acceptable fix.
- **The picker's cold fold stays linear in stored events** (about 3.5µs
  each): the pinned `readStoredLog` walks the whole log and its two-entry
  memo defeats paged reads, so the bridge cannot remove it.
- **The dashboard's 1s roster poll stays.** The bridge emits no
  `x.ai/sessions/changed`; the settled window makes its ticks cheap instead.
- **Remaining duplicate packages stay.** `js-yaml` differs by major version;
  `schemastery` and `cosmokit` (≈34K) ride the bundled tool/LSP plugins, and
  skipping them would couple the tarball to one runtime layout.
- **No SDK backport for the containment promise.** The inflated memory
  reading was parked microtasks, removed by a drain before sampling.
- **Cordis hot-path overhead was deprioritized** (2026-09-13 profiles); since
  2026-09-23 its service lookups rank beside compilation and GC.

## Benchmarks

Names are under `scripts/`. Scripts that load bridge modules need its
dependencies installed; `bridgeRoot` defaults to `../bridge/grok-leader/`.

- `bench-launch-compile-cache.mjs <tui-bin> <dsh-bin> <dsh-home> [pairs=6]
  [--port=N] [--out=DIR]`: whole launch with the leader's compile cache off,
  cold and warm, asserted; the home holds `profiles/dscode`, no settings.
- `bench-launcher.mjs <before-package> <after-package> <runtime-dir>
  <tui-bin>`: managed `dscode --version` startup, validation included.
- `bench-leader-boot.mjs <dsh-bin> <before-home> <after-home> [pairs=8]
  [--census]`: leader spawn → `registered` A/B; `--census` lists modules.
- `bench-leader-compile-cache.mjs <dsh-bin> <dsh-home> [pairs=8] [--census]`:
  leader boot with the compile cache off, cold and warm, asserted.
- `node --experimental-transform-types bench-macos-process.mjs <installed DSH
  source checkout> [repeats=6]`: macOS inspector polls and PTY teardown.
- `node --experimental-transform-types [--expose-gc] bench-session-list.mjs
  <sessions=300> [bridgeRoot] [--events=120] [--projects=1] [--lists=3]
  [--touch=1] [--sweep=true] [--roster=N] [--concurrent=K] [--titles=hit]
  [--reuse=true] [--window=false] [--strict]`: picker and roster over a real
  JSONL store; listings, opens, reads, CPU, event-loop delay.
- `node --expose-gc bench-session-memory.mjs <turns=2000> [bridgeRoot]
  [log|projections|leader]`: heap one session retains, per layer.
- `node --experimental-strip-types --expose-gc bench-session-output.mjs
  <src/session-output.ts> [events=20000] [text|metadata|slow]
  [--count-promises]`: replay through the output module into a framed sink.
- `bench-startup.mjs <compiled-bridge-entry>`: bridge import cost with and
  without Node's compile cache.
- `bench-workflows.mjs [historySize=100000] [members=200] [bridgeRoot]`:
  `dscodeWorkflows` append/render per transition, warm reads, rebuild.
- `SOAK_TURNS=200 bash soak-product-loop.sh`: real TUI → dsh → bridge loop;
  latency, RSS, descriptors, cross-talk, leader exit. Knobs in its header
  (`SOAK_WINDOWS`, `SOAK_CANCEL_EVERY`, …); `DSCODE_RELEASE_DIR` reuses one.
- `summarize-cpu-prof.mjs <profile-directory>`: sampled self time from
  `--cpu-prof` output.

## History

Per-run evidence (run ids, tmp paths, raw tables, verification counts,
digests) was condensed out on 2026-09-24: `git show
3cf5201acd:docs/performance.md`. It holds the dated sections 2026-09-23 back
to 2026-09-15, "Historical results (2026-09-13)", the "Implemented:"
sections, "Profiling and deferred work" and "Not adopted or deferred".
