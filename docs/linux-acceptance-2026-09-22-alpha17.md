# Linux acceptance of DSH 0.1.7 — 2026-09-22

## Current candidate: 0.1.7-alpha.2

The Linux x86-64 acceptance passed for the DSH alpha.2 worktree candidate, with
every gate passing on the first attempt. The full installed-product run is
**551169**, with native containment enabled. The
[adaptation report](dsh-upstream-refresh-2026-09-22.md) owns the change summary
and macOS gates. This is not acceptance of the entire upstream test suite or a
paid model service.

### Authorization and identities

The user approved this isolated `swoop` run again for alpha.2, with the alpha.1
conditions. Gates requested `nice -n 15`; the host had already reniced the
detached driver shells to 5, so workloads ran at 19. Builds and tests used one
worker, private caches and test homes, and ran sequentially without sudo, global
installs or daily-profile updates. The Rust dependency tree was rebuilt
single-threaded because this run's private `CARGO_HOME` did not match the
fingerprints of the copied previous target (the release TUI took 51 minutes).

- Remote root: `/home/hanqing/dscode-alpha172-acceptance.y3rvSP`; source
  replay HOME and TMPDIR under `/var/tmp/dscode-alpha172-y3rvSP`.
- Local root: `/Users/hqzhao/AI/dsh-alpha172/run-20260922/linux-results`;
  control scripts in `linux-control/`.
- Product base: `eb081b6f8c64300716424a5474b2b8dcb8230ef4`, reconstructed from
  `base.bundle`, `worktree.patch` and 15 untracked additions (3304 records,
  including six deletions). The pre-existing updater and Rust edits are included.
- DSH source: tag `dsh-v0.1.7-alpha.2` = `00102833dfaee1da9f48a3a8eae9d34005a75218`;
  patch SHA-256 `d18c9d039467e60de06fe8a4f674f106131c10238dca0b7b2f725acaa55e6dcd`.
- Product/TUI `0.0.14-alpha.12`; Node 22.19.0 and 24.19.0; Rust 1.94.0;
  tmux 3.4; typescript-language-server 5.0.0; kernel 6.8.0-137-generic; the
  user systemd manager reported `running`, and the PID namespace probe passed.

Handoff revision 2 (`linux-handoff-v2/`) replaced only
`scripts/e2e-native-controls.mjs` to add the alpha.2 wakeup check. It was
applied at 22:36Z, after `build-runtime` and both native matrices and while the
TUI/Rust gate, which does not read that file, was compiling. That was before any
script, bridge, product or source gate. The final `candidate-recheck` matched all
3304 revision 2 records.

### Executed gates

Paths are relative to local `evidence/` or the remote root.

| Gate | Result | Evidence |
| --- | --- | --- |
| Setup and candidate reconstruction | Passed | `logs/setup.log` |
| Fresh source runtime/plugin | CLI `0.1.7-alpha.2` | `logs/build-runtime.log` |
| Real native systemd provider, both Node lines | 15 checks each | `built-22.19.0/PASS.json`, `built-24.19.0/PASS.json` |
| Exact-version TUI and Rust product contracts | 2700 passed, 0 failed, 2 ignored | `logs/tui-and-rust.log` |
| Release/runtime/gateway/install scripts and `check.sh`, Node 22 and 24 | 47 of 47 each | `logs/scripts-22.19.0.log`, `logs/scripts-24.19.0.log` |
| TypeScript and full bridge, both Node lines | 49 files, 978 passed each | `logs/bridge-22.19.0.log`, `logs/bridge-24.19.0.log` |
| Consumer provenance | Source, patch, dependency inputs and installed tree matched | `logs/consumer-provenance.log` |
| Managed update | Installation, native repair, corruption rejection, user-file preservation | `update/update-PASS.json` |
| Provider UI | Run 540790 | `logs/product-provider.log`, `provider/` |
| Independent update channels | 15 cases | `logs/product-channels.log`, `tmp/dscode-channel-e2e-wld4J0/PASS.json` |
| Full installed TUI/headless product | Run 551169, containment enabled, four idle completion wakes | `logs/product-full.log`, `e2e/contracts-551169/` |
| Complete official source build | Passed | `logs/source-prepare.log` |
| Linux scope/native containment + Settings, both Node lines | 6 files, 128 passed each | `logs/source-*-host.log` |
| Subprocess, bash, terminal and JSONL persistence in a PID namespace, both Node lines | 43 files passed, 2 skipped; 1263 passed, 16 skipped each | `logs/source-*-namespace.log` |
| Documentation | 20 gates passed | `logs/source-docs.log` |
| Snapshot prerequisites and replay corpus | 7 files, 177 passed, 2 skipped | `logs/snapshot-prerequisites.log`, `logs/source-snapshot.log` |
| Candidate recheck | All 3304 revision 2 records matched | `logs/candidate-recheck.log` |
| Final artifact/process audit | Passed | `final-audit.json`, `logs/final-audit.log` |

