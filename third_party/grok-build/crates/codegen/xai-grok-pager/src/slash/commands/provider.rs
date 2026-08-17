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
const ADD_PROVIDER_ARG: &str = "--add";
/// Final dropdown row label.
const ADD_PROVIDER_LABEL: &str = "+ Add provider…";

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
        "/provider <id> | --add"
    }

    fn takes_args(&self) -> bool {
        true
    }

    fn args_required(&self) -> bool {
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
            return CommandResult::Error("Usage: /provider <id> | --add".into());
        }
        let Some(provider) = resolve_provider(ctx.models, query) else {
            return CommandResult::Error(format!("Unknown provider: {query}"));
        };
        // The provider's first catalog model is its default (the bridge lists
        // providers before flattening, so catalog order is provider order).
        let Some(model_id) = default_model_for(ctx.models, provider) else {
            return CommandResult::Error(format!("Provider {provider} has no models"));
        };
        CommandResult::Action(Action::SetDefaultModel(model_id))
    }
}

/// One row per provider. The row owning the current model is tagged
/// "(current)"; insert_text carries the provider id so acceptance feeds the
/// typed form directly (the same string /provider run resolves
/// case-insensitively).
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
            ArgItem {
                match_text: format!("{label} {}", provider.id),
                insert_text: provider.id.clone(),
                display,
                description: String::new(),
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
                .find(|p| p.name.as_deref().is_some_and(|n| n.eq_ignore_ascii_case(query)))
                .map(|p| p.id.as_str())
        })
}

/// The provider's default model: its first entry in the flattened catalog
/// (provider-major order from the bridge's refreshCatalog).
fn default_model_for(
    models: &ModelState,
    provider: &str,
) -> Option<agent_client_protocol::ModelId> {
    models
        .available
        .iter()
        .find(|(_, info)| {
            info.meta
                .as_ref()
                .and_then(|m| m.get("provider"))
                .and_then(|v| v.as_str())
                == Some(provider)
        })
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
    ) -> (agent_client_protocol::ModelId, agent_client_protocol::ModelInfo) {
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
            },
            crate::acp::model_state::ProviderInfo {
                id: "pi".into(),
                name: Some("Pi AI".into()),
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
        assert_eq!(items[1].display, "Pi AI");
        assert_eq!(items[0].insert_text, "deepseek");
        assert_eq!(items[2].display, ADD_PROVIDER_LABEL);
        assert_eq!(items[2].insert_text, ADD_PROVIDER_ARG);
    }

    #[test]
    fn run_add_opens_the_add_provider_modal() {
        let state = sample();
        let mut ctx = exec_ctx(&state);
        let result = ProviderCommand.run(&mut ctx, ADD_PROVIDER_ARG);
        assert!(matches!(result, CommandResult::Action(Action::OpenAddProvider)));
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
    fn run_rejects_unknown_provider() {
        let state = sample();
        let mut ctx = exec_ctx(&state);
        assert!(matches!(
            ProviderCommand.run(&mut ctx, "nope"),
            CommandResult::Error(_)
        ));
    }
}
