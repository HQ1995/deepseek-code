//! DIVERGENCE(dscode): CommandResultBlock — one host command's result.
//!
//! A header line names the invocation (`/name args`, one line); below it the
//! command's text. Text the host marks as Markdown (the bridge's own commands,
//! whose replies were agent messages) renders exactly as an agent message's
//! does: tables, code, links. Other text (DSH's command output, which DSH's own
//! client shows preformatted and an immediate command's reply showed as a plain
//! system line) renders as plain text, its line breaks kept. An error result
//! tones the header and its bullet with the error accent. The host sends the
//! same block live and on resume, so the transcript shows it identically.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use crate::appearance::AppearanceConfig;
use crate::render::wrapping::word_wrap_lines;
use crate::scrollback::block::BlockContent;
use crate::scrollback::types::{AccentStyle, BlockContext, BlockLine, BlockOutput, DisplayMode};
use crate::theme::Theme;

use super::markdown_content::MarkdownContent;

/// A command result's text, as the host sent it.
#[derive(Debug, Clone)]
enum Body {
    Markdown(MarkdownContent),
    Text(String),
}

/// Block displaying a host command's result under its invocation.
#[derive(Debug, Clone)]
pub struct CommandResultBlock {
    /// `/name args`, whitespace collapsed to one line.
    pub invocation: String,
    /// The command settled as an error.
    pub error: bool,
    /// The command's text; `None` for a bare success.
    body: Option<Body>,
}

impl CommandResultBlock {
    /// Create a result block for `/name args` with the command's text.
    pub fn new(
        name: &str,
        args: Option<&str>,
        error: bool,
        text: Option<String>,
        markdown: bool,
    ) -> Self {
        let args = args.map(|args| args.split_whitespace().collect::<Vec<_>>().join(" "));
        let invocation = match args.as_deref() {
            Some(args) if !args.is_empty() => format!("/{name} {args}"),
            _ => format!("/{name}"),
        };
        let body = text
            .filter(|text| !text.trim().is_empty())
            .map(|text| match markdown {
                true => Body::Markdown(MarkdownContent::new(text)),
                false => Body::Text(text.trim_end().to_owned()),
            });
        Self {
            invocation,
            error,
            body,
        }
    }

    /// The Markdown body, when the command sent Markdown text.
    pub fn content(&self) -> Option<&MarkdownContent> {
        match &self.body {
            Some(Body::Markdown(content)) => Some(content),
            _ => None,
        }
    }

    /// The body's text: Markdown source when `raw`, else as rendered.
    pub fn copy_text(&self, raw: bool) -> String {
        match &self.body {
            Some(Body::Markdown(content)) if raw => content.text(),
            Some(Body::Markdown(content)) => content.rendered_plain_text(),
            Some(Body::Text(text)) => text.clone(),
            None => String::new(),
        }
    }

    fn tone(&self) -> ratatui::style::Color {
        let theme = Theme::current();
        if self.error {
            theme.accent_error
        } else {
            theme.accent_skill
        }
    }
}

impl BlockContent for CommandResultBlock {
    fn output(&self, ctx: &BlockContext) -> BlockOutput {
        // The header is chrome: selection and copy take the body.
        let header = crate::render::line_utils::truncate_line(
            Line::from(Span::styled(
                self.invocation.clone(),
                Style::default()
                    .fg(self.tone())
                    .add_modifier(Modifier::BOLD),
            )),
            ctx.content_width(),
        );
        let mut lines = vec![BlockLine::separator(header)];
        if ctx.mode == DisplayMode::Collapsed {
            return BlockOutput { lines };
        }
        match &self.body {
            Some(Body::Markdown(content)) => lines.extend(content.output(ctx.width as usize).lines),
            Some(Body::Text(text)) => {
                let styled = text.lines().map(|line| Line::from(line.to_owned()));
                lines.extend(
                    word_wrap_lines(styled, ctx.width as usize)
                        .into_iter()
                        .map(|line| BlockLine::styled(line).with_selection_range(Some(0))),
                );
            }
            None => {}
        }
        BlockOutput { lines }
    }

    fn accent(&self, _ctx: &BlockContext) -> Option<AccentStyle> {
        None
    }

    fn bullet(&self, _ctx: &BlockContext) -> Option<AccentStyle> {
        Some(AccentStyle::static_color(self.tone()))
    }

