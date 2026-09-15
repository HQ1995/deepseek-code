use super::*;
use crate::app::prompt_ack::{PromptAckDeadlines, PromptAckWatch};
use std::time::{Duration, Instant};

fn sent() -> (AppView, Instant, String) {
    let mut app = test_app_with_agent();
    dispatch(Action::SendPrompt("original".into()), &mut app);
    let now = Instant::now();
    let view = app.agents.get_mut(&AgentId(0)).unwrap();
    let id = view.session.current_prompt_id.clone().unwrap();
    assert!(view.prompt_ack.is_some(), "the actual send path must arm");
    view.prompt_ack = Some(PromptAckWatch::new(&id, now));
    (app, now, id)
}
fn poll(app: &mut AppView, now: Instant) -> Option<Vec<Effect>> {
    crate::app::dispatch::prompt_ack::reconcile_at(
        app,
        &PromptAckDeadlines {
            soft: Duration::from_secs(1),
            hard: Duration::from_secs(5),
        },
        now,
    )
}

#[test]
fn prompt_ack_timeout_restores_without_resending_and_drops_late_response() {
    let (mut app, now, old) = sent();
    assert!(poll(&mut app, now).is_none());
    assert!(
        poll(&mut app, now + Duration::from_secs(1))
            .unwrap()
            .is_empty()
    );
    assert!(poll(&mut app, now + Duration::from_secs(2)).is_none());
    let effects = poll(&mut app, now + Duration::from_secs(5)).unwrap();
    assert!(
        matches!(&effects[..], [Effect::CancelUnacknowledgedPrompt { prompt_id, .. }] if prompt_id == &old)
    );
    let view = &app.agents[&AgentId(0)];
    assert!(view.session.state.is_idle());
    assert_eq!(view.prompt.text(), "original");
    assert!(view.is_rewound_prompt(&old));
    assert!(view.pending_cancel_resend.is_none());
    assert!(poll(&mut app, now + Duration::from_secs(8)).is_none());
    dispatch(Action::SendPrompt("fresh".into()), &mut app);
    let fresh = app.agents[&AgentId(0)].session.current_prompt_id.clone();
    crate::app::dispatch::prompt::handle_prompt_response(
        &mut app,
        AgentId(0),
        Err("late failure".into()),
        None,
        Some(old),
    );
    assert_eq!(app.agents[&AgentId(0)].session.current_prompt_id, fresh);
    assert!(app.agents[&AgentId(0)].session.state.is_turn_running());
}

#[test]
fn prompt_ack_keeps_newer_text_and_never_drains_pending_input() {
    let (mut app, now, _) = sent();
    let view = app.agents.get_mut(&AgentId(0)).unwrap();
    view.prompt.set_text("newer draft");
    view.session.enqueue_prompt("queued".into());
    let effects = poll(&mut app, now + Duration::from_secs(5)).unwrap();
    assert_eq!(effects.len(), 1);
    let view = &app.agents[&AgentId(0)];
    assert_eq!(view.prompt.text(), "original\n\nnewer draft");
    assert_eq!(view.session.pending_prompts.len(), 1);
    assert!(view.session.state.is_idle());
}

#[test]
fn prompt_ack_preserves_new_images_and_original_transcript() {
    let (mut app, now, _) = sent();
    let view = app.agents.get_mut(&AgentId(0)).unwrap();
    let original = view
        .session
        .in_flight_prompt
        .as_ref()
        .unwrap()
        .scrollback_entry;
    view.prompt.set_text("image draft");
    view.prompt
        .insert_image(crate::prompt_images::PastedImage {
            element_id: xai_ratatui_textarea::ElementId::from_raw(0),
            display_number: 0,
            mime_type: "image/png".into(),
            dimensions: Some((8, 8)),
            byte_len: 1,
            encoded_bytes: Some(vec![1].into()),
            source_path: None,
            staged_temp_path: None,
            session_image_path: None,
            preview: crate::prompt_images::PromptImagePreview::default(),
        })
        .unwrap();
    let draft = view.prompt.text().to_string();
    poll(&mut app, now + Duration::from_secs(5));
    let view = &app.agents[&AgentId(0)];
    assert_eq!(view.prompt.text(), draft);
    assert_eq!(view.prompt.images.len(), 1);
    assert!(view.scrollback.index_of_id(original).is_some());
}

