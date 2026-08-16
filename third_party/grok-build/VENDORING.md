grok-build vendored from https://github.com/xai-org/grok-build at commit d6a22a1aed70b58d30a0f82a1a2a76ce1301631e (upstream SOURCE_REV file says 7140ec21cc4ec809131b0fa774f4b81d61667084)
Local modification: crates/codegen/xai-grok-pager-bin/Cargo.toml renames the [[bin]] artifact from xai-grok-pager to deepseek.
Vendored local modifications (rebrand + deepseek-build integration):
1. crates/codegen/xai-grok-pager-bin/Cargo.toml: [[bin]] name deepseek, default-run deepseek.
2. crates/codegen/xai-grok-pager/src/app/event_loop.rs: in leader-client mode, skip the local x.ai interactive-login gate (auth is owned by the connected harness leader; auth_state stays Done).
3. Wire the bundled-persona picker to the harness leader agent presets:
   - app/effects/helpers.rs: SessionFlags gains persona_override; to_meta stamps it as _meta.agentProfile (plain string) ahead of the built-in grok-build-plan profile.
   - app/app_view.rs + app/event_loop.rs: AppView.persona_override threads the picked persona into SessionFlags for session/new and session/load.
   - app/actions.rs + app/dispatch/router.rs + app/agent_view/panes.rs: Action::SelectPersona records the persona picked in the subagent catalog pane.
   - actions/mod.rs + actions/defaults.rs + app/agent_view/input.rs + app/agent_view/panes.rs: ToggleCatalog (Ctrl+Y) makes the subagent catalog pane reachable so a persona can be picked.
