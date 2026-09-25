# TUI divergence ledger

Apache-2.0 change notice:
This tree is a modified distribution of
[xai-org/grok-build](https://github.com/xai-org/grok-build).
The differences listed below are local modifications made for deepseek-code.
Modified files remain under the Apache License, Version 2.0; see [LICENSE](LICENSE).

Every intentional difference between this tree and upstream grok-build.
Class: patch (generic fix, should be offered upstream) / feature (product) /
branding (our identity). Keep this list current on every sync.

The shared test registry pins the steering key so headless terminal detection
cannot change its input contract. Linux test isolation resets SIGINT/SIGTERM
after entering the namespace to handle older util-linux launchers.

## Upstream baseline

- Source baseline: xai-org/grok-build
  `19d42e35c07a9c9244f03f6df0c4c353f970d4f9` (`xai-grok-shell` 1.0.6),
  three-way merged from the prior `d6a22a1` baseline. Product-specific dsh,
  provider, branding, startup, and protocol changes below remain layered on
  top; upstream source synchronization does not enable unsupported x.ai
  surfaces.

## Branding

- Repository-only cleanup: omit `xai-grok-shell/CHANGELOG.md` and its historical
  `changelogs/` payloads, which no build or runtime reads. Embedded README,
  user-guide, tutorial, prompt, and test fixtures remain. `VENDORING.md` points
  here and to `UPSTREAM_REV` instead of duplicating stale integration notes.

- Product name and visible strings changed grok -> dscode / "Deepseek Code"
  across the pager and shell crates (recovered from the squashed history; if
  a string resurfaces after an upstream sync, reapply here).
- Vendor copy: "SpaceXAI" -> "DeepSeek" in the default model description
  (crates/codegen/xai-grok-models/default_models.json).
- Minimal auth rendering's header assertion matches the existing "Dscode"
  branding in .../xai-grok-pager-minimal/src/auth.rs.

## Feature

- DSH alpha capability projection: a zero-tool MCP server is not labelled as
  disconnected (it may expose only resources). Durable image offload uses an
  existing system-notice block, not assistant text; paged native child history
  accepts optional `imageNotes` beside ACP updates. Older pages remain valid and
  history cursors still count native events, not rendered blocks.
- Prompt acknowledgment recovery (adapted from upstream `37949780c1`): shared
  first-receipt rules for TUI/headless, with a 120s default hard deadline and
  a 10s TUI notice. `DSCODE_PROMPT_ACK_TIMEOUT_SECS` is bounded to 5–3600s;
  missing/zero/invalid values keep the default. Queue receipt, live named
  updates and terminal responses disarm the watch; model duration is unbounded.
  Recovery preserves newer drafts/attachments/queue edits, never auto-resends,
  keeps committed minimal scrollback and rejects late prompt IDs. Reconnect
  retains its own lifecycle. Unlike upstream's legacy cancel metadata, dscode
  uses the bridge's bounded `x.ai/session/cancel_prompt` request and warns on
  old/unresponsive leaders without a session-wide fallback. No telemetry added.
- Theme alias search and settings radio double-click (selectively ported from
  upstream `37949780c1`): the picker searches the same aliases the theme parser
  accepts and inserts canonical values. Only local theme variants are included;
  this does not introduce the upstream terminal theme. A timely second click
  confirms through the existing Enter path, retaining preview/revert and
  deep-link close behavior. Picker transitions, keyboard focus changes and
  clicks outside choices clear the gesture. Rust contracts and the real TUI
  acceptance cover these paths without changing the DSH runtime pin.
- Native DSH ZIP export: `/export file.zip` uses the existing session-command
  effect with `x.ai/session/export` for the root session. The bridge streams
  native logs, descendants and attachments to a private, non-overwriting file;
  Markdown and clipboard export keep their existing paths.
- Image overlay placement cache (ported from upstream `9684fa3cdb`): cache the
  image owner and rectangle together, clear and retransmit after a move or
  resize, and commit only successful writes. Identical frames avoid retransmit.
  Cell aspect measurement (ported from `75810042ca`) uses terminal-reported
  pixels/cells with a bounded fallback instead of assuming every cell is 1:2.
  Existing Kitty-protocol capability and tmux/Byobu gates remain in force.
- Bare `/` command recency (ported from upstream `07b2f7144f`): reuse the
  existing MRU and persistence, keeping curated tags first and registry order
  for ties. Skill provenance grouping is omitted because DSH's command catalog
  does not supply the corresponding metadata.
- Prompt draft stash (ported from upstream `07b2f7144f`): Ctrl+S / Alt+S
  preserves the draft, images, cursor and input mode; the same chord restores
  it on an empty composer, and a consumed side prompt restores it automatically.
  Session pickers move to F3, with `/resume` retained. Queue edits and pending
  paste probes keep ownership; keyboard and mouse history recall pop the slot.
  dscode's Alt+Enter steer retains its no-cancel behavior after deferred paste.
- In-process `/minimal` / `/fullscreen` (ported from upstream `07b2f7144f`):
  park the input reader, drain terminal writes, rebuild the viewport and reseed
  mode-dependent state without restarting the DSH session. Running streams and
  composer state survive round trips. Panic, signal and normal teardown use
  the actual screen mode; legacy exec relaunch remains the failure fallback.
  Returning to fullscreen rebuilds heights and fold groups after minimal's
  direct entry display-mode changes, including child views.
- Fullscreen external prompt editing (ported from upstream `07b2f7144f`):
  `/edit-prompt` and the command palette reuse the existing editor suspend and
  restore path in both modes. Fullscreen Ctrl+G remains the tasks shortcut.
  Existing overlay, child, queue-edit, attachment, pending-paste, and voice
  ownership checks remain in place; returning from the editor does not send.
- Managed product launcher and external leader bootstrap: the JS launcher
  provisions and verifies the exact TUI/bridge/runtime tuple before starting
  Rust and supplies the tested `DSH_BIN`. A plain TUI run defaults to leader
  mode against the external DSH CLI instead of grok's self-spawn.
  crates/codegen/xai-grok-pager/src/dsh_leader.rs
  spawns "dsh --profile dscode" with DSCODE_SOCKET /
  DSH_TELEMETRY_DISABLED=1, logs to /tmp/dscode.log, and records the PID in the
  sibling .lock. pager-bin main.rs synthesizes --leader/--leader-socket/
  --sandbox off for interactive launches and `dscode dashboard`; explicit
  --sandbox restrictions and --no-leader fail closed, including
  `--no-leader dashboard`. The user's auto-update opt-in/out is preserved.
  Host NUMA binding is applied by the caller, not by this portable launcher.
  acp::connect_via_leader and the LeaderReconnector call the new
  xai-grok-shell connect_or_spawn_external (connect-first adoption of a live
  leader, flock-serialized single spawner, one ~30s wait that covers a cold
  node boot, failed spawns are killed) so sessions spawned by the old shell
  leader on the same socket are still adopted. A binary-version mismatch is
  `IncompatibleLeader` (terminal, not retried) and cancels the registered
  client before returning; generic spawn failures stay retryable. scripts/install.sh links ~/.local/bin/dscode to the
  stable profile-owned JS bootstrap; historical direct-binary links are migrated.
  The bootstrap survives interrupted directory swaps, recovers the durable
  update journal under the profile lock, then loads the installed launcher.
- Independent stable/beta/alpha updater channels: legacy unmarked alpha config
  resolves beta, while channel_format=1 records canonical selections. Read-only
  checks bypass writeful startup and uncached checks do not persist anything.
  Rust delegates an already resolved exact target to the managed JS updater;
  the previous Rust binary-only dscode installer is removed. Direct updates,
  background updates, and leader convergence share this whole-product path.
  Source-runtime profile identity includes the pinned DSH revision/version.
  Missing or historical launchers bootstrap a known whole-product updater
  separately from the target version, preventing old beta launchers from
  delegating back into a newer cached TUI indefinitely.
- As upstream, a `config.toml` that does not parse, or that names an unknown
  channel or format, never blocks `dscode update` or startup: Rust
  `build_update_config` and the JS updater keep the release's own channel (or
  an explicit `--stable`/`--beta`/`--alpha`). dscode also names the ignored file
  on stderr, and the JS updater never rewrites a file it could not parse.
  `xai-grok-pager-bin/tests/update_never_blocked_by_config.rs` runs this
  through the `dscode` binary, `DSCODE_HOME` and the loopback
  `DSC_UPDATE_BASE_URL` release seam, without network access or an install.
