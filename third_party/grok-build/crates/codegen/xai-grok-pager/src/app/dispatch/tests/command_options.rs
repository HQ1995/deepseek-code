//! DIVERGENCE(dscode): host-served option pickers, from the palette pick or
//! bare Enter through `x.ai/commands/options` to the submitted command line.
use super::*;
use crate::app::app_view::InputOutcome;
use crate::app::dispatch::command_options::{
    SelectConfirmation, SelectOption, is_loading, option_items, query_of, title,
};
use crate::views::modal::{ActiveModal, PaletteCommand};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

const SESSION: &str = "test-session";

/// Advertise host commands as the bridge does: `/dsh` and `/preset` serve
/// options, `/goal` also runs immediately, `/compact` serves none.
fn app_with_host_commands() -> AppView {
    let mut app = test_app_with_agent();
    let id = AgentId(0);
    let models = app.agents[&id].session.models.clone();
    let meta = |value: serde_json::Value| value.as_object().cloned().unwrap();
    let agent = app.agents.get_mut(&id).unwrap();
    agent.session.session_id = Some(acp::SessionId::new(SESSION));
    agent.prompt.sync_acp_commands(
        &[
            acp::AvailableCommand::new("dsh", "Manage dsh plugins")
                .meta(meta(serde_json::json!({ "options": true }))),
            acp::AvailableCommand::new("goal", "Set or view the goal").meta(meta(
                serde_json::json!({ "options": true, "immediate": true, "attachments": true }),
            )),
            acp::AvailableCommand::new("preset", "Switch the active agent preset")
                .meta(meta(serde_json::json!({ "options": true }))),
            acp::AvailableCommand::new("compact", "Compact older conversation history"),
        ],
        None,
        &models,
    );
    app
}

fn option(id: &str, label: &str) -> SelectOption {
    SelectOption {
        id: id.into(),
        label: label.into(),
        badge: None,
        detail: None,
        active: false,
        confirmation: None,
        next: false,
    }
}

fn enter() -> KeyEvent {
    KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
}

fn press(app: &mut AppView, key: KeyEvent) -> InputOutcome {
    let registry = crate::actions::ActionRegistry::defaults();
    app.agents
        .get_mut(&AgentId(0))
        .unwrap()
        .handle_modal_key_with_registry(&key, &registry)
}

/// The fetch an effect list must be, and its loading key.
fn fetched(effects: &[Effect], command: &str, query: &str) -> String {
    let [
        Effect::FetchCommandOptions {
            command: fetched,
            query: asked,
            key,
            session_id,
            ..
        },
    ] = effects
    else {
        panic!("expected one options fetch, got {effects:?}")
    };
    assert_eq!((fetched.as_str(), asked.as_str()), (command, query));
    assert_eq!(session_id.0.as_ref(), SESSION);
    assert!(is_loading(key) && query_of(key) == Some(query), "{key}");
    key.clone()
}

fn reply(
    app: &mut AppView,
    command: &str,
    key: &str,
    result: Result<Vec<SelectOption>, String>,
) -> Vec<Effect> {
    dispatch(
        Action::TaskComplete(TaskResult::CommandOptionsLoaded {
            agent_id: AgentId(0),
            session_id: acp::SessionId::new(SESSION),
            command: command.into(),
            key: key.into(),
            result,
        }),
        app,
    )
}

/// The open picker: its command, key, row labels and selected row.
fn picker(app: &AppView) -> (String, String, Vec<String>, usize) {
    match &app.agents[&AgentId(0)].active_modal {
        Some(ActiveModal::ArgPicker {
            command,
            args_query,
            items,
            state,
            ..
        }) => (
            command.clone(),
            args_query.clone(),
            items.iter().map(|item| item.display.clone()).collect(),
            state.selected,
        ),
        _ => panic!("expected an open option picker"),
    }
}

