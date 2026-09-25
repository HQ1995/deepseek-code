//! /preset -- pick a preset: the host's options for this session, else the
//! bundled preset/agent catalog.
//!
//! DIVERGENCE(dscode): this builtin fronts the host's `/preset`. A bare
//! invocation opens the host-served option picker when the host offers
//! options (a session whose preset can still change in place); a pick comes
//! back as `/preset <id>`, which goes to the host. When the host offers
//! nothing, the bare command opens the catalog, which can start a new
//! session with the chosen preset.

use crate::app::actions::Action;
use crate::slash::command::{CommandExecCtx, CommandResult, SlashCommand};

/// Pick a preset, or manage the installed ones.
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
        "/preset [<id>|manage]"
    }

    fn fronts_host_command(&self) -> bool {
        true
    }

    fn run(&self, _ctx: &mut CommandExecCtx, args: &str) -> CommandResult {
        match args.trim() {
            "manage" => CommandResult::Action(Action::OpenNativeControls(
                crate::views::native_controls::NativeControlTarget::Presets,
            )),
            "" => CommandResult::Action(Action::ToggleCatalog),
            id => CommandResult::PassThrough(format!("/preset {id}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(args: &str) -> CommandResult {
        let models = crate::acp::model_state::ModelState::default();
        let bundle = crate::app::bundle::BundleState::default();
        let mut ctx = CommandExecCtx {
            models: &models,
            session_id: None,
            bundle_state: &bundle,
            screen_mode: crate::app::ScreenMode::Inline,
            billing_surface_visible: true,
            usage_command_visible: true,
            pager_state: crate::settings::PagerLocalSnapshot::default(),
        };
        PresetCommand.run(&mut ctx, args)
    }

    #[test]
    fn preset_command_fronts_the_host_preset_command() {
        assert!(PresetCommand.fronts_host_command());
        assert!(matches!(
            run("  "),
            CommandResult::Action(Action::ToggleCatalog)
        ));
        assert!(matches!(
            run("manage"),
            CommandResult::Action(Action::OpenNativeControls(_))
        ));
        assert!(
            matches!(run(" minimal "), CommandResult::PassThrough(text) if text == "/preset minimal")
        );
    }
}