    fn has_bullet(&self, _ctx: &BlockContext) -> bool {
        true
    }

    fn has_vpad_for(&self, _appearance: &AppearanceConfig) -> bool {
        false
    }

    fn has_raw_mode(&self) -> bool {
        false
    }

    fn is_foldable(&self) -> bool {
        self.body.is_some()
    }

    fn is_groupable(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scrollback::block::RenderBlock;
    use crate::scrollback::types::line_plain_text;

    fn ctx(mode: DisplayMode) -> BlockContext {
        BlockContext {
            mode,
            is_running: false,
            width: 60,
            raw: false,
            max_lines: None,
            appearance: AppearanceConfig::default(),
            is_selected: false,
            cwd: None,
        }
    }

    fn rows(block: &RenderBlock, mode: DisplayMode) -> Vec<String> {
        block
            .output(&ctx(mode))
            .lines
            .iter()
            .map(|line| line_plain_text(&line.content).trim_end().to_string())
            .collect()
    }

    #[test]
    fn renders_the_invocation_over_markdown_text_as_an_agent_message() {
        let text = "Plugins in **dscode**:\n\n| Bundle | On |\n| --- | --- |\n| base | yes |";
        let block = RenderBlock::command_result(
            "dsh",
            Some(" plugins\n  --all "),
            false,
            Some(text.into()),
            true,
        );
        let rows = rows(&block, DisplayMode::Expanded);
        assert!(rows[0].ends_with("/dsh plugins --all"), "{rows:?}");
        // The body is exactly what an agent message with the same text renders.
        let agent = RenderBlock::agent_message(text)
            .output(&ctx(DisplayMode::Expanded))
            .lines
            .iter()
            .map(|line| line_plain_text(&line.content).trim_end().to_string())
            .collect::<Vec<_>>();
        assert_eq!(&rows[1..], &agent[..]);
        let body = rows[1..].join("\n");
        assert!(
            body.contains("Plugins in dscode:") && !body.contains("**"),
            "{body}"
        );
        assert!(body.contains("Bundle") && body.contains("base"), "{body}");
        assert_eq!(
            block
                .searchable_text()
                .as_deref()
                .map(|text| text.contains("/dsh plugins --all")),
            Some(true)
        );
        // Collapsed keeps the invocation only.
        assert_eq!(rows_len(&block, DisplayMode::Collapsed), 1);
    }

    fn rows_len(block: &RenderBlock, mode: DisplayMode) -> usize {
        rows(block, mode).len()
    }

    #[test]
    fn renders_plain_command_output_verbatim_line_by_line() {
        let block = RenderBlock::command_result(
            "goal",
            None,
            false,
            Some("Goal\nStatus: paused\nUsage: /goal [<objective>|clear|pause]\n".into()),
            false,
        );
        let rows = rows(&block, DisplayMode::Expanded);
        assert_eq!(
            &rows[1..],
            [
                "Goal",
                "Status: paused",
                "Usage: /goal [<objective>|clear|pause]"
            ],
            "{rows:?}"
        );
        assert_eq!(
            block.copy_text(false).as_deref(),
            Some("Goal\nStatus: paused\nUsage: /goal [<objective>|clear|pause]")
        );
    }

    #[test]
    fn tones_an_error_and_keeps_a_bare_success_to_its_header() {
        let theme = Theme::current();
        let error = CommandResultBlock::new(
            "goal",
            Some("pause"),
            true,
            Some("No goal is set.".into()),
            false,
        );
        let output = error.output(&ctx(DisplayMode::Expanded));
        assert_eq!(
            output.lines[0].content.spans[0].style.fg,
            Some(theme.accent_error)
        );
        assert_eq!(
            error
                .bullet(&ctx(DisplayMode::Expanded))
                .map(|style| style.color),
            Some(theme.accent_error)
        );
        assert_eq!(
            line_plain_text(&output.lines[1].content).trim_end(),
            "No goal is set."
        );
        let bare = CommandResultBlock::new("plan", None, false, Some("  ".into()), true);
        assert_eq!(bare.output(&ctx(DisplayMode::Expanded)).lines.len(), 1);
        assert!(!bare.is_foldable());
        assert_eq!(bare.invocation, "/plan");
    }
}