- GitHub release lookups send `GITHUB_TOKEN`/`GH_TOKEN` when the environment
  provides one and fall back to the anonymous call when it is rejected or
  limit-spent: the anonymous API allows 60 requests per hour per address, which
  a release day or a shared egress address can exhaust. The Rust check and the
  managed JS updater apply the same policy.
- Environment namespace isolation: pager-bin strips every inherited `GROK_*`
  variable before configuration loads, then maps only `DSCODE_CONFIG`,
  `DSCODE_CONFIG_PATH`, `DSCODE_CONNECT_UI_TIMEOUT_SECS`,
  `DSCODE_CLIPBOARD_NO_NATIVE_READ`, and `DSCODE_CLIPBOARD_NO_OSC52` to their
  internal Grok names. The clipboard switches let isolated terminal tests avoid
  reading NSPasteboard or writing through OSC52. The dsh child also strips
  those internal names before spawning.
  Parent-shell state is untouched; recovery copy uses the DSCODE timeout name.
- Leader mode: --leader/--leader-socket flags connect the TUI to our bridge
  over the grok leader unix-socket protocol instead of x.ai; local xai auth
  is bypassed in leader mode.
- Default preset label: `app/app_view.rs` starts at `"standard"` until the
  bridge's `x.ai/bundle/status.defaultPersona` arrives, then renders the dsh
  roster's remembered `agent-presets.default`. A live manual selection still
  wins through `persona_override`.
- Persona/preset selection is fed by the bridge's dynamic bundle/status roster;
  selection uses the returned preset id while display uses its name. TUI manual
  selections stamp `rememberAgentPreset` and become the default for later new
  sessions; unmarked headless/session overrides stay local, while resume and
  fork retain their durable session preset. There is no TUI-side allowlist, so
  user-installed dsh presets appear without a Rust change. The four shipped
  presets are only the E2E baseline.
  Selection is refused before local state changes while a turn, command, replay,
  or native wake is active. The bridge also rejects in-flight preset reloads,
  including reselecting the current preset, before flushing or disposing the
  agent; the existing prompt and transcript remain intact.
- /provider command (crates/codegen/xai-grok-pager/src/slash/commands/provider.rs):
  lists providers from the bridge's initialize _meta.modelState.providers and
  switches through the existing SetDefaultModel pipeline. It keeps the same
  raw model id when the target provider offers it, otherwise falling back to
  that provider's first catalog model. The "current provider" is derived
  from the current model's provider meta (the bridge's currentProviderId is
  only a fallback). /model's dropdown is scoped to the current provider when
  empty (falling back to the full catalog if that provider has no models), and
  typing a query searches the full global catalog (rows outside the current
  provider prefixed "[provider]"), so a cross-provider switch is still a
  single /model pick via completion search. An earlier all-provider-always-
  visible iteration became unusable as providers and models grew; an earlier
  strict current-provider-only version made cross-provider switching a
  mandatory two-step hop.
  /provider rows carry a model count; a model-less provider (subscription
  pre-login, missing API key) says so in the row and errors with the
  /dsh login pointer instead of a bare "has no models". The bridge owns
  provider auth/config (~/.dsh); the TUI never hardcodes provider auth
  assumptions. /model rows also show the technical model id in the
  description column and match on it, so ids like `deepseek-v4-flash` are
  visible and typeable; provider prefixes use the human-readable provider
  name when the bridge supplies one instead of raw route ids. When two
  providers expose the same raw model id, the bridge qualifies the later
  provider's copy as `provider:model` so both remain selectable, and the
  remembered effort is isolated by the underlying provider/model pair. The
  effort menu is sourced from each model's adapter metadata instead of a
  hardcoded grok list, so unsupported levels (e.g. medium/xhigh where absent)
  are not offered. For OpenAI-compatible custom providers, the bridge refreshes the
  model catalog from `GET /models` once per provider (and writes the refreshed
  list back to settings), so stale hand-entered lists are replaced by the
  provider's current models.
- Queue-pane steering: while a turn runs, the queue row hover/focus action
  chain now includes `[steer]` next to `[Send now]` (`[steer][Send now][edit][cancel]`).
  `[steer]` removes the queued row and merges its text into the running turn
  without cancelling it, matching the composer's Alt+Enter steer. Local rows
  dispatch `Action::Interject`; server rows use the bridge's new `x.ai/queue/steer`.
- Queue-first Up navigation (ported from upstream `07b2f7144f`): on an empty
  Normal composer, Up focuses the bottom row of the merged server-then-local
  queue before falling back to prompt history. Non-empty and non-Normal
  composers keep their existing cursor/mode behavior.
- X10 mouse reassembly (ported from upstream `77cd7eb675`):
  `app/x10_filter.rs` reconstructs legacy X10 reports whose high coordinate
  byte was UTF-8-expanded by a ConPTY/WSL/SSH relay, including pairs split
  across reader batches, without consuming stale or unrelated typing.
  `event_loop.rs` runs it after CSI filtering and reasserts mouse capture on
  refocus when capture remains enabled.
- Add-provider flow: the /provider dropdown's final row "+ Add provider…"
  accepts as /provider --add, which opens a two-step add-provider modal
  (crates/codegen/xai-grok-pager/src/views/add_provider_modal.rs, wired through
  ActiveModal::AddProvider, Action::OpenAddProvider/AddProvider and
  Effect::AddProvider). Step one is a bounded vertical template picker:
  DeepSeek, OpenCodex (`ocx`), OpenAI, Anthropic, OpenRouter, and Custom;
  templates whose route id already exists are omitted. It shows each catalog
  endpoint as a display-only default, so leaving baseURL empty keeps following
  catalog updates instead of persisting today's URL. Step two is a focused
  seven-field window (current field plus bounded neighbors) over
  id/displayName/api/baseURL/credentialSource/apiKeyEnv/apiKey.
  credentialSource explicitly selects Saved key or Environment. A pasted
  apiKey renders masked and is stored by the bridge in the dsh credentials
  service ($DSH_HOME/.credentials.yaml via dsh-credentials-local) under the
  apiKeyEnv reference (derived <ID>_API_KEY when blank). The inherited launch
  environment has highest precedence, then the managed credential file, then
  project/user .env layers; the form shows the non-secret configured/source/
  writable status returned by credentials.describe. Submit sends
  x.ai/providers/add to the bridge, which writes the provider into the dsh
  settings document through the official settings seam (ctx.settings.mutate
  on the llm-pi-ai namespace); the bridge broadcasts the refreshed provider
  roster and model catalog so /provider and /model update without a reload.
  ponytail: no models field in v1 - custom routes get their models from
  bridge-side gateway discovery, catalog routes keep serving the installed
  catalog. Protocol ids are the official seam's: openai-completions /
  openai-responses / anthropic-messages.