The two environment fixtures that alpha.1 needed as retries were applied up
front. Script and product gates linked the runtime `node_modules` for the
checkout's fixtures and removed exactly that link afterwards. The snapshot gate
first linked nine built optional workspace packages under the source clone's
ignored `snapshots/node_modules`; `logs/snapshot-workspace-links.json` records
them. Playwright's headless shell came from a copy of the alpha.1 run's private
cache. No fixture, expected output, source file, manifest or lockfile changed.

The namespace skips are 4 native-systemd cases covered by the host lane,
7 Windows tests, 3 PowerShell tests, 1 macOS live-layout test and 1 zstd-only
parameterization in the newly included JSONL suite. The snapshot skips are the
two PowerShell scenarios.

### Artifacts and audit

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `dscode-linux-x86_64` | 212527832 | `87aef4b4824377deb967ffcd59485b3e96c4017ca9db90f5f80bb831515ff474` |
| `dscode-plugin.tgz` | 1340129 | `86c4b790accf1f9ec943aad357403ce644ed77d1f58bab0e4c73605919051a6c` |
| `dscode-runtime-linux-x86_64.tar.gz` | 408109772 | `e1ef91966278cc47a310c295ad56a513a93d9e2526b25d3daec86013ed49271d` |

`linux-evidence.tar.gz` is 4578335 bytes, SHA-256
`a984d81689947ddf8770de81701107a2881a6c1725ad5b69986c4e11406f2db4`. Its
591 members are a 590-file hashed inventory plus the inventory itself; every
member was rehashed after local extraction. The payload sidecars verified after
transfer. `local-delivery-verification.json` confirms that both platforms'
plugins carry the same 57 bridge files as this worktree and identical member
sets; four bundled dependency manifests differ only in JSON key order.

The final audit at 2026-09-23T00:56:53Z checked seven recorded native and E2E
process identities and their scopes. It found no live owned identity, remaining
owned scope or process referencing this run's roots. It also verified asset
sidecars, the runtime descriptor, the clean source base, and the source-test
clone's patch by reverse-apply check, unchanged tracked diff and exactly the nine
added files. The product index stayed empty, and only the original product
worktree remained.

All model traffic used mocks and replay. Graphical Kitty interaction, physical
clipboard/IME/Cmd-click, Windows, PowerShell and real model accounts were not
certified. No commit, push, release or daily install was performed.

## Superseded alpha.1 acceptance

The record below covers the earlier alpha.1 candidate and does not certify the
alpha.2 artifacts above.

The executed Linux x86-64 acceptance passed for the DSH alpha.1 worktree
candidate. The full installed-product run is **2812039**. All required final
gates passed after the documented test-environment corrections; earlier failed
attempts remain in the evidence. No product source changed during this Linux
run. This is not acceptance of the subsequently published alpha.2, the entire
upstream test suite, or a paid model service.

### Authorization and identities

The user explicitly approved this isolated run on `swoop`: “允许本次隔离验收”.
Builds/tests used nice 15 and one worker, private caches and test homes, without
sudo, global installs or daily-profile updates. Existing Node/Rust/tmux tools
were used; Playwright Chromium was downloaded only into this run's cache.

- Remote root: `/home/hanqing/dscode-alpha17-acceptance.iBOStB`.
- Local root: `/Users/hqzhao/AI/dsh-alpha17/run-20260922/linux-results`.
- Product base: `eb081b6f8c64300716424a5474b2b8dcb8230ef4`, with the pending
  adaptation and pre-existing updater/Rust edits preserved in the handoff.
  The commit banner alone does not identify the compiled worktree bytes.
