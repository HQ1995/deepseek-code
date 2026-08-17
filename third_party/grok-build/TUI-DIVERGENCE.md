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
  "dsh" on PATH -> /home/hanqing/.local/share/pi-node/.../bin/dsh -> npx),
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
  only a fallback), and /model's dropdown filters to that provider. The bridge
  owns provider auth/config (~/.dsh); the TUI never hardcodes provider auth
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
