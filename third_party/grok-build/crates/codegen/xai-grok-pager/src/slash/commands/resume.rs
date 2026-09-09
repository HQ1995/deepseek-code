//! `/resume` -- open session picker overlay to resume a previous session.

use crate::app::actions::Action;
use crate::slash::command::{CommandExecCtx, CommandResult, SlashCommand};

pub struct ResumeCommand;

pub struct ReferenceCommand;

impl SlashCommand for ReferenceCommand {
    fn name(&self) -> &str {
        "reference"
    }
    fn description(&self) -> &str {
        "Insert a reference to a previous session"
    }
    fn usage(&self) -> &str {
        "/reference"
    }
    fn run(&self, _ctx: &mut CommandExecCtx, _args: &str) -> CommandResult {
        CommandResult::Action(Action::SearchSessionReferences { query: None })
    }
}

impl SlashCommand for ResumeCommand {
    fn name(&self) -> &str {
        "resume"
    }

    fn description(&self) -> &str {
        "Resume a previous session"
    }

    fn usage(&self) -> &str {
        "/resume"
    }

    fn run(&self, _ctx: &mut CommandExecCtx, _args: &str) -> CommandResult {
        CommandResult::Action(Action::ShowSessionPicker)
    }
}
