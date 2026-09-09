//! Native child inboxes and session reminders, using the existing modal and editor.
use super::modal_window::{self, ModalWindowConfig, ModalWindowState};
use crate::theme::Theme;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{
    buffer::Buffer,
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    widgets::{
        List, ListItem, ListState, Paragraph, StatefulWidget, StatefulWidgetRef, Widget, Wrap,
    },
};
use serde_json::{Value, json};
use xai_ratatui_textarea::{TextArea, TextAreaState};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeControlTarget {
    Inbox { child_id: Option<String> },
    Reminders,
    Presets,
    Terminals,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct NativeControlItem {
    pub id: String,
    pub text: String,
    pub detail: String,
    pub editable: bool,
}

#[derive(Debug, serde::Deserialize)]
pub struct PresetDocument {
    pub id: String,
    pub content: String,
    #[serde(rename = "editPath")]
    pub edit_path: Option<std::path::PathBuf>,
}

#[derive(Debug, serde::Deserialize)]
pub struct NativeControlList {
    pub title: String,
    pub items: Vec<NativeControlItem>,
    #[serde(default)]
    pub document: Option<PresetDocument>,
}

pub enum NativeControlOutcome {
    Changed,
    Close,
    Request { method: &'static str, params: Value },
}

struct Edit {
    action: &'static str,
    message_id: Option<String>,
    expected_text: Option<String>,
    text: TextArea,
    viewport: TextAreaState,
}

pub struct NativeControls {
    pub target: NativeControlTarget,
    pub title: String,
    pub items: Vec<NativeControlItem>,
    pub window: ModalWindowState,
    pub nonce: String,
    pub busy: bool,
    pub error: Option<String>,
    selection: ListState,
    all_items: Vec<NativeControlItem>,
    query: String,
    searching: bool,
    closing: Option<String>,
    notice: Option<String>,
    edit: Option<Edit>,
    submitted: bool,
    detail_scroll: u16,
}

impl NativeControls {
    pub fn new(target: NativeControlTarget) -> Self {
        let title = match &target {
            NativeControlTarget::Presets => "Agent presets",
            NativeControlTarget::Terminals => "Persistent terminals",
            NativeControlTarget::Reminders => "Session reminders",
            NativeControlTarget::Inbox { child_id: None } => "Child conversations",
            NativeControlTarget::Inbox { .. } => "Child input queue",
        }
        .into();
        Self {
            target,
            title,
            items: vec![],
            window: ModalWindowState::default(),
            nonce: uuid::Uuid::new_v4().to_string(),
            busy: false,
            error: None,
            selection: ListState::default().with_selected(Some(0)),
            all_items: vec![],
            query: String::new(),
            searching: false,
            closing: None,
            notice: None,
            edit: None,
            submitted: false,
            detail_scroll: 0,
        }
    }

    pub fn refresh(&self) -> NativeControlOutcome {
        match &self.target {
            NativeControlTarget::Terminals => NativeControlOutcome::Request {
                method: "x.ai/terminals",
                params: json!({"terminalId": self.selected_item().map(|item| &item.id)}),
            },
            NativeControlTarget::Presets => NativeControlOutcome::Request {
                method: "x.ai/presets",
                params: json!({}),
            },
            NativeControlTarget::Inbox { child_id } => NativeControlOutcome::Request {
                method: "x.ai/subagent/inbox",
                params: json!({ "childId": child_id }),
            },
            NativeControlTarget::Reminders => NativeControlOutcome::Request {
                method: "x.ai/scheduler/list",
                params: json!({}),
            },
        }
    }

    pub fn can_poll(&self) -> bool {
        !self.busy && self.edit.is_none() && self.error.is_none() && self.closing.is_none()
    }

    pub fn loaded(&mut self, result: Result<NativeControlList, String>) {
        self.busy = false;
        match result {
            Ok(list) => {
                let copied = self
                    .edit
                    .as_ref()
                    .filter(|edit| self.submitted && edit.action == "copy")
                    .map(|edit| edit.text.text().trim().to_string());
                let selected = copied
                    .clone()
                    .or_else(|| self.selected_item().map(|item| item.id.clone()));
                if let Some(id) = copied {
                    self.query.clear();
                    self.notice = Some(format!("Copied {id}. Press e to edit."));
                }
                self.title = list.title;
                self.all_items = list.items;
                self.filter(selected.as_deref());
                if self.submitted {
                    self.edit = None;
                }
                self.closing = None;
                self.error = None;
            }
            Err(error) => self.error = Some(error),
        }
        self.submitted = false;
    }

    fn selected_item(&self) -> Option<&NativeControlItem> {
        self.selection.selected().and_then(|i| self.items.get(i))
    }

    fn filter(&mut self, selected: Option<&str>) {
        let query = self.query.to_lowercase();
        self.items = self
            .all_items
            .iter()
            .filter(|item| {
                [&item.id, &item.text, &item.detail]
                    .iter()
                    .any(|text| text.to_lowercase().contains(&query))
            })
            .cloned()
            .collect();
        let index = selected
            .and_then(|id| self.items.iter().position(|item| item.id == id))
            .unwrap_or(0);
        self.selection
            .select((!self.items.is_empty()).then_some(index));
    }

    fn begin_edit(&mut self, action: &'static str, item: Option<NativeControlItem>) {
        let mut text = TextArea::new();
        let initial = item.as_ref().map(|item| item.text.as_str()).unwrap_or("");
        text.insert_str(&initial.replace("\r\n", "\n").replace('\r', "\n"));
        self.edit = Some(Edit {
            action,
            message_id: item.as_ref().map(|item| item.id.clone()),
            expected_text: item.map(|item| item.text),
            text,
            viewport: TextAreaState::default(),
        });
        self.error = None;
        self.notice = None;
    }

    pub fn paste(&mut self, text: &str) {
        if self.searching && !self.busy {
            self.query.extend(text.chars().filter(|c| !c.is_control()));
            self.filter(None);
            return;
        }
        if !self.busy
            && let Some(edit) = &mut self.edit
        {
            edit.text
                .insert_str(&text.replace("\r\n", "\n").replace('\r', "\n"));
        }
    }

    pub fn key(&mut self, key: &KeyEvent) -> NativeControlOutcome {
        use NativeControlOutcome::*;
        if key.code == KeyCode::Esc {
            if self.busy {
                return Close;
            }
            if self.closing.take().is_some() {
                return Changed;
            }
            if self.edit.take().is_some() {
                self.error = None;
                return Changed;
            }
            if self.searching || !self.query.is_empty() {
                self.searching = false;
                self.query.clear();
                let selected = self.selected_item().map(|item| item.id.clone());
                self.filter(selected.as_deref());
                return Changed;
            }
            return Close;
        }
        if self.busy {
            return Changed;
        }
        if let Some(id) = &self.closing {
            return if key.code == KeyCode::Enter {
                Request {
                    method: "x.ai/terminals",
                    params: json!({"action": "close", "terminalId": id}),
                }
            } else {
                Changed
            };
        }
        if self.searching {
            match key.code {
                KeyCode::Enter => self.searching = false,
                KeyCode::Backspace => {
                    self.query.pop();
                }
                KeyCode::Char('u') if key.modifiers == KeyModifiers::CONTROL => self.query.clear(),
                KeyCode::Char(c)
                    if !key.modifiers.intersects(
                        KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER,
                    ) =>
                {
                    self.query.push(c)
                }
                _ => return Changed,
            }
            self.filter(None);
            self.detail_scroll = 0;
            return Changed;
        }
        if let Some(edit) = &mut self.edit {
            if key.code == KeyCode::Enter
                && !key
                    .modifiers
                    .intersects(KeyModifiers::SHIFT | KeyModifiers::ALT)
            {
                if edit.text.text().trim().is_empty() {
                    self.error = Some("Enter a message.".into());
                    return Changed;
                }
                self.submitted = true;
                return match &self.target {
                    NativeControlTarget::Terminals => Changed,
                    NativeControlTarget::Presets => Request {
                        method: "x.ai/presets",
                        params: json!({"action": "copy", "from": edit.message_id, "id": edit.text.text().trim()}),
                    },
                    NativeControlTarget::Reminders => Request {
                        method: "x.ai/scheduler/create",
                        params: json!({"text": edit.text.text()}),
                    },
                    NativeControlTarget::Inbox { child_id } => Request {
                        method: "x.ai/subagent/inbox",
                        params: json!({"childId": child_id, "action": edit.action, "messageId": edit.message_id, "expectedText": edit.expected_text, "text": edit.text.text()}),
                    },
                };
            }
            if key.code == KeyCode::Enter {
                edit.text.insert_str("\n");
            } else {
                edit.text.input(*key);
            }
            return Changed;
        }
        if key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER)
        {
            return Changed;
        }
        let selected = self.selection.selected().unwrap_or(0);
        let item = self.items.get(selected).cloned();
        match key.code {
            KeyCode::Char('/') if matches!(self.target, NativeControlTarget::Presets) => {
                self.searching = true;
                self.notice = None;
            }
            KeyCode::Home | KeyCode::End => {
                self.selection.select((!self.items.is_empty()).then_some(
                    if key.code == KeyCode::Home {
                        0
                    } else {
                        self.items.len().saturating_sub(1)
                    },
                ));
                self.detail_scroll = 0;
            }
            KeyCode::Char('i') if matches!(self.target, NativeControlTarget::Terminals) => {
                if let Some(item) = item {
                    return Request {
                        method: "x.ai/terminals",
                        params: json!({"action": "interrupt", "terminalId": item.id}),
                    };
                }
            }
            KeyCode::Enter | KeyCode::Char('v')
                if matches!(self.target, NativeControlTarget::Terminals) =>
            {
                return self.refresh();
            }
            KeyCode::Char('c') if matches!(self.target, NativeControlTarget::Presets) => {
                if let Some(mut item) = item {
                    item.text.clear();
                    self.begin_edit("copy", Some(item));
                }
            }
            KeyCode::Char('v') | KeyCode::Enter | KeyCode::Char('e')
                if matches!(self.target, NativeControlTarget::Presets) =>
            {
                if let Some(item) = item {
                    if key.code == KeyCode::Char('e') && !item.editable {
                        self.error = Some("Press c to copy this preset before editing it.".into());
                        return Changed;
                    }
                    return Request {
                        method: "x.ai/presets",
                        params: json!({"action": if key.code == KeyCode::Char('e') {"edit"} else {"read"}, "id": item.id}),
                    };
                }
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.selection.select(Some(selected.saturating_sub(1)));
                self.detail_scroll = 0;
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.selection
                    .select(Some((selected + 1).min(self.items.len().saturating_sub(1))));
                self.detail_scroll = 0;
            }
            KeyCode::PageDown => self.detail_scroll = self.detail_scroll.saturating_add(5),
            KeyCode::PageUp => self.detail_scroll = self.detail_scroll.saturating_sub(5),
            KeyCode::Char('r') => return self.refresh(),
            KeyCode::Enter
                if matches!(self.target, NativeControlTarget::Inbox { child_id: None }) =>
            {
                if let Some(item) = item {
                    self.target = NativeControlTarget::Inbox {
                        child_id: Some(item.id),
                    };
                    self.items.clear();
                    return self.refresh();
                }
            }
            KeyCode::Char('a')
                if matches!(
                    self.target,
                    NativeControlTarget::Reminders
                        | NativeControlTarget::Inbox { child_id: Some(_) }
                ) =>
            {
                self.begin_edit("queue", None)
            }
            KeyCode::Char('s')
                if matches!(
                    self.target,
                    NativeControlTarget::Inbox { child_id: Some(_) }
                ) =>
            {
                self.begin_edit("steer", None)
            }
            KeyCode::Char('e') | KeyCode::Enter
                if matches!(
                    self.target,
                    NativeControlTarget::Inbox { child_id: Some(_) }
                ) =>
            {
                if let Some(item) = item.filter(|item| item.editable) {
                    self.begin_edit("edit", Some(item));
                }
            }
            KeyCode::Char('x') => {
                if let Some(item) = item {
                    return match &self.target {
                        NativeControlTarget::Terminals => {
                            self.closing = Some(item.id);
                            Changed
                        }
                        NativeControlTarget::Reminders => Request {
                            method: "x.ai/scheduler/delete",
                            params: json!({"taskId": item.id}),
                        },
                        NativeControlTarget::Inbox { child_id: Some(id) } => Request {
                            method: "x.ai/subagent/inbox",
                            params: json!({"childId": id, "action": "remove", "messageId": item.id}),
                        },
                        _ => Changed,
                    };
                }
            }
            KeyCode::Char('i')
                if matches!(
                    self.target,
                    NativeControlTarget::Inbox { child_id: Some(_) }
                ) =>
            {
                if let Some(item) = item {
                    return self.inbox_action("steer-queued", Some(item.id));
                }
            }
            KeyCode::Char('X') => return self.inbox_action("clear", None),
            KeyCode::Char('S') => return self.inbox_action("stop", None),
            _ => {}
        }
        Changed
    }

    fn inbox_action(
        &self,
        action: &'static str,
        message_id: Option<String>,
    ) -> NativeControlOutcome {
        match &self.target {
            NativeControlTarget::Inbox { child_id: Some(id) } => NativeControlOutcome::Request {
                method: "x.ai/subagent/inbox",
                params: json!({"childId": id, "action": action, "messageId": message_id}),
            },
            _ => NativeControlOutcome::Changed,
        }
    }

    pub fn render(&mut self, buf: &mut Buffer, area: Rect) {
        let theme = Theme::current();
        let config = ModalWindowConfig {
            title: &self.title,
            tabs: None,
            shortcuts: &[],
            sizing: Default::default(),
            fold_info: None,
        };
        let Some(content) =
            modal_window::render_modal_window(buf, area, &mut self.window, &config, &theme)
        else {
            return;
        };
        let area = content.content;
        let hints = if self.closing.is_some() {
            "Enter: close terminal and its processes · Esc: cancel"
        } else if self.searching {
            "Type to filter · Enter: select results · Esc: clear search"
        } else if self.edit.is_some() {
            "Enter: submit · Shift+Enter: newline · Esc: cancel edit"
        } else {
            match &self.target {
                NativeControlTarget::Presets => {
                    "/: search · c: copy · v: view · e: edit · Esc: back"
                }
                NativeControlTarget::Terminals => {
                    "i: interrupt command · x: close terminal · PgUp/PgDn: output · r: refresh · Esc: close"
                }
                NativeControlTarget::Reminders => "a: add · x: cancel · r: refresh · Esc: close",
                NativeControlTarget::Inbox { child_id: None } => {
                    "↑↓: select child · Enter: open queue · Esc: close"
                }
                NativeControlTarget::Inbox { .. } => {
                    "a: queue · s: steer · e: edit · x: remove · i: steer queued · X: clear · S: stop · Esc: close"
                }
            }
        };
        let note = match &self.target {
            NativeControlTarget::Presets => {
                "Copy a shipped preset to customize it. Edits take effect after restarting dscode; use /preset to select."
            }
            NativeControlTarget::Terminals => {
                "Shells live until closed or the session ends. Interrupt sends Ctrl+C; close ends the shell and its processes. Output: latest 1000 retained lines."
            }
            NativeControlTarget::Reminders => {
                "Delivery requires this session to stay open; overdue reminders resume with the session."
            }
            NativeControlTarget::Inbox { .. } => {
                "Only pending messages can be edited. Stopping a child preserves its queue."
            }
        };
        let [
            note_area,
            search_area,
            list_area,
            detail_area,
            status_area,
            hint_area,
        ] = Layout::vertical([
            Constraint::Length(2),
            Constraint::Length(if matches!(self.target, NativeControlTarget::Presets) {
                1
            } else {
                0
            }),
            Constraint::Percentage(40),
            Constraint::Min(3),
            Constraint::Length(2),
            Constraint::Length(2),
        ])
        .areas(area);
        Paragraph::new(note)
            .wrap(Wrap { trim: false })
            .render(note_area, buf);
        if search_area.height > 0 {
            Paragraph::new(format!(
                "Search: {}{}  ({}/{})",
                self.query,
                if self.searching { "▏" } else { "" },
                self.items.len(),
                self.all_items.len()
            ))
            .render(search_area, buf);
        }
        if self.items.is_empty() {
            Paragraph::new(if self.busy {
                "Loading…"
            } else if !self.query.is_empty() {
                "No matching presets. Press Esc to clear search."
            } else if matches!(self.target, NativeControlTarget::Terminals) {
                "No persistent terminals in this session."
            } else {
                "No pending items."
            })
            .render(list_area, buf);
        } else {
            let rows = self.items.iter().map(|item| {
                ListItem::new(format!(
                    "{}\n{}",
                    item.text.lines().next().unwrap_or(""),
                    item.detail
                ))
            });
            StatefulWidget::render(
                List::new(rows)
                    .highlight_symbol("› ")
                    .highlight_style(Style::default().add_modifier(Modifier::REVERSED)),
                list_area,
                buf,
                &mut self.selection,
            );
        }
        if let Some(edit) = &mut self.edit {
            let [label, editor] =
                Layout::vertical([Constraint::Length(1), Constraint::Min(1)]).areas(detail_area);
            let label_text = if matches!(self.target, NativeControlTarget::Reminders) {
                "after 10m <message> / every 5m <message> / at <ISO date-time> <message>"
            } else {
                match edit.action {
                    "copy" => "New preset id (lowercase letters, digits and hyphens)",
                    "steer" => "Message for the next step",
                    "edit" => "Edit pending message",
                    _ => "Message for the next turn",
                }
            };
            Paragraph::new(label_text).render(label, buf);
            StatefulWidgetRef::render_ref(&&edit.text, editor, buf, &mut edit.viewport);
            if let Some((x, y)) = edit.text.cursor_pos_with_state(editor, edit.viewport) {
                if let Some(cell) = buf.cell_mut((x, y)) {
                    cell.set_style(Style::default().add_modifier(Modifier::REVERSED));
                }
            }
        } else if let Some(item) = self.selection.selected().and_then(|i| self.items.get(i)) {
            let detail = Paragraph::new(item.text.as_str()).wrap(Wrap { trim: false });
            let max_scroll = detail
                .line_count(detail_area.width)
                .saturating_sub(usize::from(detail_area.height))
                .min(usize::from(u16::MAX)) as u16;
            self.detail_scroll = self.detail_scroll.min(max_scroll);
            detail
                .scroll((self.detail_scroll, 0))
                .render(detail_area, buf);
        }
        let closing = self
            .closing
            .as_ref()
            .map(|id| format!("Close {id}? Shell state and running processes will be lost."));
        Paragraph::new(
            self.error
                .as_deref()
                .or(closing.as_deref())
                .unwrap_or(if self.busy {
                    "Updating…"
                } else {
                    self.notice.as_deref().unwrap_or("")
                }),
        )
        .wrap(Wrap { trim: false })
        .render(status_area, buf);
        Paragraph::new(hints)
            .wrap(Wrap { trim: false })
            .render(hint_area, buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn key(state: &mut NativeControls, code: KeyCode) -> NativeControlOutcome {
        state.key(&KeyEvent::new(code, KeyModifiers::NONE))
    }
    fn presets(count: usize) -> NativeControlList {
        NativeControlList {
            title: "presets".into(),
            document: None,
            items: (0..count)
                .map(|i| NativeControlItem {
                    id: format!("preset-{i}"),
                    text: format!("Preset {i}\nDescription {i}"),
                    detail: format!("preset-{i} · user"),
                    editable: true,
                })
                .collect(),
        }
    }
    #[test]
    fn output_scroll_clamps_at_the_last_wrapped_page() {
        let mut state = NativeControls::new(NativeControlTarget::Terminals);
        let mut list = presets(1);
        list.items[0].text = format!("{}END_OF_OUTPUT", "long wrapped output ".repeat(200));
        state.loaded(Ok(list));
        state.detail_scroll = u16::MAX;
        let area = Rect::new(0, 0, 100, 45);
        let mut buffer = Buffer::empty(area);
        state.render(&mut buffer, area);
        let text = buffer
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(text.contains("END_OF_OUTPUT"));
        assert!(state.detail_scroll < u16::MAX);
    }
    #[test]
    fn preset_search_and_copy_focus_survive_refresh_and_failures() {
        let mut state = NativeControls::new(NativeControlTarget::Presets);
        state.loaded(Ok(presets(20)));
        key(&mut state, KeyCode::Char('/'));
        state.paste("DESCRIPTION 7");
        assert_eq!(state.items.len(), 1);
        key(&mut state, KeyCode::Enter);
        key(&mut state, KeyCode::Char('c'));
        state.paste("preset-20");
        let NativeControlOutcome::Request { params, .. } = key(&mut state, KeyCode::Enter) else {
            panic!()
        };
        assert_eq!(params["from"], "preset-7");
        state.loaded(Err("duplicate".into()));
        assert_eq!(state.edit.as_ref().unwrap().text.text(), "preset-20");
        key(&mut state, KeyCode::Enter);
        state.loaded(Ok(presets(21)));
        assert_eq!(state.selected_item().unwrap().id, "preset-20");
        assert!(state.query.is_empty());
        let NativeControlOutcome::Request { params, .. } = key(&mut state, KeyCode::Char('e'))
        else {
            panic!()
        };
        assert_eq!(params["id"], "preset-20");
        state.loaded(Ok(presets(21)));
        assert_eq!(state.selected_item().unwrap().id, "preset-20");
        key(&mut state, KeyCode::Char('/'));
        state.paste("not present");
        assert!(state.selected_item().is_none());
        assert!(matches!(
            key(&mut state, KeyCode::Esc),
            NativeControlOutcome::Changed
        ));
        assert_eq!(state.items.len(), 21);
    }
    #[test]
    fn terminal_close_requires_confirmation_and_interrupt_is_distinct() {
        let mut state = NativeControls::new(NativeControlTarget::Terminals);
        state.loaded(Ok(presets(1)));
        let NativeControlOutcome::Request { params, .. } = key(&mut state, KeyCode::Char('i'))
        else {
            panic!()
        };
        assert_eq!(params["action"], "interrupt");
        assert!(matches!(
            key(&mut state, KeyCode::Char('x')),
            NativeControlOutcome::Changed
        ));
        assert!(!state.can_poll());
        key(&mut state, KeyCode::Esc);
        assert!(state.closing.is_none());
        key(&mut state, KeyCode::Char('x'));
        let NativeControlOutcome::Request { params, .. } = key(&mut state, KeyCode::Enter) else {
            panic!()
        };
        assert_eq!(params["action"], "close");
        state.loaded(Err("close failed".into()));
        assert_eq!(state.items.len(), 1);
        assert!(state.closing.is_some());
        state.loaded(Ok(presets(0)));
        assert!(state.items.is_empty());
    }
    #[test]
    fn failed_edit_preserves_multiline_text_and_expected_version() {
        let mut state = NativeControls::new(NativeControlTarget::Inbox {
            child_id: Some("child".into()),
        });
        state.loaded(Ok(NativeControlList {
            document: None,
            title: "queue".into(),
            items: vec![NativeControlItem {
                id: "m".into(),
                text: "one\ntwo".into(),
                detail: "queued".into(),
                editable: true,
            }],
        }));
        state.key(&KeyEvent::new(KeyCode::Char('e'), KeyModifiers::NONE));
        state.paste("\r\nthree\rfour");
        let NativeControlOutcome::Request { params, .. } =
            state.key(&KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
        else {
            panic!("expected edit request")
        };
        assert_eq!(params["expectedText"], "one\ntwo");
        assert_eq!(params["text"], "one\ntwo\nthree\nfour");
        state.loaded(Err("message already consumed".into()));
        assert_eq!(
            state.edit.as_ref().unwrap().text.text(),
            "one\ntwo\nthree\nfour"
        );
        assert!(!state.can_poll());
    }
}