- Provider edit/delete: in the /provider dropdown, Ctrl+E opens the same field
  window prefilled from the provider's settings and credential status (id
  locked, empty fields mean unset) and submits x.ai/providers/update; changing
  a credential ref cleans its old unshared file-backed key. Ctrl+D arms a y/n
  delete confirm that submits x.ai/providers/remove; successful removal also
  clears an unshared file-backed credential. Shared refs and read-only launch
  environment credentials are retained. Both bridge methods reuse the official
  settings seam, never write settings.yaml directly, and return the refreshed
  roster. Deleting the provider that owns the current model is blocked (switch
  provider first), both in the dropdown footer and by the bridge.
- /usage shows real per-session stats instead of grok.com billing. It opens the
  existing usage modal on the "Context usage" tab (session/info context
  breakdown: used/total/pct, turns, tool calls, messages, compactions) and
  hides the "Usage limit" billing tab when there is no billing surface
  (bridge billing config:null). The context block's model caption falls back
  to the live model catalog (name + provider) because the bridge serves
  session/info model:null. The x.ai/session/usage RPC is skipped (bridge has
  no such method); /usage is session-scoped and "manage" stays gated by
  billing_surface_visible (never true in dscode).
- Managed worktrees are local to the dscode Rust client because dsh exposes a
  session cwd but no x.ai worktree RPC. Welcome/Ctrl+W and worktree-backed
  forks materialize through xai-fast-worktree, then create a normal dsh
  session at that cwd; conversation forks use the bridge's
  x.ai/session/fork with newCwd. If dsh session creation/forking fails, dscode
  rolls back only the worktree created by that request through the upstream
  no-data-loss remover and reports any path it must retain. The public
  `dscode worktree` list/show/rm/gc/db commands use the same local registry
  without spawning xai-grok-shell. x.ai restore-code semantics remain hidden
  and fail closed because dsh does not persist repository snapshots.

## Capability boundaries

- Slash commands removed (x.ai authoring/management surfaces, dsh has no
  matching concept): /personas and /config-agents (agents-modal authoring UI),
  /login, /logout, /share, /feedback, /imagine, /imagine_video, /import_claude,
  /gboom, /voice, /release_notes, /announcements, /recap, /timeline. /preset
  remains the only preset picker; /usage is adapted to session stats (above).
- Coding-data sharing, an x.ai account preference with no dsh counterpart, is
  removed: no consent banner, `coding_data_sharing` settings row or `/privacy`
  command. The pager snapshot field, its lock type and its `current_value_for`
  mapping stay dormant. `tests/settings_e2e.rs` omits the row's tests and
  asserts that neither the row nor `/privacy` is registered.
Unavailable built-ins: `/dashboard`, `/cd`, `/recap`, `/voice`, `/hooks`, `/plugins`, `/marketplace`, `/delete`, `/remember`.
`/auto` is not a pager command at all: the builtin, its feature-gate plumbing
and its `PAGER_COMMAND_KEYS` entry are gone, so a typed `/auto` reaches the host,
which refuses it.

These commands remain known to the registry while hidden from completion.
Typed names and aliases get a local unavailable message, including tool-gated
commands before capability discovery; they do not become model prompts.
`/skills`, `/mcps`, and `/workflows` are supported read-only harness browsers;
`/rewind` forks conversation history, preserving files and the source session.

- Bridge now maps dsh capabilities onto grok RPCs: x.ai/session/rename →
  dsh session-title, session/set_mode → dsh plan-mode, x.ai/session/fork →
  dsh sessions.fork + agents.create(seed), x.ai/mcp/list → scoped dsh MCP client configurations and tools
  (connection status is `unknown` when the harness does not expose it), x.ai/yolo_mode_changed → dsh permission-presets, /loop →
  a TUI-owned model scheduling instruction. /tasks is fed from dsh jobs
  (task_backgrounded/task_completed),
  dsh subagent events (subagent_spawned/subagent_finished), and dsh-schedule
  (scheduled_task_created), x.ai/skills/list serves dsh skills,
  todo/write maps to ACP Plan updates, goal/changed maps to GoalUpdated,
  x.ai/btw runs a one-shot subagent so it does not pollute the main
  session context, and AvailableCommandsUpdate.meta.capabilities drives
  runtime capability-aware slash visibility (subagents/skills/plan/todo/
  schedule/goal). Capabilities come from the selected agent's actual tool
  schemas and scoped services, not from hardcoded preset ids. session/new and session/load accept
  _meta.provider/_meta.model/_meta.reasoningEffort and the permission modes
  the bridge can enforce exactly. Unsupported sandbox, prompt/rule/tool,
  auto/acceptEdits/dontAsk, and no-subagents metadata are rejected fail-closed
  instead of silently weakening CLI flags. The leader profile does not mount
  dsh-schedule globally: doing so injects its three tools into every root agent
  and breaks the shipped minimal preset's exact two-tool contract. TUI /loop
  therefore follows the `schedule` capability (a preset whose agent has
  `schedule_create`, such as `standard`); it is not tool-gated, since the
  leader advertises capabilities and never `meta.tools`.
- The host profile mounts `dsh-code-runtime-worker-thread`; without it dsh's
  shipped `code` preset silently exposes the native standard roster instead of
  its intended single `run_code` tool.
- dscode CLI surfaces hidden because they have no dsh counterpart or are not
  worth exposing yet: login, logout, plugin, memory, setup, trace, dashboard,
  --restore-code, --oauth. They remain parseable for compatibility/guidance
  but are omitted from --help.
## Patch

- `xai-grok-shell/src/leader/client.rs`: oversized outgoing ACP requests return
  a local JSON-RPC error before any frame bytes are written. The connection
  remains usable; a real socket test sends another request after the rejection.

- Minimal native/wake streaming (ported from upstream `77cd7eb675`): the five
  live/commit decisions share `is_turn_or_wake_running`. Reuse the local
  `wake_display_state` so DSH `sessionRunning` activity holds the live tail
  even when the foreground turn is idle; an armed-only goal does not hold it.
  A newly running native round releases the finished foreground prompt's pin
  when already following, without changing manual history browsing or an
  owned foreground turn. Slash test expectations reflect ACP-owned `/compact`
  and the shared fullscreen editor path.
- External editor and pager terminal handoff (ported from upstream
  `07b2f7144f`): suspend focus, paste, mouse and negotiated Kitty reports before
  cooked mode; restore the actual keyboard flags and prior mouse choice after
  child exit, including failure. Fullscreen children stay on the alternate
  screen. Existing reader/writer quiescence and retry handling remain shared
  by prompt/config editing and `/transcript`.
- Table selection copy (ported from upstream `bc7f02eddd`): source-derived
  `TableCopyMeta` travels through parsing, batch/streaming rendering and parent
  or child selection. Wrapped URLs and CJK stay contiguous, while original
  whitespace survives cell, grid and drag copy. Raw grids without source
  metadata keep the upstream wrap-join fallback. The streaming path retains
  frozen metadata and rebases the live tail after appends and width changes.
