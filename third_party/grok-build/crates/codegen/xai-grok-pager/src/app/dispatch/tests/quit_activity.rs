//! DIVERGENCE(dscode): the quit guard, from the first Ctrl+C through
//! `x.ai/client/activity` to the text after "press again to quit".
use super::*;
use crate::app::app_view::{InputOutcome, PendingAction};
use crate::app::dispatch::quit_activity::{
    ActivityCount, ClientActivity, QUIT_ACTIVITY_TTL, quit_detail,
};
use crate::input::key::KeyShortcut;
use crate::views::shortcuts_bar::PendingHint;
use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use std::time::Duration;

fn count(kind: &str, count: u64, one: &str, other: &str, labels: &[&str]) -> ActivityCount {
    ActivityCount {
        kind: kind.into(),
        count,
        one: one.into(),
        other: other.into(),
        labels: labels.iter().map(|label| label.to_string()).collect(),
    }
}

fn job(n: u64, labels: &[&str]) -> ActivityCount {
    count("job", n, "job", "jobs", labels)
}

fn reminder(n: u64) -> ActivityCount {
    count("schedule", n, "reminder", "reminders", &[])
}

fn activity(stops: Vec<ActivityCount>, waits: Vec<ActivityCount>) -> ClientActivity {
    ClientActivity { stops, waits }
}

fn ctrl_c() -> Event {
    Event::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL))
}

fn fetches(app: &AppView) -> Vec<u64> {
    app.pending_effects
        .iter()
        .filter_map(|effect| match effect {
            Effect::FetchClientActivity { key } => Some(*key),
            _ => None,
        })
        .collect()
}

/// An idle agent view with its quit armed by one Ctrl+C; returns the key it asked under.
fn armed_app() -> (AppView, u64) {
    let mut app = test_app_with_agent();
    let outcome = app.handle_input(&ctrl_c());
    assert!(matches!(outcome, InputOutcome::Changed), "{outcome:?}");
    let keys = fetches(&app);
    assert_eq!(keys.len(), 1, "one quit arm asks once");
    (app, keys[0])
}

fn reply(app: &mut AppView, key: u64, result: Result<ClientActivity, String>) {
    let effects = dispatch_task_result(TaskResult::ClientActivityLoaded { key, result }, app);
    assert!(effects.is_empty());
}

#[test]
fn quit_activity_lists_the_work_a_quit_stops() {
    let detail = quit_detail(&activity(
        vec![
            count("turn", 1, "turn", "turns", &[]),
            job(2, &["build", "test"]),
        ],
        vec![],
    ));
    assert_eq!(
        detail.as_deref(),
        Some("stops 1 turn, 2 jobs (build, test)")
    );
}

#[test]
fn quit_activity_waits_agree_with_their_count() {
    assert_eq!(
        quit_detail(&activity(vec![], vec![reminder(1)])).as_deref(),
        Some("1 reminder waits for the next open")
    );
    assert_eq!(
        quit_detail(&activity(vec![], vec![reminder(2)])).as_deref(),
        Some("2 reminders wait for the next open")
    );
    assert_eq!(
        quit_detail(&activity(
            vec![],
            vec![reminder(1), count("hook", 1, "hook", "hooks", &[])]
        ))
        .as_deref(),
        Some("1 reminder, 1 hook wait for the next open")
    );
}

#[test]
fn quit_activity_joins_what_stops_and_what_waits() {
    let detail = quit_detail(&activity(
        vec![count("turn", 1, "turn", "turns", &[]), job(2, &[])],
        vec![reminder(1)],
    ));
    assert_eq!(
        detail.as_deref(),
        Some("stops 1 turn, 2 jobs; 1 reminder waits for the next open")
    );
}

#[test]
fn quit_activity_shows_at_most_two_one_line_labels() {
    let long = "x".repeat(80);
    let detail = quit_detail(&activity(
        vec![
            job(3, &["build\n  all", "  ", "test", "lint"]),
            count("subagent", 1, "subagent", "subagents", &[&long]),
        ],
        vec![],
    ))
    .unwrap();
    assert_eq!(
        detail,
        format!(
            "stops 3 jobs (build all, test, \u{2026}), 1 subagent ({}\u{2026})",
            "x".repeat(47)
        )
    );
    // Exactly two labels need no ellipsis.
    assert_eq!(
        quit_detail(&activity(vec![job(2, &["a", "b"])], vec![])).as_deref(),
        Some("stops 2 jobs (a, b)")
    );
}

#[test]
fn quit_activity_count_picks_the_noun_and_falls_back_to_the_kind() {
    assert_eq!(
        quit_detail(&activity(vec![job(1, &[])], vec![])).as_deref(),
        Some("stops 1 job")
    );
    assert_eq!(
        quit_detail(&activity(vec![job(4, &[])], vec![])).as_deref(),
        Some("stops 4 jobs")
    );
    assert_eq!(
        quit_detail(&activity(
            vec![count("queued prompt", 2, "", "", &[])],
            vec![]
        ))
        .as_deref(),
        Some("stops 2 queued prompt")
    );
}

