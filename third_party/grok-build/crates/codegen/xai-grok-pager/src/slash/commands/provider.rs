//! /provider — pick a provider; the session's model moves to that provider's
//! first catalog model (the bridge relays provider ids; auth stays in
//! ~/.dsh/settings.yaml on the dsh side, so the TUI never assumes an auth
//! method).
//!
//! dscode: provider selection is the current model's provider, not a separate
//! state slot. The bridge resolves provider -> default model, and the pager
//! reuses the existing SetDefaultModel / SwitchModel pipeline (same path as
//! /model), so the session model, app default, dashboard staging, persistence,
//! and rollback all behave exactly like a model switch.

use crate::acp::model_state::ModelState;
use crate::app::actions::Action;
use crate::slash::command::{AppCtx, ArgItem, CommandExecCtx, CommandResult, SlashCommand};

/// Select a provider for this session.
pub struct ProviderCommand;

/// The args token the dropdown's final row inserts: accepting it runs
/// /provider --add, which opens the add-provider modal.
pub(crate) const ADD_PROVIDER_ARG: &str = "--add";
/// Final dropdown row label.
const ADD_PROVIDER_LABEL: &str = "+ Add provider…";

/// A provider row armed for deletion (Ctrl+D in the /provider dropdown). The
/// armed state lives on the prompt widget, not the snapshot, so snapshot
/// rebuilds cannot drop a live confirm.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProviderPendingDelete {
    pub provider_id: String,
    /// Row display name (without the "(current)" suffix).
    pub name: String,
    /// The provider owns the current model: 'y' must not dispatch; the
    /// footer explains the block instead.
    pub blocked: bool,
}

/// Outcome of routing a key through an armed ProviderPendingDelete.
pub(crate) enum ProviderPendingDeleteKey {
    /// 'y': caller should remove this provider (never for a blocked arm).
    Confirm(String),
    /// Arm cleared ('n', or 'y' on a blocked arm); caller redraws.
    Cancel,
    /// Arm cleared, but the key should still be processed normally.
    Disarmed,
    /// Nothing armed, or not an unmodified key press.
    NotArmed,
}

/// Route a key through an armed provider delete: 'y' confirms (unless the
/// provider is in use), 'n' cancels, any other unmodified key disarms and
/// falls through - the same contract the session picker's pending delete
/// uses, so both surfaces read alike.
pub(crate) fn handle_provider_pending_delete_key(
    pending: &mut Option<ProviderPendingDelete>,
    key: &crossterm::event::KeyEvent,
) -> ProviderPendingDeleteKey {
    use crossterm::event::{KeyCode, KeyEventKind};
    if pending.is_none() {
        return ProviderPendingDeleteKey::NotArmed;
    }
    if key.kind != KeyEventKind::Press || !key.modifiers.is_empty() {
        return ProviderPendingDeleteKey::NotArmed;
    }
    match key.code {
        KeyCode::Char('y') => {
            if let Some(armed) = pending.take()
                && !armed.blocked
            {
                ProviderPendingDeleteKey::Confirm(armed.provider_id)
            } else {
                ProviderPendingDeleteKey::Cancel
            }
        }
        KeyCode::Char('n') => {
            *pending = None;
            ProviderPendingDeleteKey::Cancel
        }
        _ => {
            *pending = None;
            ProviderPendingDeleteKey::Disarmed
        }
    }
}

impl SlashCommand for ProviderCommand {
    fn name(&self) -> &str {
        "provider"
    }

    fn description(&self) -> &str {
        "Switch the active provider"
    }

    fn session_scoped(&self) -> bool {
        true
    }

    fn offered_when_session_less(&self) -> bool {
        // The dashboard offers /provider like /model: the pick stages the
        // provider's default model for the next spawned agent.
        true
    }

    fn usage(&self) -> &str {
        "/provider [id] | --add"
    }

    fn takes_args(&self) -> bool {
        true
    }

    fn arg_placeholder(&self) -> Option<&str> {
        Some("<provider>")
    }

    fn suggest_args(&self, ctx: &AppCtx, _args_query: &str) -> Option<Vec<ArgItem>> {
        Some(build_provider_items(ctx.models))
    }

