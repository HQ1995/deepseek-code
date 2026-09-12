# Upgrade and release

`dscode` ships three versioned parts: the vendored Rust TUI, the
`grok-leader` bridge, and a pinned DSH runtime. A product release identifies one
complete tuple; never follow an unpinned `latest` runtime at user launch.

## TUI sync

The TUI lives in `third_party/grok-build` and is maintained as in-repo source,
not a submodule.

1. Run `scripts/update-tui.sh <upstream-ref>` to prepare a scratch diff.
2. Port selected upstream changes by hand; do not replace the tree wholesale.
3. Update `third_party/grok-build/UPSTREAM_REV`.
4. Record every local difference in
   `third_party/grok-build/TUI-DIVERGENCE.md`.
5. Build and run the full product suite.

Generic fixes should go upstream when practical. Remove their divergence entry
after the upstream baseline contains the fix.

## dsh runtime

Follow only [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
Do not maintain a separate product harness fork. Keep dscode integration in the
external bridge, submit generic fixes upstream, and consume verified official
revisions through the versioned product tuple.

The supported runtime is declared in `bridge/grok-leader/package.json`:

- `dsh.testedVersion`: exact runtime used by the launcher
- `dsh.supportedRange`: compatibility range for profile plugins
- `dsh.sourceCommit`: full upstream revision for a source-built SDK/runtime

To upgrade dsh:

1. bump the tested version and range when needed;
2. update the entire `@deepseek-ai/dsh-*` SDK family; update the registry lockfile
   only when that family is published, otherwise build the pinned source family;
3. mirror that pinned dsh dependency tree's Node floor in the launcher and npm
   metadata, but never install or switch the user's Node runtime;
4. rebuild the bridge and run the complete E2E suite;

The current source pin is `0.1.5-rc.2` at
`fb2c4b9e698e30edb738bca4cf0618587db7d203`. The builder uses the official upstream
package build, compiles the bridge against that installed SDK, bundles ordinary
plugin dependencies without duplicating host peers, and packages the private
runtime including native helpers. Users install those artifacts as a complete
tuple. Never mix SDK families or duplicate Cordis/service scope
identities.

DSH 0.1.5 uses V3 session logs. The bridge normalizes its two historical model
selection event names through a narrowly scoped adapter on the pinned JSONL
provider; the native migrator performs validation and generation publication.
V0/V1/V2 originals remain intact. An older runtime refuses the newer generation:
rolling back the executable is possible, but does not downgrade session data or
resume a stale copy. Use a matching runtime to continue migrated conversations.
The same rule applies to new required events within V3, including parent-owned
subagent catalogs and file deliveries: an older runtime may refuse these logs
even though their numeric format version is still 3.
Linux runtime payloads now include `node-addon-system` 0.1.2 flock and Landlock
artifacts, built with the official `native/system` scripts.

Source-runtime descriptors record the source revision, DSH version, platform,
and architecture; the launcher validates them and the CLI/native helper before
activation. The helper is discovered from the installed layout and checked
against what its own `prebuilds.json` declares, so an upstream package rename or
renamed identifier cannot block an update the installed launcher would
otherwise refuse. An explicit `DSH_BIN` must report the exact pin. Registry-backed
releases may reuse an exact PATH runtime. Neither path upgrades a global install.

Stable, beta, and alpha are independent product channels. Beta and alpha each
include their own prereleases plus stable releases. Unmarked historical
`channel = "alpha"` resolves beta; canonical settings carry `channel_format = 1`.
Checks never write that migration. The installer commits the channel only after
the exact tuple is ready, restoring moved entries after ordinary commit errors.

### DSH 0.1.5 feature coverage

The [rc.2 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.2)
and [rc.1 feature summary](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1)
describe the target. Runtime features use official implementations. Browser
presentation does not automatically become a TUI feature.

| Upstream capability | dscode integration |
|---|---|
| V3 logs, immutable migration, SessionHandle and process locks | Native persistence; existing legacy model-selection adapter; resume/fork/archive tests |
| Parent-owned subagent catalog and ordered discovery | Native `listDescendants`; `/subagents`, Tasks and child history; catalog survives restart |
| Continuable children, queue/edit/remove/steer/stop | Existing native inbox adapters and TUI controls; terminal states retain readable history |
| Agent Team messaging changes | Included in the runtime; experimental Team composition remains opt-in (see below) |
| Goals, explicit pause/resume and turn cancellation | `/goal` and native controls; pausing does not let the model resume itself |
| Reminder scheduling | `/reminders`; native durable schedules, delivered while the owning session is open |
| Jobs, retained output and subprocess cleanup | `/tasks`, passive output and cancellation; host PID validation remains enforced |
| Persistent shell and REPL | `terminal` preset and `/tasks terminals`; native interrupt/close and per-session ownership |
| Minimal preset | Follows upstream's persistent shell; `str_replace_editor` is now an explicit opt-in |
| Standard read/write/edit, FS_NOT_OBSERVED and scoped tool guidance | Native tools and permissions; structured errors remain visible |
| PTC execution and nested output | `ptc`; every nested sub-dispatch becomes its own transcript row (name, arguments, output, execute/edit raw shapes, diff fallback) in live and replayed history |
| Workflows and Ralph | `/workflows`, task phases, history and native workflow tools |
| LSP navigation | Opt-in `lsp` preset; installed language server required |
| Session search and long references | `/resume`, `/reference`, `history` tools and native on-demand event reads |
| Long-session performance and projection hydration | Native runtime fixes; bridge keeps its bounded session index and paginated child history |
| New DeepSeek-V41-Flash model | Official native adapter is packaged, including text/image and in-history system-prompt capabilities; enable it explicitly as described below |
| Existing DeepSeek V4 models | Retained by upstream; saved provider/model selections are preserved |
| Dynamic system prompts | Native request reconstruction follows the selected adapter/model's declared capability |
| Model discovery and reasoning/image metadata | `/provider` and `/model`; native discovery plus the existing bounded endpoint capability reader |
| Invalid pi-ai configurations | Provider remains visible with its native diagnostic; working models remain selectable and saved routes remain editable/removable |
| Provider Base URL validation | Shared add/edit validation runs before writes; surrounding whitespace is normalized |
| HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY | Native runtime proxy support; environment is inherited by the managed runtime |
| Streaming tool-call continuation | Native DeepSeek fix preserves call identifiers and names |
| MCP tool pagination | Native repeated-cursor rejection; `/mcps` and bridge initialization keep diagnostic behavior |
| Skills and commands | `/skills`, skill insertion and native command discovery; TUI search uses its existing picker |
| Preset editing and plugin composition | `/preset manage`, `/dsh`; host service identities remain shared |
| `present` file delivery | Clickable transcript links from `deliverables/presented`, live and after resume; child/fork paths use the viewed workspace |
| Standard-derived custom presets | `history`, `terminal` and `lsp` snapshots also mount `present`; user copies remain user-owned snapshots |
| General file input | Existing local file references let native file tools read paths; browser upload/progress UI has no terminal transport equivalent |
| Images and read_image | Existing input admission; top-level results and PTC sub-call results both resolve images to viewer paths, plus explicit image opening |
| Markdown/ZIP export | `/export`; ZIP includes logs and attachments, while `present` stores source-file references rather than copies |
| Independent text feedback | Native `/feedback <text>` appends feedback without a model turn; upstream telemetry policy may include session context |
| Feedback rating/category dialogs | Web-only controls; no new TUI rating or category dialog |
| Sidebar tabs, splits, PDF/HTML previews, file icons | Browser UI is not ported; TUI uses transcript links, existing viewers and explicit external opening |
| Workspace editor/file-manager actions | Existing TUI links/editor handoff; no browser desktop toolbar |
| Web layout, localization, scrolling and reconnect fixes | Browser-only changes; TUI keeps its own tested rendering and reconnect paths |
| Windows UI and Python SDK fixes | Included upstream; dscode's supported targets remain Linux x86-64 and macOS ARM64 |

To use the official DeepSeek adapter, add this override to the existing
`~/.dsh/profiles/dscode/cordis.patch.yml`, provide `DEEPSEEK_API_KEY`, restart,
then choose `deepseek-official` / `deepseek-flash` in `/model`:

```yaml
- id: llm-deepseek
  disabled: false
```

The default profile remains provider-neutral. OpenAI-compatible gateway routes
use their own discovered metadata; they do not inherit the native adapter's
vision or system-prompt capabilities just because model names match. Model
catalog and transport tests do not certify a live provider account.

Experimental Agent Teams are published upstream but are not enabled in our
shipped presets. Their profile only disables global legacy controls; Standard
still mounts those controls in its preset scope. A safe future integration
needs a Team-aware preset plus a Team roster/task-board adapter, rather than
mounting both sets of overlapping tools. No Team-specific TUI board, task claims
or membership controls are claimed here.

## Bridge changes

- Keep `docs/grok-leader-protocol.md`, the captured handshake fixture, and
  codec/socket tests in sync with wire changes.
- Fail fast on protocol-version mismatches and unsupported CLI metadata.
- After local bridge edits, run `scripts/update-bridge.sh` before manual TUI
  testing. It replaces the plugin transactionally while preserving the profile,
  runtime, and channel; a different tuple requires `scripts/install.sh`. A live
  leader keeps its loaded code until the last client exits.

## Validation

Compile and test against the same SDK as the runtime:

```sh
scripts/dev-bridge-tests.sh            # build the pinned source payload
scripts/dev-bridge-tests.sh --reuse    # use matching artifacts from dist/
DSCODE_E2E_RELEASE_DIR=/path/to/payload scripts/dev-bridge-tests.sh
```

The runner copies the bridge into a temporary workspace and uses the payload's
SDK, leaving the checkout's dependency installation intact. `DSCODE_SOURCE_DIR`
and `DSCODE_RUNTIME_CONSUMER` reuse an exact source checkout and installed SDK.
Consumer reuse requires `dscode-consumer.json` from a completed source build;
the builder verifies the commit, platform, and installed dependency bytes.
An old consumer without this record must be rebuilt: omit the consumer override
or point it at a new directory. Existing unverified caches are never relabeled.
`DSCODE_TUI_BIN` selects the compiled TUI for CLI contracts.

Product and release checks:

```sh
scripts/check.sh
node --test scripts/release-payload.test.mjs
scripts/check-rust.sh
scripts/e2e-product.sh
scripts/e2e-product.sh --full --provider-ui
# On Linux with a working user-systemd manager, also verify escaped descendants:
DSCODE_E2E_CONTAINMENT=1 scripts/e2e-product.sh --full --provider-ui
scripts/e2e-release-lifecycle.sh
node scripts/e2e-update-channels.mjs --plugin dist/dscode-plugin.tgz \
  --runtime dist/dscode-runtime-linux-x86_64.tar.gz --tui dist/dscode-linux-x86_64
```

CI runs script, bridge, and Rust checks on Ubuntu and macOS. Tagged releases
build `dscode-linux-x86_64` and `dscode-macos-aarch64` in
`.github/workflows/release.yml`.

Linux Rust tests require user/PID namespace isolation; `scripts/check-rust.sh`
fails if `unshare` cannot provide it. Process-lifecycle tests must not share the
host PID namespace. The full Linux product suite also needs tmux and the
[LSP dependencies](../bridge/grok-leader/README.md#optional-lsp).

`DSCODE_RELEASE_DIR` selects existing payloads for product E2Es.
`DSCODE_E2E_DSH_BIN` and `DSCODE_E2E_PLUGIN_TGZ` select explicit runtime/plugin
artifacts. Source tarball policies in `DSCODE_E2E_PNPM_CONFIG` may override
ordinary dependency edges only; global `file:` peer overrides duplicate DSH
scope identities and are invalid.

The product matrix above uses simulated model replies; it is not live-model
certification. Run `node scripts/e2e-live-models.mjs --help` for the separate,
billable live-model acceptance runner. Supply the built TUI, pinned DSH binary,
an already provisioned disposable `--home` and its `--profile` at
`HOME/profiles/dscode`, the exact `--provider`/`--model`, and a fresh `--out`
directory outside the repository. The runner forwards `OCX_API_KEY` by default;
`DSCODE_LIVE_AUTH_ENV` selects alternative credential environment-variable names.
Use a direct model route, not an alias that can fail over to a different model.

Live results include native tool/child/goal evidence, filesystem assertions,
TUI captures and per-scenario pass/fail/skip records in `results.json`.
`--scenario` selects a focused rerun. Images are capability-reported, not a
vision-understanding test; headless cases are not visual TUI coverage. Neither
a passing finite matrix nor the absence of a credentialed run establishes
exhaustive model compatibility.

## Release

1. Keep `VERSION` and `bridge/grok-leader/package.json` versions equal.
2. Start with `scripts/release.sh --dry-run` and inspect the staged binaries,
   checksums, plugin tarball, license bundle, and version banner. Reuse an exact
   source checkout/SDK consumer via `DSCODE_SOURCE_DIR` and `DSCODE_RUNTIME_CONSUMER`.
3. Commit a clean tree, then run `scripts/release.sh`. The release gate requires
   the exact tag commit's successful CI workflow and validates draft asset
   checksums, gzip contents, and plugin/runtime provenance before publication.
4. Wait for both platforms' TUI assets and, for source releases, runtime archives
   and checksums, plus the plugin and its checksum, before making the release public.
5. Stable publishes to npm `latest`; beta and alpha use their matching npm tags
   and GitHub prereleases. Release selection never treats alpha as beta.
