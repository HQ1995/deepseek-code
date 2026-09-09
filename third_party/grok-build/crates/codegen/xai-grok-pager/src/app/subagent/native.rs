//! DSH child transcripts use the owning leader's persistence and native cursors.
use crate::acp::meta::NotificationMeta;
use crate::app::actions::Effect;
use crate::app::agent_view::AgentView;
use crate::app::app_view::AppView;
use agent_client_protocol as acp;
use serde::Deserialize;

#[derive(Debug, Clone, Default)]
pub(crate) struct NativeChild {
    pub attempt_id: String,
    pub next_seq: usize,
    pub notified_seq: usize,
    pub loading: bool,
    pub nonce: u64,
    pub durable: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBatch {
    pub(crate) next_seq: usize,
    pub(crate) total_seq: usize,
    pub(crate) entries: Vec<HistoryEntry>,
    pub(crate) durable: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryEntry {
    update: Option<acp::SessionUpdate>,
    meta: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    turn_ended: bool,
}

pub(crate) fn request_history(parent: &mut AgentView, child_id: &str) {
    if parent.active_subagent.as_deref() != Some(child_id) {
        return;
    }
    let Some(session_id) = parent.session.session_id.clone() else {
        return;
    };
    let Some(native) = parent
        .subagent_sessions
        .get_mut(child_id)
        .and_then(|info| info.native.as_mut())
    else {
        return;
    };
    if native.loading {
        return;
    }
    native.loading = true;
    native.nonce = native.nonce.wrapping_add(1);
    parent.pending_effects.push(Effect::FetchChildHistory {
        agent_id: parent.session.id,
        session_id,
        child_id: child_id.to_owned(),
        after: native.next_seq,
        nonce: native.nonce,
    });
}

pub(crate) fn history_changed(notif: &acp::ExtNotification, app: &mut AppView) -> bool {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Changed {
        session_id: String,
        child_session_id: String,
        next_seq: usize,
    }
    let Ok(changed) = serde_json::from_str::<Changed>(notif.params.get()) else {
        return false;
    };
    let Some(parent) = app.agents.values_mut().find(|parent| {
        parent
            .session
            .session_id
            .as_ref()
            .is_some_and(|id| id.0.as_ref() == changed.session_id)
    }) else {
        return false;
    };
    let Some(native) = parent
        .subagent_sessions
        .get_mut(&changed.child_session_id)
        .and_then(|info| info.native.as_mut())
    else {
        return false;
    };
    native.notified_seq = native.notified_seq.max(changed.next_seq);
    if native.notified_seq > native.next_seq || !native.durable {
        native.durable = false;
        request_history(parent, &changed.child_session_id);
    }
    false
}

pub(crate) fn apply_history(
    parent: &mut AgentView,
    child_id: &str,
    after: usize,
    nonce: u64,
    result: Result<HistoryBatch, String>,
) {
    let Some(native) = parent
        .subagent_sessions
        .get_mut(child_id)
        .and_then(|info| info.native.as_mut())
    else {
        return;
    };
    if native.nonce != nonce || !native.loading || native.next_seq != after {
        return;
    }
    native.loading = false;
    let batch = match result {
        Ok(batch)
            if batch.next_seq >= after
                && batch.next_seq <= batch.total_seq
                && (batch.next_seq > after || batch.next_seq == batch.total_seq) =>
        {
            batch
        }
        result => {
            let error = result
                .err()
                .unwrap_or_else(|| "Invalid child history cursor".into());
            if let Some(child) = parent.subagent_views.get_mut(child_id) {
                child
                    .scrollback
                    .push_block(crate::scrollback::block::RenderBlock::system(format!(
                        "Could not load subagent history: {error}. Reopen to retry."
                    )));
            }
            return;
        }
    };
    native.next_seq = batch.next_seq;
    native.notified_seq = native.notified_seq.max(batch.total_seq);
    native.durable = batch.durable && native.next_seq >= native.notified_seq;
    let more = native.next_seq < native.notified_seq;
    if let Some(child) = parent.subagent_views.get_mut(child_id) {
        if after == 0 {
            drop(child.take_replay_rebuilt_state());
            child.inline_media_cache = Default::default();
            child.inline_media_load_failed = Default::default();
        }
        child.scrollback.begin_batch();
        for entry in batch.entries {
            if let Some(update) = entry.update {
                if let acp::SessionUpdate::Plan(plan) = update {
                    child.todo.update_todos(
                        plan.entries
                            .into_iter()
                            .map(xai_grok_shell::tools::todo::todo_item_from_plan_entry)
                            .collect(),
                    );
                } else {
                    let meta = NotificationMeta::from_json(entry.meta.as_ref());
                    child
                        .session
                        .handle_update(update, &meta, &mut child.scrollback);
                }
            }
            if entry.turn_ended {
                super::finalize_finished_child_view(child, None);
            }
        }
        child.scrollback.end_batch();
        if parent
            .subagent_sessions
            .get(child_id)
            .is_some_and(|info| info.finished)
        {
            child.scrollback.finish_all_running();
        } else {
            // Replaying earlier turn/end records must not idle the current attempt.
            child.session.state = crate::app::agent::AgentState::TurnRunning;
        }
    }
    if more {
        request_history(parent, child_id);
    }
    evict(parent, child_id);
}

pub(crate) fn evict(parent: &mut AgentView, child_id: &str) -> bool {
    if parent.active_subagent.as_deref() == Some(child_id) {
        return false;
    }
    let Some(info) = parent.subagent_sessions.get_mut(child_id) else {
        return false;
    };
    let Some(native) = info.native.as_mut() else {
        return false;
    };
    if !info.finished || native.loading || !native.durable {
        return false;
    }
    native.next_seq = 0;
    native.nonce = native.nonce.wrapping_add(1);
    if let Some(child) = parent.subagent_views.get_mut(child_id) {
        drop(child.take_replay_rebuilt_state());
        child.inline_media_cache = Default::default();
        child.inline_media_load_failed = Default::default();
        crate::memory_release::request_release_after_draw_with("native-subagent-evict");
    }
    true
}
