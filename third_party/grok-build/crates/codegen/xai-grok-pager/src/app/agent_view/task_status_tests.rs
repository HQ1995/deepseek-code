use super::{AgentPane, AgentView, AppRenderParams, BannerSlotParams, test_fixtures};
use crate::actions::ActionRegistry;
use crate::app::app_view::InputOutcome;
use crate::app::bundle::BundleState;
use crate::scrollback::render::ScratchBuffer;
use crossterm::event::{Event, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use std::time::Instant;
fn workflow_run(status: &str) -> crate::views::workflows::WorkflowRunSnapshot {
    crate::views::workflows::WorkflowRunSnapshot {
        run_id: "wf-gate".to_owned(),
        name: "gate".to_owned(),
        objective: "objective".to_owned(),
        status: status.to_owned(),
        management_available: true,
        builtin: false,
        phases: Vec::new(),
        current_phase: None,
        agents: Vec::new(),
        agent_budget: None,
        agents_used: 0,
        agents_reserved: 0,
        agents_remaining: None,
        agent_usage_incomplete: false,
        active_agents: 0,
        elapsed_ms: 0,
        received_at: Instant::now(),
        pause_message: None,
        result_summary: None,
    }
}
fn draw_frame(agent: &mut AgentView, registry: &ActionRegistry) -> Buffer {
    let area = Rect::new(0, 0, 80, 30);
    let bundle = BundleState::default();
    let mut buf = Buffer::empty(area);
    let mut scratch = ScratchBuffer::new();
    agent.draw(
        area,
        &mut buf,
        registry,
        &mut scratch,
        None,
        false,
        BannerSlotParams {
            height: 0,
            announcements: &[],
            hidden_ids: &std::collections::BTreeSet::new(),
            privacy_banner: false,
            mouse_pos: None,
            tip: None,
        },
        &bundle,
        false,
        false,
        &mut Vec::new(),
        AppRenderParams::default(),
    );
    buf
}
fn mouse_down(column: u16, row: u16) -> Event {
    Event::Mouse(MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column,
        row,
        modifiers: KeyModifiers::empty(),
    })
}
#[test]
fn paused_status_has_one_click_target_that_clears_when_terminal() {
    let _theme = crate::theme::cache::pin_theme();
    let registry = ActionRegistry::defaults();
    let mut agent = test_fixtures::make_agent();
    agent.last_terminal_size = (80, 30);
    agent.workflow_runs = vec![workflow_run("user_paused")];
    let _ = draw_frame(&mut agent, &registry);
    let rect = agent
        .hit_bg_status
        .rect
        .expect("paused workflow must arm one background status target");
    let outcome = agent.handle_input(&mouse_down(rect.x, rect.y), &registry);
    assert!(matches!(outcome, InputOutcome::Changed));
    assert!(agent.tasks.overlay.visible && agent.tasks.overlay.focused);
    assert_eq!(agent.active_pane, AgentPane::Tasks);
    let outcome = agent.handle_input(&mouse_down(rect.x, rect.y), &registry);
    assert!(matches!(outcome, InputOutcome::Changed));
    assert!(!agent.tasks.overlay.visible && !agent.tasks.overlay.focused);
    assert_eq!(agent.active_pane, AgentPane::Scrollback);
    agent.workflow_runs[0].status = "complete".to_owned();
    let _ = draw_frame(&mut agent, &registry);
    assert!(agent.hit_bg_status.rect.is_none());
}
/// DIVERGENCE(dscode): `x` on a running task arms a stop instead of killing
/// it; only the pending-action rail's second press fires the kill.
#[test]
fn tasks_pane_x_arms_a_two_press_stop() {
    use crate::app::actions::Action;
    let registry = ActionRegistry::defaults();
    let mut agent = test_fixtures::make_agent();
    test_fixtures::focus_running_bg_task(&mut agent);
    let x = Event::Key(crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Char('x'),
        KeyModifiers::NONE,
    ));
    match agent.handle_input(&x, &registry) {
        InputOutcome::ArmPending {
            action: Action::KillBgTask(task_id),
            label: Some("stop"),
            ttl,
            ..
        } => {
            assert_eq!(task_id, "task-1");
            assert_eq!(ttl, crate::views::tasks_pane::STOP_CONFIRM_WINDOW);
            assert_eq!(ttl, std::time::Duration::from_secs(3));
        }
        other => panic!("x must arm the stop, got {other:?}"),
    }
    // A finished task has nothing to stop: `x` arms nothing.
    agent.session.bg_tasks.get_mut("task-1").unwrap().status =
        crate::app::agent::BgTaskStatus::Done;
    assert!(!matches!(
        agent.handle_input(&x, &registry),
        InputOutcome::ArmPending { .. } | InputOutcome::Action(Action::KillBgTask(_))
    ));
}
/// The `[✗]` button's twin: the first click arms (and says so), a second
/// click on the same row inside the window confirms, and a click on another
/// row or after the window re-arms instead.
#[test]
fn tasks_pane_stop_click_needs_a_second_click_within_the_window() {
    use crate::views::tasks_pane::{STOP_CONFIRM_WINDOW, TaskEntryId, TasksPane};
    let mut pane = TasksPane::new();
    let a = TaskEntryId::BgTask("a".into());
    let b = TaskEntryId::BgTask("b".into());
    let t0 = Instant::now();
    assert!(!pane.confirm_stop_click(&a, t0), "first click only arms");
    assert!(pane.confirm_stop_click(&a, t0 + std::time::Duration::from_secs(2)));
    assert!(
        !pane.confirm_stop_click(&a, t0 + std::time::Duration::from_secs(2)),
        "a confirm consumes the arm"
    );
    assert!(!pane.confirm_stop_click(&b, t0), "another row re-arms");
    assert!(
        !pane.confirm_stop_click(&a, t0),
        "and disarms the first row"
    );
    assert!(
        !pane.confirm_stop_click(&a, t0 + STOP_CONFIRM_WINDOW),
        "a click after the window re-arms"
    );
}
/// A single `[✗]` click only arms and says so; the second click on the same
/// row stops the task.
#[test]
fn tasks_pane_kill_button_needs_two_clicks() {
    use crate::app::actions::Action;
    let _theme = crate::theme::cache::pin_theme();
    let registry = ActionRegistry::defaults();
    let mut agent = test_fixtures::make_agent();
    agent.last_terminal_size = (80, 30);
    test_fixtures::focus_running_bg_task(&mut agent);
    let _ = draw_frame(&mut agent, &registry);
    let (_, rect) = agent
        .tasks
        .kill_button_rects
        .first()
        .cloned()
        .expect("a running task row paints a kill button");
    let click = mouse_down(rect.x, rect.y);
    assert!(matches!(
        agent.handle_input(&click, &registry),
        InputOutcome::Changed
    ));
    let toast = agent.toast.clone().map(|(msg, _)| msg);
    assert_eq!(toast.as_deref(), Some("Click \u{2717} again to stop"));
    assert!(matches!(
        agent.handle_input(&click, &registry),
        InputOutcome::Action(Action::KillBgTask(ref t)) if t == "task-1"
    ));
}
