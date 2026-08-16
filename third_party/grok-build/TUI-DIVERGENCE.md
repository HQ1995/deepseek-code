# TUI divergence ledger

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

- Leader mode: --leader/--leader-socket flags connect the TUI to our bridge
  over the grok leader unix-socket protocol instead of x.ai; local xai auth
  is bypassed in leader mode.
- Default preset label: hardcoded fallback "standard" -> "minimal" in
  crates/codegen/xai-grok-pager/src/app/app_view.rs (2 sites), matching the
  bridge's default preset (minimal). Coupled change: if the bridge default
  ever changes, update these labels too.
- Persona/preset selection is fed by the bridge's bundle/status personas;
  no TUI-side persona list of its own.

## Feature

- Slash commands removed (x.ai authoring/management surfaces, dsh has no
  matching concept): /personas and /config-agents (agents-modal authoring UI),
  /login, /logout, /share, /feedback, /imagine, /imagine_video, /import_claude,
  /gboom, /voice, /release_notes, /announcements, /recap, /timeline. /preset
  remains the only preset picker; /usage is kept pending provider billing.
## Patch

- None currently. Generic bug fixes found here must go upstream as PRs and
  be removed from this list when accepted.
