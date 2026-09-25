# DSH 0.1.7 adaptation — 2026-09-22

## 0.1.7-rc.2 — 2026-09-24

Branch `feat/dsh-0.1.7-rc.2` pins official revision
`477b4f420553e8a52c2fbccc464d7561b239c443`, release `0.1.7-rc.2` (committed
2026-09-24T13:39:59Z). Its GitHub prerelease was published at 14:10:21Z and npm
published `@deepseek-ai/dsh@0.1.7-rc.2` at 14:18:11Z; the npm tags were then
`next=0.1.7-rc.2`, `alpha=0.1.7-alpha.2` and `latest=0.1.5-rc.3`. It supersedes
the rc.1 pin below.

Changes, audited over every package, service, event, bundle row and CLI flag
the bridge uses:

- The whole `dsh-*` family moves to `0.1.7-rc.2`. `dsh-schedule` now depends on
  `dsh-api-session-controller`, which brings the API gateway into the closure:
  the lockfile adds 12 `dsh-*` packages plus `ws`, `mime-types`, `mime-db`,
  `@js-temporal/polyfill` and `jsbi`.
- Schedules move from session events to a Host service with its own storage:
  daily, weekly and cron kinds, `schedule_update`, required titles, a 60 s
  minimum interval and `schedule/changed`; the `schedule` projection is gone.
  Delivery goes through a host-provided `sessionController.resolveAgent`, which
  the bridge now provides for sessions open in dscode. rc.1 session-event
  reminders are not migrated; each open names them once.
- The source backport is rebased with one addition: Schedule's
  `requestDelivery()`, which the bridge calls when a session becomes ready, so a
  reminder due while its session was closed or busy is delivered once it can be
  (see [patches](../patches/README.md)). `sourcePatchSha256` becomes
  `27385698…`.
- 2026-09-25: the backport also fixes the local provider's foreground-signal
  race (the stdin-wait scan no longer sits between reading the foreground
  group and killing it, and a group that exited in the gap is re-read, within
  a bound), so the bridge's `terminal-signal` wrapper is gone.
  `sourcePatchSha256` becomes `a421672e…`.
- The native DeepSeek row is now `@deepseek-ai/dsh-llm-deepseek-api-key`
  (API key only); the new `llm-deepseek-account` row is on in the base layer and
  disabled by dscode's patch. `/dsh add` treats it, `deepseek-account` and
  `authorization` as credential rows.
- Approval requests carry a localized `displayReason`, which prompts now show.
- Tool-registry changes inside a conversation are recorded as developer
  messages; the next step carries the tools, `/browser on` reaches running
  Sessions, and the TUI shows the change as a system line.
- The subagent catalog walk uses `listDescendants`; listing failures name the
  session instead of reporting an unknown subagent.
- The `dsh-ssh` helper and `dsh-ptc-runtime-node` bootstrap are byte-identical
  to rc.1 (`42373bff…`, `1a5631d2…`), so remote hosts deployed for rc.1 keep
  working without a redeploy.

### Local gates

On swoop (Ubuntu 24.04.3 LTS, Linux x86_64), under `nice -n 15`, against the
source-built runtime (`dscode-runtime-linux-x86_64.tar.gz`, 404983214 bytes,
`7519ad562bf12da90229b3382956547e4f7062a9b4ae401e290f595b849fd986`) and a
plugin built from the final tree:

| Gate | Result |
| --- | --- |
| Patched Schedule package suite | 847 passed |
| `scripts/check.sh` and script tests | Passed; 47 script tests |
| Bridge `tsc` and vitest against the runtime | 76 files, 1,177 passed |
| TUI and Rust (`scripts/check-rust.sh`) | Passed |
| Installed: native provider, Teams (negative control fails as required), browser (installed and SDK), Inspector | Passed |
| SSH smoke and integrity, remote install and remote TUI (isolated sshd) | Passed |
| Managed update, update channels (17 checks), prompt acknowledgement | Passed |
| Full installed TUI E2E | Run 2444341 and provider-manage run 2516502 passed |

