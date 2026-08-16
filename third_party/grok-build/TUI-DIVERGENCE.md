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
- /provider command (crates/codegen/xai-grok-pager/src/slash/commands/provider.rs):
  lists providers from the bridge's initialize _meta.modelState.providers and
  switches the session to the picked provider's first catalog model by reusing
  the existing SetDefaultModel pipeline. The "current provider" is derived
  from the current model's provider meta (the bridge's currentProviderId is
  only a fallback), and /model's dropdown filters to that provider. The bridge
  owns provider auth/config (~/.dsh); the TUI never hardcodes provider auth
  assumptions.

## Patch

- None currently. Generic bug fixes found here must go upstream as PRs and
  be removed from this list when accepted.
