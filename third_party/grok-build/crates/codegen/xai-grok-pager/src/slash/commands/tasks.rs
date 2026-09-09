//! `/tasks` -- list background tasks, subagents, and scheduled tasks.
//!
//! Minimal mode has no interactive `TasksPane`, so `/tasks` is the way
//! to snapshot what's running in the background. It works in every render mode.
//! The dispatcher (`dispatch_show_tasks`) reads the three task sources and
//! commits a read-only list; killing/attaching is out of scope here (use the
//! tasks pane in the full TUI).

use crate::app::actions::Action;
use crate::slash::command::{CommandExecCtx, CommandResult, SlashCommand};

/// List background tasks, subagents, and scheduled tasks.
pub struct TasksCommand;

pub struct NativeControlsCommand {
    pub reminders: bool,
}

impl SlashCommand for NativeControlsCommand {
    fn name(&self) -> &str {
        if self.reminders { "reminders" } else { "inbox" }
    }
    fn usage(&self) -> &str {
        if self.reminders {
            "/reminders"
        } else {
            "/inbox"
        }
    }
    fn description(&self) -> &str {
        if self.reminders {
            "Manage session reminders"
        } else {
            "Manage child conversation input queues"
        }
    }
    fn session_scoped(&self) -> bool {
        true
    }
    fn visible(&self, ctx: &crate::slash::command::AppCtx) -> bool {
        ctx.capabilities.as_ref().map_or(true, |caps| {
            caps.contains(if self.reminders {
                "schedule"
            } else {
                "subagents"
            })
        })
    }
    fn run(&self, ctx: &mut CommandExecCtx, _args: &str) -> CommandResult {
        if ctx.session_id.is_none() {
            return CommandResult::Error("No active session".into());
        }
        CommandResult::Action(Action::OpenNativeControls(if self.reminders {
            crate::views::native_controls::NativeControlTarget::Reminders
        } else {
            crate::views::native_controls::NativeControlTarget::Inbox { child_id: None }
        }))
    }
}

impl SlashCommand for TasksCommand {
    fn name(&self) -> &str {
        "tasks"
    }

    fn description(&self) -> &str {
        "List background tasks, subagents, and scheduled tasks"
    }

    fn session_scoped(&self) -> bool {
        true
    }

    fn usage(&self) -> &str {
        "/tasks [terminals]"
    }

    fn run(&self, ctx: &mut CommandExecCtx, args: &str) -> CommandResult {
        if ctx.session_id.is_none() {
            return CommandResult::Error("No active session".to_string());
        }
        match args.trim() {
            "" => CommandResult::Action(Action::ShowTasks),
            "terminals" => CommandResult::Action(Action::OpenNativeControls(
                crate::views::native_controls::NativeControlTarget::Terminals,
            )),
            _ => CommandResult::Error("Usage: /tasks [terminals]".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::model_state::ModelState;
    use crate::app::bundle::BundleState;
    use crate::settings::PagerLocalSnapshot;

    static DEFAULT_BUNDLE_STATE: BundleState = BundleState {
        has_cache: false,
        version: String::new(),
        personas: Vec::new(),
        roles: Vec::new(),
        agents: Vec::new(),
        skills: Vec::new(),
        persona_details: Vec::new(),
        role_details: Vec::new(),
    };

    fn run_with_session(sid: Option<&agent_client_protocol::SessionId>) -> CommandResult {
        let models = ModelState::default();
        let mut ctx = CommandExecCtx {
            models: &models,
            session_id: sid,
            bundle_state: &DEFAULT_BUNDLE_STATE,
            screen_mode: crate::app::ScreenMode::Minimal,
            billing_surface_visible: true,
            usage_command_visible: true,
            pager_state: PagerLocalSnapshot::default(),
        };
        TasksCommand.run(&mut ctx, "")
    }

    #[test]
    fn no_session_errors() {
        match run_with_session(None) {
            CommandResult::Error(msg) => assert!(msg.contains("No active session")),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn with_session_dispatches_show_tasks() {
        let sid = agent_client_protocol::SessionId::from("s1".to_string());
        assert!(matches!(
            run_with_session(Some(&sid)),
            CommandResult::Action(Action::ShowTasks)
        ));
    }
}
