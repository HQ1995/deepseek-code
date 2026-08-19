//! "Add provider" modal, opened from the /provider dropdown's final row.
//!
//! Presets pre-fill the form; Custom starts empty. Submission sends the form
//! over x.ai/providers/add and the bridge writes it into the dsh settings
//! document through the official settings seam (llm-pi-ai namespace).
//! ponytail: no models list in v1 — the bridge fills a custom route from
//! gateway discovery, and catalog routes keep serving the installed catalog;
//! add a models field here if a provider ever needs hand-entered models.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget};
use unicode_width::UnicodeWidthStr;

use crate::input::line_editor::LineEditOutcome;
use crate::input::line_editor::LineEditor;
use crate::theme::Theme;
use crate::views::modal_window::{
    self as mw, ModalSizing, ModalWindowConfig, ModalWindowState, Shortcut,
};

pub const MODAL_TITLE: &str = "Add provider";
pub const EDIT_MODAL_TITLE: &str = "Edit provider";

/// Wire protocols the official dsh seam accepts (llm-pi-ai supportedProtocols).
pub const APIS: [&str; 3] = [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
];

/// One pre-fill template. Empty fields stay empty so the user completes them.
#[derive(Debug, Clone, Copy)]
pub struct ProviderPreset {
    pub label: &'static str,
    pub id: &'static str,
    pub api_key_env: &'static str,
    pub api: &'static str,
    pub base_url: &'static str,
}

/// Preset order is the dropdown order; PRESETS.len() indexes Custom.
pub const PRESETS: &[ProviderPreset] = &[
    ProviderPreset {
        label: "DeepSeek official",
        id: "deepseek-official",
        api_key_env: "DEEPSEEK_API_KEY",
        api: "openai-responses",
        base_url: "",
    },
    ProviderPreset {
        label: "OpenCodex gateway",
        id: "opencode-go",
        api_key_env: "OCX_API_KEY",
        api: "openai-responses",
        base_url: "http://127.0.0.1:10100/v1",
    },
    ProviderPreset {
        label: "OpenAI-compatible",
        id: "",
        api_key_env: "OPENAI_API_KEY",
        api: "openai-completions",
        base_url: "https://api.openai.com/v1",
    },
    ProviderPreset {
        label: "Anthropic-compatible",
        id: "",
        api_key_env: "ANTHROPIC_API_KEY",
        api: "anthropic-messages",
        base_url: "https://api.anthropic.com/v1",
    },
    ProviderPreset {
        label: "OpenRouter",
        id: "",
        api_key_env: "OPENROUTER_API_KEY",
        api: "openai-completions",
        base_url: "https://openrouter.ai/api/v1",
    },
];

pub const CUSTOM_PRESET_LABEL: &str = "Custom (empty form)";

/// Auth note shown in the form: paste a key (stored in the dsh credentials
/// store) or name an env var — either resolves at request time.
pub const AUTH_NOTE: &str =
    "apiKey is stored in the dsh credentials store; leave it empty to use the named env var instead.";

/// The submitted form. Empty optional fields ride as empty strings; the bridge
/// treats them as unset before the official settings write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddProviderForm {
    pub id: String,
    pub display_name: String,
    pub api_key_env: String,
    pub api: String,
    pub base_url: String,
    /// Literal API key to store in the dsh credentials store (empty = none;
    /// the named env var is used instead). Never echoed back in edit mode.
    pub api_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Id,
    DisplayName,
    ApiKeyEnv,
    Api,
    BaseUrl,
    ApiKey,
}

impl Field {
    const ALL: [Field; 6] = [
        Field::Id,
        Field::DisplayName,
        Field::ApiKeyEnv,
        Field::Api,
        Field::BaseUrl,
        Field::ApiKey,
    ];

    fn index(self) -> usize {
        Self::ALL.iter().position(|f| *f == self).unwrap_or(0)
    }

