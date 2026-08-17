# TUI divergence triage

Audit of every intentional divergence between `third_party/grok-build` and
upstream `xai-org/grok-build`, with effort estimates and a recommended
removal order. Sources: `third_party/grok-build/TUI-DIVERGENCE.md`,
`third_party/grok-build/VENDORING.md`, targeted greps for local-only marks
(`dscode`/`DSCODE`, `dsh_leader.rs`, `DEEPSEEK_LEADER_*`, the thinking
display-mode default, `[[bin]]` names), and spot-checks against the upstream
tree at the recorded vendoring commit
`d6a22a1` (the `SOURCE_REV` value `7140ec` is unfetchable upstream —
history was rewritten; see Bookkeeping).

Classes: **(a)** removable branding/config, **(b)** upstreamable generic fix,
**(c)** must-keep deepseek-specific integration.

## Applied in this branch (source-only; rebuild + release required)

1. `crates/codegen/xai-grok-pager-bin/src/main.rs`: lowercase `dscode`
   exec-name strings now derive from `env!("CARGO_BIN_NAME")` (the
   `[[bin]]` name in Cargo.toml is the single brand point). Output is
   byte-identical (`CARGO_BIN_NAME=dscode`). `plugin_dir_leader_warning`
   const became a function for the same reason. Rebuild + release required.
2. `crates/codegen/xai-grok-pager/src/dsh_leader.rs`: removed the hardcoded
   host pi-node fallback (`HOST_DSH`); resolution is now
   `DSH_BIN` -> `dsh` on PATH -> npx, and `dsh` is on PATH here
   (`~/.local/bin/dsh`), so behavior is unchanged. Ledger updated to match.
   Rebuild + release required.

No `cargo build` was run; both changes are source-only and need a rebuild
and release before they ship.

## Table