- Text multi-click timing starts the next-click window after selection handling.
  A synchronous clipboard write must not expire an already queued third click
  and turn a full table-cell copy into a single rendered line. The macOS product
  E2E injects a private 400ms clipboard write, longer than the 300ms click window;
  copy ordering and the gesture timeout remain unchanged.
- Selected upstream TUI fixes (2026-09-08; baseline remains `19d42e35c0`):
  - `9684fa3cdb`: coalesce Enter + Ctrl+J as one pasted CRLF, including a
    trailing newline, while preserving genuine Enter and standalone Ctrl+J.
  - `77cd7eb675`: `ScrollbackState::replace_tool_block` preserves display mode
    across same-kind progress/completion updates, including Execute/Search;
    kind upgrades and Edit's untrusted-summary transition retain their policy.
  - `07b2f7144f`: `/copy` uses the assistant's Markdown source through the
    existing clipboard/file path, including the active child view.
  - `bb7f39d585`: scanned wrap fragments share an OSC8 ID, scanner IDs avoid
    Markdown IDs, and scanning fills uncovered continuation rows. Preserve
    the local bounded cursor-position startup in `xai-ratatui-inline`.
  - `bb7f39d585`: the status row stays on "running" while an armed send-now
    awaits the shell's hand-off (`AgentView::send_now_awaiting_current`), so a
    double Enter no longer flickers the row between idle and running.
  - `75810042ca` (1.0.19 changelog: mid-turn freezes when the terminal stops
    reading output): `Presenter::observe_writer_progress` tracks the writer
    watermark, gates draws while the writer trails its queue, and reports a
    stall past 5s as `term.writer.blocked` / recovery as
    `term.writer.recovered` in the unified log.
  - `75810042ca` (1.0.24): Esc no longer cancels a running turn; the bar keeps
    a conservative hint because Esc's owner stays app-level. Ctrl+C cancels.
  - 1.0.13 image clamp: an over-2000px image is re-encoded even when the
    downscale is not smaller in bytes, so a byte-efficient 2048px export can
    no longer brick many-image requests; the 5s stall threshold and the clamp
    carry unit coverage (`presenter_*`, `oversize_dimension_*`).
  Relevant upstream unit/ACP/terminal regressions are retained. Product PTY
  checks in `scripts/e2e-tui-bridge.sh` exercise CRLF/manual submission,
  fullscreen editor restoration, source-preserving copy and OSC8 output.
- crates/codegen/xai-grok-shell/src/session/acp_session_tests/tool_layer_images_bridge_tests.rs:
  added the missing 'use base64::Engine as _;' (base64 0.22 trait import) so the
  shell test binary compiles. Generic bug fixes found here must go upstream as
  PRs and be removed from this list when accepted.
- `xai-grok-pager/tests/registered_features_are_documented.rs` is omitted:
  the public grok-build sync includes that test but excludes both
  `docs/internal` files it `include_str!`s, so the published test target cannot
  compile. Re-enable only when those operator documents become public or the
  upstream test is made self-contained. `scripts/release-payload.test.mjs`
  checks our documented unavailable commands against the registry locally.
- The dashboard non-git location test chooses a temporary root with no `.git`
  ancestor. CI/dev `TMPDIR` may itself live inside another checkout, where the
  original fixture was correctly detected as Git-backed and asserted the
  opposite. Product behavior is unchanged; this is test isolation.
- `app/status_line/command.rs`: when the wait sees the script exit first
  (another child's `SIGCHLD` reaps it before the reactor reports its stdout),
  the run collects what the non-blocking pipe already holds instead of
  painting an empty row. A grandchild still holding the pipe answers
  `WouldBlock`, so the read never waits for it.
- `completions_cmd.rs`: the zsh root-prompt fix-up matches the context tag of
  the name the script is generated for; a fixed `grok-command` tag stopped
  matching once the binary was renamed.
- `views/welcome/mod.rs`: a startup warning wraps at spaces to the screen
  width (at most four rows, the last ending in `…`) instead of being cut at
  the edge, and `sanitize_user_error` keeps 400 characters instead of 200 so a
  session failure can name its cause and the next step. It also drops an ACP
  error's data when that data only repeats the message (a leader refusal's
  `{"message": …}`), which `Display` would print again as JSON.
- Tests that point `GROK_HOME` at a tempdir join the `GROK_HOME` serial group,
  and the effects helper restores the variable before its tempdir goes. Worktree
  paths resolve `GROK_HOME` on every call, so a parallel swap could put another
  test's checkout in that tempdir and delete it.
- Parallel-suite isolation for upstream pager tests (assertions unchanged):
  tests that read the global theme twice (thinking quote-bar selection, the
  three Mermaid view cache-key tests) hold `theme::cache::pin_theme()`, and
  tests that open the dashboard join the `GROK_AGENT_DASHBOARD` serial group
  (two clipboard-routing tests in `task_result.rs`, six in `dashboard.rs`).
- Session relocation `load_candidates` (ported from upstream `75810042ca`,
  with its regression test): a cwd bucket deleted between the sessions readdir
  and opening it is skipped. Before, a concurrent delete failed
  `list_summaries`, and resume by title with it.
- Upstream pager tests that assert what dscode replaces (branding, Kitty
  placement, `/loop` gating, fail-closed images, ACP-owned `/compact`, the
  pre-session model pick, local refusal of unregistered pager names, finished
  thinking previews, removed coding-data sharing) carry `DIVERGENCE(dscode)`
  notes; the full pager suite passes, integration targets included. Run it as
  `scripts/check-rust.sh` runs its gate, with `SSH_CONNECTION`, `SSH_CLIENT`
  and `SSH_TTY` unset. Upstream reads them once per process and skips local
  file-drop classification over SSH, so its file-drop paste tests fail in a
  suite started from an SSH shell.
Slash commands removed: login, logout, share, feedback, imagine,
imagine_video, import_claude, gboom, voice, release_notes, announcements,
recap, timeline.
Why: these x.ai-cloud-only commands have no dsh-adaptable equivalent; the
TUI is a frontend over the dsh bridge.
Kept: usage (adapted to session stats, above), mcps, plugin, doctor,
debug, settings_cmd, compact, rewind, tasks, plan, workflows, model,
preset, personas, and the TUI-own UI commands.
Only the commands were removed: the announcement banner view, the voice
engine and keybinding, the gboom game, and the share/recap/voice registry
gates remain, so the banner CTA still advertises /announcements hide.

### Thinking blocks default to truncated preview

`scrollback/state/mod.rs` initializes `thinking_display_mode` to
`DisplayMode::Truncated` (upstream: `Collapsed`) so finished thought blocks
show the one-line reasoning preview under the duration header by default,
matching grok's visible behavior. Ctrl+E still switches the sticky mode.

### Idle queue snapshot retires optimistic echoes

