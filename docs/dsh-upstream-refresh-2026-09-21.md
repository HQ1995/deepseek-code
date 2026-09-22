# DSH upstream refresh — 2026-09-21

## Release facts

Checked against the official GitHub and npm APIs at `2026-09-22T02:54Z`. DSH
has published the prerelease **`0.1.6-alpha.2`**. The [GitHub release][release]
was published at `2026-09-17T13:30:16Z`; its tag `dsh-v0.1.6-alpha.2`
resolves directly to commit `ddefc45fbc7f8e46dd73185e68295696d1297887`, whose
commit time is `2026-09-17T13:19:19Z`. The release is marked
`prerelease: true`. [Tag API][tag-api], [commit API][commit-api].

The official `master` resolved to that same commit, so this check found no
unreleased upstream work beyond the tag. [Master commit API][master-api].

The [npm registry record for `@deepseek-ai/dsh`][npm-dsh] reports:

| npm dist-tag | Published package version | Package publication time (UTC) |
| --- | --- | --- |
| `alpha` | `0.1.6-alpha.2` | `2026-09-17T13:52:10.201Z` |
| `next` | `0.1.5-rc.2` | `2026-09-10T14:57:10.790Z` |
| `latest` | `0.1.5-rc.2` | `2026-09-10T14:57:10.790Z` |

The newest publication is therefore on `alpha` only; `latest` and `next`
still select the older rc.2.

32 of the 35 distinct `@deepseek-ai` packages declared across the bridge's peer,
development and ordinary dependencies have a published `0.1.6-alpha.2` version
record. The three that do not are the unchanged support packages
[`@deepseek-ai/cordis`][npm-cordis] `4.0.2` (`2026-08-30T13:13:14.302Z`),
[`@deepseek-ai/schemastery`][npm-schemastery] `3.18.2`
(`2026-08-30T13:14:16.636Z`) and
[`@deepseek-ai/node-addon-system`][npm-node-addon-system] `0.1.2`
(`2026-09-08T14:34:51.575Z`), each still selected by its `latest` tag.
Selected publication times of packages that did move:

| Package | `0.1.6-alpha.2` publication time (UTC) |
| --- | --- |
| [`@deepseek-ai/dsh-agent`][npm-agent] | `2026-09-17T13:38:55.569Z` |
| [`@deepseek-ai/dsh-subprocess-local`][npm-subprocess-local] | `2026-09-17T13:37:18.079Z` |
| [`@deepseek-ai/dsh-terminal-bash`][npm-terminal-bash] | `2026-09-17T13:47:54.595Z` |

548 non-merge commits are reachable from the tag beyond the alpha.1 commit
`0a15e36e7f82b6ed45af6fa9759f29b40dcd965d` inspected by the
[previous refresh](dsh-upstream-refresh-2026-09-15.md), so alpha.2 is not a
one-fix release. [Alpha.1-to-alpha.2 comparison][alpha-compare].

This check establishes published version/channel metadata and official tag
identity. It does not establish byte equivalence between npm tarballs and the
Git tree, and it did not install a package.

## Effect on the product pin

[The bridge manifest](../bridge/grok-leader/package.json) moves from
`0.1.5-rc.2` / `fb2c4b9e698e30edb738bca4cf0618587db7d203` to
`0.1.6-alpha.2` / `ddefc45fbc7f8e46dd73185e68295696d1297887`, including
`supportedRange`, `testedVersion`, `sourceCommit` and
`sourcePatchSha256`. The bridge lock is regenerated to the same version and no
`0.1.5-rc.2` resolution remains in it. Koffi's build approval moves to pnpm
11's `allowBuilds` key in the [bridge workspace](../bridge/grok-leader/pnpm-workspace.yaml).

[patches/README.md](../patches/README.md) records what happened to the local
backport. The regenerated [`dsh-ddefc45fbc...` patch][patch] carries only the
macOS kernel process-observation work. Its Linux half is gone because the
release owns it: alpha.2 contains
`packages/subprocess/subprocess-local/src/linux-scope.ts`, the early-bootstrap
fixture and the authored `bash-startup-timeout` recorded session that the
previous patch backported. The acceptance that validated that backport on a
real user systemd stays recorded in
[the combined Linux settlement report](linux-acceptance-2026-09-17.md) and is
re-run for every payload that bumps the runtime. This is a production change,
so the Linux threshold reopens; the run is requested separately and is not
claimed here.

## Composition carried with the pin

alpha.2 replaces the worker-thread runtime packages and adds a native
session-log contributor, so the pin carries the composition the
[alpha.1 adaptation audit](runtime-alpha16-adaptation.md) specified:

- [cordis.patch.yml](../bridge/grok-leader/cordis.patch.yml) inserts no runtime
  row at all, disables the host row under its new id `workflow-ptc`, and opts
  out of `session-log-deepseek` contributions with
  `config.enabled: false`. Base owns the PTC runtime; the shipped workflow
  presets mount their own isolated engine.
