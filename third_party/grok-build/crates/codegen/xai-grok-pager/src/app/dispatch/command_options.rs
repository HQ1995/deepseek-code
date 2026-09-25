//! DIVERGENCE(dscode): host-served option pickers.
//!
//! A host command whose descriptor says `_meta.options` (or a builtin that
//! fronts one) opens the ArgPicker when it is picked in Ctrl+P or entered
//! bare. Its rows come from `x.ai/commands/options`, loaded the way the
//! reference picker loads its candidates: the picker opens empty
//! under a loading key, and only the reply carrying that key fills it.
//! Picking a row submits `/name <id>`; a `next` row asks again with its id as
//! the query. No command is named here.

use super::ctx::with_active_agent;
use crate::app::actions::{Action, Effect};
use crate::app::agent_view::AgentView;
use crate::app::app_view::AppView;
use crate::slash::command::ArgItem;
use crate::views::modal::{ActiveModal, PaletteSnapshot};
use crate::views::modal_window::ModalWindowState;
use crate::views::picker::PickerState;

const LOADING: &str = "options:loading:";
const READY: &str = "options:ready:";

/// DSH's `SelectConfirmation`: shown as the row's detail for now.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default)]
pub struct SelectConfirmation {
    pub title: String,
    pub description: String,
}

/// DSH's `SelectOption`, plus dscode's `next`, as the host serves it.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct SelectOption {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub badge: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub confirmation: Option<SelectConfirmation>,
    #[serde(default)]
    pub next: bool,
}

/// The query an option picker's key carries; `None` for any other picker.
/// Keys are `options:<state>:<nonce>:<query>`.
pub(crate) fn query_of(args_query: &str) -> Option<&str> {
    let rest = args_query
        .strip_prefix(LOADING)
        .or_else(|| args_query.strip_prefix(READY))?;
    Some(rest.split_once(':').map_or("", |(_, query)| query))
}

/// Whether an option picker is still waiting for its rows.
pub(crate) fn is_loading(args_query: &str) -> bool {
    args_query.starts_with(LOADING)
}

/// An option picker's title: the command line its rows complete.
pub(crate) fn title(command: &str, args_query: &str) -> Option<String> {
    let query = query_of(args_query)?;
    Some(if query.is_empty() {
        format!("/{command}")
    } else {
        format!("/{command} {query}")
    })
}

fn loading_key(query: &str) -> String {
    format!("{LOADING}{}:{query}", uuid::Uuid::new_v4())
}

/// An empty option picker for `command`, waiting for its bare options.
pub(crate) fn loading_picker(
    command: &str,
    previous_palette: Option<PaletteSnapshot>,
) -> ActiveModal {
    ActiveModal::ArgPicker {
        command: command.to_string(),
        args_query: loading_key(""),
        items: vec![],
        original_items: vec![],
        state: PickerState::input_active(),
        previous_palette,
        window: ModalWindowState::new(),
    }
}

/// Rows for the picker, and the active row it starts on. A badge follows the
/// label, the active row says "(current)", a confirmation's description is the
/// detail, and a `next` row's insert text ends in a space, the picker's mark
/// for "one more argument".
pub(crate) fn option_items(options: Vec<SelectOption>) -> (Vec<ArgItem>, Option<usize>) {
    let active = options.iter().position(|option| option.active);
    let items = options
        .into_iter()
        .map(|option| {
            let mut display = option.label;
            if let Some(badge) = option.badge.filter(|badge| !badge.trim().is_empty()) {
                display = format!("{display} · {badge}");
            }
            if option.active {
                display.push_str(" (current)");
            }
            let description = option
                .confirmation
                .map(|confirmation| confirmation.description)
                .filter(|text| !text.trim().is_empty())
                .or(option.detail)
                .unwrap_or_default();
            let insert_text = if option.next {
                format!("{} ", option.id)
            } else {
                option.id.clone()
            };
            ArgItem {
                display,
                match_text: option.id,
                insert_text,
                description,
            }
        })
        .collect();
    (items, active)
}

/// Load `command`'s options at `query` into the agent's option picker for it,
/// opening one when none is showing.
pub(crate) fn load(agent: &mut AgentView, command: &str, query: &str) -> Vec<Effect> {
    let Some(session_id) = agent.session.session_id.clone() else {
        agent.show_toast("No active session");
        return vec![];
    };
    let key = loading_key(query);
    match agent.active_modal.as_mut() {
        Some(ActiveModal::ArgPicker {
            command: open,
            args_query,
            items,
            original_items,
            state,
            ..
        }) if open.as_str() == command && query_of(args_query).is_some() => {
            args_query.clone_from(&key);
            items.clear();
            original_items.clear();
            *state = PickerState::input_active();
        }
        _ => {
            agent.active_modal = Some(loading_picker(command, None));
            if let Some(ActiveModal::ArgPicker { args_query, .. }) = agent.active_modal.as_mut() {
                args_query.clone_from(&key);
            }
        }
    }
    vec![Effect::FetchCommandOptions {
        agent_id: agent.session.id,
        session_id,
        command: command.to_string(),
        query: query.to_string(),
        key,
    }]
}

/// `Action::LoadCommandOptions` for the active agent.
pub(super) fn open(app: &mut AppView, command: &str, query: &str) -> Vec<Effect> {
    let mut effects = vec![];
    with_active_agent(app, |agent| effects = load(agent, command, query));
    effects
}

/// A reply for the picker still waiting under `key`. An empty bare list runs
/// the bare command instead (a draft-preserving send, which never reopens
/// the picker); an empty `next` list says so; a failure closes the picker.
pub(super) fn loaded(
    app: &mut AppView,
    agent_id: crate::app::agent::AgentId,
    session_id: &agent_client_protocol::SessionId,
    command: &str,
    key: &str,
    result: Result<Vec<SelectOption>, String>,
) -> Vec<Effect> {
    let Some(agent) = app.agents.get_mut(&agent_id) else {
        return vec![];
    };
    if agent.session.session_id.as_ref() != Some(session_id) {
        return vec![];
    }
    let Some(ActiveModal::ArgPicker {
        command: open,
        args_query,
        items,
        original_items,
        state,
        ..
    }) = agent.active_modal.as_mut()
    else {
        return vec![];
    };
    if open.as_str() != command || args_query.as_str() != key {
        return vec![];
    }
    let bare = query_of(key).is_some_and(str::is_empty);
    match result {
        Err(error) => {
            agent.active_modal = None;
            agent.show_toast(&format!("Could not load /{command} options: {error}"));
            vec![]
        }
        Ok(options) if options.is_empty() && bare => {
            agent.active_modal = None;
            super::router::dispatch(
                Action::SendSlashCommandPreservingDraft(format!("/{command}")),
                app,
            )
        }
        Ok(options) => {
            *args_query = key.replacen(LOADING, READY, 1);
            let (rows, active) = option_items(options);
            // Keep what was typed while the rows loaded.
            let typed = state.query().to_lowercase();
            *items = rows
                .iter()
                .filter(|item| {
                    typed.is_empty()
                        || item.match_text.to_lowercase().contains(&typed)
                        || item.display.to_lowercase().contains(&typed)
                        || item.description.to_lowercase().contains(&typed)
                })
                .cloned()
                .collect();
            *original_items = rows;
            state.selected = active
                .filter(|_| typed.is_empty())
                .unwrap_or(0)
                .min(items.len().saturating_sub(1));
            vec![]
        }
    }
}