`app/app_view.rs apply_queue_changed` retires every optimistic prompt echo
when the broadcast is the idle empty snapshot (no entries, no running
prompt). Upstream only retires on the RPC cancel/delete path, so a
successfully-run queued prompt left a ghost held row (#N) after the queue
drained. Divergence is a strict bug fix; candidate for upstreaming.

### Turn finalize kicks the local queue drain (viewer rails)

`app/turn_completion.rs apply_terminal_outcome` now runs
`maybe_drain_queue_and_note_peek` after a `ViewerFinalized` outcome, so the
`prompt_complete` / durable `TurnCompleted` rails drain the viewer's locally
pending prompts at turn end. Upstream's viewer finalize finishes the turn
without draining, so prompts queued while the TUI's adoption/turn state lagged
the running turn stayed stuck in the queue pane forever. The PromptResponse
rail already drains; the idle-only / FIFO (server rows first) / editing-front
gates are unchanged. Divergence is a strict bug fix; candidate for upstreaming.

### Bridge settle responses without a wire promptId are attributed by the RPC id

app/dispatch/prompt.rs handle_prompt_response now falls back to the
RPC-minted prompt_id for Ok responses too, not only Err. The dsh bridge
settled session/prompt with a bare stopReason result (no promptId meta),
which left every healthy response unattributed: the lost-response reconcile
was never disarmed (the stale arm then refused the next turn's
prompt_complete arm) and the not-the-running-turn gate never fired (a late
response finished whatever turn was current, emptying a freshly adopted
promoted turn). The bridge now stamps _meta.promptId on every settle result
(the grok shell's PromptResponse _meta shape), so the fallback only covers
older leaders. Root-cause postscript: the bridge also used to emit every
extension notification WITHOUT the ACP '_' wire prefix, which
agent-client-protocol drops as method_not_found before dispatch — so
prompt_complete, queue/changed, and session/interjection never reached the
pager at all, and this fallback plus the two fixes below were compensating
for a severed notification plane. The bridge now prefixes all extension
notifications; these pager-side fixes remain as defense in depth. apply_turn_start_shim also back-dates the adopted turn's
elapsed anchor from the wire turnStartMs (via
acp_handler::prompt_origin::viewer_turn_anchor, now pub(crate)) instead of
stamping now(), so a fast handoff does not finalize with a bogus 0.0s
marker. Divergence is a strict bug fix; candidate for upstreaming.

### Follow-up steer parity in the dsh bridge

The dsh bridge implements grok's ui.follow_up_behavior=steer semantics
(bridge config followUpBehavior / env DSCODE_FOLLOW_UP; default
queue, matching upstream; per-prompt override via session/prompt
_meta.followUp): with steer on, a prompt sent while a turn runs folds into
that turn at the harness's next step boundary instead of parking behind the
whole turn. The wire stays TUI-compatible: the row is broadcast once
(optimistic echo retires by id), then leaves the queue; the text streams as
a user echo inside the live turn; the RPC settles with the host turn. The
bridge also implements the two grok mid-turn wire inputs the pager already
emits: x.ai/interject (merge into the running turn, no cancel; broadcasts
x.ai/session/interjection) and session/prompt _meta.sendNow (cancel the
running turn, run this prompt next — previously silently ignored, which
made the composer's send-now chord a plain queue). Known gap: the TUI
settings toggle for [ui].follow_up_behavior does not propagate to the
bridge in leader mode — the bridge reads its own config/env.

### The queue pane always keeps a live selection

`views/queue_pane.rs sync_from_merged` initializes the list selection to the
first row whenever rows exist and re-homes a selection whose row vanished
(ran, removed, steered). Upstream leaves the selection unset until the user
navigates, so a freshly focused pane silently swallowed e/x/Enter while the
hint bar advertised them. Strict bug fix; candidate for upstreaming.

### Alt+Enter steers the composer into the running turn

New ActionId::SteerPrompt (actions/defaults.rs, default Alt+Enter, prompt
context): with a turn running and a non-empty composer it emits
Action::Interject — the existing mid-turn interjection pipeline (local
block, x.ai/interject, broadcast dedup by interjectionId) — folding the
text into the live turn WITHOUT cancelling it. Idle sessions fall back to
a plain send. Upstream has the interject pipeline but no composer chord
for it (Ctrl+Enter is send-now, which cancels); this fills the "add
context without losing the turn" gesture. Feature class; candidate for
upstreaming.

### Queue snapshots are seq-gated (stale broadcasts dropped whole)

xai-prompt-queue QueueChanged gains an optional `seq` field (absent on the
wire when unset, so the golden wire JSON and legacy emitters are unchanged).
The pager (app/acp_handler/queue.rs handle_queue_changed) keeps a per-session
watermark (AppView::queue_seq_watermarks) and drops any stamped snapshot
whose seq is not strictly newer before it touches queue state — the mirror
reconcile, optimistic-echo retirement, and adoption logic all assume
snapshots arrive in emission order, and the gate enforces that assumption in
one place instead of each consumer defending against reordering. A session's
first stamped snapshot always applies ("never seen" is not a watermark of
0), and x.ai/sessions/changed removal drops the session's watermark so the
map stays bounded by live sessions. The dsh
bridge stamps every x.ai/queue/changed with an epoch-seeded strictly
increasing seq (a restarted leader outranks its predecessor, so no reset
handshake exists). The native shell emitter does not stamp seq yet
(seq: None), so non-leader mode is unchanged; stamping it upstream is the
natural follow-up if this is offered as a PR.

### /rewind forks conversation history

`/rewind` and its `/undo` alias open the native prompt-boundary picker.
The bridge implements `x.ai/rewind/points` and `x.ai/rewind/execute` using a
new dsh session fork. `conversation_only` is the wire mode; no file snapshots
are claimed, no files are reverted, and the source session remains intact.
The TUI renders this conversation-only result and switches to the new session.

### Plugin slash commands arrive over ACP available_commands_update

Not a TUI divergence — recorded here as the contract's other half: the
bridge advertises dsh-registry plugin commands (plus its own /dsh) via the
standard ACP `available_commands_update`, and the stock pager merges
agent-advertised commands into the slash registry (builtin names win,
BLOCKED_ACP_NAMES skipped). New dsh plugins get top-level slash commands
with zero pager changes.

This generic path covers dsh presets, tools, commands, providers, models, and
settings. Browser-only plugin slots, custom panels, and private extension RPCs
still require an explicit TUI/bridge adapter; they are not inferred. The same
applies to plugin-owned durable session event types while pinned dsh
0.1.5-rc.2 deliberately has no public downstream registration seam for that
vocabulary. The bridge writes native `model/selection` records; its legacy
JSONL reader normalizes historical names without mutating DSH's global table.

### xAI login/logout CLI subcommands are severed

`dscode login` / `dscode logout` no longer run the upstream xAI OAuth
flows (run_cli_login/logout) — dscode has no x.ai backend, so the last
reachable OAuth entry points print a redirect to the dsh-side auth
surfaces (/provider --add, /dsh login) and exit 2. The subcommands stay
in the arg parser so users get guidance rather than "unknown command";
the auth subsystem itself stays vendored untouched (entry-point severing
keeps upstream merges cheap; see the leader-failure entry below for the
embedded-fallback entry point). The in-TUI login screen is unreachable
in bridge mode: the bridge advertises only `xai.api_key`, which
`needs_interactive_login()` classifies as non-interactive.

### Leader failure is terminal — no embedded-agent fallback, fail-fast spawn

Upstream falls back to the embedded in-process agent when the leader
connect fails, and waits out the full spawn timeout polling for the
socket. In dscode the embedded agent is the real grok shell — no dsh
bridge, greets the user with xAI OAuth — so `app/mod.rs` removes the
fallback: a leader failure restores the terminal and prints the error
plus the dsh leader log tail (the actual boot failure: plugin
resolution, profile errors). `xai-grok-shell leader/mod.rs
connect_or_spawn_inner` additionally watches the spawned external
leader's pid while waiting for the socket and fails immediately with
"exited before its socket became connectable" when the process dies,
instead of blank-polling the 30s timeout. Verified: a broken profile now
errors in ~1s with the resolve error on screen (was: 30s black screen,
then the xAI login). A start that failed outright (`dsh_leader.rs`
`leader_start_failure`) prints that context, then the cause on its own line,
then one generic line naming the launcher's safe mode, "If a plugin broke
startup, run `dscode doctor --reset-plugins`."; it names no plugin, and a unit
test pins it as the last line. A timeout keeps its own startup report.

### Leader protocol mismatches fail during registration

`xai-grok-shell/src/leader/client.rs` requires the leader to advertise exactly
the client's `LEADER_PROTOCOL_VERSION` before any ACP traffic starts. Upstream
stores mismatched metadata and rejects only later control commands, which lets
an incompatible foreign leader fail piecemeal in session methods. dscode owns
both adapters at this seam, so a missing or different version is a terminal
registration error. The focused client test pins the fail-fast behavior.

### Unsupported extension surfaces are hard-hidden

The unavailable built-ins above open Grok's plugin world or require semantics
the dsh bridge cannot provide. `/skills` and `/mcps` instead browse scoped dsh
services. MCP editing uses `dscode mcp` and `cordis.patch.yml`: reads propagate
storage errors, edits share the profile lock, and writes use atomic replacement.
Future plugin capabilities enter through harness-advertised ACP commands.

### Manual compaction uses the dsh command registry

The grok `/compact` builtin is omitted from `slash/commands/mod.rs`, and
`compact` is no longer globally hidden. Presets that mount
`@deepseek-ai/dsh-command-compact` advertise its ACP command; the existing
generic command adapter executes `compactNow()` without a model turn. Presets
without that command show no completion row, while a raw `/compact` receives
the bridge's explicit unavailable result instead of becoming model text. An ACP
command that takes an omitted builtin's name (a `PAGER_COMMAND_KEYS` entry)
breaks completion ties like that builtin, so `/comp` still completes to
`/compact` rather than `/compact-mode`.

### Bare /provider opens a list picker

`/provider` with no args opens the generic ArgPicker as a provider roster
(dispatch/providers.rs open_provider_picker): navigation-first (arrows move
the highlight immediately, '/' searches), Enter switches to the highlighted
provider's default model, `e` opens the edit form, `d` arms a y/n delete
(reusing the composer's ProviderPendingDelete contract; the bridge still
refuses removing the in-use provider), `a` opens the add form. The typed
`/provider <id>` form still works. Rationale: the completion dropdown is a
typing surface, not a management surface — picking/editing providers wants
a highlighted list ("上下选到哪个就指向哪个"). The modal footer lists `e`, `d`
and `a`; after `d` it shows the y/n confirm, or why the in-use provider cannot
be deleted.

### Native DeepSeek provider template

The add-provider form lists a "DeepSeek (native)" template right after the
OpenAI-compatible "DeepSeek" one (class: feature). Each template row shows a
short note before its URL, and the label column fits the longest label. The
native template uses provider id `deepseek-official`, the `DEEPSEEK_API_KEY`
variable and the default base URL `https://api.deepseek.com/anthropic`. Its API
value `deepseek-native` is not a pi-ai protocol but a marker. The bridge
enables the official `llm-deepseek` adapter for it instead of writing a pi-ai
route and names it "DeepSeek (native)". The form shows its id, name and
protocol as fixed and skips them, since the bridge would ignore edits.

Adding a provider while no model is selected says to choose one with `/model`,
and re-picking the active provider says so instead of closing silently. The
`/model` picker drops the `[provider]` prefix when only one provider has models,
so the first pick after adding a provider shows plain model names.

### Provider form: arrows move fields; presets are a chooser row

Up/Down in the add/edit provider form previously cycled PRESETS — every
press rewrote all fields (data loss mid-edit) while Tab was the only way
to move rows. Now Up/Down always move the row focus (the picker
contract), presets are the form's first row cycled with Left/Right (the
same interaction as the api row), and Enter on the preset row advances
into the form instead of submitting a barely-seen prefill. Additionally
Action::SetDefaultModel's idempotent branch now toasts ("Already on X")
so picking the current provider/model in any picker gives feedback
instead of silence.

### dsh cache hit percentage is shown in the status row

`acp/meta.rs` parses the bridge-owned `cacheHitPercent` notification metadata;
`app/acp_handler/mod.rs` stores its newest cumulative value on `AgentView`, and
`app/agent_view/render.rs` renders `cache N%` beside the context meter. The
bridge computes the value from dsh's disjoint uncached/read/write input buckets
and sends a non-rendering empty update when terminal usage follows streamed
text, so the status cannot stay one turn behind.
`views/agent_status.rs` accepts borrowed dynamic lines so the percentage is
rendered without formatting or allocating a new status string every frame.

### dsh decode speed is shown in the status row

`acp/meta.rs` parses the bridge-owned `tokensPerSecond` notification metadata
and `app/acp_handler/mod.rs` stores it on `AgentView`; `app/agent_view/render.rs`
renders `tok/s N` beside the cache pill. The bridge folds decode speed exactly
as the upstream `sessionStats` projection does (first token of a step to its
assembled message, over that message's provider output tokens) and sends it
with the same terminal-usage update as the cache percentage.

### Image input capability fails closed

`acp/model_state.rs` now defaults `current_model_accepts_images()` to false
when the selected model has no affirmative `acceptsImages` or
`inputModalities` metadata. Upstream's permissive default assumes the fixed
Grok catalog; dscode admits arbitrary provider models, where missing metadata
cannot prove multimodal support. `app/agent_view/paste.rs` refuses image chips
for those models and cleans temporary paste files. The bridge independently
rejects direct/headless image prompts before writing an attachment.

### MCP edits preserve valid empty patch documents

`dsh_mcp_patch.rs` removes an empty `[]` document before appending the first
MCP entry, including when the empty document has comments. Removing the last
entry from a comment-bearing patch restores `[]` instead of leaving a
comment-only document that the dsh loader rejects. Existing comments and
unrelated `!!js` expressions remain intact.

### DSH continuable-child controls

`/subagents` and `/goal` run over the generic immediate-command rail (see
"Immediate host commands"), preserving the parent's active turn and queued
prompts.

Native DSH child views fetch `x.ai/subagent/history` pages through the owning
parent connection. Their committed-event notifications refresh open views;
successful durable reads allow finished views to release memory and replay on
reopen. Parent restart rediscovers completed children. Native session/turn attempt
IDs reject late finishes from earlier executions. This path does not assume
Grok `updates.jsonl` files exist for DSH child sessions.
The bridge owns descendant authorization and uses DSH's native admission and
Inbox operations. Same-ID continuations emit an explicit resumed spawn: only a
fresh live event may reopen a terminal child. Its existing child view and
transcript survive; ordinary duplicate spawns and stale resumes remain no-ops.
Coverage includes scoped bridge controls, TUI dispatch/lifecycle regressions,
and real TUI Queue/Edit/Remove/Steer/Clear/Stop/Resume with a held parent stream.

### Native inbox, reminders, job logs and tool images

`views/native_controls.rs` reuses the modal chrome and multiline TextArea for
`/inbox` and `/reminders`. Child Tasks rows open their queue with `q`; reminder
rows open the Schedule list. Responses are scoped to the owning session and
modal request. Failed edits retain their draft; failed cancellation retains the
reminder row. The add editor lists every reminder form the bridge parses
(after/every/at plus DSH 0.1.7-rc.2's daily/weekly/cron), wrapped over as many
rows as the width needs. `/loop` requests native `schedule_create` with a title,
`every_seconds` and the official one-minute minimum (DSH 0.1.7-rc.2),
independent of Grok's detached-loop setting.

The bridge feeds non-consuming collected subprocess snapshots into the existing
Tasks stdout store and viewer. Completed output is not repeatedly rescanned.
Tool image updates carry verified durable attachment paths in `dscodeImages`;
the existing media block renders the first preview and lists additional paths.
Typed images decode extensionless attachment objects. The bridge finishes image
hydration before sending tool completion, later text and prompt settlement.
Preview errors remain visible independently of tool success. Live output, root
replay and child history use the same attachment projection. Acceptance drives
these controls through the real TUI, including the image Open action with an
isolated recorder in place of the operating system's GUI opener.

### Viewer quotes, turn navigation, skills and preset authoring

Selective ports from Grok snapshot `75810042ca2762aa0b0fa17864f3f68823ccbea5`
add viewer selection-to-draft quoting, last-viewer position restoration, source
cell URL/email annotations, and turn-boundary navigation. The existing monolithic
viewer remains; resume identity also includes task id or standalone document title.
Standalone documents survive streaming ticks without a transcript anchor.

DSH skills use the native scoped registry and slash invocation. `/preset manage`
reuses NativeControls and the existing external editor, with native copy/read
operations and owned-session/nonced replies. LSP lives in the optional bridge
preset and uses official packages rather than a second Rust language client.


### Terminal management, runtime doctor and preset polish

Tasks `t` and `/tasks terminals` reuse NativeControls for the exact-owner DSH
terminal registry. Read-only previews poll bounded scrollback; interrupt and
confirmed close call different native operations. Wrapped detail paging uses
Ratatui's existing line-count API to clamp scrolling (rendered-line-info feature).
Preset search is local; successful copy reveals its id and offers the existing
editor. `/doctor` keeps terminal diagnostics and asynchronously adds a native
bridge report, scoped to the same session binding. Runtime validation remains in
the JS launcher/update layer, with a read-only pre-startup CLI fallback.

### Process ID validation

The shared shell-base Unix process helpers reject zero and unsigned IDs outside
the positive signed PID range before probing or signalling. Previously an invalid
external leader PID such as `u32::MAX` became `-1` and could broadcast SIGTERM
to unrelated processes during failure cleanup. Boundary checks and real child
termination tests run in the product Rust release gate.

The catalog keeps role descriptions alongside localized preset names. Overlay
ownership tests expect the current Kitty transmit-and-display command (`a=T`),
and both child and modal post-flush cleanup cases run in the release gate.

### DSH profile isolation and automatic updates

Default DSH leader sockets include the canonical profile path and TUI build.
External bridge registration reports its actual package version; mismatches
fail with a profile/update diagnostic without evicting another session's leader.
A development TUI accepts its corresponding release bridge without `-dev`.

Selecting the DSH backend preserves the user's automatic-update setting.
Whole-product update delegation carries the original trigger so the launcher
can honor background opt-out and avoid stale-target reinstalls. Socket isolation,
version compatibility and launch/update argument checks run in the release gate.

### Remote workspace paths fail closed

A dscode leader reports `_meta.dscodeExecutionWorld` in `initialize` (class:
feature). An SSH world means session paths name files on another machine. The
pager records the world once, in the render crate's `execution_world`, before
any session exists. An unknown or malformed world counts as remote.

In a remote world the pager:
- opens sessions at the remote workspace (or a directory inside it) and sends
  no local project MCP servers, both interactive and headless;
- records the leader's workspace as the session cwd;
- never links or opens a file target (`osc8` resolution, `OpenLink`), whether
  or not the path exists locally;
- skips full-file edit highlighting, the line viewer, `@` completion, media
  scanning of message text and git discovery;
- refuses worktrees, location changes, the agents/personas modal and dropped
  non-image files;
- runs the status-line command outside session directories;
- skips the folder-trust question for its launch directory, from which it
  loads nothing.

Bridge-written tool images stay local and open as before. Unit tests cover the
parse, the session cwd rule and each refusal.

In a remote world the header reads `ssh HOST:PATH` and never shows the launch
directory a view without a session still holds, nor that directory's git branch
or worktree badge on the welcome screen. The first `@` shows a tip that
completion is off there.

### Welcome menu rows come from one list

The signed-in welcome menu is built from one ordered list of items that
rendering, the row count and Enter/click dispatch all read (class: behavior).
Upstream mapped fixed row positions to actions. "New worktree" appears only
where a worktree can be made: a git checkout on this computer that is not a
remote workspace. Ctrl+W follows the same rule. Leaving the row out never moves
another row's action.

### Always-asking approvals

A permission request with `_meta.dscodeAlwaysAsks: true` (dscode's browser
actions) waits for an explicit answer (class: feature). Always-approve neither
auto-approves it on arrival nor drains it when turned on, and the prompt offers
no Ctrl+O always-approve hint. The leader also sends the call's planned
arguments as `rawInput` and, for browser actions, a title such as "the browser
to open https://…", which the existing MCP argument display renders.
When DSH gives a reason for asking, the leader appends it to the tool title
("bash — <reason>"). Execute prompts are titled from the command's own
description, so such a title (anything but Grok's "Execute `…`") becomes the
first line under the command instead of being dropped (class: feature).

### Approvals from a host's call view

A permission request whose tool call carries `_meta['dscode/view']` (the
tool's own call view, the same one its card reads; `acp/tool_view.rs`
`approval_view`) renders from the view, keyed on its kind and never on a tool
name (`acp_handler/permissions.rs`): a `terminal` (or a generic view of the
`execute` kind) shows the command as the body, its description as the title,
then the reason and a `cwd:` line; a `diff` reads "Allow <view title>?" (for
example "Allow Edit /w/a.ts?") over unified `-`/`+` preview lines of the
change, drawn in the diff colours, each file headed by its path when the title
does not name it; anything else reads "Allow <view title>?" over its salient
input (else the planned arguments), capped by the MCP-argument formatter. The
leader titles such a request "<view title> — <reason>", and the reason leads
the lines. Grok's `BashToolInput` parsing and the "Execute `" prefix remain
the fallback for requests without a view (class: feature).

### Preset change after history opens a new session

The leader refuses to change the preset of a session that has history. Picking
a preset for such a session (any user prompt in its scrollback) therefore opens
a new session with that preset and says so, instead of reloading the old one
into an empty transcript (class: behavior). A session without history still
reloads with the picked preset.

### Native child run length

`subagent_finished` with `_meta.subagentDurationAvailable: true` supplies the
child's settled run length even when its other metrics are unavailable, so a
finished row stops counting up (class: feature).

### Teammate rows in tool groups

Subagent rows whose role is `teammate` group under their own noun ("Ran 1
teammate"), and a terminal row keeps its started row's persona and role so one
teammate counts once (class: feature).

### First-run welcome offers a provider

While the catalog that arrives with the leader handshake has no model, the
welcome menu leads with "Add a provider", which opens the add-provider form
(class: feature). Enter runs the row the arrows highlighted; it used to start
a session whatever was highlighted, which left rows without a shortcut
unreachable from the keyboard. The welcome footer no longer reads "Logged in with API key":
the leader advertises that auth method only to pass the auth gate, and keys
belong to each provider (class: behavior).

### Browser actions read as actions

A `Browser: <action>` tool title renders on the running status row as the
label and the action, like `Fetch:`, rather than as a shell command after
"Run" (class: feature). A media card whose file is an object in the leader's
content-addressed attachment store (`…/objects/<xx>/<sha256>`, a browser
screenshot) shows a caption on its path row; Open and copy-path still target
the file.

### Plan mode is guidance

Turning always-approve on under plan mode toasts that every tool now runs
automatically and that plan mode guides the model without blocking edits:
DSH plan mode is a prompt section, not an edit gate (class: behavior).

### Truncated replies

A turn that ends with `max_tokens` pushes "Output token limit reached; the
reply was cut off — send "continue" to resume." before "Worked for" on every
turn-end path: a normal end, the viewer, lost-response recovery and wake turns
(class: feature).

### Two-press task stop

In the Tasks pane, `x` and the `[✗]` control arm first and stop the task on a
second press within 3 s, like the DSH job list (class: behavior).

### Tool input and result fallbacks

A non-shell execute card (such as `run_code`) shows its content on success as
well as on failure. Execute cards without a `command`, and generic other cards,
show their capped (40-line) `rawInput` when expanded (class: feature).

### Structured question answers

A DSH question result (`{"answers":[…]}`) renders as question → answer pairs,
matching answer ids to the questions in the call's `rawInput` by shape, not by
tool name (class: feature).

### No session delete in /resume

Both /resume pickers drop `d delete`: DSH has no session delete, only archive
(class: behavior). The dashboard's own delete remains upstream's.

### dscode sessions

`dscode sessions list [--all]` and `search` query the leader
(`x.ai/session/list`, `x.ai/session/search`) instead of grok's session
storage; `delete` is hidden and refuses with an explanation (class: behavior).

### Provider key status

`/provider` rows (the dropdown and the picker) follow the model count or note
with the key state from the bridge's non-secret `credential` facts: "key
missing" when the key reference resolves to nothing, "key from env" for the
launch environment or a `.env` file, and nothing for a saved key. Generic over
the field; no provider is named (class: feature).

### Tool identity comes from `_meta['x.ai/tool']`

A tool card's identity is `_meta['x.ai/tool'].name` when the host stamps one,
else its title, as headless output already reads it. The checks that hide
todo, goal, workflow, scheduler, task and background-wait cards, the execute
and skill detection, and the inline plan-review source use that identity, so a
host may title a card by what it does ("Update todo list") without the card
reappearing. Title-shaped checks (`Goal:`, `Await:`, `Validating workflow`)
still read the title. A `tool_call_update`'s `_meta` keys now override the
start's key by key, streamed or final, instead of being dropped (class: feature).

### Host command descriptors and the palette's Commands section

`slash/acp_command.rs` reads the rest of a host command's DSH descriptor from
its `_meta`: `definitionId` and `attachments`. A non-skill host command without
`attachments: true` refuses the composer's images before dispatch
(`SlashCommand::refuses_attachments`): the draft keeps its text and images and a
toast names the command. Builtins, skills and unknown names keep their images.
The Ctrl+P palette lists the host's non-skill commands in one generic Commands
section before Other, in advertised order, in place of the per-plugin Goal and
Compact History rows; builtins that shadow an advertised name (such as
`/preset`, now a Model & Input row) keep their own rows (class: feature).

### Immediate host commands

A host command whose descriptor carries `_meta.immediate: true`
(`SlashCommand::runs_immediately`) runs at once over `x.ai/commands/run`, beside
a running turn and its queue, and its `{result: {kind, text}}` lands like the
old goal reply. The bridge marks `/goal` and `/subagents`; the TUI names neither,
and the dedicated `x.ai/goal` / `x.ai/subagents` intercept and routes are gone.
Without the advertisement, `/goal` is an ordinary queued command (class:
feature).

The bridge used to send the capability list as a bare `meta` key, which is
not ACP's `_meta`, so the TUI never received capabilities: `/btw`, `/plan`,
`/inbox` and `/reminders` were always offered (their gates fail open) and
`/loop` never was. It now sends `_meta.capabilities`, and `/loop` drops its
`schedule_create` toolset requirement (the leader sends no `_meta.tools`)
for the `schedule` capability alone.

### Tool cards from a host's tool views

A tool call carrying `_meta['dscode/view']` (the dscode bridge's normalized
DSH `presentCall` view, and on its final update the `presentResult` view)
renders from the view, keyed on the view's kind and never on a tool name
(`acp/tool_view.rs`): `terminal` is the Execute card (the call view's command,
description and, expanded, a cwd other than the session's; the result text;
the result view's non-zero exit or signal as the error), `diff` the Edit card
(the ACP diff content, else the view's diffs; "Creating " when every result
diff is a new file), `read` the Read card (the window's lines, its range when
it is not the whole file), `search` the Search card (grouped matches or a path
list, "N of total" when the tool capped them), `web` the WebSearch or WebFetch
card, and `generic` the Other card (the view's title, its kind as the summary,
its salient input expanded and capped, the result text; a skill keeps the
Skill card without the kind), except that a generic view of the `execute` kind
(a background run, code, terminal and job controls) is the Execute card any
execute call has, read off the call's own input, whose description the Tasks
row takes. A generic call keeps its card family while it runs (a file read on
a location stays Read, a search or fetch of one salient input stays Search or
WebFetch) so verb groups do not jump, and a failed file read without a result
view stays a Read card with its error. A final update's view is kept under
`dscode/resultView` beside the call's own, and the ACP debug log names each
notification's view card. The bridge sends no typed `rawOutput` (the Bash byte
array, `ReadFile`, `GrepSearch`, `WebSearch`, `WebFetch`) for a call with a
view, so these cards no longer read it for DSH tools. A call without a view
renders as before, from its typed `rawOutput` (class: feature).

### Host-served option pickers

A host command whose descriptor carries `_meta.options: true`
(`SlashCommand::serves_options`, `CommandRegistry::options_command`) opens the
existing ArgPicker when picked in Ctrl+P or entered bare, instead of running.
The picker opens empty ("Loading…") and asks `x.ai/commands/options`
`{sessionId, name, query}` (`app/dispatch/command_options.rs`), the way the
reference picker asks `x.ai/session/references`: only the reply carrying its
loading key fills it. Each DSH `SelectOption` becomes one row: the label (a
badge after a `·`, "(current)" on the `active` row, which is preselected) and
the detail, or the `confirmation`'s description, which is only shown for now.
Picking a row submits `/name <id>` as a draft-preserving send, which runs the
command and never reopens the picker; a `next` row asks again one argument
further (the title shows the line so far, "/dsh enable"). An empty bare list
runs the bare command; an empty later step says "Nothing to choose"; a failed
load closes the picker with a toast. Typing filters the rows as it does for
every ArgPicker. No command is named in Rust (class: feature).

The builtin `/preset` fronts the host's `/preset`
(`SlashCommand::fronts_host_command`): the registry keeps the host's options
flag for a name a builtin holds, so a bare `/preset` (or the palette's Switch
Preset row) opens the host's preset options while the session can still change
preset in place. There the host offers none (a turn, history or an Agent Team
preset), so the bare builtin opens the preset catalog as before, which can
start a new session with the pick. `/preset <id>` now goes to the host instead
of reopening the catalog; `/preset manage` is unchanged (class: behavior).
