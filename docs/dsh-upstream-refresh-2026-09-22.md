# DSH 0.1.7 adaptation — 2026-09-22

The current candidate pins official `deepseek-ai/deepseek-harness` revision
`00102833dfaee1da9f48a3a8eae9d34005a75218`, release `0.1.7-alpha.2`. Tag
`dsh-v0.1.7-alpha.2` resolves directly to that commit (committed
2026-09-22T15:25:38Z); its GitHub prerelease was published at 15:49:49Z. npm
published `@deepseek-ai/dsh@0.1.7-alpha.2` at 16:08:55Z; at 21:55Z the npm tags
were `alpha=0.1.7-alpha.2`, `latest=0.1.5-rc.2`, `next=0.1.5-rc.3`, and master
still resolved to the alpha.2 commit. It supersedes the unpublished
[alpha.1 candidate](#superseded-alpha1-candidate) recorded below, on the same
product base.

**The alpha.2 candidate passed every executed product gate on macOS and Linux,
including both full installed-product E2E runs with the new wakeup check.**
Linux also passed native containment, source replay and its final
artifact/process audit, with every gate passing on the first attempt. The one
failed gate is a pre-existing session-list benchmark fixture defect (below),
which makes no product claim. The candidate remains an unpublished worktree.
Upstream master and npm still named alpha.2 at 2026-09-23T00:58Z.

Follow-up, 2026-09-23: the source backport gained a `dsh-config-editor`
performance change (see [performance](performance.md)). Its digest is now
`f3fe5695ed2260428f2fe45108650144ba583d62b6371545838af765d10b71b0`; the
`d18c9d03…` artifacts below remain the accepted record. The revised macOS
payload passed the bridge suites and every installed-product gate. Its Linux
acceptance has not been run.

## Changes from the alpha.1 candidate

- The whole `@deepseek-ai/dsh-*` family moves to `0.1.7-alpha.2`, with Cordis
  4.0.4, Schemastery 3.18.4 and `cordis-plugin-include` 1.0.9. The bridge lockfile
  was re-resolved from the registry. pnpm's release-age exclusions now name the
  alpha.2 family and its vendor packages, and the regenerated lockfile passes the
  strict supply-chain check with no alpha.1 entries. Every non-SDK lock entry is
  identical to the alpha.1 lock, and the Node floor is unchanged.
- The source backport was rebased to
  [`dsh-00102833….patch`](../patches/dsh-00102833dfaee1da9f48a3a8eae9d34005a75218.patch),
  SHA-256 `d18c9d039467e60de06fe8a4f674f106131c10238dca0b7b2f725acaa55e6dcd`.
  Upstream alpha.2 documented best-effort spill collection in the same
  `subprocess-local` README paragraphs; only that context and the README pair's
  translation hashes changed. Settings readiness, the macOS kernel process table,
  the JSONL helper extraction and their tests are byte-identical hunks. None of
  them is upstream in alpha.2.
- No bridge source change was needed. The alpha.1→alpha.2 source diff of every
  SDK package the bridge imports or mounts was reviewed:
  - `tool-jobs` no longer caps idle completion wakeups by default. dscode mounts it
    without configuration, so it inherits the fix for stalled sessions.
  - `spill-policy` now retains text and images within `maxInlineTokens`. dscode
    configures no spill policy; the base bundle supplies 12500. The bash
    truncation marker the projection recognizes is unchanged.
  - `installFailLoud` now also exits on uncaught exceptions. Node already
    terminated on those; only the diagnostic changed.
  - MCP content projection moved to the new `projectContent` hook, and
    `SessionPageRequest` gained an optional `turnWindow`. The bridge uses neither.
  - First-install npm registry probing is a web plugin-manager service; neither
    `dsh plugin add` nor the launcher uses it.
- The full product E2E gains an alpha.2 wakeup check. One prompt starts a chain of
  four two-second background jobs, and each idle completion must open its own
  model turn that starts the next job. With `maxConsecutiveWakes: 3` restored in
  a scratch copy, the run timed out after the fourth completion, as alpha.1 did
  by default. The shipped profile passes it.
- The E2E runtime target and the [upgrade notes](upgrade-strategy.md) now name
  alpha.2. A custom `spill-policy` override must rename `maxInlineBytes` to
  `maxInlineTokens`, as upstream requires.

## Final macOS artifact identity

Evidence root: `/Users/hqzhao/AI/dsh-alpha172/run-20260922`.

- Source checkout `/Users/hqzhao/AI/dsh-alpha172/src`, clean at the pin; the
  builder applied the patch in its own temporary clone.
- Consumer `consumer/`: `dscode-consumer.json` records the pin, patch digest,
  `darwin/arm64`, dependency inputs and tree digest
  `250cf16aec474e9c0032d9bd9261c7240ac4f8f7a1486d5ed817b29cd1aaa5ba`.
- TUI `0.0.14-alpha.12 (eb081b6f)`, built with Rust 1.94.0 and
  `GROK_VERSION=0.0.14-alpha.12`. Its Rust sources are unchanged since alpha.1,
  but the binary crate always relinks, so its hash differs from the alpha.1 TUI.
  The banner names the base commit, not the pre-existing Rust worktree edits.
- `payload-audit.json` checks sidecar equality, runtime descriptor and patch
  identity, manifest version/DSH/dependency equality, a clean source checkout and
  byte equality of 57 packed plugin files with this worktree.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `dscode-macos-aarch64` | 173090448 | `cc0a8fb012abf4ccd21fed0512d45a52c7b24d90bc875c54061c10593a3a68df` |
| `dscode-plugin.tgz` | 1340144 | `0dbc655562195a1f3fbbe1dbfcab7b855b72dc8f1150a760fd23f71472d3ce74` |
| `dscode-runtime-macos-aarch64.tar.gz` | 425741503 | `5ca879af86333d83caa77cdaff402a4232509c29d794eb0640d7713c87b3e07d` |

## Executed macOS gates

Log paths are relative to the evidence root. From the bridge suites onward,
gates ran through `control/gate.sh`, which removes ambient model credentials,
`NODE_OPTIONS` and DSH/dscode home overrides and records start/finish times.
The payload build, TUI build and patched-source gates ran earlier, directly in
the host shell; those offline suites make no model calls.

| Gate | Result | Evidence |
| --- | --- | --- |
| Source runtime, plugin and consumer build | Passed in 4 min 45 s | `logs/build-payload.log` |
| Bridge against the source SDK, Node 24.19.0 | 49 files, 978 passed | `logs/bridge-node24.log` |
| Bridge against the source SDK, Node 22.19.0 | 49 files, 978 passed | `logs/bridge-node22.log` |
| Patched source: Settings, macOS process table/inspector, terminal, JSONL persistence | 25 files, 851 passed, 1 skipped | `logs/source-patch-tests.log` |
| Patched source: subprocess-local, subprocess, terminal-bash | 22 files passed, 3 skipped; 486 passed, 19 skipped | `logs/source-subprocess-local-macos-retry1.log` |
| Upstream documentation gates on the patched source | 20 passed | `logs/source-docs.log` |
| Release, runtime, gateway and install-selection scripts, both Node lines | 47 tests: 46 passed, 1 Linux-only skip; `check.sh` passed | `logs/scripts-node24.log`, `logs/scripts-node22.log` |
| Rust product contracts | 2700 passed, 0 failed, 2 ignored | `logs/rust-checks.log` |
| Managed update | Install, native repair, corruption/legacy-overlay repair, composed profile, same-version no-op, corrupt-asset rejection, user-file preservation | `logs/product-update.log`, `update/update-PASS.json` |
| Provider UI | Add/edit/switch/delete/restart, run 16822 | `logs/product-provider.log`, `provider/` |
| Independent update channels | 15 cases, including cold npm bootstrap and downgrade | `logs/product-channels.log`, `channels/PASS.json` |
| Full installed TUI and headless product, with the wakeup chain | Passed without scenario-only flags, run 46803 | `logs/product-full-wake.log`, `e2e-full-wake/contracts-46803/` |
| Wakeup chain negative control, `maxConsecutiveWakes: 3` | Failed as intended after the fourth completion | `logs/red-wake-cap3-retry1.log`, `red-check/` |
| Consumer provenance, payload audit, `check.sh`, `git diff --check` | Passed | `logs/consumer-provenance.log`, `payload-audit.json`, `logs/check-final.log` |
| Session-memory benchmark smoke, 1000 turns | Passed; no performance claim | `logs/bench-memory-smoke-1000.log` |
| Session-list benchmark smoke, 2 sessions | **Failed**; see below | `logs/bench-list-smoke.log` |

The earlier full product run 18945 also passed; it predates the wakeup check.
The first source subprocess run had one failure: the Windows executable search
test reads `NoDefaultCurrentDirectoryInExePath`, which this host shell exports.
With only that variable removed, the retry passed. Scratch run `red-wake-cap3`
stopped before any scenario because the scratch copy lacked the bridge's
dependency link; `red-wake-cap3-retry1` is the negative control.

The full run covered headless resume, fork and multimodal prompts; shipped and
custom preset rosters; worktrees; streaming, paste and external-editor recovery;
Markdown/table copy and OSC 8 links; image stash; screen-mode switching;
questions; native goals, tasks, reminders, child inbox controls and `present`
deliveries; passive task output followed by an intact model `job_output` read;
the four-step wakeup chain; skills, turn navigation, preset copy/edit and real
TypeScript LSP; archives, persistent shell and Python REPL; the runtime doctor;
and interactive rewind. Kitty graphics were skipped because
`DSCODE_E2E_KITTY_BIN` was not set.

The session-list benchmark fixture seeds turns from 0 and records tool calls
without an advertised tool lifecycle. The V4 validator rejects both when the
benchmark reopens a session for writing. The same script fails identically
against the alpha.1 consumer, so this is a pre-existing fixture defect, not an
alpha.2 regression. The alpha.1 record below reports different phases for this
command and cannot be reproduced with the current script. The fixture is left
unchanged here; making it V4-valid is follow-up work.

Follow-up, 2026-09-23: the fixture now writes V4 turns numbered from 1, with
closed steps whose assistant message advertises each tool call before it runs,
a closed answer step, and derived titles citing the first human prompt. With
it working, one benchmark expectation also proved wrong: the touched-session
counts assumed every touched session was in the listed project. They now count
only touched sessions visible there. `logs/fix-bench-list-smoke.log` reruns the
2-session smoke with no violations; multi-project, `--reuse=true`, two-touch
and title/roster/concurrency variants also complete without violations. The
memory benchmark is unchanged. Its fixture never reopens a session, and
changing its event mix would break comparison with recorded measurements.

## Linux acceptance

The user approved this isolated `swoop` run again for alpha.2, on the alpha.1
conditions: private root `/home/hanqing/dscode-alpha172-acceptance.y3rvSP`,
private caches and test homes, one build/test worker, sequential gates, no sudo,
no global installs. Gates requested `nice -n 15`. The host had already reniced
the detached driver shells to 5, so workloads ran at the minimum priority, 19.

The handoff recorded 3304 file entries. Revision 2 replaced only
`scripts/e2e-native-controls.mjs`, adding the wakeup check, after the runtime
build and native matrices, while the TUI/Rust gate (which does not read it) was
compiling. That was before any script, bridge, product or source gate ran. The
final recheck matched every revision 2 record. The product harness reads YAML
through the checkout's bridge dependencies, which a source-only handoff lacks. Each script and product gate linked this run's
runtime `node_modules` for its duration and removed exactly that link; alpha.1
had needed a retry for the same reason.

| Gate | Result |
| --- | --- |
| Fresh source runtime/plugin | CLI `0.1.7-alpha.2`; descriptor names this pin and patch |
| Native systemd provider matrix, Node 22.19.0 and 24.19.0 | 15 checks each |
| Exact-version TUI and Rust product contracts | 2700 passed, 0 failed, 2 ignored |
| Release/runtime/gateway/install scripts and `check.sh`, both Node lines | 47 of 47 each |
| TypeScript and full bridge, both Node lines | 49 files, 978 passed each |
| Consumer provenance | Source, patch, dependency inputs and installed tree matched |
| Managed update, provider UI (run 540790), update channels | All passed; 15 channel cases |
| Full installed TUI/headless product with containment | Run 551169 passed, including the four-step wakeup chain |
| Patched source: Linux scope, native containment and Settings (host) | 6 files, 128 passed per Node line |
| Patched source: subprocess, bash, terminal and JSONL persistence (PID namespace) | 43 files, 1263 passed, 16 skipped per Node line |
| Documentation gates / snapshot replay corpus | 20 passed / 7 files, 177 passed, 2 skipped |
| Candidate recheck and final audit | Passed; no live owned process, scope or residual process |

The namespace lane now includes the JSONL persistence suite the backport
touches. Its 16 skips are 4 native-systemd cases covered by the host lane,
7 Windows, 3 PowerShell and 1 macOS live-layout test, plus 1 zstd-only
parameterization. The 2 snapshot skips are PowerShell scenarios. Rust's ignored
tests are the existing visual picker smoke and the known theme-accent mismatch.

| Linux asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `dscode-linux-x86_64` | 212527832 | `87aef4b4824377deb967ffcd59485b3e96c4017ca9db90f5f80bb831515ff474` |
| `dscode-plugin.tgz` | 1340129 | `86c4b790accf1f9ec943aad357403ce644ed77d1f58bab0e4c73605919051a6c` |
| `dscode-runtime-linux-x86_64.tar.gz` | 408109772 | `e1ef91966278cc47a310c295ad56a513a93d9e2526b25d3daec86013ed49271d` |

The payload and `linux-evidence.tar.gz` (4578335 bytes, SHA-256
`a984d81689947ddf8770de81701107a2881a6c1725ad5b69986c4e11406f2db4`) are in
`linux-results/`. All 590 inventoried evidence files were rehashed locally.
Both platforms' plugins carry the same 57 bridge files as this worktree; four
bundled dependency manifests differ only in JSON key order. Details are in
[the Linux acceptance record](linux-acceptance-2026-09-22-alpha17.md).

## Boundaries

All model traffic used the mock gateway and isolated homes; no real model account
was exercised. Kitty graphics, physical Cmd-click, IME, the host clipboard,
Windows and PowerShell were not certified. The complete upstream DSH test suite
was not run. No commit, push, release or daily-profile update was performed, and
the pre-existing updater and Rust worktree edits were preserved.

## Superseded alpha.1 candidate

This section keeps the record of the earlier alpha.1 run, with its headings
nested here. None of its gates certify the alpha.2 artifacts above.

The candidate pinned official `deepseek-ai/deepseek-harness` revision
`c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`, release `0.1.7-alpha.1`.
Upstream `master` and tag `dsh-v0.1.7-alpha.1` both resolved to that revision
at the initial check. By the follow-up at 15:54:51 UTC, master and the newly
published alpha.2 tag resolved to `00102833dfaee1da9f48a3a8eae9d34005a75218`;
the alpha.1 tag remained unchanged. npm still reported `alpha=0.1.7-alpha.1`,
`latest=0.1.5-rc.2`, and `next=0.1.5-rc.3`. This acceptance remains scoped to
the user's named alpha.1 candidate. The [upstream follow-up](dsh-alpha17-upstream-followup-2026-09-22.md)
records official sources, release timing and alpha.2 considerations.

**The alpha.1 candidate passed the executed macOS and Linux gates, including
both full installed-product E2E runs.** Linux source replay and the final
artifact/process audit also passed. This remains an unpublished worktree
candidate; alpha.2 has not been adapted or certified by this run.

### Changes

- One SDK family, Cordis 4.0.3 and Schemastery 3.18.3; host services remain peers.
- Ordered native preset declaration patches replace directory-based shipped
  presets. Editable copies live under the profile's `preset-bundles` directory;
  historical custom presets are imported without rewriting their bytes. Native
  registry identity remains stable across Cordis proxies; activation failures
  roll back registrations and newly copied files. Invalid local presets receive
  individual diagnostics. The old default selection imports once without
  replacing an explicit newer selection.
- V4 first-class tool messages feed transcript, images and pending-call cleanup.
  The native migrator publishes V4 beside unchanged historical generations.
- Jobs use native session ownership, event subscriptions and non-consuming
  output snapshots. Bridge monkey patches of subprocess and terminal output
  have been removed.
- Native Settings import completion gates the first model catalog. Without this
  fix, the installed headless first boot failed with `requested provider/model
  is not in the catalog: fake-model` while legacy provider import was pending.
- YAML parsing uses js-yaml 4, matching the schema exported by native Include.
  Profile, preset and observer E2E fixtures follow the new persistence formats.
- Consumer provenance includes the non-SDK dependency inputs, preventing reuse
  of a consumer built with incompatible YAML dependencies after manifest edits.

### Final artifact identity

Evidence root: `/Users/hqzhao/AI/dsh-alpha17/run-20260922`.

- Source checkout: `/Users/hqzhao/AI/dsh-alpha17/src`, clean at the pinned revision.
- Source patch SHA-256:
  `a1dbb05991058cd7713acb984ef819a223d3f4bef543a99c0edd94c8d158d853`.
- Consumer: `consumer-v5`; release payload: `payload-v5` under the evidence root.
- TUI: `0.0.14-alpha.12`, built with Rust 1.94.0 and
  `GROK_VERSION=0.0.14-alpha.12` from the worktree based on `eb081b6f`.
  This binary includes the pre-existing Rust edits; the commit banner alone
  does not identify all compiled source bytes.
- `payload-v5-audit.json` records checksum-sidecar equality, the runtime's
  source/patch identity, manifest dependency equality and byte equality of 57
  plugin source/configuration files against this worktree.
- `logs/consumer-v5-final-audit.log` confirms the builder's source, patch,
  dependency-input and installed-tree provenance validation.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `dscode-macos-aarch64` | 173090448 | `7c8b17f4f018c2de2120902832f9d0c038ef6a1d38a5a31f83dc800ef2aec226` |
| `dscode-plugin.tgz` | 1340131 | `b54b168b213cca5fc493d1f91fe27cf5a6e20804936decd2685d09c49a8bc2f5` |
| `dscode-runtime-macos-aarch64.tar.gz` | 425671234 | `d5ed51a0b9b99db97a0dbf88cd8ac6f7e1d1671c5519640de9378c82e40719e8` |

### Executed local gates

All log paths below are relative to the evidence root.

| Gate | Result | Evidence |
| --- | --- | --- |
| Source-runtime bridge, Node 24.19.0 | 49 files, 978 passed, exit 0 | `logs/bridge-final24.log` |
| Source-runtime bridge, Node 22.19.0 | 49 files, 978 passed, exit 0 | `logs/bridge-final22.log` |
| Settings/macOS source patch selection | 3 files, 45 passed | `logs/source-patch-tests.log` |
| Release/runtime scripts | 42 passed, 1 platform skip | `logs/release-tests-final.log` |
| Rust release build and product contracts | Passed, exit 0 | `logs/build-tui-exact.log`, `logs/rust-checks.log` |
| Managed update, final payload | Install, explicit/startup native repair, corruption and legacy-overlay repair, composed profile, same-version no-op, corrupt-asset rejection and user-file preservation passed | `logs/update-final.log` |
| Provider UI, final payload | Add/edit/switch/delete/restart passed, run 98790 | `logs/provider-final.log`, `provider-final/` |
| Full installed TUI and headless product, final payload | Passed without scenario-only flags, run 14557, exit 0 | `logs/e2e-final2.log`, `e2e-final2/contracts-14557/PASS.json` |
| Independent update channels | 15 cases passed, including cold npm bootstrap and downgrade | `logs/channels-v4b.log` |
| Benchmark fixture smoke | 1000-turn memory and 2-session list runs passed; no performance claim | `logs/bench-memory-smoke-1000.log`, `logs/bench-list-smoke.log` |
| Script syntax, version and platform helpers | Passed after the final E2E wait edits | `logs/check-final2.log` |

The source selection preceded the final documentation-only pairing-record
refresh in the patch; its tested implementation is unchanged. The channel
suite used v4b before the final documentation/provenance rebuild. It is retained
as channel-behavior evidence, not proof of the final artifact bytes. Other
superseded consumers and payloads do not certify the final patch digest.

The full E2E exercised eight shipped/custom preset rosters, first-boot legacy
provider import, streaming, images, resume/fork/rewind, worktrees, external
editor success/failure, paste, links/table copy, display switching, plugin
lifecycle, native goals/tasks/workflows/reminders, child history, preset copy
and editing, real TypeScript LSP, archives, persistent shell and Python REPL.
Passive job display was followed by actual model `job_output` calls, verifying
that display had not consumed the model's output cursor.

The preceding `e2e-final` run stopped at an automation race: it had created the
first preset copy but never sent the duplicate-copy ACP request. The script now
waits for the copy editor and completed search state before entering text, and
for the normal footer before editing. `e2e-final2` passed copy, duplicate-ID
rejection and file-preserving edit checks. No product Rust workaround was added.

### Linux acceptance and boundaries

The user explicitly approved this isolated Linux x86-64 acceptance on `swoop`.
It runs under `/home/hanqing/dscode-alpha17-acceptance.iBOStB`, using nice 15,
one build/test worker, private caches and test homes, with no global installs.
The transferred candidate's 3301 file records were verified before building.
The fresh Linux runtime passed the 15-case native systemd/cancellation matrix
on both Node 22.19.0 and 24.19.0. Rust contracts passed 2700 tests with two
pre-existing ignored tests. Both Node lines passed 47 script checks and all
978 bridge tests. Managed update, provider UI, all 15 update-channel cases and
the full TUI/headless E2E passed; the final product run is `2812039`.

Source tests passed 128 host tests and 518 namespace tests on each Node line,
20 documentation gates, and 175 recorded-session/browser snapshot tests.
Platform/tool skips, environment setup corrections, exact payload hashes and
evidence paths are detailed in [the Linux acceptance record](linux-acceptance-2026-09-22-alpha17.md).
The final audit found no live owned processes or scopes and verified payload
sidecars, consumer provenance, all 3301 transferred candidate file records,
57 packed plugin files and unchanged source-test patch contents.

Local Linux evidence is in `linux-results/evidence`, with its payload under
`linux-results/payload`, below the evidence root. The handoff archive retains
its original pre-approval documentation and hashes; these reports record the
subsequent authorization and execution without relabeling those input bytes.

All model traffic used mock services and isolated test homes. No real model
account was exercised. Graphical Kitty image interaction was skipped because
`DSCODE_E2E_KITTY_BIN` was not configured; the tmux/headless image paths passed.
Physical Cmd-click, IME and the host clipboard were not certified. This run did
not execute the complete upstream DSH test suite.

No commit, push, release, or daily-profile update was performed. Pre-existing
updater and Rust worktree changes were preserved.

The final `git diff --check` passed; the shared index is empty, no index lock
remains, and only the original main worktree remains. The post-run process
audit on macOS checked 123 retained leader lock files: none referenced a live PID, and
no process command referenced this evidence root. The result is retained in
`post-run-process-audit.json`; test evidence and failed-run diagnostics remain
available.