    fn next(self) -> Field {
        Self::ALL[(self.index() + 1) % Self::ALL.len()]
    }

    fn label(self) -> &'static str {
        match self {
            Field::Id => "id",
            Field::DisplayName => "displayName",
            Field::ApiKeyEnv => "apiKeyEnv",
            Field::Api => "api",
            Field::BaseUrl => "baseURL",
            Field::ApiKey => "apiKey",
        }
    }
}

/// Modal state; boxed inside ActiveModal::AddProvider.
pub struct AddProviderModalState {
    pub window: ModalWindowState,
    /// Selected preset row; PRESETS.len() is Custom.
    pub preset: usize,
    pub field: Field,
    pub(crate) id: LineEditor,
    pub(crate) display_name: LineEditor,
    pub(crate) api_key_env: LineEditor,
    /// Index into APIS, or APIS.len() for "(unset)" (empty api = catalog default).
    pub api_idx: usize,
    pub(crate) base_url: LineEditor,
    pub(crate) api_key: LineEditor,
    /// Some(route id) while the form edits an existing provider: the id row
    /// is locked (routes cannot be renamed) and submit goes to
    /// x.ai/providers/update. None = the add flow.
    pub editing: Option<String>,
    /// True while the ACP add is in flight (content keys are ignored).
    pub submitting: bool,
    /// Last bridge/local validation error, shown under the note.
    pub error: Option<String>,
}

impl AddProviderModalState {
    pub fn new() -> Self {
        let mut state = Self {
            window: ModalWindowState::new(),
            preset: 0,
            field: Field::Id,
            id: LineEditor::default(),
            display_name: LineEditor::default(),
            api_key_env: LineEditor::default(),
            api_idx: 0,
            base_url: LineEditor::default(),
            api_key: LineEditor::default(),
            editing: None,
            submitting: false,
            error: None,
        };
        state.apply_preset(0);
        state
    }

    fn set_editor(editor: &mut LineEditor, value: &str) {
        editor.set_text(value);
    }

    /// Fill the form from a preset row (Custom clears it).
    pub fn apply_preset(&mut self, preset: usize) {
        self.preset = preset;
        let (id, api_key_env, api, base_url) = match PRESETS.get(preset) {
            Some(p) => (p.id, p.api_key_env, p.api, p.base_url),
            None => ("", "", APIS[0], ""),
        };
        Self::set_editor(&mut self.id, id);
        Self::set_editor(&mut self.display_name, "");
        Self::set_editor(&mut self.api_key_env, api_key_env);
        Self::set_editor(&mut self.base_url, base_url);
        Self::set_editor(&mut self.api_key, "");
        self.api_idx = APIS
            .iter()
            .position(|candidate| *candidate == api)
            .unwrap_or(0);
        self.error = None;
    }

    /// Open the form in edit mode, prefilled from the provider's raw
    /// settings profile. Unset fields prefill empty; an unset api selects
    /// the "(unset)" picker slot so a no-op save writes nothing back.
    pub fn prefilled(
        id: &str,
        display_name: &str,
        api_key_env: &str,
        api: Option<&str>,
        base_url: &str,
    ) -> Self {
        let mut state = Self::new();
        state.editing = Some(id.to_string());
        state.preset = PRESETS.len();
        state.field = Field::DisplayName;
        Self::set_editor(&mut state.id, id);
        Self::set_editor(&mut state.display_name, display_name);
        Self::set_editor(&mut state.api_key_env, api_key_env);
        Self::set_editor(&mut state.base_url, base_url);
        state.api_idx = api
            .and_then(|value| APIS.iter().position(|candidate| *candidate == value))
            .unwrap_or(APIS.len());
        state
    }

    pub(crate) fn editor(&self, field: Field) -> &LineEditor {
        match field {
            Field::Id => &self.id,
            Field::DisplayName => &self.display_name,
            Field::ApiKeyEnv => &self.api_key_env,
            Field::Api => &self.id, // unused placeholder; Api has no editor
            Field::BaseUrl => &self.base_url,
            Field::ApiKey => &self.api_key,
        }
    }

