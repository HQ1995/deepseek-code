# TUI divergence ledger

Apache-2.0 change notice:
This tree is a modified distribution of
[xai-org/grok-build](https://github.com/xai-org/grok-build).
The differences listed below are local modifications made for deepseek-code.
Modified files remain under the Apache License, Version 2.0; see [LICENSE](LICENSE).

Every intentional difference between this tree and upstream grok-build.
Class: patch (generic fix, should be offered upstream) / feature (product) /
branding (our identity). Keep this list current on every sync.

## Upstream baseline

- Source baseline: xai-org/grok-build
  `19d42e35c07a9c9244f03f6df0c4c353f970d4f9` (`xai-grok-shell` 1.0.6),
  three-way merged from the prior `d6a22a1` baseline. Product-specific dsh,
  provider, branding, startup, and protocol changes below remain layered on
  top; upstream source synchronization does not enable unsupported x.ai
  surfaces.

## Branding

- Product name and visible strings changed grok -> dscode / "Deepseek Code"
  across the pager and shell crates (recovered from the squashed history; if
  a string resurfaces after an upstream sync, reapply here).
- Privacy/telemetry vendor copy: "SpaceXAI" -> "DeepSeek" in
  crates/codegen/xai-grok-pager/src/views/privacy_banner.rs and
  .../settings/defs.rs (plus their test expectations).

## Feature

- Single-entry-point leader bootstrap: the binary is the launcher. A plain TUI
  run (no subcommand, no one-shot prompt, no --no-leader) defaults to leader
  mode against the EXTERNAL dsh CLI instead of grok's self-spawn:
  crates/codegen/xai-grok-pager/src/dsh_leader.rs resolves dsh (DSH_BIN env ->
  "dsh" on PATH -> npx),
  spawns "dsh --profile dscode" with DSCODE_SOCKET /
  DSH_TELEMETRY_DISABLED=1 and a numactl node-1 wrapper (host policy,
  conditional), logs to /tmp/dscode.log, and records the PID in the
  sibling .lock. pager-bin main.rs synthesizes --leader/--leader-socket/
  --sandbox off/--no-auto-update; acp::connect_via_leader and the
  LeaderReconnector call the new xai-grok-shell connect_or_spawn_external
  (connect-first adoption of a live leader, flock-serialized single spawner,
  one ~30s wait that covers a cold node boot, failed spawns are killed) so
  sessions spawned by the old shell leader on the same socket
  are still adopted. scripts/dscode.sh + bin/dscode are gone; install.sh links
  ~/.local/bin/dscode directly to the prebuilt binary.
- Environment namespace isolation: pager-bin maps DSCODE_CONFIG,
  DSCODE_CONFIG_PATH, and DSCODE_CONNECT_UI_TIMEOUT_SECS onto the upstream
  GROK_* implementation names before configuration loads. When a DSCODE alias
  is absent, the corresponding inherited GROK_* value is removed inside the
  dscode process, so a co-installed grok-build cannot leak its shell-wide
  configuration into dscode. The mapping never mutates the parent shell;
  startup recovery copy advertises the DSCODE timeout name.
- Leader mode: --leader/--leader-socket flags connect the TUI to our bridge
  over the grok leader unix-socket protocol instead of x.ai; local xai auth
  is bypassed in leader mode.
- Default preset label: hardcoded fallback "standard" -> "minimal" in
  crates/codegen/xai-grok-pager/src/app/app_view.rs (2 sites), matching the
  bridge's default preset (minimal). Coupled change: if the bridge default
  ever changes, update these labels too.
- Persona/preset selection is fed by the bridge's dynamic bundle/status roster;
  selection uses the returned preset id while display uses its name. There is
  no TUI-side allowlist, so user-installed dsh presets appear without a Rust
  change. The four shipped presets are only the E2E baseline.
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

## Feature

- Slash commands removed (x.ai authoring/management surfaces, dsh has no
  matching concept): /personas and /config-agents (agents-modal authoring UI),
  /login, /logout, /share, /feedback, /imagine, /imagine_video, /import_claude,
  /gboom, /voice, /release_notes, /announcements, /recap, /timeline. /preset
  remains the only preset picker; /usage is adapted to session stats (above).
- Slash commands hard-hidden because dsh has no matching surface: /cd (no
  Agent Dashboard), /auto (no dsh auto permission-mode classifier),
  /workflows (dsh workflow has no list/run-history API yet), /compact,
  /delete, /remember, /mcps, /skills, plus the already-hidden /hooks,
  /plugins, /marketplace, /dashboard, /rewind. The bridge explicitly refuses
  the five typed dsh-extension commands so none can fall through to the model.
- Bridge now maps dsh capabilities onto grok RPCs: x.ai/session/rename →
  dsh session-title, session/set_mode → dsh plan-mode, x.ai/session/fork →
  dsh sessions.fork + agents.create(seed), x.ai/mcp/list → dsh MCP tool
  names, x.ai/yolo_mode_changed → dsh permission-presets, /loop →
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
  therefore stays hidden unless scheduling is supplied by a preset-scoped
  composition.
- The host profile mounts `dsh-code-runtime-worker-thread`; without it dsh's
  shipped `code` preset silently exposes the native standard roster instead of
  its intended single `run_code` tool.
- dscode CLI surfaces hidden because they have no dsh counterpart or are not
  worth exposing yet: login, logout, plugin, memory, setup, trace, dashboard,
  --restore-code, --oauth. They remain parseable for compatibility/guidance
  but are omitted from --help.
## Patch

- crates/codegen/xai-grok-shell/src/session/acp_session_tests/tool_layer_images_bridge_tests.rs:
  added the missing 'use base64::Engine as _;' (base64 0.22 trait import) so the
  shell test binary compiles. Generic bug fixes found here must go upstream as
  PRs and be removed from this list when accepted.
- `xai-grok-pager/tests/registered_features_are_documented.rs` is omitted:
  the public grok-build sync includes that test but excludes both
  `docs/internal` files it `include_str!`s, so the published test target cannot
  compile. Re-enable only when those operator documents become public or the
  upstream test is made self-contained.
- The dashboard non-git location test chooses a temporary root with no `.git`
  ancestor. CI/dev `TMPDIR` may itself live inside another checkout, where the
  original fixture was correctly detected as Git-backed and asserted the
  opposite. Product behavior is unchanged; this is test isolation.
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

### /rewind is hidden (bridge has no rewind RPCs)

`slash/registry.rs CommandRegistry::new` adds `rewind` to the fail-closed
`hidden` set (same mechanism as /dashboard and /voice; the `undo` alias is
hidden with it because the gate matches the canonical name). Upstream
/rewind opens a picker backed by the x.ai/rewind/points and
x.ai/rewind/execute RPCs, which the grok-leader bridge does not implement —
the visible command was a dead end that errored on open. Typed `/rewind`
now falls through to the model as plain prompt text like any unrecognized
command. Un-hide it when the bridge implements rewind over dsh session
persistence (the sessions store replays full transcripts, so a
turn-boundary rewind is feasible later).

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
applies to plugin-owned durable session event types while pinned dsh rc.8 has
no public downstream registration seam for that vocabulary.

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
then the xAI login).