#[test]
fn command_options_rows_carry_badges_the_active_row_confirmations_and_next() {
    let (items, active) = option_items(vec![
        SelectOption {
            badge: Some("custom".into()),
            detail: Some("Its detail".into()),
            ..option("mine", "Mine")
        },
        SelectOption {
            active: true,
            ..option("standard", "Standard mode")
        },
        SelectOption {
            detail: Some("hidden by the confirmation".into()),
            confirmation: Some(SelectConfirmation {
                title: "Remove it?".into(),
                description: "npm uninstalls it".into(),
            }),
            ..option("remove x", "Remove")
        },
        SelectOption {
            next: true,
            ..option("enable", "Turn a plugin on")
        },
    ]);
    assert_eq!(active, Some(1));
    let rows: Vec<_> = items
        .iter()
        .map(|item| {
            (
                item.display.as_str(),
                item.description.as_str(),
                item.insert_text.as_str(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("Mine · custom", "Its detail", "mine"),
            ("Standard mode (current)", "", "standard"),
            ("Remove", "npm uninstalls it", "remove x"),
            ("Turn a plugin on", "", "enable "),
        ]
    );
    // The wire shape: DSH's fields, dscode's `next`, unknown fields ignored.
    let parsed: SelectOption = serde_json::from_value(serde_json::json!({
        "id": "on", "label": "On", "active": true, "extra": 1,
        "confirmation": { "title": "Turn it on?", "description": "Asks first", "confirmLabel": "Turn on" },
    }))
    .unwrap();
    assert!(parsed.active && !parsed.next);
    assert_eq!(parsed.confirmation.unwrap().description, "Asks first");
    assert_eq!(
        title("dsh", "options:ready:n:enable").as_deref(),
        Some("/dsh enable")
    );
    assert_eq!(title("dsh", "loading:n"), None);
}

#[test]
fn command_options_bare_enter_opens_a_loading_picker_that_takes_only_its_reply() {
    let mut app = app_with_host_commands();
    let agent = app.agents.get_mut(&AgentId(0)).unwrap();
    agent.prompt.set_text("/dsh");
    let effects = dispatch(Action::SendPrompt("/dsh".into()), &mut app);
    let key = fetched(&effects, "dsh", "");
    assert_eq!(app.agents[&AgentId(0)].prompt.text(), "");
    let (command, args_query, rows, _) = picker(&app);
    assert_eq!(
        (command.as_str(), args_query.as_str()),
        ("dsh", key.as_str())
    );
    assert!(rows.is_empty());
    // A reply for another request, command or session changes nothing.
    reply(
        &mut app,
        "dsh",
        "options:loading:stale:",
        Ok(vec![option("x", "Stale")]),
    );
    reply(
        &mut app,
        "goal",
        &key,
        Ok(vec![option("x", "Wrong command")]),
    );
    assert!(picker(&app).2.is_empty());
    reply(
        &mut app,
        "dsh",
        &key,
        Ok(vec![
            option("plugins", "List plugins"),
            SelectOption {
                active: true,
                ..option("inspect", "Inspect a plugin")
            },
        ]),
    );
    let (_, args_query, rows, selected) = picker(&app);
    assert_eq!(rows, ["List plugins", "Inspect a plugin (current)"]);
    assert_eq!(selected, 1, "the active row is preselected");
    assert!(!is_loading(&args_query));
    // Enter submits `/dsh <id>` as a draft-preserving command line.
    assert!(matches!(
        press(&mut app, enter()),
        InputOutcome::Action(Action::SendSlashCommandPreservingDraft(text)) if text == "/dsh inspect"
    ));
    assert!(app.agents[&AgentId(0)].active_modal.is_none());
}

#[test]
fn command_options_palette_pick_opens_the_picker_and_next_rows_ask_again() {
    let mut app = app_with_host_commands();
    let agent = app.agents.get_mut(&AgentId(0)).unwrap();
    agent.prompt.set_text("keep this draft");
    let entries = crate::views::modal::filter_palette_entries(
        "dsh",
        agent.sharing_enabled,
        &agent.prompt.slash_controller,
    );
    let row = entries
        .iter()
        .position(
            |entry| matches!(&entry.command, PaletteCommand::SlashCommand(text) if text == "/dsh"),
        )
        .expect("palette row for /dsh");
    let mut state = crate::views::picker::PickerState::input_active();
    state.set_query("dsh");
    state.selected = row;
    agent.active_modal = Some(ActiveModal::CommandPalette {
        entries,
        state,
        window: crate::views::modal_window::ModalWindowState::new(),
    });
    let InputOutcome::Action(action) = press(&mut app, enter()) else {
        panic!("the palette pick must load options")
    };
    assert!(
        matches!(&action, Action::LoadCommandOptions { command, query } if command == "dsh" && query.is_empty())
    );
    assert!(matches!(
        &app.agents[&AgentId(0)].active_modal,
        Some(ActiveModal::ArgPicker {
            previous_palette: Some(_),
            ..
        })
    ));
    let key = fetched(&dispatch(action, &mut app), "dsh", "");
    reply(
        &mut app,
        "dsh",
        &key,
        Ok(vec![
            option("plugins", "List plugins"),
            SelectOption {
                next: true,
                ..option("enable", "Turn a plugin on")
            },
        ]),
    );
    press(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    let InputOutcome::Action(action) = press(&mut app, enter()) else {
        panic!("a next row must ask again")
    };
    assert!(
        matches!(&action, Action::LoadCommandOptions { command, query } if command == "dsh" && query == "enable")
    );
    let key = fetched(&dispatch(action, &mut app), "dsh", "enable");
    let (_, args_query, rows, _) = picker(&app);
    assert_eq!(args_query, key);
    assert!(rows.is_empty(), "the next step loads from empty");
    assert_eq!(title("dsh", &args_query).as_deref(), Some("/dsh enable"));
    // An empty next step stays open and says so; its rows arrive otherwise.
    reply(
        &mut app,
        "dsh",
        &key,
        Ok(vec![option("enable @acme/x", "X")]),
    );
    assert!(matches!(
        press(&mut app, enter()),
        InputOutcome::Action(Action::SendSlashCommandPreservingDraft(text)) if text == "/dsh enable @acme/x"
    ));
    assert_eq!(app.agents[&AgentId(0)].prompt.text(), "keep this draft");
}

#[test]
fn command_options_empty_bare_list_runs_the_bare_command_and_failures_close() {
    let mut app = app_with_host_commands();
    app.agents
        .get_mut(&AgentId(0))
        .unwrap()
        .prompt
        .set_text("/goal");
    let key = fetched(
        &dispatch(Action::SendPrompt("/goal".into()), &mut app),
        "goal",
        "",
    );
    // No goal: nothing to pick, so `/goal` itself runs, over its immediate rail.
    let effects = reply(&mut app, "goal", &key, Ok(vec![]));
    assert!(
        matches!(effects.as_slice(), [Effect::RunSessionCommand { method, .. }] if *method == "x.ai/commands/run"),
        "{effects:?}"
    );
    assert!(app.agents[&AgentId(0)].active_modal.is_none());

    app.agents
        .get_mut(&AgentId(0))
        .unwrap()
        .prompt
        .set_text("/dsh");
    let key = fetched(
        &dispatch(Action::SendPrompt("/dsh".into()), &mut app),
        "dsh",
        "",
    );
    assert!(reply(&mut app, "dsh", &key, Err("boom".into())).is_empty());
    let agent = &app.agents[&AgentId(0)];
    assert!(agent.active_modal.is_none());
}

#[test]
fn command_options_keep_typed_filters_and_leave_other_commands_alone() {
    let mut app = app_with_host_commands();
    app.agents
        .get_mut(&AgentId(0))
        .unwrap()
        .prompt
        .set_text("/dsh");
    let key = fetched(
        &dispatch(Action::SendPrompt("/dsh".into()), &mut app),
        "dsh",
        "",
    );
    for c in "rem".chars() {
        press(
            &mut app,
            KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE),
        );
    }
    reply(
        &mut app,
        "dsh",
        &key,
        Ok(vec![
            SelectOption {
                active: true,
                ..option("plugins", "List plugins")
            },
            option("remove", "Remove a plugin"),
        ]),
    );
    assert_eq!(picker(&app).2, ["Remove a plugin"]);
    assert_eq!(picker(&app).3, 0);

    // A command without options, and any bare command with arguments, runs.
    let mut app = app_with_host_commands();
    for text in ["/compact", "/dsh plugins"] {
        app.agents
            .get_mut(&AgentId(0))
            .unwrap()
            .prompt
            .set_text(text);
        let effects = dispatch(Action::SendPrompt(text.into()), &mut app);
        assert!(
            !effects
                .iter()
                .any(|effect| matches!(effect, Effect::FetchCommandOptions { .. })),
            "{text}: {effects:?}"
        );
        assert!(app.agents[&AgentId(0)].active_modal.is_none(), "{text}");
    }
}

#[test]
fn command_options_front_the_builtin_preset_only_while_the_host_serves_them() {
    let mut app = app_with_host_commands();
    app.agents
        .get_mut(&AgentId(0))
        .unwrap()
        .prompt
        .set_text("/preset");
    let key = fetched(
        &dispatch(Action::SendPrompt("/preset".into()), &mut app),
        "preset",
        "",
    );
    // A session whose preset cannot change in place offers nothing: the
    // bare builtin runs and opens the preset catalog.
    reply(&mut app, "preset", &key, Ok(vec![]));
    let agent = &app.agents[&AgentId(0)];
    assert!(agent.active_modal.is_none());
    assert!(agent.catalog.overlay.visible);

    let mut app = test_app_with_agent();
    app.agents
        .get_mut(&AgentId(0))
        .unwrap()
        .prompt
        .set_text("/preset");
    let effects = dispatch(Action::SendPrompt("/preset".into()), &mut app);
    assert!(effects.is_empty(), "{effects:?}");
    assert!(app.agents[&AgentId(0)].catalog.overlay.visible);
}
