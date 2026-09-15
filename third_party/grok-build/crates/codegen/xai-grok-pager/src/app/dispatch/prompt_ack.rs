//! Local recovery never drains a queue or resends the uncertain prompt.
use crate::app::actions::Effect;
use crate::app::agent_view::{AgentView, PromptInputMode, PromptMode};
use crate::app::app_view::AppView;
use crate::app::prompt_ack::{PromptAckDeadlines, PromptAckOutcome};
use crate::scrollback::block::RenderBlock;
use std::time::Instant;

pub(crate) fn reconcile_overdue_prompt_acks(
    app: &mut AppView,
    deadlines: &PromptAckDeadlines,
) -> Option<Vec<Effect>> {
    reconcile_at(app, deadlines, Instant::now())
}
pub(super) fn reconcile_at(
    app: &mut AppView,
    deadlines: &PromptAckDeadlines,
    now: Instant,
) -> Option<Vec<Effect>> {
    if app.reconnect_pending {
        return None;
    }
    let mut changed = false;
    let mut effects = Vec::new();
    for agent in app.agents.values_mut() {
        changed |= poll(agent, deadlines, now, &mut effects);
        for child in agent.subagent_views.values_mut() {
            changed |= poll(child, deadlines, now, &mut effects);
        }
    }
    changed.then_some(effects)
}
fn poll(
    agent: &mut AgentView,
    deadlines: &PromptAckDeadlines,
    now: Instant,
    effects: &mut Vec<Effect>,
) -> bool {
    let Some(watch) = agent.prompt_ack.as_mut() else {
        return false;
    };
    if agent.session.current_prompt_id.as_deref() != Some(watch.prompt_id())
        || !(agent.session.state.is_turn_running() || agent.session.state.is_cancelling())
    {
        agent.prompt_ack = None;
        return false;
    }
    match watch.poll(now, deadlines) {
        PromptAckOutcome::Waiting => false,
        PromptAckOutcome::SoftNotice => {
            agent.show_toast("Waiting for the agent to acknowledge this prompt…");
            true
        }
        PromptAckOutcome::Expired => {
            let id = watch.prompt_id().to_owned();
            agent.prompt_ack = None;
            recover(agent, &id, deadlines);
            if let Some(session_id) = agent.session.session_id.clone() {
                effects.push(Effect::CancelUnacknowledgedPrompt {
                    session_id,
                    prompt_id: id,
                });
            }
            true
        }
    }
}
fn recover(agent: &mut AgentView, id: &str, deadlines: &PromptAckDeadlines) {
    agent.note_rewound_prompt(id);
    let safe_composer = matches!(agent.prompt_mode, PromptMode::Normal)
        && matches!(agent.prompt_input_mode, PromptInputMode::Normal)
        && agent.prompt.images.is_empty()
        && agent.permission_queue.is_empty()
        && agent.plan_approval_view.is_none()
        && agent.question_view.is_none();
    let recovery = if safe_composer && let Some(stash) = agent.session.in_flight_prompt.take() {
        let empty = agent.prompt.text().is_empty();
        let text = if empty {
            stash.text.clone()
        } else {
            format!("{}\n\n{}", stash.text, agent.prompt.text())
        };
        agent.prompt.set_text(&text);
        agent.prompt.restore_chip_elements(&stash.chip_elements);
        agent.prompt.set_images(stash.images);
        agent.prompt.set_cursor(text.len());
        for entry in stash
            .combined_scrollback_entries
            .into_iter()
            .chain([stash.scrollback_entry])
        {
            if !agent.scrollback.is_committed(entry) {
                agent.scrollback.remove_entry(entry);
            }
        }
        if empty {
            "Your prompt is back in the input box."
        } else {
            "Your prompt was placed above your newer draft."
        }
    } else {
        "Your current input is unchanged; the original prompt remains in the conversation."
    };
    agent.session.finish_turn(&mut agent.scrollback);
    agent.mark_turn_finished();
    agent.activity_started_at = None;
    agent.last_activity = None;
    agent.pending_cancel_resend = None;
    agent.pending_turn_end_reconcile = None;
    agent.clear_send_now_expectation();
    agent.cancel_turn_view = None;
    agent.cancel_turn_buttons.clear();
    super::permissions::drain_permission_queue(agent);
    if let Some(question) = agent
        .question_view
        .as_ref()
        .filter(|q| q.local_kind.is_none())
    {
        let tool_id = question.tool_call_id.clone();
        agent.dismiss_resolved_interaction(&tool_id);
    }
    if let Some(mut plan) = agent.plan_approval_view.take() {
        plan.send_stale_cancel();
        agent.plan_next_comment_id = plan.next_comment_id;
        agent.prompt.restore(plan.stashed_prompt);
        agent.line_viewer = None;
    }
    if agent.bash_turn {
        agent.bash_turn = false;
        agent.scrollback.goto_bottom();
    }
    agent.scrollback.push_block(RenderBlock::system(format!(
        "No acknowledgment received within {}s. {recovery} Cancellation requested for this prompt only. It may already have run; check the conversation and running work before retrying. Nothing was resent.", deadlines.hard.as_secs()
    )));
    agent.show_toast("No prompt acknowledgment — review before retrying");
}

pub(super) fn cancel_complete(
    app: &mut AppView,
    sid: &agent_client_protocol::SessionId,
    id: &str,
    result: Result<(), String>,
) {
    let Err(error) = result else {
        return;
    };
    let report = |agent: &mut AgentView| {
        if agent.session.session_id.as_ref() == Some(sid) && agent.is_rewound_prompt(id) {
            agent
                .scrollback
                .push_block(RenderBlock::system(error.clone()));
            agent.show_toast("Cancellation unconfirmed — check running work before retrying");
        }
    };
    for agent in app.agents.values_mut() {
        report(agent);
        for child in agent.subagent_views.values_mut() {
            report(child);
        }
    }
}
