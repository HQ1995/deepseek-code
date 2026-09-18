# Performance work

This pass covers macOS terminal CPU and latency, long-session/streaming work,
startup, and runtime/package footprint.
Changes must preserve cancellation, ownership checks, stream ordering,
durable history and the full product loop. A fast isolated benchmark alone
does not establish overall application performance.

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

Not adopted in this pass. Each candidate is product code under
`third_party/grok-build`, so it reopens the Linux acceptance threshold, and
the three belong in one cycle or none. What that cycle would buy is bounded by
the conditions in the table: the auth budget is only paid where `auth.json`
is missing or unreadable, and the tmux probes only in tmux-backed panes. The
always-paid item is the OTLP client build, and it is deliberately built at
init, outside the batch-processor thread, to avoid a "no reactor" panic when
an export runs there; deferring it to the first export is a behaviour change
with its own verification, not a mechanical move.

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