    pub(crate) fn editor_mut(&mut self, field: Field) -> &mut LineEditor {
        match field {
            Field::Id => &mut self.id,
            Field::DisplayName => &mut self.display_name,
            Field::ApiKeyEnv => &mut self.api_key_env,
            Field::Api => &mut self.id, // unused placeholder
            Field::BaseUrl => &mut self.base_url,
            Field::ApiKey => &mut self.api_key,
        }
    }

    pub fn form(&self) -> AddProviderForm {
        AddProviderForm {
            id: self.id.text().to_string(),
            display_name: self.display_name.text().to_string(),
            api_key_env: self.api_key_env.text().to_string(),
            api: APIS
                .get(self.api_idx)
                .map_or(String::new(), |value| (*value).to_string()),
            base_url: self.base_url.text().to_string(),
            api_key: self.api_key.text().to_string(),
        }
    }

    /// Next focusable field: the id row is skipped while editing (routes
    /// cannot be renamed), so the cycle is displayName -> apiKeyEnv -> api
    /// -> baseURL.
    fn next_field(field: Field, editing: bool) -> Field {
        let mut next = field;
        for _ in 0..Field::ALL.len() {
            next = next.next();
            if !editing || next != Field::Id {
                return next;
            }
        }
        field
    }

    /// Previous focusable field (mirror of next_field for BackTab).
    fn prev_field(field: Field, editing: bool) -> Field {
        let mut prev = field;
        for _ in 0..Field::ALL.len() {
            let idx = prev.index();
            prev = Field::ALL[if idx == 0 {
                Field::ALL.len() - 1
            } else {
                idx - 1
            }];
            if !editing || prev != Field::Id {
                return prev;
            }
        }
        field
    }
}

impl Default for AddProviderModalState {
    fn default() -> Self {
        Self::new()
    }
}

/// Outcome of a content key event. Chrome events (Esc, [x]) are handled by
/// the caller via modal_window, mirroring the usage modal.
#[derive(Debug)]
pub enum AddProviderOutcome {
    Submit(AddProviderForm),
    Changed,
    Unchanged,
}

/// Lowercase kebab-case, like settings namespace ids: letter start, then
/// lowercase letters/digits/hyphens.
pub fn valid_provider_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn handle_add_provider_key(
    state: &mut AddProviderModalState,
    key: &KeyEvent,
) -> AddProviderOutcome {
    if key.kind == KeyEventKind::Release {
        return AddProviderOutcome::Unchanged;
    }
    if state.submitting {
        return AddProviderOutcome::Unchanged;
    }
    if key
        .modifiers
        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER)
    {
        return AddProviderOutcome::Unchanged;
    }
    match key.code {
        KeyCode::Up => {
            let next = state.preset.saturating_sub(1);
            if next != state.preset {
                state.apply_preset(next);
                return AddProviderOutcome::Changed;
            }
            AddProviderOutcome::Unchanged
        }
        KeyCode::Down => {
            let next = (state.preset + 1).min(PRESETS.len());
            if next != state.preset {
                state.apply_preset(next);
                return AddProviderOutcome::Changed;
            }
            AddProviderOutcome::Unchanged
        }
        KeyCode::Tab => {
            state.field = AddProviderModalState::next_field(state.field, state.editing.is_some());
            AddProviderOutcome::Changed
        }
        KeyCode::BackTab => {
            state.field = AddProviderModalState::prev_field(state.field, state.editing.is_some());
            AddProviderOutcome::Changed
        }
        KeyCode::Left if state.field == Field::Api => {
            state.api_idx = (state.api_idx + APIS.len()) % (APIS.len() + 1);
            AddProviderOutcome::Changed
        }
        KeyCode::Right if state.field == Field::Api => {
            state.api_idx = (state.api_idx + 1) % (APIS.len() + 1);
            AddProviderOutcome::Changed
        }
        KeyCode::Enter => {
            let form = state.form();
            let id = form.id.trim();
            if id.is_empty() {
                state.error = Some("id is required (lowercase kebab-case)".to_string());
                return AddProviderOutcome::Changed;
            }
            if !valid_provider_id(id) {
                state.error = Some(
                    "id must be lowercase kebab-case (letters, digits, hyphens; starts with a letter)"
                        .to_string(),
                );
                return AddProviderOutcome::Changed;
            }
            state.error = None;
            state.submitting = true;
            AddProviderOutcome::Submit(AddProviderForm {
                id: id.to_string(),
                ..form
            })
        }
        _ => {
            if state.field == Field::Api {
                return AddProviderOutcome::Unchanged;
            }
            let outcome = state.editor_mut(state.field).handle_key(key);
            match outcome {
                LineEditOutcome::TextChanged | LineEditOutcome::CursorChanged => {
                    AddProviderOutcome::Changed
                }
                LineEditOutcome::HandledNoChange => AddProviderOutcome::Changed,
                LineEditOutcome::Unhandled => AddProviderOutcome::Unchanged,
            }
        }
    }
}