    fn run(&self, ctx: &mut CommandExecCtx, args: &str) -> CommandResult {
        let query = args.trim();
        if query == ADD_PROVIDER_ARG {
            return CommandResult::Action(Action::OpenAddProvider);
        }
        if query.is_empty() {
            // Bare /provider opens the list picker: arrows move the highlight,
            // Enter switches, e edits, d deletes (y/n), a adds.
            return CommandResult::Action(Action::OpenProviderPicker);
        }
        let Some(provider) = resolve_provider(ctx.models, query) else {
            return CommandResult::Error(format!("Unknown provider: {query}"));
        };
        // Preserve the same raw model id when the target provider offers it;
        // otherwise use that provider's first catalog model.
        let Some(model_id) = default_model_for(ctx.models, provider) else {
            // The remedy (log in, add a key, …) is the agent's knowledge, not
            // the TUI's: relay the bridge-supplied note when there is one.
            let note = ctx
                .models
                .providers
                .iter()
                .find(|p| p.id == provider)
                .and_then(|p| p.note.as_deref())
                .map(|n| format!(" — {n}"))
                .unwrap_or_default();
            return CommandResult::Error(format!("Provider {provider} has no models{note}"));
        };
        CommandResult::Action(Action::SetDefaultModel(model_id))
    }
}

/// One row per provider. The row owning the current model is tagged
/// "(current)"; insert_text carries the provider id so acceptance feeds the
/// typed form directly (the same string /provider run resolves
/// case-insensitively). The description column carries the bridge-supplied
/// note when present (the agent knows WHY a provider is empty and what
/// unlocks it), else the model count — so an unpickable provider says so
/// before the user hits the error.
fn build_provider_items(models: &ModelState) -> Vec<ArgItem> {
    let scope = models.current_provider_scope();
    let mut items: Vec<ArgItem> = models
        .providers
        .iter()
        .map(|provider| {
            let label = provider.name.as_deref().unwrap_or(&provider.id);
            let display = if !scope.is_empty() && provider.id == scope {
                format!("{label} (current)")
            } else {
                label.to_string()
            };
            let model_count = models
                .available
                .values()
                .filter(|info| {
                    info.meta
                        .as_ref()
                        .and_then(|m| m.get("provider"))
                        .and_then(|v| v.as_str())
                        == Some(provider.id.as_str())
                })
                .count();
            let description = match (provider.note.as_deref(), model_count) {
                (Some(note), _) => note.to_string(),
                (None, 0) => "no models".to_string(),
                (None, 1) => "1 model".to_string(),
                (None, n) => format!("{n} models"),
            };
            ArgItem {
                match_text: format!("{label} {}", provider.id),
                insert_text: provider.id.clone(),
                display,
                description,
            }
        })
        .collect();
    // ponytail: the final row accepts as /provider --add (no trailing space,
    // so Enter accepts and sends), which run() maps to OpenAddProvider.
    items.push(ArgItem {
        display: ADD_PROVIDER_LABEL.to_string(),
        match_text: "add provider".to_string(),
        insert_text: ADD_PROVIDER_ARG.to_string(),
        description: "Add a provider to the dsh settings".to_string(),
    });
    items
}

/// Case-insensitive match on provider id first, then display name.
fn resolve_provider<'a>(models: &'a ModelState, query: &str) -> Option<&'a str> {
    models
        .providers
        .iter()
        .find(|p| p.id.eq_ignore_ascii_case(query))
        .map(|p| p.id.as_str())
        .or_else(|| {
            models
                .providers
                .iter()
                .find(|p| {
                    p.name
                        .as_deref()
                        .is_some_and(|n| n.eq_ignore_ascii_case(query))
                })
                .map(|p| p.id.as_str())
        })
}

/// Raw model id behind a bridge wire id. Duplicate ids are qualified as
/// `provider:model`; the first owner keeps the bare id.
fn raw_model_id<'a>(models: &'a ModelState, id: &'a agent_client_protocol::ModelId) -> &'a str {
    let wire = id.0.as_ref();
    let provider = models.provider_for(id);
    wire.strip_prefix(provider)
        .and_then(|rest| rest.strip_prefix(':'))
        .unwrap_or(wire)
}

fn belongs_to_provider(
    models: &ModelState,
    id: &agent_client_protocol::ModelId,
    provider: &str,
) -> bool {
    models.provider_for(id) == provider
}

