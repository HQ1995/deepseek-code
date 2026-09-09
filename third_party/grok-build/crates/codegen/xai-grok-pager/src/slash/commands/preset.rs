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
        "Pick a preset; /preset manage to copy, view or edit"
    }

    fn usage(&self) -> &str {
        "/preset [manage]"
    }

    fn run(&self, _ctx: &mut CommandExecCtx, args: &str) -> CommandResult {
        if args.trim() == "manage" {
            return CommandResult::Action(Action::OpenNativeControls(
                crate::views::native_controls::NativeControlTarget::Presets,
            ));
        }
        CommandResult::Action(Action::ToggleCatalog)
    }
}
