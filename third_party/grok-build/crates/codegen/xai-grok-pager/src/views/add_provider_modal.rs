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

/// One pre-fill template. `base_url` is persisted; `default_base_url` is a
/// display-only catalog default used when the persisted value stays empty.
#[derive(Debug, Clone, Copy)]
pub struct ProviderPreset {
    pub label: &'static str,
    pub id: &'static str,
    pub display_name: &'static str,
    pub api_key_env: &'static str,
    pub api: &'static str,
    pub base_url: &'static str,
    pub default_base_url: &'static str,
}

/// Preset order is the dropdown order; PRESETS.len() indexes Custom.
pub const PRESETS: &[ProviderPreset] = &[
    ProviderPreset {
        label: "DeepSeek",
        id: "deepseek",
        display_name: "DeepSeek",
        api_key_env: "DEEPSEEK_API_KEY",
        api: "",
        base_url: "",
        default_base_url: "https://api.deepseek.com",
    },
    ProviderPreset {
        label: "OpenCodex",
        id: "ocx",
        display_name: "OpenCodex",
        api_key_env: "OCX_API_KEY",
        api: "openai-responses",
        base_url: "http://127.0.0.1:10100/v1",
        default_base_url: "http://127.0.0.1:10100/v1",
    },
    ProviderPreset {
        label: "OpenAI",
        id: "openai",
        display_name: "OpenAI",
        api_key_env: "OPENAI_API_KEY",
        api: "",
        base_url: "",
        default_base_url: "https://api.openai.com/v1",
    },
    ProviderPreset {
        label: "Anthropic",
        id: "anthropic",
        display_name: "Anthropic",
        api_key_env: "ANTHROPIC_API_KEY",
        api: "",
        base_url: "",
        default_base_url: "https://api.anthropic.com",
    },
    ProviderPreset {
        label: "OpenRouter",
        id: "openrouter",
        display_name: "OpenRouter",
        api_key_env: "OPENROUTER_API_KEY",
        api: "",
        base_url: "",
        default_base_url: "https://openrouter.ai/api/v1",
    },
];

pub const CUSTOM_PRESET_LABEL: &str = "Custom (empty form)";

/// Auth precedence shown in the form. The dsh credential provider gives the
/// inherited launch environment priority over its managed file store.
pub const AUTH_NOTE: &str =
    "Launch environment wins; pasted keys are saved securely and used otherwise.";

/// Where this form expects the provider credential to come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialSource {
    Saved,
    Environment,
}

impl CredentialSource {
    fn label(self) -> &'static str {
        match self {
            Self::Saved => "Saved key",
            Self::Environment => "Environment",
        }
    }

    pub(crate) fn wire(self) -> &'static str {
        match self {
            Self::Saved => "saved",
            Self::Environment => "environment",
        }
    }

    fn toggled(self) -> Self {
        match self {
            Self::Saved => Self::Environment,
            Self::Environment => Self::Saved,
        }
    }
}

/// The submitted form. Empty optional fields ride as empty strings; the bridge
/// treats them as unset before the official settings write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddProviderForm {
    pub id: String,
    pub display_name: String,
    pub api_key_env: String,
    pub api: String,
    pub base_url: String,
    pub credential_source: CredentialSource,
    /// Literal API key to store in the dsh credentials store (empty = none;
    /// the named env var is used instead). Never echoed back in edit mode.
    pub api_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Id,
    DisplayName,
    Api,
    BaseUrl,
    CredentialSource,
    ApiKeyEnv,
    ApiKey,
}

impl Field {
    const ALL: [Field; 7] = [
        Field::Id,
        Field::DisplayName,
        Field::Api,
        Field::BaseUrl,
        Field::CredentialSource,
        Field::ApiKeyEnv,
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
            Field::Id => "ID",
            Field::DisplayName => "Display name",
            Field::Api => "API protocol",
            Field::BaseUrl => "Base URL",
            Field::CredentialSource => "Key source",
            Field::ApiKeyEnv => "Environment",
            Field::ApiKey => "API key",
        }
    }
}