macOS acceptance for rc.2 has not run yet.

## 0.1.7-rc.1 — 2026-09-23

Branch `dsh-0.1.7-rc.1` (`b362cbc9`) pins official revision
`46a7f68b0922371ce7144b668b90e377d8e799f4`, release `0.1.7-rc.1`. Tag
`dsh-v0.1.7-rc.1` resolves to that commit (committed 2026-09-23T13:03:33Z). Its
GitHub prerelease was published at 13:30:24Z, and npm published
`@deepseek-ai/dsh@0.1.7-rc.1` at 13:44:12Z. When checked later that day, the npm tags were
`next=0.1.7-rc.1`, `alpha=0.1.7-alpha.2` and `latest=0.1.5-rc.3`, and master
resolved to the rc.1 commit. rc.1 is 156 commits after alpha.2 and supersedes
the alpha.2 pin below.

Changes, audited over every package, service, event, bundle row and CLI flag
the bridge uses:

- The whole `dsh-*` family moves to `0.1.7-rc.1`. Cordis, Schemastery,
  cordis-plugin-include/loader and node-addon-system are unchanged. The lockfile
  adds only `semver` (a new `dsh-app-boot` dependency).
- The source backport is byte-identical on rc.1 (upstream touched none of its
  files); `sourcePatchSha256` stays `f3fe5695…`.
- Session format, events, services and the base bundle's rows are unchanged.
- rc.1 enforces `@deepseek-ai/dsh*` peer compatibility at install and boot (see
  [upgrade strategy](upgrade-strategy.md)). dscode pins exact peers. `/dsh add`
  applies the runtime's rule before touching the profile, and the doctor reports
  skipped or exempted profile bundles.
- `libreoffice-kit` in the runtime closure moves from 0.0.1 to 0.1.0; the macOS
  runtime archive shrinks from 426 MB to 409 MB.

### macOS artifact identity and gates

Evidence root `/Users/hqzhao/AI/dsh-rc171/run-20260923`. The source checkout
`/Users/hqzhao/AI/dsh-rc171/src` is clean at the pin. The consumer tree digest
is `c9b8df93d6ce32cc681069ef686a78ff7243400c004cba7724c4b4bf662b1239`.
`payload-audit.json` checks the sidecars, the runtime descriptor, the patch
identity and byte equality of 61 plugin files with `b362cbc9`. The TUI is
`0.0.14-alpha.12 (e6173390)`: Rust sources are unchanged by this adoption.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `dscode-macos-aarch64` | 173090448 | `fc8ffc93c2c20b3d217fe65101a6336631dbe0dbfad0a561f833221eb98705d3` |
| `dscode-plugin.tgz` | 1348985 | `de8853c3c173995fa0f89560e8cfe100e10feeb7f348f884558627327f5fa8d0` |
| `dscode-runtime-macos-aarch64.tar.gz` | 409440270 | `ab7049f2a46e2da25b7983a12979c3fa736d939df68de19f8c3662888aa32748` |

| Gate | Result | Evidence |
| --- | --- | --- |
| Source runtime, plugin and consumer build | Passed in 5 min 36 s | `logs/build-payload-2.log` |
| Bridge against the source SDK, Node 24.19.0 / 22.19.0 | 66 files, 1,040 passed each | `logs/doctor-green.log`, `logs/bridge-final-node22.log` |
| New preflight tests before the fix | 2 failed as expected | `logs/compat-red.log` |
| Full installed TUI E2E (final payload) | Run 87919 passed | `logs/product-full-final.log` |
| Managed update, provider management, update channels | Passed | `logs/product-{update,provider,channels}.log` |
| rc.1 `dsh plugin add` of an alpha.2-peered bundle | Refused with the exact `allow-version` command | `logs/doctor-playwright-add.log` |
| Installed doctor on the rc.1 runtime | WARN under the exemption, ERROR after revoking it | `doctor-home/` |