#[test]
fn prompt_ack_matching_receipt_and_reconnect_leave_the_turn_alone() {
    let (mut app, now, id) = sent();
    app.reconnect_pending = true;
    assert!(poll(&mut app, now + Duration::from_secs(6)).is_none());
    app.reconnect_pending = false;
    let view = app.agents.get_mut(&AgentId(0)).unwrap();
    view.ack_prompt_if_named(Some("unrelated"));
    assert!(view.prompt_ack.is_some());
    view.ack_prompt_if_named(Some(&id));
    assert!(poll(&mut app, now + Duration::from_secs(6)).is_none());
    assert!(app.agents[&AgentId(0)].session.state.is_turn_running());
}

#[test]
fn prompt_ack_stale_watch_and_new_boundary_do_not_cancel_new_work() {
    let (mut app, now, _) = sent();
    let view = app.agents.get_mut(&AgentId(0)).unwrap();
    view.session.current_prompt_id = Some("different".into());
    assert!(poll(&mut app, now + Duration::from_secs(6)).is_none());
    let view = app.agents.get_mut(&AgentId(0)).unwrap();
    assert!(view.prompt_ack.is_none());
    view.arm_prompt_ack("different");
    view.start_turn_boundary(Some("new"));
    assert!(view.prompt_ack.is_none());
}

#[test]
fn prompt_ack_preserves_queue_edit_and_committed_scrollback() {
    let (mut app, now, _) = sent();
    let view = app.agents.get_mut(&AgentId(0)).unwrap();
    let entry = view
        .session
        .in_flight_prompt
        .as_ref()
        .unwrap()
        .scrollback_entry;
    let idx = view.scrollback.index_of_id(entry).unwrap();
    view.scrollback.mark_committed(idx);
    view.prompt_mode = crate::app::agent_view::PromptMode::EditingQueued {
        id: 7,
        original: "queued".into(),
        server_id: Some("other".into()),
        kind: crate::app::agent::QueueEntryKind::Prompt,
    };
    view.prompt.set_text("edited queue row");
    poll(&mut app, now + Duration::from_secs(5));
    let view = &app.agents[&AgentId(0)];
    assert_eq!(view.prompt.text(), "edited queue row");
    assert!(matches!(
        view.prompt_mode,
        crate::app::agent_view::PromptMode::EditingQueued { id: 7, .. }
    ));
    assert!(view.scrollback.index_of_id(entry).is_some());
}

#[test]
fn prompt_ack_cancelling_and_hidden_child_are_polled_without_touching_parent() {
    let (mut child_app, now, id) = sent();
    let mut child = child_app.agents.swap_remove(&AgentId(0)).unwrap();
    child.session.session_id = Some(acp::SessionId::new("child"));
    child.session.state = AgentState::TurnCancelling;
    let mut app = test_app_with_agent();
    app.agents
        .get_mut(&AgentId(0))
        .unwrap()
        .insert_subagent_view("child".into(), Box::new(child));
    let effects = poll(&mut app, now + Duration::from_secs(5)).unwrap();
    assert!(
        matches!(&effects[..], [Effect::CancelUnacknowledgedPrompt { session_id, prompt_id }] if session_id.0.as_ref() == "child" && prompt_id == &id)
    );
    let parent = &app.agents[&AgentId(0)];
    assert!(parent.prompt.text().is_empty());
    assert_eq!(parent.subagent_views["child"].prompt.text(), "original");
    assert!(parent.subagent_views["child"].session.state.is_idle());
}