#[test]
fn quit_activity_with_nothing_to_report_keeps_todays_text() {
    assert_eq!(quit_detail(&ClientActivity::default()), None);
    assert_eq!(
        quit_detail(&activity(vec![job(0, &["idle"])], vec![reminder(0)])),
        None
    );
    let hint = |detail: Option<&str>| PendingHint {
        shortcut: KeyShortcut::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
        label: "quit",
        detail: detail.map(str::to_string),
    };
    assert_eq!(hint(None).text(), "press again to quit");
    assert_eq!(hint(Some("")).text(), "press again to quit");
    assert_eq!(
        hint(Some("stops 1 turn")).text(),
        "press again to quit \u{2014} stops 1 turn"
    );
}

#[test]
fn quit_activity_reads_partial_and_unknown_replies() {
    let empty: ClientActivity = serde_json::from_str("{}").unwrap();
    assert_eq!(empty, ClientActivity::default());
    let reply: ClientActivity = serde_json::from_str(
        r#"{"stops":[{"kind":"job","count":2,"one":"job","other":"jobs","extra":true}],"future":1}"#,
    )
    .unwrap();
    assert_eq!(reply.stops, vec![job(2, &[])]);
    assert!(serde_json::from_str::<ClientActivity>(r#"{"stops":[{"count":-1}]}"#).is_err());
}

#[test]
fn quit_activity_ctrl_c_arms_asks_once_and_the_second_press_quits() {
    let (mut app, key) = armed_app();
    let pending = app.pending_action.as_ref().unwrap();
    assert!(matches!(pending.action, Action::Quit));
    assert_eq!(pending.activity_key, Some(key));
    assert_eq!(pending.detail, None);
    // An event that leaves the arm in place does not ask again.
    let _ = app.handle_input(&Event::Resize(120, 40));
    assert_eq!(fetches(&app), vec![key]);
    // The second press quits without waiting for the answer.
    let outcome = app.handle_input(&ctrl_c());
    assert!(
        matches!(outcome, InputOutcome::Action(Action::Quit)),
        "{outcome:?}"
    );
    assert_eq!(fetches(&app), vec![key]);
    assert!(app.pending_action.is_none());
}

#[test]
fn quit_activity_reply_fills_the_arm_that_asked_and_keeps_it_up() {
    let (mut app, key) = armed_app();
    let armed_until = app.pending_action.as_ref().unwrap().expires_at;
    reply(
        &mut app,
        key,
        Ok(activity(vec![job(1, &["sleep 60"])], vec![reminder(1)])),
    );
    let pending = app.pending_action.as_ref().unwrap();
    assert_eq!(
        pending.detail.as_deref(),
        Some("stops 1 job (sleep 60); 1 reminder waits for the next open")
    );
    assert!(pending.expires_at > armed_until);
    assert!(pending.expires_at >= Instant::now() + QUIT_ACTIVITY_TTL - Duration::from_millis(200));
    // Still the same arm: the next Ctrl+C quits.
    let outcome = app.handle_input(&ctrl_c());
    assert!(
        matches!(outcome, InputOutcome::Action(Action::Quit)),
        "{outcome:?}"
    );
}

#[test]
fn quit_activity_ignores_stale_failed_and_empty_replies() {
    let (mut app, key) = armed_app();
    let armed_until = app.pending_action.as_ref().unwrap().expires_at;
    let work = || Ok(activity(vec![job(1, &[])], vec![]));
    reply(&mut app, key + 1_000_000, work());
    reply(&mut app, key, Err("method not found".into()));
    reply(&mut app, key, Ok(ClientActivity::default()));
    let pending = app.pending_action.as_ref().unwrap();
    assert_eq!(pending.detail, None);
    assert_eq!(pending.expires_at, armed_until);
    // An arm that expired while the leader answered stays expired.
    app.pending_action.as_mut().unwrap().expires_at = Instant::now() - Duration::from_millis(1);
    reply(&mut app, key, work());
    assert_eq!(app.pending_action.as_ref().unwrap().detail, None);
    // A reply after the arm is gone, or for another pending action, changes nothing.
    app.pending_action = None;
    reply(&mut app, key, work());
    assert!(app.pending_action.is_none());
    let mut other = PendingAction::new(
        Action::NewSession,
        KeyShortcut::new(KeyCode::Char('n'), KeyModifiers::CONTROL),
        "new session",
    );
    other.activity_key = Some(key);
    app.pending_action = Some(other);
    reply(&mut app, key, work());
    assert_eq!(app.pending_action.as_ref().unwrap().detail, None);
}