The bridge needed no change for rc.1 before the preflight (run 52227 passed on
the unchanged bridge).

A review of the adoption then found the preflight weaker than DSH's own rule.
It checked only the root package and resolved profile copies before the
installation, and it hinted a PATH `dsh` command that could target another
profile. `411b30eb` checks the packages a bundle's rows insert, and resolves
the installation first. It adds `/dsh allow-version` and `/dsh revoke-version`,
rolls back a package that installs incompatible, and hardens the doctor probe.
Re-verified on its rebuilt plugin:

| Gate | Result | Evidence |
| --- | --- | --- |
| Bridge against the source SDK, Node 24.19.0 / 22.19.0 | 1,044 passed each | `logs/review-fix-3.log`, `logs/rv-rc1-bridge-node22.log` |
| Full installed TUI E2E | Run 18550 passed | `logs/rv-rc1-full.log` |
| Managed update | Passed | `logs/rv-rc1-update.log` |
| Doctor from `411b30eb` on the rc.1 runtime and a profile holding an alpha.2 bundle | One ERROR for that bundle | `doctor-home/` |

### Linux acceptance

On swoop (Ubuntu 24.04.3 LTS, Linux 6.8.0-137-generic x86_64), with the
user-approved isolation: every gate ran under `nice -n 15` with one Cargo, Rust
test, Make and vitest worker. Caches, `DSH_HOME` and temporary files were private
to the run root `/home/hanqing/dscode-rc171-acceptance.vwjmPX`. There was no sudo
and no global install; official Node 22.19.0 and 24.19.0 were reused read-only
from an earlier run. `b362cbc9` was built there from the same pinned source and patch:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `dscode-linux-x86_64` | 212501272 | `a74d0390a21093a57ab96c78f75822c586111580cd38bc4a652d0493410a80cb` |
| `dscode-plugin.tgz` | 1348957 | `5a118269fc0c004c876cbd7865a3a7fcc8c11c08b7d6551d24fe8a8963fefd66` |
| `dscode-runtime-linux-x86_64.tar.gz` | 408245907 | `5e6ad93af8e763bfbd8f6e9504d1264072e151b03de8f2d1acf09d6f76d1f08e` |

All 22 gates passed (logs under the run root's `logs/`):

| Gate | Result |
| --- | --- |
| Setup, source runtime build, consumer provenance | Passed; runtime build 7 min |
| Built Linux native acceptance, Node 22.19.0 / 24.19.0 | 15 cases each |
| TUI and Rust (`scripts/check-rust.sh`) | 2,700 passed, 2 ignored |
| `scripts/check.sh` and script tests, Node 22.19.0 / 24.19.0 | Passed; 47 script tests |
| Bridge against the source SDK, Node 22.19.0 / 24.19.0 | 66 files, 1,040 passed each |
| Source prepare, host and user-namespace runs on both Node versions, docs, snapshot prerequisites and snapshot | Passed |
| Managed update, provider management, update channels | Passed |
| Full installed TUI E2E | Run 2695239 passed |

The review fixes were then checked out from a bundle into a private clone, and
their bridge suites ran on both Node versions (`logs/review-bridge.log`).
`411b30eb` passed 1,044 tests each; the capability branch's `77614bd0` passed
1,050 each.

## Earlier candidates

Before rc.1 this adaptation produced two unpublished worktree candidates on the
same product base: `0.1.7-alpha.1` (`c36a83ff`, patch `a1dbb059…`) and
`0.1.7-alpha.2` (`00102833`, patch `d18c9d03…`, later `f3fe5695…`). Each passed
its executed macOS and Linux product gates; neither was released. Their
changes, artifacts, gates and evidence paths are in
`git show 3cf5201acd:docs/dsh-upstream-refresh-2026-09-22.md`.