pub fn handle_add_provider_paste(
    state: &mut AddProviderModalState,
    text: &str,
) -> AddProviderOutcome {
    if state.submitting || state.field == Field::Api {
        return AddProviderOutcome::Unchanged;
    }
    match state.editor_mut(state.field).insert_paste(text) {
        LineEditOutcome::TextChanged | LineEditOutcome::CursorChanged => {
            AddProviderOutcome::Changed
        }
        LineEditOutcome::HandledNoChange => AddProviderOutcome::Changed,
        LineEditOutcome::Unhandled => AddProviderOutcome::Unchanged,
    }
}

/// One labeled form row: the fixed label column and the value cell.
struct RowSpec {
    label: &'static str,
    value: String,
    focused: bool,
    cursor_col: usize,
}

fn row_specs(state: &AddProviderModalState) -> Vec<RowSpec> {
    let cursor = |editor: &LineEditor| editor.viewport(usize::MAX).cursor_display_column;
    let value = |field: Field| -> (String, usize, bool) {
        let focused = state.field == field;
        if field == Field::Api {
            let api = APIS.get(state.api_idx).map_or("(unset)", |value| *value);
            return (api.to_string(), 0, focused);
        }
        let editor = state.editor(field);
        // Secrets never render: the key cell shows a fixed-width mask.
        if field == Field::ApiKey && !editor.text().is_empty() {
            return ("\u{2022}".repeat(editor.text().chars().count()), cursor(editor), focused);
        }
        (editor.text().to_string(), cursor(editor), focused)
    };
    let fields = [
        Field::Id,
        Field::DisplayName,
        Field::ApiKeyEnv,
        Field::Api,
        Field::BaseUrl,
        Field::ApiKey,
    ];
    fields
        .iter()
        .map(|field| {
            let (text, cursor_col, focused) = value(*field);
            RowSpec {
                label: field.label(),
                value: text,
                focused,
                cursor_col,
            }
        })
        .collect()
}

fn preset_label(preset: usize) -> &'static str {
    PRESETS.get(preset).map_or(CUSTOM_PRESET_LABEL, |p| p.label)
}