/// Prefer the current raw model on the target provider; fall back to the
/// provider's first entry in bridge catalog order.
fn default_model_for(
    models: &ModelState,
    provider: &str,
) -> Option<agent_client_protocol::ModelId> {
    if let Some(current) = models.current.as_ref() {
        let current_raw = raw_model_id(models, current);
        if let Some((id, _)) = models.available.iter().find(|(id, _)| {
            belongs_to_provider(models, id, provider) && raw_model_id(models, id) == current_raw
        }) {
            return Some(id.clone());
        }
    }
    models
        .available
        .iter()
        .find(|(id, _)| belongs_to_provider(models, id, provider))
        .map(|(id, _)| id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn model(
        id: &str,
        name: &str,
        provider: &str,
    ) -> (
        agent_client_protocol::ModelId,
        agent_client_protocol::ModelInfo,
    ) {
        let id = agent_client_protocol::ModelId::new(Arc::from(id));
        let mut meta = serde_json::Map::new();
        meta.insert(
            "provider".into(),
            serde_json::Value::String(provider.to_string()),
        );
        let info = agent_client_protocol::ModelInfo::new(id.clone(), name.to_string())
            .meta(serde_json::Value::Object(meta).as_object().cloned());
        (id, info)
    }

    fn sample() -> ModelState {
        let mut state = ModelState::default();
        state.providers = vec![
            crate::acp::model_state::ProviderInfo {
                id: "deepseek".into(),
                name: Some("DeepSeek".into()),
                ..Default::default()
            },
            crate::acp::model_state::ProviderInfo {
                id: "pi".into(),
                name: Some("Pi AI".into()),
                ..Default::default()
            },
        ];
        let (chat_id, chat) = model("deepseek-chat", "DeepSeek Chat", "deepseek");
        let (reasoner_id, reasoner) = model("deepseek-reasoner", "DeepSeek Reasoner", "deepseek");
        let (pi_id, pi) = model("pi-code", "Pi Code", "pi");
        state.available.insert(chat_id.clone(), chat);
        state.available.insert(reasoner_id, reasoner);
        state.available.insert(pi_id, pi);
        state.current = Some(chat_id);
        state.current_provider = Some("deepseek".into());
        state
    }

    fn app_ctx<'a>(state: &'a ModelState) -> AppCtx<'a> {
        AppCtx {
            models: state,
            cwd: std::path::Path::new("."),
            has_session_announcements: false,
            billing_surface_visible: true,
            usage_command_visible: true,
            workflows_available: true,
            capabilities: None,
            screen_mode: crate::app::ScreenMode::Fullscreen,
            current_title: None,
        }
    }

    fn exec_ctx<'a>(state: &'a ModelState) -> CommandExecCtx<'a> {
        static BUNDLE: std::sync::LazyLock<crate::app::bundle::BundleState> =
            std::sync::LazyLock::new(crate::app::bundle::BundleState::default);
        CommandExecCtx {
            models: state,
            session_id: None,
            bundle_state: &BUNDLE,
            screen_mode: crate::app::ScreenMode::Inline,
            billing_surface_visible: true,
            usage_command_visible: true,
            pager_state: crate::settings::PagerLocalSnapshot::default(),
        }
    }

    #[test]
    fn suggests_one_row_per_provider_plus_the_add_row() {
        let state = sample();
        let items = ProviderCommand.suggest_args(&app_ctx(&state), "").unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].display, "DeepSeek (current)");
        assert_eq!(items[0].description, "2 models");
        assert_eq!(items[1].display, "Pi AI");
        assert_eq!(items[1].description, "1 model");
        assert_eq!(items[0].insert_text, "deepseek");
        assert_eq!(items[2].display, ADD_PROVIDER_LABEL);
        assert_eq!(items[2].insert_text, ADD_PROVIDER_ARG);
    }

    #[test]
    fn a_model_less_provider_relays_the_bridge_note_verbatim() {
        let mut state = sample();
        state.providers.push(crate::acp::model_state::ProviderInfo {
            id: "codex".into(),
            name: Some("ChatGPT (Codex)".into()),
            note: Some("not logged in — /dsh login codex".into()),
            ..Default::default()
        });
        state.providers.push(crate::acp::model_state::ProviderInfo {
            id: "bare".into(),
            name: Some("Bare".into()),
            ..Default::default()
        });
        let items = ProviderCommand.suggest_args(&app_ctx(&state), "").unwrap();
        // The note is display-only pass-through: the TUI renders whatever the
        // bridge said and hardcodes no remedy of its own.
        let codex = items.iter().find(|i| i.insert_text == "codex").unwrap();
        assert_eq!(codex.description, "not logged in — /dsh login codex");
        let bare = items.iter().find(|i| i.insert_text == "bare").unwrap();
        assert_eq!(bare.description, "no models");

        let mut ctx = exec_ctx(&state);
        match ProviderCommand.run(&mut ctx, "codex") {
            CommandResult::Error(msg) => {
                assert_eq!(
                    msg,
                    "Provider codex has no models — not logged in — /dsh login codex"
                );
            }
            other => panic!("expected an error for a model-less provider, got {other:?}"),
        }
        match ProviderCommand.run(&mut ctx, "bare") {
            CommandResult::Error(msg) => assert_eq!(msg, "Provider bare has no models"),
            other => panic!("expected an error for a model-less provider, got {other:?}"),
        }
    }

    #[test]
    fn bare_run_opens_the_provider_picker() {
        let state = sample();
        let mut ctx = exec_ctx(&state);
        let result = ProviderCommand.run(&mut ctx, "");
        assert!(matches!(
            result,
            CommandResult::Action(Action::OpenProviderPicker)
        ));
    }

    #[test]
    fn run_add_opens_the_add_provider_modal() {
        let state = sample();
        let mut ctx = exec_ctx(&state);
        let result = ProviderCommand.run(&mut ctx, ADD_PROVIDER_ARG);
        assert!(matches!(
            result,
            CommandResult::Action(Action::OpenAddProvider)
        ));
    }

    #[test]
    fn run_resolves_provider_and_dispatches_default_model() {
        let state = sample();
        let mut ctx = exec_ctx(&state);
        let result = ProviderCommand.run(&mut ctx, "PI");
        match result {
            CommandResult::Action(Action::SetDefaultModel(id)) => {
                assert_eq!(id.0.as_ref(), "pi-code");
            }
            other => panic!("expected SetDefaultModel(pi-code), got {other:?}"),
        }
    }

    #[test]
    fn switching_provider_preserves_the_same_raw_model_when_available() {
        let mut state = sample();
        let (shared, info) = model("pi:deepseek-chat", "DeepSeek Chat", "pi");
        state.available.insert(shared, info);
        let mut ctx = exec_ctx(&state);
        match ProviderCommand.run(&mut ctx, "pi") {
            CommandResult::Action(Action::SetDefaultModel(id)) => {
                assert_eq!(id.0.as_ref(), "pi:deepseek-chat");
            }
            other => panic!("expected the matching Pi model, got {other:?}"),
        }
    }

    #[test]
    fn run_rejects_unknown_provider() {
        let state = sample();
        let mut ctx = exec_ctx(&state);
        assert!(matches!(
            ProviderCommand.run(&mut ctx, "nope"),
            CommandResult::Error(_)
        ));
    }

    #[test]
    fn pending_delete_y_confirms_n_cancels_other_disarms() {
        let key =
            |code| crossterm::event::KeyEvent::new(code, crossterm::event::KeyModifiers::NONE);
        let arm = || ProviderPendingDelete {
            provider_id: "pi".into(),
            name: "Pi AI".into(),
            blocked: false,
        };
        let mut pending = Some(arm());
        assert!(matches!(
            handle_provider_pending_delete_key(&mut pending, &key(crossterm::event::KeyCode::Char('y'))),
            ProviderPendingDeleteKey::Confirm(id) if id == "pi"
        ));
        assert!(pending.is_none());

        let mut pending = Some(arm());
        assert!(matches!(
            handle_provider_pending_delete_key(
                &mut pending,
                &key(crossterm::event::KeyCode::Char('n'))
            ),
            ProviderPendingDeleteKey::Cancel
        ));
        assert!(pending.is_none());

        let mut pending = Some(arm());
        assert!(matches!(
            handle_provider_pending_delete_key(&mut pending, &key(crossterm::event::KeyCode::Down)),
            ProviderPendingDeleteKey::Disarmed
        ));
        assert!(pending.is_none());

        let mut pending = None;
        assert!(matches!(
            handle_provider_pending_delete_key(
                &mut pending,
                &key(crossterm::event::KeyCode::Char('y'))
            ),
            ProviderPendingDeleteKey::NotArmed
        ));
    }

    #[test]
    fn pending_delete_refuses_a_blocked_confirm() {
        let key = crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char('y'),
            crossterm::event::KeyModifiers::NONE,
        );
        let mut pending = Some(ProviderPendingDelete {
            provider_id: "deepseek".into(),
            name: "DeepSeek".into(),
            blocked: true,
        });
        assert!(matches!(
            handle_provider_pending_delete_key(&mut pending, &key),
            ProviderPendingDeleteKey::Cancel
        ));
        assert!(pending.is_none());
    }
}
