# Performance work

This pass covers macOS terminal CPU and latency, long-session/streaming work,
startup, and runtime/package footprint.
Changes must preserve cancellation, ownership checks, stream ordering,
durable history and the full product loop. A fast isolated benchmark alone
does not establish overall application performance.

## 2026-09-15: macOS current-identity checks

The source runtime backport selects one PID for `isAlive` instead of reading
the full process table. It compares the same start timestamp immediately before
signalling, without a cache or polling change. Tree snapshots still enumerate
all processes. Only status 1 with empty stdout/stderr from a selected-PID query
means absence; other failures propagate. Existing macOS timestamp precision
and observational containment limits are unchanged.

Six alternating fresh-process pairs per Node version exercised the actual
`LocalTerminalHandle` with a real `node-pty` bash and eight sleep children.
All nine observed identities were checked absent after teardown in every run.
Baseline is official DSH `fb2c4b9e698e30edb738bca4cf0618587db7d203`; candidate
is that commit plus the [source backport](../patches/README.md).

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
RSS was slightly higher. This is not time to an interactive TUI. No default
cache setting has been changed. Full launch measurements are needed before
adopting this tradeoff. See the [Node compile-cache documentation](https://nodejs.org/download/release/v22.18.0/docs/api/module.html#module-compile-cache)
for invalidation, per-Node-version caches and coverage caveats.

The terminal baseline was remeasured using the real pinned Bash backend:
200ms polling still costs approximately 30 `ps` calls / 372–377ms of synchronous
process-query time per Python REPL operation, with approximately 3.2s latency.
The 50ms baseline costs 82–84 calls / 1005–1026ms. Short shell commands take
about 250ms at 200ms polling versus 100ms at 50ms. Reducing native inspection
cost without this latency tradeoff is a follow-up priority. Keep fresh process
identity checks for signals/teardown; a stale cache is not an acceptable fix.

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

- **Node compile cache for the leader.** A warm `NODE_COMPILE_CACHE` saved
  roughly the same ≈30ms (~8%) on leader boot in the earlier profile-home
  benchmark, at the cost of a per-Node-version cache directory (1486 entries
  for this graph) and initial population time. Not enabled by default; a
  launch-level decision, see the compile-cache notes above.
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
