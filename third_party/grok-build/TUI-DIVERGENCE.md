# TUI divergence ledger

Apache-2.0 change notice:
This tree is a modified distribution of
[xai-org/grok-build](https://github.com/xai-org/grok-build).
The differences listed below are local modifications made for deepseek-code.
Modified files remain under the Apache License, Version 2.0; see [LICENSE](LICENSE).

Every intentional difference between this tree and upstream grok-build.
Class: patch (generic fix, should be offered upstream) / feature (product) /
branding (our identity). Keep this list current on every sync.

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
  spawns "dsh --profile deepseek-leader" with DEEPSEEK_LEADER_SOCKET /
  DSH_TELEMETRY_DISABLED=1 and a numactl node-1 wrapper (host policy,
  conditional), logs to /tmp/deepseek-leader.log, and records the PID in the
  sibling .lock. pager-bin main.rs synthesizes --leader/--leader-socket/
  --sandbox off/--no-auto-update; acp::connect_via_leader and the
  LeaderReconnector call the new xai-grok-shell connect_or_spawn_external
  (connect-first adoption of a live leader, flock-serialized single spawner,
  one ~30s wait that covers a cold node boot, failed spawns are killed) so
  sessions spawned by the old shell leader on the same socket
  are still adopted. scripts/dscode.sh + bin/dscode are gone; install.sh links
  ~/.local/bin/dscode directly to the prebuilt binary.
- Leader mode: --leader/--leader-socket flags connect the TUI to our bridge
  over the grok leader unix-socket protocol instead of x.ai; local xai auth
  is bypassed in leader mode.
- Default preset label: hardcoded fallback "standard" -> "minimal" in
  crates/codegen/xai-grok-pager/src/app/app_view.rs (2 sites), matching the
  bridge's default preset (minimal). Coupled change: if the bridge default
  ever changes, update these labels too.
- Persona/preset selection is fed by the bridge's bundle/status personas;
  no TUI-side persona list of its own.
- /provider command (crates/codegen/xai-grok-pager/src/slash/commands/provider.rs):
  lists providers from the bridge's initialize _meta.modelState.providers and
  switches the session to the picked provider's first catalog model by reusing
  the existing SetDefaultModel pipeline. The "current provider" is derived
  from the current model's provider meta (the bridge's currentProviderId is
  only a fallback). /model's dropdown is GLOBAL: every provider's models in
  one list, rows outside the current model's provider prefixed "[provider]",
  so a cross-provider switch is a single /model pick (an earlier iteration
  scoped /model to the current provider, which made /provider a mandatory
  two-step hop through an arbitrary first model — reverted as unusable).
  /provider rows carry a model count; a model-less provider (subscription
  pre-login, missing API key) says so in the row and errors with the
  /dsh login pointer instead of a bare "has no models". The bridge owns
  provider auth/config (~/.dsh); the TUI never hardcodes provider auth
  assumptions.
- Add-provider flow: the /provider dropdown's final row "+ Add provider…"
  accepts as /provider --add, which opens a new add-provider modal
  (crates/codegen/xai-grok-pager/src/views/add_provider_modal.rs, wired through
  ActiveModal::AddProvider, Action::OpenAddProvider/AddProvider and
  Effect::AddProvider). The modal offers the dsh provider presets (DeepSeek
  official, OpenCodex gateway, OpenAI/Anthropic-compatible, OpenRouter) plus a
  Custom empty form over id/displayName/apiKeyEnv/api/baseURL; auth is env-key
  only (the form says so). Submit sends x.ai/providers/add to the bridge,
  which writes the provider into the dsh settings document through the official
  settings seam (ctx.settings.mutate on the llm-pi-ai namespace); the response
  refreshes modelState.providers so /provider updates without a reload.
  ponytail: no models field in v1 - custom routes get their models from
  bridge-side gateway discovery, catalog routes keep serving the installed
  catalog. Protocol ids are the official seam's: openai-completions /
  openai-responses / anthropic-messages.
- Provider edit/delete: in the /provider dropdown, Ctrl+E opens the same
  modal prefilled from the provider's settings profile (id locked, empty
  fields mean unset) and submits x.ai/providers/update; Ctrl+D arms a
  y/n delete confirm that submits x.ai/providers/remove. Both bridge methods
  reuse the official settings seam (ctx.settings.mutate on llm-pi-ai), never
  write settings.yaml directly, and return the refreshed roster. Deleting the
  provider that owns the current model is blocked (switch provider first),
  both in the dropdown footer and by the bridge.
- /usage shows real per-session stats instead of grok.com billing. It opens the
  existing usage modal on the "Context usage" tab (session/info context
  breakdown: used/total/pct, turns, tool calls, messages, compactions) and
  hides the "Usage limit" billing tab when there is no billing surface
  (bridge billing config:null). The context block's model caption falls back
  to the live model catalog (name + provider) because the bridge serves
  session/info model:null. The x.ai/session/usage RPC is skipped (bridge has
  no such method); /usage is session-scoped and "manage" stays gated by
  billing_surface_visible (never true in dscode).

## Feature

- Slash commands removed (x.ai authoring/management surfaces, dsh has no
  matching concept): /personas and /config-agents (agents-modal authoring UI),
  /login, /logout, /share, /feedback, /imagine, /imagine_video, /import_claude,
  /gboom, /voice, /release_notes, /announcements, /recap, /timeline. /preset
  remains the only preset picker; /usage is adapted to session stats (above).
## Patch

- crates/codegen/xai-grok-shell/src/session/acp_session_tests/tool_layer_images_bridge_tests.rs:
  added the missing 'use base64::Engine as _;' (base64 0.22 trait import) so the
  shell test binary compiles. Generic bug fixes found here must go upstream as
  PRs and be removed from this list when accepted.
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
(bridge config followUpBehavior / env DEEPSEEK_LEADER_FOLLOW_UP; default
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
