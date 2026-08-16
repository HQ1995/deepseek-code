//! /preset -- open the bundled preset/agent catalog to pick a preset.

use crate::app::actions::Action;
use crate::slash::command::{CommandExecCtx, CommandResult, SlashCommand};

/// Open the bundled catalog pane so a preset can be picked.
pub struct PresetCommand;

impl SlashCommand for PresetCommand {
    fn name(&self) -> &str {
        "preset"
    }

    fn aliases(&self) -> &[&str] {
        &["presets"]
    }

    fn description(&self) -> &str {
        "Pick the agent preset for this session"
    }

    fn usage(&self) -> &str {
        "/preset"
    }

    fn run(&self, _ctx: &mut CommandExecCtx, _args: &str) -> CommandResult {
        CommandResult::Action(Action::ToggleCatalog)
    }
}