### Leader protocol mismatches fail during registration

`xai-grok-shell/src/leader/client.rs` requires the leader to advertise exactly
the client's `LEADER_PROTOCOL_VERSION` before any ACP traffic starts. Upstream
stores mismatched metadata and rejects only later control commands, which lets
an incompatible foreign leader fail piecemeal in session methods. dscode owns
both adapters at this seam, so a missing or different version is a terminal
registration error. The focused client test pins the fail-fast behavior.

### Unsupported extension surfaces are hard-hidden

`slash/registry.rs CommandRegistry::new` adds `/hooks`, `/plugins`,
`/marketplace`, `/skills`, `/compact`, `/delete`, `/remember`, and `/mcps`
to the fail-closed `hidden` set. The pager-plugin group opens grok-build's
OWN plugin system — a second plugin world dscode does not use, whose names
collide head-on with the real one (dsh plugins, managed by /dsh). Note dsh itself DOES have skills
(the `skills` registry, packages/skill) and hooks (hooks-claude-code);
those live harness-side and are unreachable from these TUI management
surfaces. The remaining commands require extension RPCs or session mutation
semantics the bridge cannot complete. Typed commands reach the bridge's
precise refusal; they never become model prompts. The future path for
exposing harness-side features is bridge-advertised ACP commands, not
un-hiding grok's local UIs.

### Bare /provider opens a list picker

`/provider` with no args opens the generic ArgPicker as a provider roster
(dispatch/providers.rs open_provider_picker): navigation-first (arrows move
the highlight immediately, '/' searches), Enter switches to the highlighted
provider's default model, `e` opens the edit form, `d` arms a y/n delete
(reusing the composer's ProviderPendingDelete contract; the bridge still
refuses removing the in-use provider), `a` opens the add form. The typed
`/provider <id>` form still works. Rationale: the completion dropdown is a
typing surface, not a management surface — picking/editing providers wants
a highlighted list ("上下选到哪个就指向哪个").

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