| # | File | Divergence | Class | Effort |
|---|------|------------|-------|--------|
| 1 | `xai-grok-pager-bin/Cargo.toml` | `[[bin]]` renamed `xai-grok-pager` -> `dscode`, `default-run` dscode (VENDORING.md says "deepseek"; actual is dscode). Coupled to install.sh release URLs (`dscode-linux-x86_64`) | a | medium |
| 2 | `xai-grok-pager-bin/src/main.rs` | lowercase `dscode` exec-name strings -> `env!("CARGO_BIN_NAME")` (applied). Title-case `Dscode` prose remains at 93, 178, 1884, 1887, 1903 | a | done |
| 3 | `xai-grok-pager/src/app/cli.rs` | `name = "dscode"`, `about = "Deepseek Code TUI"` (upstream: "grok" / "Grok Build TUI"). Lib crate: `CARGO_BIN_NAME` unavailable, no config seam | a | small |
| 4 | `xai-grok-pager/src/completions_cmd.rs` | completion name hardcoded "dscode" (upstream "grok"). Same lib-crate constraint as #3 | a | small |
| 5 | `xai-grok-pager/src/settings/defs.rs:50,55,486,491` + `xai-grok-pager-render/src/theme/mod.rs:147` | theme labels "Grok Night/Day" -> "Dscode Night/Day" | a | small |
| 6 | `xai-grok-pager/src/views/session_picker.rs:262` | source label `Self::Grok => "Dscode"` | a | small |
| 7 | ~14 other crates (crash-handler, fast-worktree, grok-config, grok-mcp, grok-memory, pager-minimal, pager-render, sampling-types, workspace, voice) | mechanical grok->dscode strings in errors/OAuth client name/UI text; no seam, cosmetic | a | small (batch) |
| 8 | `xai-grok-version/Cargo.toml:6` | description "Lockstepped grok CLI version." -> "dscode" (package metadata only) | a | trivial |
| 9 | `xai-grok-pager/src/dsh_leader.rs` | `HOST_DSH` host-specific path (removed — applied). Remaining: numactl node-1 wrapper auto-applies wherever numactl is on PATH; keep on this host, but should be env-gated | a | small |
| 10 | `xai-grok-shell/src/session/acp_session_tests/tool_layer_images_bridge_tests.rs` | added `use base64::Engine as _;` so tests compile | b | small |
| 11 | `xai-grok-shell/src/leader/mod.rs:91` | `EXTERNAL_SPAWN_WAIT_TIMEOUT` 30s const; generic spawn-timeout knob, upstreamable as env-configurable | b | small |
| 12 | `xai-grok-pager-bin/src/main.rs` (applied #2) | version_text now prints `env!("CARGO_BIN_NAME")` — honest version reporting; PR candidate upstream (they hardcode "grok") | b | done |
| 13 | `xai-grok-pager/src/scrollback/state/mod.rs:267` | `thinking_display_mode` default `Truncated` (upstream `Collapsed`). UX default; no config seam today | a | small |
| 14 | `xai-grok-pager/src/app/app_view.rs:4839,4958` | preset-label fallback "standard" -> "minimal", coupled to bridge default | c | — |
| 15 | `xai-grok-pager/src/dsh_leader.rs` + `pager-bin/main.rs` | single-entry leader bootstrap: resolve dsh, spawn `dsh --profile deepseek-leader`, `DEEPSEEK_LEADER_SOCKET`/`DEEPSEEK_LEADER_LOG`, `DSH_TELEMETRY_DISABLED=1`, PID in sibling .lock | c | — |
| 16 | `xai-grok-shell/src/leader/mod.rs`, `xai-grok-pager/src/acp/mod.rs` | `connect_or_spawn_external`, `LeaderReconnector`, flock-serialized spawner, ~30s cold-boot wait, failed-spawn kill | c | — |
| 17 | `xai-grok-pager/src/app/event_loop.rs:1066` | skip local x.ai interactive-login gate in leader-client mode (auth owned by harness) | c | — |
| 18 | pager-bin main.rs + cli.rs | `--leader`/`--leader-socket` flags, local x.ai auth bypass in leader mode | c | — |
| 19 | persona wiring (`effects/helpers.rs`, `app_view.rs`, `actions`, `dispatch`, `agent_view`) | `SessionFlags.persona_override` -> `_meta.agentProfile`; persona picker fed by bridge bundle; `ToggleCatalog` (Ctrl+Y) | c | — |
| 20 | `xai-grok-pager/src/slash/commands/provider.rs`, `views/add_provider_modal.rs` | /provider command + add/edit/delete modal over `x.ai/providers/*` bridge RPCs | c | — |
| 21 | `xai-grok-pager/src/slash/commands/usage.rs`, `views/usage_modal.rs` | /usage shows session stats, billing tab hidden | c | — |
| 22 | `slash/commands/` | removed x.ai-only commands (login, logout, share, feedback, imagine*, import_claude, gboom, voice, release_notes, announcements, recap, timeline, personas, config-agents) | c | — |
| 23 | `views/welcome/mod.rs:1705,2085`, `app/mouse.rs:151`, `app/app_view.rs:3931,4801` | privacy banner removed (ledger's "SpaceXAI -> DeepSeek copy" entry is stale: the file is deleted; DeepSeek copy survives only in settings_modal test fixtures) | c | — |

## Bookkeeping (fix at next sync; no rebuild)

- `third_party/grok-build/SOURCE_REV` (`7140ec`) is unfetchable upstream;
  `UPSTREAM_REV` is UNKNOWN. Pin a real upstream commit.
- TUI-DIVERGENCE.md: privacy_banner entry describes a file that no longer
  exists (banner is removed, not reworded). VENDORING.md: bin renamed to
  "deepseek" but the artifact is "dscode". Ledger should say so.
- main.rs still has one upstream-identical stale string, "Update installed.
  Run `grok` to start." — not a divergence, but the CARGO_BIN_NAME seam from
  patch #2 covers it if you want it fixed.

## Recommended order

1. (done) main.rs `CARGO_BIN_NAME` + `HOST_DSH` removal — rebuild + release.
2. Bookkeeping fixes — no code risk, makes the next sync auditable.
3. Trivial (a): xai-grok-version description (#8).
4. Small (a) batch: theme labels, session_picker, cli/completions via a
   shared brand const — only if we accept a lib-crate build.rs seam.
5. Env-gate the numactl wrapper (#9) — decide default-off vs install.sh sets it.
6. UX decision (#13): revert to upstream `Collapsed` (one line) or add a
   settings key for the thinking default.
7. Medium (a): `[[bin]]` rename removal (#1) — coordinate release artifact
   names and install.sh first.
8. Submit upstream PRs (#10, #12, #11); delete their ledger entries when
   accepted.
