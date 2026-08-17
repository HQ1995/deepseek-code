//! Add-provider dispatch: open the modal, submit the form over
//! x.ai/providers/add, and apply the refreshed provider roster.

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
    agent.active_modal = Some(ActiveModal::AddProvider {
        state: Box::new(AddProviderModalState::new()),
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
    vec![Effect::AddProvider { agent_id: id, form }]
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
    agent.active_modal = None;
    app.show_toast("Provider added");
    vec![]
}