- DSH source: `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`, version
  `0.1.7-alpha.1`.
- Source patch SHA-256:
  `a1dbb05991058cd7713acb984ef819a223d3f4bef543a99c0edd94c8d158d853`.
- Product/TUI: `0.0.14-alpha.12`; Node 22.19.0 and 24.19.0; Rust 1.94.0;
  tmux 3.4; Linux kernel 6.8.0-137-generic.

The handoff verifier checked all **3301** source/configuration file records,
including deletions, modes and symlinks, before and after acceptance. The
clean upstream base remained at the exact pin. The patched test clone passed
reverse-apply validation, including all nine newly added files, and its tracked
diff remained byte-identical. Local post-run comparison permits only the updated
acceptance report among the original candidate entries; new follow-up reports
do not alter the source or payload inputs.

### Executed gates

Paths below are relative to local `evidence/` or the remote root.

| Gate | Final result | Evidence |
| --- | --- | --- |
| Fresh source runtime/plugin | Build passed; runtime CLI 0.1.7-alpha.1 | `logs/build-runtime.log` |
| Real native systemd provider, both Node lines | 15 checks passed each | `built-22.19.0/PASS.json`, `built-24.19.0/PASS.json` |
| Exact-version TUI release | Build and version check passed | `logs/tui-and-rust.log` |
| Rust product contracts | 2700 passed, 0 failed, 2 pre-existing ignored | `logs/tui-and-rust.log` |
| Release/runtime/install/gateway scripts, Node 22 | 47 passed; syntax/platform checks passed | `logs/scripts-22.19.0-retry1.log` |
| Same scripts, Node 24 | 47 passed; syntax/platform checks passed | `logs/scripts-24.19.0.log` |
| TypeScript and full bridge, both Node lines | 49 files / 978 passed each | `logs/bridge-22.19.0.log`, `logs/bridge-24.19.0.log` |
| Managed update | Installation, native repair, corruption rejection and user-file preservation passed | `update/update-PASS.json` |
| Provider UI | Add/edit/switch/delete/restart passed, run 2799072 | `logs/product-provider.log`, `provider/` |
| Independent update channels | 15 cases passed, including cold npm install and downgrade | `logs/product-channels.log`, `tmp/dscode-channel-e2e-NrwWPq/PASS.json` |
| Full installed TUI/headless product | Passed without scenario-only flags, containment enabled | `logs/product-full.log`, `e2e/contracts-2812039/PASS.json` |
| Complete official source build | Native addon, host/client libraries and web build passed | `logs/source-prepare.log` |
| Linux scope/native containment + Settings, both Node lines | 6 files / 128 passed each | `logs/source-22.19.0-host.log`, `logs/source-24.19.0-host.log` |
| Subprocess, bash and terminal source selection, both Node lines | 25 files / 518 passed each; 15 skips each | `logs/source-22.19.0-namespace.log`, `logs/source-24.19.0-namespace.log` |
| Documentation | 20 gates passed, 0 failed/skipped | `logs/source-docs.log` |
| Full selected snapshot config, lib/replay mode | 7 files / 175 passed, 2 skipped | `logs/source-snapshot-retry1.log` |
| Consumer provenance | Source/patch/dependency inputs and installed-tree digest matched | `logs/consumer-provenance.log` |
| Final candidate identity | All 3301 file records matched | `logs/candidate-recheck-retry1.log` |
| Final artifact/process audit | Passed | `final-audit.json`, `logs/final-audit.log` |

The native matrix includes ordinary and PTY cancellation, immediate disposal,
ENOENT/EACCES before exec, direct exit versus detached-descendant cleanup, and
collection of owned scopes. These are new built-provider checks on the real
user manager. The earlier Linux early-cancellation blocker is cleared for this
alpha.1 tuple; the implementation is upstream, not a new local Linux patch.

Rust process-lifecycle tests ran in a separate PID namespace. Their actual
process state, nice value and single-worker environment are recorded in
`logs/rust-pid-namespace.json` and `logs/rust-resource-policy.json`. Source
namespace tests ran with a dedicated Python PID-1 reaper so Node did not own
orphan reaping; the real native-systemd selection ran separately on the host.

The namespace skips comprise four native-systemd cases covered by the host
lane, seven Windows tests, one macOS live-layout test and three PowerShell tests.
The snapshot skips are the two PowerShell scenarios. Rust's ignored tests are
the existing visual picker debug smoke and the known theme-accent mismatch.

