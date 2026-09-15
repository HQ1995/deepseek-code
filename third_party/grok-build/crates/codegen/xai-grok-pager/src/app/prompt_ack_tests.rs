use super::*;

#[test]
fn deadlines_are_bounded_and_never_disabled() {
    for value in [None, Some(""), Some("0"), Some("oops"), Some("-1")] {
        assert_eq!(
            PromptAckDeadlines::from_env(value).hard,
            Duration::from_secs(120)
        );
    }
    assert_eq!(
        PromptAckDeadlines::from_env(Some("1")).hard,
        Duration::from_secs(5)
    );
    assert_eq!(
        PromptAckDeadlines::from_env(Some("999999")).hard,
        Duration::from_secs(3600)
    );
    assert_eq!(
        PromptAckDeadlines::from_env(Some(" 20 ")).soft,
        Duration::from_secs(10)
    );
}

#[test]
fn notice_fires_once_and_expiry_is_inclusive() {
    let now = Instant::now();
    let deadlines = PromptAckDeadlines::from_env(Some("5"));
    let mut watch = PromptAckWatch::new("mine", now);
    assert_eq!(watch.poll(now, &deadlines), PromptAckOutcome::Waiting);
    assert_eq!(
        watch.poll(now + deadlines.soft, &deadlines),
        PromptAckOutcome::SoftNotice
    );
    assert_eq!(
        watch.poll(now + deadlines.soft, &deadlines),
        PromptAckOutcome::Waiting
    );
    assert_eq!(
        watch.poll(watch.hard_deadline(&deadlines), &deadlines),
        PromptAckOutcome::Expired
    );
}

fn ext(method: &str, params: serde_json::Value) -> AcpClientMessageBox {
    let (tx, _) = tokio::sync::oneshot::channel();
    AcpClientMessageBox::ExtNotification(xai_acp_lib::AcpArgsBox {
        request: Box::new(acp::ExtNotification::new(
            method,
            serde_json::value::to_raw_value(&params).unwrap().into(),
        )),
        response_tx: tx,
    })
}
#[test]
fn queue_and_terminal_ack_require_exact_session_and_prompt() {
    let sid = acp::SessionId::new("one");
    for (method, params, expected) in [
        (
            "x.ai/queue/changed",
            serde_json::json!({"sessionId":"one", "entries":[], "runningPromptId":"mine"}),
            true,
        ),
        (
            "x.ai/queue/changed",
            serde_json::json!({"sessionId":"two", "entries":[], "runningPromptId":"mine"}),
            false,
        ),
        (
            "x.ai/queue/changed",
            serde_json::json!({"sessionId":"one", "entries":[], "runningPromptId":"other"}),
            false,
        ),
        (
            "x.ai/queue/changed",
            serde_json::json!({"sessionId":"one", "entries":[{"id":"mine", "version":0, "kind":"prompt", "text":"queued", "position":0}]}),
            true,
        ),
        (
            "x.ai/session/prompt_complete",
            serde_json::json!({"sessionId":"one", "promptId":"mine"}),
            true,
        ),
        (
            "x.ai/session/prompt_complete",
            serde_json::json!({"sessionId":"one", "promptId":"other"}),
            false,
        ),
        (
            "x.ai/models/update",
            serde_json::json!({"sessionId":"one", "promptId":"mine"}),
            false,
        ),
        (
            "x.ai/queue/changed",
            serde_json::json!({"broken":true}),
            false,
        ),
    ] {
        assert_eq!(message_acks(&ext(method, params), &sid, "mine"), expected);
    }
}
#[test]
fn only_live_named_updates_ack() {
    let sid = acp::SessionId::new("one");
    for (session, meta, expected) in [
        ("one", serde_json::json!({"promptId":"mine"}), true),
        ("two", serde_json::json!({"promptId":"mine"}), false),
        ("one", serde_json::json!({"promptId":"other"}), false),
        (
            "one",
            serde_json::json!({"promptId":"mine", "isReplay":true}),
            false,
        ),
        ("one", serde_json::json!({}), false),
    ] {
        let (tx, _) = tokio::sync::oneshot::channel();
        let msg = AcpClientMessageBox::SessionNotification(xai_acp_lib::AcpArgsBox {
            request: Box::new(
                acp::SessionNotification::new(
                    acp::SessionId::new(session),
                    acp::SessionUpdate::AgentMessageChunk(acp::ContentChunk::new(
                        acp::ContentBlock::Text(acp::TextContent::new("hi")),
                    )),
                )
                .meta(meta.as_object().cloned()),
            ),
            response_tx: tx,
        });
        assert_eq!(message_acks(&msg, &sid, "mine"), expected);
    }
}

#[tokio::test]
async fn cancellation_uses_only_the_named_request_and_never_legacy_fallback() {
    use xai_acp_lib::AcpAgentMessage;
    for reply in [
        Some("cancelled"),
        Some("cancelling"),
        Some("not_found"),
        Some("already_submitted"),
        None,
    ] {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            cancel_unacknowledged(&tx, &acp::SessionId::new("one"), "mine").await
        });
        let Some(AcpAgentMessage::ExtMethod(args)) = rx.recv().await else {
            panic!("expected a request, never session/cancel");
        };
        assert_eq!(args.request.method.as_ref(), "x.ai/session/cancel_prompt");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(args.request.params.get()).unwrap(),
            serde_json::json!({"sessionId":"one", "promptId":"mine"})
        );
        let response = match reply {
            Some(status) => Ok(acp::ExtResponse::new(
                serde_json::value::to_raw_value(&serde_json::json!({"status":status}))
                    .unwrap()
                    .into(),
            )),
            None => Err(acp::Error::new(-32601, "method not found")),
        };
        args.response_tx.send(response).unwrap();
        assert_eq!(task.await.unwrap().is_ok(), reply == Some("cancelled"));
        assert!(rx.try_recv().is_err(), "no fallback cancellation");
    }
}

#[tokio::test]
async fn cancellation_wait_is_bounded_when_peer_never_answers() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        cancel_unacknowledged(&tx, &acp::SessionId::new("one"), "mine").await
    });
    let held_request = rx.recv().await.unwrap();
    let result = tokio::time::timeout(CANCEL_TIMEOUT + Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
    assert!(result.unwrap_err().contains("timed out"));
    drop(held_request);
}