/// Modal state; boxed inside ActiveModal::AddProvider.
pub struct AddProviderModalState {
    pub window: ModalWindowState,
    /// Selected template; PRESETS.len() is Custom.
    pub preset: usize,
    /// Global preset indices available for this add; existing provider ids are
    /// omitted and Custom is always the final entry.
    templates: Vec<usize>,
    template_cursor: usize,
    /// Add starts in a vertical template picker. Edit opens the form directly.
    pub choosing_preset: bool,
    pub field: Field,
    pub(crate) id: LineEditor,
    pub(crate) display_name: LineEditor,
    pub(crate) api_key_env: LineEditor,
    /// Index into APIS, or APIS.len() for "(unset)" (empty api = catalog default).
    pub api_idx: usize,
    pub(crate) base_url: LineEditor,
    pub(crate) api_key: LineEditor,
    pub credential_source: CredentialSource,
    pub credential: Option<crate::acp::model_state::ProviderCredentialInfo>,
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
        Self::new_for_existing(&[])
    }

    pub fn new_for_existing(existing_provider_ids: &[String]) -> Self {
        let mut templates: Vec<usize> = PRESETS
            .iter()
            .enumerate()
            .filter(|(_, preset)| !existing_provider_ids.iter().any(|id| id == preset.id))
            .map(|(index, _)| index)
            .collect();
        templates.push(PRESETS.len());
        let preset = templates[0];
        let mut state = Self {
            window: ModalWindowState::new(),
            preset,
            templates,
            template_cursor: 0,
            choosing_preset: true,
            field: Field::Id,
            id: LineEditor::default(),
            display_name: LineEditor::default(),
            api_key_env: LineEditor::default(),
            api_idx: 0,
            base_url: LineEditor::default(),
            api_key: LineEditor::default(),
            credential_source: CredentialSource::Saved,
            credential: None,
            editing: None,
            submitting: false,
            error: None,
        };
        state.apply_preset(preset);
        state
    }

    fn set_editor(editor: &mut LineEditor, value: &str) {
        editor.set_text(value);
    }

    /// Fill the form from a template row (Custom clears it).
    pub fn apply_preset(&mut self, preset: usize) {
        self.preset = preset;
        let (id, display_name, api_key_env, api, base_url) = match PRESETS.get(preset) {
            Some(p) => (p.id, p.display_name, p.api_key_env, p.api, p.base_url),
            None => ("", "", "", "", ""),
        };
        Self::set_editor(&mut self.id, id);
        Self::set_editor(&mut self.display_name, display_name);
        Self::set_editor(&mut self.api_key_env, api_key_env);
        Self::set_editor(&mut self.base_url, base_url);
        Self::set_editor(&mut self.api_key, "");
        self.api_idx = APIS
            .iter()
            .position(|candidate| *candidate == api)
            .unwrap_or(APIS.len());
        self.credential = inherited_env_credential(api_key_env);
        self.credential_source = if self
            .credential
            .as_ref()
            .is_some_and(|info| info.source.as_deref() == Some("env"))
        {
            CredentialSource::Environment
        } else {
            CredentialSource::Saved
        };
        self.error = None;
    }

    /// Open the form in edit mode, prefilled from the provider's raw settings
    /// profile. Unset fields prefill empty; an unset api selects the "(unset)"
    /// picker slot so a no-op save writes nothing back.
    pub fn prefilled(
        id: &str,
        display_name: &str,
        api_key_env: &str,
        api: Option<&str>,
        base_url: &str,
        credential: Option<crate::acp::model_state::ProviderCredentialInfo>,
    ) -> Self {
        let mut state = Self::new();
        state.editing = Some(id.to_string());
        state.choosing_preset = false;
        state.preset = PRESETS
            .iter()
            .position(|preset| preset.id == id)
            .unwrap_or(PRESETS.len());
        state.field = Field::DisplayName;
        Self::set_editor(&mut state.id, id);
        Self::set_editor(&mut state.display_name, display_name);
        Self::set_editor(&mut state.api_key_env, api_key_env);
        Self::set_editor(&mut state.base_url, base_url);
        state.api_idx = api
            .and_then(|value| APIS.iter().position(|candidate| *candidate == value))
            .unwrap_or(APIS.len());
        state.credential = credential.or_else(|| inherited_env_credential(api_key_env));
        state.credential_source = if state
            .credential
            .as_ref()
            .is_some_and(|info| info.source.as_deref() != Some("file"))
        {
            CredentialSource::Environment
        } else {
            CredentialSource::Saved
        };
        state
    }

    pub(crate) fn editor(&self, field: Field) -> &LineEditor {
        match field {
            Field::Id => &self.id,
            Field::DisplayName => &self.display_name,
            Field::ApiKeyEnv => &self.api_key_env,
            Field::Api | Field::CredentialSource => &self.id, // chooser placeholders
            Field::BaseUrl => &self.base_url,
            Field::ApiKey => &self.api_key,
        }
    }

    pub(crate) fn editor_mut(&mut self, field: Field) -> &mut LineEditor {
        match field {
            Field::Id => &mut self.id,
            Field::DisplayName => &mut self.display_name,
            Field::ApiKeyEnv => &mut self.api_key_env,
            Field::Api | Field::CredentialSource => &mut self.id, // chooser placeholders
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
            credential_source: self.credential_source,
            api_key: self.api_key.text().to_string(),
        }
    }

    fn focusable(&self, field: Field) -> bool {
        if self.editing.is_some() && field == Field::Id {
            return false;
        }
        self.credential_source != CredentialSource::Environment || field != Field::ApiKey
    }

    fn next_field(&self, field: Field) -> Field {
        let mut next = field;
        for _ in 0..Field::ALL.len() {
            next = next.next();
            if self.focusable(next) {
                return next;
            }
        }
        field
    }

    fn prev_field(&self, field: Field) -> Field {
        let mut prev = field;
        for _ in 0..Field::ALL.len() {
            let idx = prev.index();
            prev = Field::ALL[if idx == 0 {
                Field::ALL.len() - 1
            } else {
                idx - 1
            }];
            if self.focusable(prev) {
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

fn inherited_env_credential(
    reference: &str,
) -> Option<crate::acp::model_state::ProviderCredentialInfo> {
    let configured =
        !reference.is_empty() && std::env::var_os(reference).is_some_and(|value| !value.is_empty());
    configured.then(|| crate::acp::model_state::ProviderCredentialInfo {
        configured: true,
        source: Some("env".to_string()),
        writable: false,
    })
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
    if state.choosing_preset {
        if key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER)
        {
            return AddProviderOutcome::Unchanged;
        }
        let last = state.templates.len().saturating_sub(1);
        match key.code {
            KeyCode::Up => state.template_cursor = state.template_cursor.saturating_sub(1),
            KeyCode::Down => state.template_cursor = (state.template_cursor + 1).min(last),
            KeyCode::Home => state.template_cursor = 0,
            KeyCode::End => state.template_cursor = last,
            KeyCode::Enter | KeyCode::Tab => {
                state.choosing_preset = false;
                state.field = Field::Id;
                return AddProviderOutcome::Changed;
            }
            _ => return AddProviderOutcome::Unchanged,
        }
        state.apply_preset(state.templates[state.template_cursor]);
        return AddProviderOutcome::Changed;
    }
    if key
        .modifiers
        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER)
    {
        return AddProviderOutcome::Unchanged;
    }
    match key.code {
        // Up/Down always move row focus. Left/Right changes chooser rows;
        // text rows keep ordinary cursor semantics through LineEditor.
        KeyCode::Up => {
            state.field = state.prev_field(state.field);
            AddProviderOutcome::Changed
        }
        KeyCode::Down | KeyCode::Tab => {
            state.field = state.next_field(state.field);
            AddProviderOutcome::Changed
        }
        KeyCode::BackTab => {
            state.field = state.prev_field(state.field);
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
        KeyCode::Left | KeyCode::Right if state.field == Field::CredentialSource => {
            state.credential_source = state.credential_source.toggled();
            if state.credential_source == CredentialSource::Environment {
                state.api_key.set_text("");
            }
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
            if matches!(state.field, Field::Api | Field::CredentialSource) {
                return AddProviderOutcome::Unchanged;
            }
            let outcome = state.editor_mut(state.field).handle_key(key);
            match outcome {
                LineEditOutcome::TextChanged => {
                    if state.field == Field::ApiKeyEnv {
                        state.credential = inherited_env_credential(state.api_key_env.text());
                    }
                    AddProviderOutcome::Changed
                }
                LineEditOutcome::CursorChanged | LineEditOutcome::HandledNoChange => {
                    AddProviderOutcome::Changed
                }
                LineEditOutcome::Unhandled => AddProviderOutcome::Unchanged,
            }
        }
    }
}

pub fn handle_add_provider_paste(
    state: &mut AddProviderModalState,
    text: &str,
) -> AddProviderOutcome {
    if state.submitting
        || state.choosing_preset
        || matches!(state.field, Field::Api | Field::CredentialSource)
    {
        return AddProviderOutcome::Unchanged;
    }
    match state.editor_mut(state.field).insert_paste(text) {
        LineEditOutcome::TextChanged => {
            if state.field == Field::ApiKeyEnv {
                state.credential = inherited_env_credential(state.api_key_env.text());
            }
            AddProviderOutcome::Changed
        }
        LineEditOutcome::CursorChanged | LineEditOutcome::HandledNoChange => {
            AddProviderOutcome::Changed
        }
        LineEditOutcome::Unhandled => AddProviderOutcome::Unchanged,
    }
}

/// One labeled form row: the fixed label column and the value cell.
struct RowSpec {
    field: Field,
    label: &'static str,
    value: String,
    placeholder: Option<String>,
    focused: bool,
    cursor_col: usize,
}

fn preset_label(preset: usize) -> &'static str {
    PRESETS.get(preset).map_or(CUSTOM_PRESET_LABEL, |p| p.label)
}

fn credential_summary(state: &AddProviderModalState) -> String {
    let reference = state.api_key_env.text();
    if state.credential_source == CredentialSource::Environment {
        return match state.credential.as_ref() {
            Some(info) if info.configured && info.source.as_deref() == Some("env") => {
                format!("Credential: ${reference} from launch environment (highest priority)")
            }
            _ if reference.is_empty() => {
                "Credential: choose an environment variable name".to_string()
            }
            _ => format!("Credential: ${reference} is not set in the launch environment"),
        };
    }
    if !state.api_key.text().is_empty() {
        return "Credential: new key will be saved securely".to_string();
    }
    match state.credential.as_ref() {
        Some(info) if info.source.as_deref() == Some("env") => {
            "Credential: launch environment currently overrides saved keys".to_string()
        }
        Some(info) if info.configured && info.source.as_deref() == Some("file") => {
            "Credential: saved key (type a new key to replace)".to_string()
        }
        Some(info) if info.configured => {
            format!(
                "Credential: {}",
                info.source.as_deref().unwrap_or("configured")
            )
        }
        _ => "Credential: paste a key to save securely".to_string(),
    }
}

fn row_specs(state: &AddProviderModalState) -> Vec<RowSpec> {
    let cursor = |editor: &LineEditor| editor.viewport(usize::MAX).cursor_display_column;
    Field::ALL
        .iter()
        .map(|field| {
            let focused = state.field == *field;
            let (value, cursor_col) = match field {
                Field::Api => (
                    APIS.get(state.api_idx)
                        .map_or(String::new(), |value| (*value).to_string()),
                    0,
                ),
                Field::CredentialSource => (state.credential_source.label().to_string(), 0),
                _ => {
                    let editor = state.editor(*field);
                    let value = if *field == Field::ApiKey && !editor.text().is_empty() {
                        "\u{2022}".repeat(editor.text().chars().count())
                    } else {
                        editor.text().to_string()
                    };
                    (value, cursor(editor))
                }
            };
            let placeholder = if value.is_empty() {
                match field {
                    Field::Api => Some("catalog default".to_string()),
                    Field::BaseUrl => PRESETS
                        .get(state.preset)
                        .filter(|preset| !preset.default_base_url.is_empty())
                        .map(|preset| format!("default: {}", preset.default_base_url))
                        .or_else(|| Some("required for Custom".to_string())),
                    Field::ApiKey => Some(
                        if state.credential_source == CredentialSource::Environment {
                            "not used in Environment mode".to_string()
                        } else {
                            match state.credential.as_ref() {
                                Some(info) if info.configured => {
                                    "leave empty to keep current".to_string()
                                }
                                _ => "paste to save securely".to_string(),
                            }
                        },
                    ),
                    Field::CredentialSource => None,
                    _ => None,
                }
            } else {
                None
            };
            RowSpec {
                field: *field,
                label: if *field == Field::ApiKeyEnv
                    && state.credential_source == CredentialSource::Saved
                {
                    "Credential ref"
                } else {
                    field.label()
                },
                value,
                placeholder,
                focused,
                cursor_col,
            }
        })
        .collect()
}

fn centered_window(len: usize, selected: usize, max_rows: usize) -> std::ops::Range<usize> {
    if len == 0 || max_rows == 0 {
        return 0..0;
    }
    let width = max_rows.min(len);
    let start = selected
        .saturating_sub(width / 2)
        .min(len.saturating_sub(width));
    start..start + width
}

pub fn render_add_provider_modal(buf: &mut Buffer, area: Rect, state: &mut AddProviderModalState) {
    let theme = Theme::current();
    let editing = state.editing.is_some();
    let shortcuts: Vec<Shortcut> = if state.choosing_preset {
        vec![
            Shortcut {
                label: "Enter continue",
                clickable: false,
                id: 0,
            },
            Shortcut {
                label: "\u{2191}/\u{2193} template",
                clickable: false,
                id: 0,
            },
            Shortcut {
                label: "Esc close",
                clickable: false,
                id: 0,
            },
        ]
    } else {
        vec![
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
                label: "\u{2191}/\u{2193} field  \u{2190}/\u{2192} value",
                clickable: false,
                id: 0,
            },
            Shortcut {
                label: "Esc close",
                clickable: false,
                id: 0,
            },
        ]
    };
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
    let focused_style = Style::default()
        .fg(theme.text_primary)
        .add_modifier(Modifier::BOLD);
    let value_style = Style::default().fg(theme.text_primary);
    let dim = Style::default().fg(theme.gray_dim);

    if state.choosing_preset {
        let mut lines = vec![
            Line::from(Span::styled(
                "Choose a starting template",
                Style::default().fg(theme.gray),
            )),
            Line::from(Span::styled(
                "Catalog defaults stay automatic unless you edit them.",
                dim,
            )),
            Line::from(""),
        ];
        let count = state.templates.len();
        let available = content.height.saturating_sub(lines.len() as u16) as usize;
        for position in centered_window(count, state.template_cursor, available.min(7)) {
            let index = state.templates[position];
            let selected = position == state.template_cursor;
            let label = preset_label(index);
            let detail = PRESETS
                .get(index)
                .map(|preset| preset.default_base_url)
                .filter(|value| !value.is_empty())
                .unwrap_or("blank form");
            lines.push(Line::from(vec![
                Span::styled(
                    if selected { "› " } else { "  " },
                    Style::default().fg(theme.accent_user),
                ),
                Span::styled(
                    format!("{label:<20}"),
                    if selected { focused_style } else { value_style },
                ),
                Span::styled(detail.to_string(), dim),
            ]));
        }
        Paragraph::new(lines).render(content, buf);
        return;
    }

    let mut lines: Vec<Line<'static>> = Vec::new();
    if editing {
        lines.push(Line::from(vec![
            Span::styled("Editing provider ", Style::default().fg(theme.gray)),
            Span::styled(state.id.text().to_string(), focused_style),
            Span::styled(" (ID is fixed)", dim),
        ]));
    } else {
        lines.push(Line::from(vec![
            Span::styled("Template ", Style::default().fg(theme.gray)),
            Span::styled(preset_label(state.preset), focused_style),
        ]));
    }

    let rows = row_specs(state);
    let selected = rows.iter().position(|row| row.focused).unwrap_or(0);
    let footer_rows = 3 + usize::from(state.error.is_some());
    let available = (content.height as usize)
        .saturating_sub(lines.len() + footer_rows)
        .min(7);
    let range = centered_window(rows.len(), selected, available);
    lines.push(Line::from(Span::styled(
        format!(
            "Fields {}–{} of {}",
            range.start.saturating_add(1),
            range.end,
            rows.len()
        ),
        dim,
    )));

    const LABEL_WIDTH: usize = 16;
    let mut cursor_target = None;
    for row in &rows[range] {
        let id_locked = editing && row.field == Field::Id;
        let prefix = if row.focused { "› " } else { "  " };
        let cursor_row = content.y + lines.len() as u16;
        let empty = row.value.is_empty();
        let mut spans = vec![
            Span::styled(prefix, Style::default().fg(theme.accent_user)),
            Span::styled(
                format!("{:<LABEL_WIDTH$}", row.label),
                Style::default().fg(if id_locked {
                    theme.gray_dim
                } else {
                    theme.gray
                }),
            ),
        ];
        if id_locked {
            spans.push(Span::styled(row.value.clone(), dim));
        } else if empty {
            if row.focused {
                spans.push(Span::styled("▏", value_style));
            }
            spans.push(Span::styled(
                row.placeholder
                    .clone()
                    .unwrap_or_else(|| "(unset)".to_string()),
                dim,
            ));
        } else {
            spans.push(Span::styled(row.value.clone(), value_style));
        }
        lines.push(Line::from(spans));

        if row.focused
            && !empty
            && !id_locked
            && !matches!(row.field, Field::Api | Field::CredentialSource)
        {
            let label_width = "› ".width() + LABEL_WIDTH;
            let x = content.x + (label_width + row.cursor_col) as u16;
            if x < content.x.saturating_add(content.width) {
                cursor_target = Some((x, cursor_row));
            }
        }
    }

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(credential_summary(state), dim)));
    lines.push(Line::from(Span::styled(AUTH_NOTE, dim)));
    if let Some(error) = &state.error {
        lines.push(Line::from(Span::styled(
            error.as_str().to_string(),
            Style::default()
                .fg(theme.accent_error)
                .add_modifier(Modifier::BOLD),
        )));
    }

    Paragraph::new(lines).render(content, buf);
    if let Some((x, y)) = cursor_target
        && let Some(cell) = buf.cell_mut((x, y))
    {
        cell.set_style(Style::default().fg(theme.bg_dark).bg(theme.text_primary));
    }
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
        assert!(state.choosing_preset);
        assert_eq!(state.form().id, "deepseek");
        assert_eq!(state.form().display_name, "DeepSeek");
        assert_eq!(state.form().api_key_env, "DEEPSEEK_API_KEY");
        assert_eq!(state.form().api, "");

        state.apply_preset(1);
        assert_eq!(state.form().id, "ocx");
        assert_eq!(state.form().display_name, "OpenCodex");
        assert_eq!(state.form().api_key_env, "OCX_API_KEY");
        assert_eq!(state.form().api, "openai-responses");
        assert_eq!(state.form().base_url, "http://127.0.0.1:10100/v1");

        state.apply_preset(PRESETS.len());
        assert_eq!(state.form().id, "");
        assert_eq!(state.form().display_name, "");
        assert_eq!(state.form().api_key_env, "");
        assert_eq!(state.form().base_url, "");
    }

    #[test]
    fn existing_provider_templates_are_not_offered_again() {
        let state = AddProviderModalState::new_for_existing(&[
            "deepseek".to_string(),
            "openai".to_string(),
        ]);
        assert_eq!(state.templates, vec![1, 3, 4, PRESETS.len()]);
        assert_eq!(state.preset, 1);
        assert_eq!(state.form().id, "ocx");
    }

    #[test]
    fn template_picker_uses_up_down_then_enters_the_form() {
        let mut state = AddProviderModalState::new();
        assert_eq!(state.preset, 0);
        handle_add_provider_key(&mut state, &key(KeyCode::Down));
        assert_eq!(state.preset, 1);
        assert_eq!(state.form().id, "ocx");
        handle_add_provider_key(&mut state, &key(KeyCode::Up));
        assert_eq!(state.preset, 0);
        handle_add_provider_key(&mut state, &key(KeyCode::Up));
        assert_eq!(state.preset, 0, "template selection clamps at the top");
        handle_add_provider_key(&mut state, &key(KeyCode::End));
        assert_eq!(state.preset, PRESETS.len());
        handle_add_provider_key(&mut state, &key(KeyCode::Enter));
        assert!(!state.choosing_preset);
        assert_eq!(state.field, Field::Id);
    }

    #[test]
    fn tab_cycles_fields_and_left_right_cycles_protocol() {
        let mut state = AddProviderModalState::new();
        state.apply_preset(1);
        state.choosing_preset = false;
        assert_eq!(state.field, Field::Id);
        handle_add_provider_key(&mut state, &key(KeyCode::Tab));
        assert_eq!(state.field, Field::DisplayName);
        handle_add_provider_key(&mut state, &key(KeyCode::Tab));
        assert_eq!(state.field, Field::Api);
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
        // Enter on the template picker advances into the form; validation fires
        // on Enter from any field row.
        handle_add_provider_key(&mut state, &key(KeyCode::Enter));
        assert_eq!(state.field, Field::Id);
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
        let credential = crate::acp::model_state::ProviderCredentialInfo {
            configured: true,
            source: Some("file".to_string()),
            writable: true,
        };
        let mut state = AddProviderModalState::prefilled(
            "acme-gw",
            "Acme",
            "ACME_KEY",
            Some("openai-completions"),
            "https://acme.test/v1",
            Some(credential),
        );
        assert_eq!(state.editing.as_deref(), Some("acme-gw"));
        assert!(!state.choosing_preset);
        assert_eq!(state.form().id, "acme-gw");
        assert_eq!(state.form().display_name, "Acme");
        assert_eq!(state.form().api_key_env, "ACME_KEY");
        assert_eq!(state.form().api, "openai-completions");
        assert_eq!(state.form().base_url, "https://acme.test/v1");
        assert!(credential_summary(&state).contains("saved key"));
        assert_eq!(state.field, Field::DisplayName);
        let mut visited = Vec::new();
        for _ in 0..6 {
            handle_add_provider_key(&mut state, &key(KeyCode::Tab));
            visited.push(state.field);
        }
        assert_eq!(
            visited,
            vec![
                Field::Api,
                Field::BaseUrl,
                Field::CredentialSource,
                Field::ApiKeyEnv,
                Field::ApiKey,
                Field::DisplayName,
            ]
        );
        assert!(!visited.contains(&Field::Id));
    }

    #[test]
    fn unset_api_prefills_the_unset_picker_slot_and_submits_empty() {
        let mut state = AddProviderModalState::prefilled("acme-gw", "", "", None, "", None);
        assert_eq!(state.api_idx, APIS.len());
        assert_eq!(state.form().api, "");
        handle_add_provider_key(&mut state, &key(KeyCode::Tab));
        assert_eq!(state.field, Field::Api);
        handle_add_provider_key(&mut state, &key(KeyCode::Right));
        assert_eq!(state.form().api, APIS[0]);
    }

    #[test]
    fn field_window_tracks_focus_without_scroll_state() {
        assert_eq!(centered_window(7, 0, 3), 0..3);
        assert_eq!(centered_window(7, 3, 3), 2..5);
        assert_eq!(centered_window(7, 6, 3), 4..7);
        assert_eq!(centered_window(7, 2, 7), 0..7);
    }

    #[test]
    fn credential_source_toggle_clears_and_skips_the_saved_key_field() {
        let mut state = AddProviderModalState::new();
        state.choosing_preset = false;
        state.field = Field::CredentialSource;
        state.api_key.set_text("secret");

        handle_add_provider_key(&mut state, &key(KeyCode::Right));
        assert_eq!(state.credential_source, CredentialSource::Environment);
        assert_eq!(state.api_key.text(), "");
        handle_add_provider_key(&mut state, &key(KeyCode::Down));
        assert_eq!(state.field, Field::ApiKeyEnv);
        handle_add_provider_key(&mut state, &key(KeyCode::Down));
        assert_eq!(state.field, Field::Id, "API key is skipped in env mode");
        assert_eq!(state.form().credential_source.wire(), "environment");
    }

    #[test]
    fn empty_catalog_endpoint_is_a_display_hint_not_a_submitted_override() {
        let mut state = AddProviderModalState::new();
        state.apply_preset(2);
        state.choosing_preset = false;
        let base = row_specs(&state)
            .into_iter()
            .find(|row| row.field == Field::BaseUrl)
            .unwrap();
        assert_eq!(state.form().base_url, "");
        assert_eq!(
            base.placeholder.as_deref(),
            Some("default: https://api.openai.com/v1")
        );
    }
}