pub fn render_add_provider_modal(buf: &mut Buffer, area: Rect, state: &mut AddProviderModalState) {
    let theme = Theme::current();
    let editing = state.editing.is_some();
    let shortcuts: Vec<Shortcut> = vec![
        Shortcut {
            label: if state.submitting {
                "Saving…"
            } else if editing {
                "Enter save"
            } else {
                "Enter add"
            },
            clickable: false,
            id: 0,
        },
        Shortcut {
            label: "↑/↓ preset  Tab field",
            clickable: false,
            id: 0,
        },
        Shortcut {
            label: "Esc close",
            clickable: false,
            id: 0,
        },
    ];
    let sizing = ModalSizing {
        width_pct: 0.75,
        max_width: 100,
        min_width: 50,
        v_margin: 3,
        h_pad: 2,
        v_pad: 1,
        footer_lines: 2,
    };
    let config = ModalWindowConfig {
        title: if editing {
            EDIT_MODAL_TITLE
        } else {
            MODAL_TITLE
        },
        tabs: None,
        shortcuts: &shortcuts,
        sizing,
        fold_info: None,
    };
    let Some(mca) = mw::render_modal_window(buf, area, &mut state.window, &config, &theme) else {
        return;
    };
    let content = mca.content;

    let mut lines: Vec<Line<'static>> = Vec::new();
    let focused_style = Style::default()
        .fg(theme.text_primary)
        .add_modifier(Modifier::BOLD);
    let value_style = Style::default().fg(theme.text_primary);
    let dim = Style::default().fg(theme.gray_dim);

    if editing {
        lines.push(Line::from(vec![
            Span::styled("Editing provider ", Style::default().fg(theme.gray)),
            Span::styled(state.id.text().to_string(), focused_style),
            Span::styled(" (id is fixed)", dim),
        ]));
    } else {
        lines.push(Line::from(vec![
            Span::styled("Preset ", Style::default().fg(theme.gray)),
            Span::styled("↑/↓ ", dim),
            Span::styled(preset_label(state.preset), focused_style),
        ]));
    }
    lines.push(Line::from(""));

    for row in row_specs(state) {
        let id_locked = editing && row.label == Field::Id.label();
        let prefix = if row.focused { "› " } else { "  " };
        let label_w = "› ".width() + 12;
        let cursor_row = content.y + lines.len() as u16;
        let empty = row.value.is_empty();
        let mut spans = vec![
            Span::styled(prefix, Style::default().fg(theme.accent_user)),
            Span::styled(
                format!("{:<12}", row.label),
                Style::default().fg(if id_locked {
                    theme.gray_dim
                } else {
                    theme.gray
                }),
            ),
        ];
        if id_locked {
            spans.push(Span::styled(row.value, dim));
        } else if row.focused && empty {
            spans.push(Span::styled("▏", value_style));
        } else if empty {
            spans.push(Span::styled("(unset)", dim));
        } else {
            spans.push(Span::styled(row.value, value_style));
        }
        lines.push(Line::from(spans));

        // Cursor cell for the focused text row.
        if row.focused && !empty && !id_locked {
            let x = content.x + (label_w + row.cursor_col) as u16;
            if x < content.x.saturating_add(content.width) {
                if let Some(cell) = buf.cell_mut((x, cursor_row)) {
                    cell.set_style(Style::default().fg(theme.bg_dark).bg(theme.text_primary));
                }
            }
        }
    }

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(AUTH_NOTE, dim)));
    if let Some(error) = &state.error {
        lines.push(Line::from(Span::styled(
            error.as_str().to_string(),
            Style::default()
                .fg(theme.accent_error)
                .add_modifier(Modifier::BOLD),
        )));
    }

    let visible: Vec<Line> = lines.into_iter().take(content.height as usize).collect();
    Paragraph::new(visible).render(content, buf);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn presets_prefill_and_custom_clears() {
        let mut state = AddProviderModalState::new();
        assert_eq!(state.form().id, "deepseek-official");
        assert_eq!(state.form().api, "openai-responses");
        assert_eq!(state.form().api_key_env, "DEEPSEEK_API_KEY");

        state.apply_preset(PRESETS.len());
        assert_eq!(state.form().id, "");
        assert_eq!(state.form().api_key_env, "");
        assert_eq!(state.form().api, "openai-completions");
    }

    #[test]
    fn tab_cycles_fields_and_left_right_cycles_protocol() {
        let mut state = AddProviderModalState::new();
        assert_eq!(state.field, Field::Id);
        assert!(matches!(
            handle_add_provider_key(&mut state, &key(KeyCode::Tab)),
            AddProviderOutcome::Changed
        ));
        assert_eq!(state.field, Field::DisplayName);
        for _ in 0..2 {
            handle_add_provider_key(&mut state, &key(KeyCode::Tab));
        }
        assert_eq!(state.field, Field::Api);
        // The DeepSeek official preset pre-fills openai-responses (index 1).
        assert_eq!(state.form().api, "openai-responses");
        handle_add_provider_key(&mut state, &key(KeyCode::Right));
        assert_eq!(state.form().api, "anthropic-messages");
        handle_add_provider_key(&mut state, &key(KeyCode::Left));
        assert_eq!(state.form().api, "openai-responses");
    }

    #[test]
    fn submit_validates_kebab_id() {
        let mut state = AddProviderModalState::new();
        state.apply_preset(PRESETS.len());
        state.id.set_text("Bad_Id!");
        assert!(matches!(
            handle_add_provider_key(&mut state, &key(KeyCode::Enter)),
            AddProviderOutcome::Changed
        ));
        assert!(state.error.is_some());
        assert!(!state.submitting);

        state.id.set_text("acme-gateway");
        let outcome = handle_add_provider_key(&mut state, &key(KeyCode::Enter));
        match outcome {
            AddProviderOutcome::Submit(form) => {
                assert_eq!(form.id, "acme-gateway");
                assert!(state.submitting);
            }
            other => panic!("expected Submit, got {other:?}"),
        }
    }

    #[test]
    fn valid_provider_id_accepts_kebab_and_rejects_uppercase() {
        assert!(valid_provider_id("a"));
        assert!(valid_provider_id("acme-gateway-2"));
        assert!(!valid_provider_id(""));
        assert!(!valid_provider_id("-lead"));
        assert!(!valid_provider_id("Acme"));
        assert!(!valid_provider_id("a_b"));
    }

    #[test]
    fn prefilled_edit_locks_the_id_and_skips_it_in_the_tab_cycle() {
        let mut state = AddProviderModalState::prefilled(
            "acme-gw",
            "Acme",
            "ACME_KEY",
            Some("openai-completions"),
            "https://acme.test/v1",
        );
        assert_eq!(state.editing.as_deref(), Some("acme-gw"));
        assert_eq!(state.form().id, "acme-gw");
        assert_eq!(state.form().display_name, "Acme");
        assert_eq!(state.form().api_key_env, "ACME_KEY");
        assert_eq!(state.form().api, "openai-completions");
        assert_eq!(state.form().base_url, "https://acme.test/v1");
        // The form opens on DisplayName (Id is locked) and the cycle wraps
        // back to DisplayName without ever focusing Id.
        assert_eq!(state.field, Field::DisplayName);
        handle_add_provider_key(&mut state, &key(KeyCode::Tab));
        assert_eq!(state.field, Field::ApiKeyEnv);
        // Five more tabs walk Api -> BaseUrl -> ApiKey -> DisplayName ->
        // ApiKeyEnv: a full wrap that never lands on the locked Id.
        for _ in 0..5 {
            handle_add_provider_key(&mut state, &key(KeyCode::Tab));
        }
        assert_eq!(state.field, Field::ApiKeyEnv);
    }

    #[test]
    fn unset_api_prefills_the_unset_picker_slot_and_submits_empty() {
        let mut state = AddProviderModalState::prefilled("acme-gw", "", "", None, "");
        assert_eq!(state.api_idx, APIS.len());
        assert_eq!(state.form().api, "");
        for _ in 0..2 {
            handle_add_provider_key(&mut state, &key(KeyCode::Tab));
        }
        assert_eq!(state.field, Field::Api);
        handle_add_provider_key(&mut state, &key(KeyCode::Right));
        assert_eq!(state.form().api, APIS[0]);
    }
}
