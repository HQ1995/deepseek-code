//! Provider-management dispatch: the add/edit modal, submit over
//! x.ai/providers/add or /update, removal over /remove, and the shared
//! roster-refresh application.

use crate::acp::model_state::ProviderInfo;
use crate::app::actions::Effect;
use crate::app::agent::AgentId;
use crate::app::agent_view::AgentView;
use crate::app::app_view::{ActiveView, AppView};
use crate::views::add_provider_modal::{AddProviderForm, AddProviderModalState};
use crate::views::modal::ActiveModal;

/// The agent's open add-provider modal state, if any.
pub(super) fn add_provider_modal_state_mut(
    agent: &mut AgentView,
) -> Option<&mut AddProviderModalState> {
    match agent.active_modal.as_mut() {
        Some(ActiveModal::AddProvider { state }) => Some(state),
        _ => None,
    }
}

/// Open (or focus) the add-provider modal. Full TUI only. When not on an
/// agent view (dashboard/welcome), switch to an existing agent or create a
/// placeholder session so the modal can mount — the same fallback
/// dispatch_open_settings uses.
pub(super) fn open_add_provider_modal(app: &mut AppView) -> Vec<Effect> {
    open_provider_modal(app, None)
}

/// Open the add-provider modal prefilled from the provider's settings
/// profile and submit it as an update (the dropdown's edit row action).
pub(super) fn open_edit_provider_modal(app: &mut AppView, provider_id: &str) -> Vec<Effect> {
    let profile = app
        .models
        .providers
        .iter()
        .chain(app.agents.values().flat_map(|agent| agent.session.models.providers.iter()))
        .find(|provider| provider.id == provider_id)
        .cloned();
    let Some(profile) = profile else {
        app.show_toast("Provider not found in the roster");
        return vec![];
    };
    open_provider_modal(app, Some(&profile))
}

/// Mount the add-provider modal (optionally in edit mode). Full TUI only.
/// When not on an agent view (dashboard/welcome), switch to an existing
/// agent or create a placeholder session so the modal can mount - the same
/// fallback dispatch_open_settings uses.
fn open_provider_modal(app: &mut AppView, prefill: Option<&ProviderInfo>) -> Vec<Effect> {
    let mut effects = vec![];
    let id = match app.active_view {
        ActiveView::Agent(id) => id,
        _ => {
            if let Some(existing) = app.agents.keys().next().copied() {
                super::ctx::switch_to_agent(app, existing, super::ctx::SwitchCause::Picker);
                existing
            } else {
                let (new_id, create_effects) =
                    super::session::lifecycle::dispatch_new_session_inner_with_id(app, None);
                effects.extend(create_effects);
                new_id
            }
        }
    };
    let Some(agent) = app.agents.get_mut(&id) else {
        return effects;
    };
    if add_provider_modal_state_mut(agent).is_some() {
        return effects;
    }
    let state = match prefill {
        Some(profile) => AddProviderModalState::prefilled(
            &profile.id,
            profile.display_name.as_deref().unwrap_or(""),
            profile.api_key_env.as_deref().unwrap_or(""),
            profile.api.as_deref(),
            profile.base_url.as_deref().unwrap_or(""),
        ),
        None => AddProviderModalState::new(),
    };
    agent.active_modal = Some(ActiveModal::AddProvider {
        state: Box::new(state),
    });
    effects
}

/// Submit the form to the bridge. The modal itself already set
/// `submitting`; the bridge's answer lands in handle_add_provider_complete.
pub(super) fn add_provider(app: &mut AppView, form: AddProviderForm) -> Vec<Effect> {
    let ActiveView::Agent(id) = app.active_view else {
        return vec![];
    };
    if !app.agents.contains_key(&id) {
        return vec![];
    }
    // An open modal in edit mode submits an update for the route it was
    // opened on; a fresh modal adds.
    let provider_id = app
        .agents
        .get_mut(&id)
        .and_then(add_provider_modal_state_mut)
        .and_then(|state| state.editing.clone());
    vec![Effect::AddProvider {
        agent_id: id,
        form,
        provider_id,
    }]
}

/// Send the (already confirmed) removal to the bridge; the answer lands in
/// handle_remove_provider_complete.
pub(super) fn remove_provider(app: &mut AppView, provider_id: String) -> Vec<Effect> {
    let ActiveView::Agent(id) = app.active_view else {
        return vec![];
    };
    if !app.agents.contains_key(&id) {
        return vec![];
    }
    vec![Effect::RemoveProvider {
        agent_id: id,
        provider_id,
    }]
}

/// Apply the bridge's answer: refresh both provider rosters and close the
/// modal on success; keep the modal open with the error text on failure.
pub(super) fn handle_add_provider_complete(
    app: &mut AppView,
    agent_id: AgentId,
    providers: Vec<ProviderInfo>,
    error: Option<String>,
) -> Vec<Effect> {
    let Some(agent) = app.agents.get_mut(&agent_id) else {
        return vec![];
    };
    if let Some(error) = error {
        if let Some(state) = add_provider_modal_state_mut(agent) {
            state.error = Some(error);
            state.submitting = false;
        }
        return vec![];
    }
    // The active agent's session and the app-level staging roster must both
    // see the new provider now (mirrors set_default_model_inner).
    agent.session.models.providers = providers.clone();
    app.models.providers = providers;
    let updated = matches!(
        &agent.active_modal,
        Some(ActiveModal::AddProvider { state }) if state.editing.is_some()
    );
    agent.active_modal = None;
    app.show_toast(if updated {
        "Provider updated"
    } else {
        "Provider added"
    });
    vec![]
}

/// Apply the bridge's answer to a removal: refresh both rosters and close
/// the provider dropdown on success; surface a refusal as a toast.
pub(super) fn handle_remove_provider_complete(
    app: &mut AppView,
    agent_id: AgentId,
    providers: Vec<ProviderInfo>,
    error: Option<String>,
) -> Vec<Effect> {
    if let Some(error) = error {
        app.show_toast(&format!("Couldn't remove provider: {error}"));
        return vec![];
    }
    let Some(agent) = app.agents.get_mut(&agent_id) else {
        return vec![];
    };
    agent.session.models.providers = providers.clone();
    app.models.providers = providers;
    if let Some(ActiveModal::ArgPicker { command, .. }) = &agent.active_modal
        && command == "provider"
    {
        agent.active_modal = None;
    }
    app.show_toast("Provider removed");
    vec![]
}
