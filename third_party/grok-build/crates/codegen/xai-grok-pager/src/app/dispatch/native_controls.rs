use super::ctx::get_active_agent_mut;
use crate::app::{
    actions::{Effect, TaskResult},
    agent_view::AgentView,
    app_view::AppView,
};
use crate::views::{
    modal::ActiveModal,
    native_controls::{NativeControlOutcome, NativeControlTarget, NativeControls},
};

pub(super) fn open(app: &mut AppView, target: NativeControlTarget) -> Vec<Effect> {
    let Some(agent) = get_active_agent_mut(app) else {
        return vec![];
    };
    if agent.session.session_id.is_none() {
        agent.show_toast("Open a session first.");
        return vec![];
    }
    let state = NativeControls::new(target);
    let request = state.refresh();
    agent.active_modal = Some(ActiveModal::NativeControls {
        state: Box::new(state),
    });
    fetch(agent, request)
}

fn fetch(agent: &mut AgentView, request: NativeControlOutcome) -> Vec<Effect> {
    let NativeControlOutcome::Request { method, mut params } = request else {
        return vec![];
    };
    let Some(session_id) = agent.session.session_id.clone() else {
        return vec![];
    };
    let Some(ActiveModal::NativeControls { state }) = agent.active_modal.as_mut() else {
        return vec![];
    };
    if state.busy {
        return vec![];
    }
    state.busy = true;
    state.nonce = uuid::Uuid::new_v4().to_string();
    params["sessionId"] = serde_json::json!(session_id.0.to_string());
    vec![Effect::FetchNativeControls {
        agent_id: agent.session.id,
        session_id,
        nonce: state.nonce.clone(),
        method,
        params,
    }]
}

pub(super) fn request(
    app: &mut AppView,
    method: &'static str,
    params: serde_json::Value,
) -> Vec<Effect> {
    let Some(agent) = get_active_agent_mut(app) else {
        return vec![];
    };
    fetch(agent, NativeControlOutcome::Request { method, params })
}

pub(super) fn result(app: &mut AppView, result: TaskResult) -> Vec<Effect> {
    match result {
        TaskResult::NativeControlsLoaded {
            agent_id,
            session_id,
            nonce,
            mut result,
        } => {
            let Some(agent) = app.agents.get_mut(&agent_id) else {
                return vec![];
            };
            if agent.session.session_id.as_ref() != Some(&session_id) {
                return vec![];
            }
            let Some(ActiveModal::NativeControls { state }) = agent.active_modal.as_mut() else {
                return vec![];
            };
            if state.nonce != nonce {
                return vec![];
            }
            let document = result.as_mut().ok().and_then(|list| list.document.take());
            let is_presets = matches!(state.target, NativeControlTarget::Presets);
            state.loaded(result);
            if let Some(document) = document {
                if let Some(path) = document.edit_path {
                    if app.pending_editor.is_none() {
                        app.pending_editor = Some(
                            crate::app::external_editor::PendingEditorRequest::ConfigFile {
                                path,
                                refresh_agents_modal: None,
                            },
                        );
                    }
                } else {
                    agent.active_modal = None;
                    agent.install_block_viewer(
                        crate::views::block_viewer::BlockViewerPane::for_plain_text(
                            &format!("Preset: {}", document.id),
                            &document.content,
                        ),
                    );
                }
            }
            if is_presets {
                return vec![Effect::FetchBundleStatus];
            }
            vec![Effect::WaitNativeControls {
                agent_id,
                session_id,
                nonce,
            }]
        }
        TaskResult::NativeControlsPoll {
            agent_id,
            session_id,
            nonce,
        } => {
            let Some(agent) = app.agents.get_mut(&agent_id) else {
                return vec![];
            };
            if agent.session.session_id.as_ref() != Some(&session_id) {
                return vec![];
            }
            let Some(ActiveModal::NativeControls { state }) = agent.active_modal.as_ref() else {
                return vec![];
            };
            if state.nonce != nonce {
                return vec![];
            }
            if state.can_poll() {
                let request = state.refresh();
                fetch(agent, request)
            } else {
                vec![Effect::WaitNativeControls {
                    agent_id,
                    session_id,
                    nonce,
                }]
            }
        }
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{
        agent::{AgentId, ScheduledTaskInfo},
        app_view::tests::test_app_with_agent,
    };
    use crate::views::native_controls::NativeControlList;

    #[test]
    fn native_controls_drop_closed_replaced_and_foreign_session_responses() {
        let mut app = test_app_with_agent();
        let id = AgentId(0);
        for stale in ["closed", "replaced", "session"] {
            let effects = open(&mut app, NativeControlTarget::Reminders);
            let Effect::FetchNativeControls {
                agent_id,
                session_id,
                nonce,
                ..
            } = &effects[0]
            else {
                panic!("expected fetch")
            };
            let response = TaskResult::NativeControlsLoaded {
                agent_id: *agent_id,
                session_id: session_id.clone(),
                nonce: nonce.clone(),
                result: Ok(NativeControlList {
                    document: None,
                    title: "stale result".into(),
                    items: vec![],
                }),
            };
            let agent = app.agents.get_mut(&id).unwrap();
            match stale {
                "closed" => agent.active_modal = None,
                "replaced" => {
                    agent.active_modal = Some(ActiveModal::NativeControls {
                        state: Box::new(NativeControls::new(NativeControlTarget::Reminders)),
                    })
                }
                _ => agent.session.session_id = Some("another-session".into()),
            }
            assert!(result(&mut app, response).is_empty());
            if let Some(ActiveModal::NativeControls { state }) = &app.agents[&id].active_modal {
                assert_ne!(state.title, "stale result");
            }
        }
    }

    #[test]
    fn native_reminder_cancel_failure_keeps_row_until_success() {
        let mut app = test_app_with_agent();
        let id = AgentId(0);
        let agent = app.agents.get_mut(&id).unwrap();
        let session_id = agent.session.session_id.clone().unwrap();
        agent.session.scheduled_tasks.insert(
            "reminder".into(),
            ScheduledTaskInfo {
                task_id: "reminder".into(),
                prompt: "check".into(),
                human_schedule: "once".into(),
                created_at: std::time::Instant::now(),
                next_fire_at: None,
                tag: "reminder".into(),
                last_subagent_id: None,
            },
        );
        for outcome in [Err("offline".into()), Ok(())] {
            let failed = outcome.is_err();
            super::super::task_result::dispatch_task_result(
                TaskResult::ScheduledTaskDeleted {
                    session_id: session_id.clone(),
                    task_id: "reminder".into(),
                    result: outcome,
                },
                &mut app,
            );
            assert_eq!(
                app.agents[&id]
                    .session
                    .scheduled_tasks
                    .contains_key("reminder"),
                failed
            );
        }
    }
}
