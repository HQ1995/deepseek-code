//! First-ack deadlines, not model execution deadlines. Shared by TUI and headless.
use agent_client_protocol as acp;
use std::time::{Duration, Instant};
use xai_acp_lib::{AcpAgentTx, AcpClientMessageBox, acp_send};

pub(crate) const CANCEL_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug)]
pub(crate) struct PromptAckDeadlines {
    pub(crate) soft: Duration,
    pub(crate) hard: Duration,
}
impl PromptAckDeadlines {
    pub(crate) fn from_process_env() -> Self {
        Self::from_env(
            std::env::var("DSCODE_PROMPT_ACK_TIMEOUT_SECS")
                .ok()
                .as_deref(),
        )
    }
    fn from_env(value: Option<&str>) -> Self {
        let seconds = match value.and_then(|v| v.trim().parse::<u64>().ok()) {
            None | Some(0) => 120,
            Some(n) => n.clamp(5, 3600),
        };
        let hard = Duration::from_secs(seconds);
        Self {
            soft: Duration::from_secs(10).min(hard / 2),
            hard,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct PromptAckWatch {
    prompt_id: String,
    armed_at: Instant,
    noticed: bool,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PromptAckOutcome {
    Waiting,
    SoftNotice,
    Expired,
}
impl PromptAckWatch {
    pub(crate) fn new(prompt_id: impl Into<String>, now: Instant) -> Self {
        Self {
            prompt_id: prompt_id.into(),
            armed_at: now,
            noticed: false,
        }
    }
    pub(crate) fn prompt_id(&self) -> &str {
        &self.prompt_id
    }
    pub(crate) fn hard_deadline(&self, deadlines: &PromptAckDeadlines) -> Instant {
        self.armed_at + deadlines.hard
    }
    pub(crate) fn poll(
        &mut self,
        now: Instant,
        deadlines: &PromptAckDeadlines,
    ) -> PromptAckOutcome {
        let waited = now.saturating_duration_since(self.armed_at);
        if waited >= deadlines.hard {
            return PromptAckOutcome::Expired;
        }
        if !self.noticed && waited >= deadlines.soft {
            self.noticed = true;
            return PromptAckOutcome::SoftNotice;
        }
        PromptAckOutcome::Waiting
    }
}

pub(crate) fn queue_changed_acks(
    changed: &crate::app::prompt_queue::QueueChanged,
    id: &str,
) -> bool {
    changed.running_prompt_id.as_deref() == Some(id)
        || changed.entries.iter().any(|entry| entry.id == id)
}

/// Replay, another session/prompt, and untagged ambient activity are not receipt.
pub(crate) fn message_acks(msg: &AcpClientMessageBox, sid: &acp::SessionId, id: &str) -> bool {
    match msg {
        AcpClientMessageBox::SessionNotification(notif) if notif.request.session_id == *sid => {
            let meta = crate::acp::meta::NotificationMeta::from_json(notif.request.meta.as_ref());
            !meta.is_replay && meta.prompt_id.as_deref() == Some(id)
        }
        AcpClientMessageBox::ExtNotification(notif)
            if notif.request.method.as_ref() == "x.ai/queue/changed" =>
        {
            serde_json::from_str::<crate::app::prompt_queue::QueueChanged>(
                notif.request.params.get(),
            )
            .is_ok_and(|changed| {
                changed.session_id == sid.0.as_ref() && queue_changed_acks(&changed, id)
            })
        }
        AcpClientMessageBox::ExtNotification(notif)
            if notif.request.method.as_ref() == "x.ai/session/prompt_complete" =>
        {
            serde_json::from_str::<serde_json::Value>(notif.request.params.get()).is_ok_and(|p| {
                p.get("sessionId").and_then(|v| v.as_str()) == Some(sid.0.as_ref())
                    && p.get("promptId").and_then(|v| v.as_str()) == Some(id)
            })
        }
        _ => false,
    }
}

/// Never fall back to legacy session/cancel: old bridges would clear unrelated input.
/// A successful request still does not prove that earlier effects never ran.
pub(crate) async fn cancel_unacknowledged(
    tx: &AcpAgentTx,
    sid: &acp::SessionId,
    id: &str,
) -> Result<(), String> {
    let params = serde_json::json!({ "sessionId": sid, "promptId": id });
    let request = acp::ExtRequest::new(
        "x.ai/session/cancel_prompt",
        serde_json::value::to_raw_value(&params)
            .expect("cancel prompt params")
            .into(),
    );
    let response = match tokio::time::timeout(CANCEL_TIMEOUT, acp_send(request, tx)).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(format!("Cancellation could not be confirmed: {error}")),
        Err(_) => return Err("Cancellation confirmation timed out.".into()),
    };
    let status = serde_json::from_str::<serde_json::Value>(response.0.get()).ok();
    match status
        .as_ref()
        .and_then(|v| v.get("status"))
        .and_then(|v| v.as_str())
    {
        Some("cancelled") => Ok(()),
        Some("cancelling") => {
            Err("Cancellation is pending; accepted native work may still finish.".into())
        }
        Some("already_submitted") => {
            Err("The prompt was already submitted and cannot be retracted independently.".into())
        }
        _ => Err("Cancellation could not be confirmed; check running work before retrying.".into()),
    }
}

#[cfg(test)]
#[path = "prompt_ack_tests.rs"]
mod tests;