The full product run covered preset rosters, legacy provider first boot, images,
streaming, worktrees, paste and editor behavior, copy/links, model selection,
native goals/tasks/workflows/reminders, child history, preset copy/edit, real
TypeScript LSP, archives, persistent shell/Python, passive task previews followed
by model output reads, owner isolation, rewind, fork and resume. The detached
containment child was observed in a `dsh-subprocess-*.scope` and verified dead.

### Retained failures and environment corrections

- `scripts-22.19.0` initially failed two installation-selection assertions:
  its fixture links the checkout's `node_modules`, absent in the source-only
  handoff. Linking this run's fresh runtime dependencies made all 47 pass.
  That exact temporary symlink was removed after testing, restoring the
  candidate Git inventory. The first post-run inventory check detected this
  symlink; `candidate-recheck-retry1` then verified all 3301 original records.
- `source-snapshot` initially passed 166 tests and failed nine. Eight failures
  arose because authored snapshot patches could not resolve optional built
  workspace packages (LSP, terminal, Python PTC and external/SDK subagents).
  Their built entries imported successfully. Nine specific links in the test
  clone's ignored `snapshots/node_modules` supplied the missing resolution
  anchors; `logs/snapshot-workspace-links.json` records every target. The ninth
  failed test needed Playwright's Chromium headless shell. The matching browser
  and FFmpeg were installed in the private cache. No fixture, expected output,
  source file, package manifest or lockfile was changed to make replay pass.
- The prerequisite control script itself needed directory filtering and a
  fresh Node process for post-link resolution checks, avoiding cached negative
  package lookups. Its two failed setup attempts are retained alongside the
  successful `snapshot-prerequisites-retry2` gate.
- Two earlier SSH transports remained open after their remote commands had
  terminated. Exact remote exit files and absent workload processes were
  checked before closing only those local SSH PIDs. The runtime build's remote
  exit was 0; the first product sequence stopped at the fixture failure above.
  Neither transport exit was treated as a reason to restart successful builds.

### Artifacts and audit

All three assets and their `.sha256` sidecars are in local `payload/` and remote
`payload/`. Local `local-delivery-verification.json` records the post-transfer
checksums and another comparison of both Linux and macOS final plugin bytes
with the unchanged current source. The plugin comparison covers 57 files plus
manifest version, DSH metadata, dependencies and peer dependencies.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `dscode-linux-x86_64` | 212524168 | `17eb520f647501064c5314556a6be2653012543eedeef3ec70aedb8afd4862a0` |
| `dscode-plugin.tgz` | 1340105 | `23e505fc618d3015eb174963957198e9e64ead8a87f97b1e0c159c77b8bd733a` |
| `dscode-runtime-linux-x86_64.tar.gz` | 408076611 | `fe11c74a448db8f86b827212df37ce264f6d856faf7d59fa6cec73ea905991f5` |

`linux-evidence.tar.gz` is 4,136,885 bytes, SHA-256
`ea972b8985e545ca75c11d6d1ae1a39a448674c684cb7ecdc99ecf6c6156058d`.
Its 603 members comprise a 602-file hashed inventory and the inventory itself.
The archive was copied locally and every inventoried member rehashed. It
contains controls, gate logs and exit markers, consumer/runtime descriptors,
native PASS records, product contracts/observer output and provider artifacts.
Bulky caches, test homes, compiler targets and the base Git bundle remain remote
and are excluded from this evidence archive; payloads were transferred separately.

The final process audit at **2026-09-22T20:09:19Z** checked seven recorded native
and E2E process start identities, their scopes, and process command/cwd references
to this run's roots. It found no live owned identity, residual process or owned
scope. Both product and source Git indexes remained empty; only the original
product worktree remained after E2E worktree cleanup.

All model traffic used mocks/replay. Graphical Kitty image interaction, physical
clipboard/IME/Cmd-click, Windows, PowerShell and real model accounts were not
certified. No commit, push, release or daily install was performed. See the
[main adaptation report](dsh-upstream-refresh-2026-09-22.md) for macOS evidence
and [upstream follow-up](dsh-alpha17-upstream-followup-2026-09-22.md) for the
later alpha.2 publication and provider migration boundary.