- The owned [history](../bridge/grok-leader/presets/history/agent.cordis.yml),
  [LSP](../bridge/grok-leader/presets/lsp/agent.cordis.yml) and
  [terminal](../bridge/grok-leader/presets/terminal/agent.cordis.yml) snapshots
  move to `@deepseek-ai/dsh-workflow-ptc` and restate upstream's
  `tool-plugin-manager disabled: true` row. All three keep `ralph` enabled.
- [native-session-status.ts](../bridge/grok-leader/src/native-session-status.ts)
  subscribes to the awaited `agent/created` lifecycle instead of
  `agent/session-start`.
- [runtime-composition.spec.ts](../bridge/grok-leader/tests/runtime-composition.spec.ts)
  is a new static guard over those three decisions, and the existing
  expectations that named the removed rows were updated with them.

Upstream also now ships `tool-ralph` disabled in every preset it owns. That
changes shipped tool availability rather than the engine contract: a deployment
that wants the tool back forks the preset, which is what the three dscode
snapshots are. The installed-product harnesses were corrected to expect exactly
that split:

- [e2e-tui-bridge.sh](../scripts/e2e-tui-bridge.sh) drops `ralph` from the
  shipped `standard` roster, keeps it for the three owned presets, adds the
  `lsp` and `terminal` presets to the Responses roster audit, and expects the
  read-only cordis preset (`cordis_inspect_list`, `cordis_inspect_query`,
  `plugin_manager`).
- [e2e-history.mjs](../scripts/e2e-history.mjs) separates the shipped
  `standard` roster from the owned history roster, which still adds `ralph`.
- [e2e-contracts.mjs](../scripts/e2e-contracts.mjs) expects the pinned
  `testedVersion` to be `0.1.6-alpha.2`.

## Verification on Darwin arm64

Run root: `/Users/hqzhao/AI/dsh-alpha2/run-20260921`. The payload was built from
the official alpha.2 source checkout before these gates; bridge sources did not
change after the bridge suite ran.

| Gate | Result | Evidence |
| --- | --- | --- |
| Release payload build | plugin `534ac5db...6d96`, runtime `7eeaff7e...0de4`, both `shasum -c` OK | `payload/*.sha256` |
| `bash scripts/check.sh` | `PASS scripts/check.sh` | `logs/check-sh.log` |
| `node --test scripts/*.test.mjs` | 46 passed, 1 skipped, 0 failed | this run |
| `bash scripts/check-rust.sh` | `PASS Rust product contracts` | `logs/check-rust.log` |
| Bridge compile + suite | `tsc` clean; 47 files passed, 1 skipped; 964 tests passed, 4 skipped | `logs/dev-bridge-tests.log` |
| Installed product E2E | `PASS real TUI + dsh + bridge E2E run 16681` | `logs/e2e-full-final.log`, `/tmp/dscode-tui-e2e/contracts-16681/PASS.json` |

The E2E run covers the compiled TUI through the installed profile: environment
isolation, preset picker and compaction, provider/model selection, bridge-owned
plugin lifecycle, the bridge-owned preset switch mid-turn, streaming, paste and
editor paths, Markdown/OSC8 copy, table-cell copy, image stash and restore,
fullscreen/minimal switching, `ask_user_question`, durable resume, the eight
shipped and custom preset rosters, session-event and durable-history access
(14 cases), native goal/task/child/terminal controls, the rewind picker and
paged rewind, and the runtime contract acceptance record above.

Not covered locally: the Node 22 half of the bridge matrix (the local nvm tree
only has 22.15.0, below the bridge's 22.19 floor, so the local suite runs on Node
24.19.0), Linux, kitty pixel rendering (no configured executable), physical
macOS Cmd-click, and any real-provider paid call.

[release]: https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2
[tag-api]: https://api.github.com/repos/deepseek-ai/deepseek-harness/git/ref/tags/dsh-v0.1.6-alpha.2
[commit-api]: https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/ddefc45fbc7f8e46dd73185e68295696d1297887
[master-api]: https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/master
[npm-dsh]: https://registry.npmjs.org/@deepseek-ai%2Fdsh
[npm-agent]: https://registry.npmjs.org/@deepseek-ai%2Fdsh-agent
[npm-subprocess-local]: https://registry.npmjs.org/@deepseek-ai%2Fdsh-subprocess-local
[npm-terminal-bash]: https://registry.npmjs.org/@deepseek-ai%2Fdsh-terminal-bash
[npm-cordis]: https://registry.npmjs.org/@deepseek-ai%2Fcordis
[npm-schemastery]: https://registry.npmjs.org/@deepseek-ai%2Fschemastery
[npm-node-addon-system]: https://registry.npmjs.org/@deepseek-ai%2Fnode-addon-system
[alpha-compare]: https://github.com/deepseek-ai/deepseek-harness/compare/0a15e36e7f82b6ed45af6fa9759f29b40dcd965d...ddefc45fbc7f8e46dd73185e68295696d1297887
[patch]: ../patches/dsh-ddefc45fbc7f8e46dd73185e68295696d1297887.patch
