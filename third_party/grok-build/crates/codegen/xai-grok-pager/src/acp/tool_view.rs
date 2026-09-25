//! DIVERGENCE(dscode): tool cards from a host's tool views.
//!
//! The dscode bridge sends each tool's own render intent (DSH's
//! `presentCall` / `presentResult`) as `_meta['dscode/view']`: the call view
//! on the `tool_call`, the result view on its final `tool_call_update`. Each
//! view kind maps onto a card the TUI already has, keyed on the view and never
//! on a tool name: `terminal` → Execute, `diff` → Edit, `read` → Read,
//! `search` → Search, `web` → WebSearch / WebFetch, `generic` → Other (an
//! `execute` kind stays Execute; a pending file read, search or fetch keeps its
//! card family while it runs). A call without a view renders as before.
use super::{
    Path, RAW_INPUT_MAX_LINES, RenderBlock, content_text, execute_command_from_tool_call,
    extract_edit_error, extract_raw_field, extract_search_meta, fill_non_shell_execute,
    make_relative_path, peeled_if_changed, tool_call_title, tool_name, value_display,
};
use crate::scrollback::blocks::tool::search::{
    SearchFileMatch, SearchLineMatch, SearchToolCallBlock,
};
use crate::scrollback::blocks::tool::{
    EditToolCallBlock, ExecuteToolCallBlock, LineRange, OtherToolCallBlock, ReadToolCallBlock,
    ToolCallBlock, WebFetchToolCallBlock, WebSearchToolCallBlock,
};
use agent_client_protocol as acp;
use serde::Deserialize;
use serde_json::Value;

/// The `_meta` key a host's tool view rides under.
pub(super) const VIEW_KEY: &str = "dscode/view";
/// Where a final merge keeps the result view, so the call view stays beside it.
pub(super) const RESULT_VIEW_KEY: &str = "dscode/resultView";

/// A settling update's view moves to [`RESULT_VIEW_KEY`] before the merge, so
/// the call's own view (its command, cwd, pattern) is kept for the card.
pub(super) fn settled_meta(update: Option<acp::Meta>) -> Option<acp::Meta> {
    update.map(|mut meta| {
        if let Some(view) = meta.remove(VIEW_KEY) {
            meta.insert(RESULT_VIEW_KEY.into(), view);
        }
        meta
    })
}

/// The card a notification's view names, for the debug log: `none` without one.
pub(super) fn view_card(meta: Option<&acp::Meta>) -> &str {
    meta.and_then(|m| m.get(VIEW_KEY))
        .and_then(|view| view.get("card"))
        .and_then(Value::as_str)
        .unwrap_or("none")
}

#[derive(Debug, Deserialize)]
struct TextBlock {
    #[serde(default)]
    text: String,
}
#[derive(Debug, Deserialize)]
struct Location {
    path: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileDiff {
    path: String,
    #[serde(default)]
    old_text: Option<String>,
    new_text: String,
}
#[derive(Debug, Deserialize)]
struct DiffView {
    #[serde(default)]
    diffs: Vec<FileDiff>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenericCall {
    title: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    raw_input: Option<Value>,
    #[serde(default)]
    content: Option<Vec<TextBlock>>,
    #[serde(default)]
    locations: Vec<Location>,
}
#[derive(Debug, Deserialize)]
struct TerminalCall {
    title: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "card", rename_all = "lowercase")]
enum CallView {
    Generic(GenericCall),
    Terminal(TerminalCall),
    Diff(DiffView),
}
#[derive(Debug, Deserialize)]
struct GenericResult {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    content: Option<Vec<TextBlock>>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalResult {
    #[serde(default)]
    output: Option<String>,
    #[serde(default)]
    exit_code: Option<i64>,
    #[serde(default)]
    signal: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LineMatch {
    line_number: usize,
    line: String,
}
#[derive(Debug, Deserialize)]
struct FileMatches {
    path: String,
    matches: Vec<LineMatch>,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "shape", rename_all = "lowercase")]
enum SearchResult {
    Matches {
        files: Vec<FileMatches>,
        truncated: bool,
        total: usize,
    },
    Paths {
        paths: Vec<String>,
        truncated: bool,
        total: usize,
    },
}
#[derive(Debug, Deserialize)]
struct ReadLine {
    number: usize,
    text: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadResult {
    path: String,
    offset: usize,
    lines: Vec<ReadLine>,
    total_lines: usize,
}
#[derive(Debug, Deserialize)]
struct Source {
    url: String,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum WebResult {
    Search {
        #[serde(default)]
        title: Option<String>,
        sources: Vec<Source>,
        #[serde(default)]
        answer: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Fetch { url: String, status_code: u16 },
}
#[derive(Debug, Deserialize)]
#[serde(tag = "card", rename_all = "lowercase")]
enum ResultView {
    Generic(GenericResult),
    Terminal(TerminalResult),
    Diff(DiffView),
    Search(SearchResult),
    Read(ReadResult),
    Web(WebResult),
}

fn view<T: for<'de> Deserialize<'de>>(tc: &acp::ToolCall, key: &str) -> Option<T> {
    let value = tc.meta.as_ref()?.get(key)?;
    serde_json::from_value(value.clone()).ok()
}
fn texts(blocks: &[TextBlock]) -> String {
    blocks
        .iter()
        .map(|block| block.text.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The card a host's tool view asks for, or `None` when the call carries no
/// view the TUI understands (it then renders as before).
pub(super) fn view_block(tc: &acp::ToolCall, session_cwd: Option<&Path>) -> Option<RenderBlock> {
    let call: Option<CallView> = view(tc, VIEW_KEY);
    let result: Option<ResultView> = view(tc, RESULT_VIEW_KEY);
    let success = !matches!(tc.status, acp::ToolCallStatus::Failed);
    let block = match (result, call) {
        (None, None) => return None,
        (Some(ResultView::Read(read)), _) => read_block(&read),
        (Some(ResultView::Search(search)), call) => search_block(tc, search, call.as_ref()),
        (Some(ResultView::Web(web)), call) => web_block(tc, web, call.as_ref(), success),
        (Some(ResultView::Diff(diff)), call) => {
            let call = match &call {
                Some(CallView::Diff(call)) => Some(call),
                _ => None,
            };
            edit_block(tc, Some(&diff), call, success)
        }
        (Some(ResultView::Terminal(done)), Some(CallView::Terminal(call))) => {
            terminal_block(tc, Some(&call), Some(&done), success, session_cwd)
        }
        (Some(ResultView::Terminal(done)), _) => {
            terminal_block(tc, None, Some(&done), success, session_cwd)
        }
        // A generic result on a terminal (a failure, a background run) or a
        // diff (a failed edit) keeps the call's card, with the raw result.
        (_, Some(CallView::Terminal(call))) => {
            terminal_block(tc, Some(&call), None, success, session_cwd)
        }
        (_, Some(CallView::Diff(call))) => edit_block(tc, None, Some(&call), success),
        // An execute of no terminal (a background run, code): the Execute
        // card any execute call has, from the call's own input.
        (_, Some(CallView::Generic(call))) if call.kind.as_deref() == Some("execute") => {
            execute_block(tc, success, session_cwd)
        }
        (Some(ResultView::Generic(result)), Some(CallView::Generic(call))) => {
            generic_block(tc, Some(&call), Some(&result), success)
        }
        (None, Some(CallView::Generic(call))) => generic_block(tc, Some(&call), None, success),
        (Some(ResultView::Generic(result)), None) => {
            generic_block(tc, None, Some(&result), success)
        }
    };
    Some(RenderBlock::ToolCall(block))
}

/// A shell command: the call view's command, description and cwd; the
/// result's text and the view's exit status (a non-zero exit or a signal is
/// the card's error, as for a Bash-shaped result).
fn terminal_block(
    tc: &acp::ToolCall,
    call: Option<&TerminalCall>,
    result: Option<&TerminalResult>,
    success: bool,
    session_cwd: Option<&Path>,
) -> ToolCallBlock {
    let command = call.map_or_else(|| execute_command_from_tool_call(tc), |c| c.title.clone());
    let mut block = ExecuteToolCallBlock::new(command.clone());
    block.header_display = peeled_if_changed(&command, session_cwd);
    if let Some(description) = call.and_then(|c| c.description.clone()) {
        block = block.with_description(description);
    }
    // The working directory, when it is not the session's, shows expanded.
    if let Some(cwd) = call.and_then(|c| c.cwd.as_deref())
        && session_cwd != Some(Path::new(cwd))
    {
        block.input = Some(format!("cwd: {cwd}"));
    }
    match result {
        Some(done) => {
            // The tool's own text, exit marker included: the card has no
            // exit-status pill, so the view's marker-free output is the fallback.
            let text = content_text(tc);
            block.output = if text.is_empty() {
                done.output.clone()
            } else {
                Some(text)
            };
            let exit = done.exit_code.unwrap_or(0);
            if !success || exit != 0 || done.signal.is_some() {
                block.error = Some(match &done.signal {
                    Some(signal) => signal.clone(),
                    None if exit != 0 => format!("exit code {exit}"),
                    None => "Command failed".into(),
                });
            }
        }
        None => {
            let text = content_text(tc);
            if !success {
                block.error = Some(if text.is_empty() {
                    "Command failed".into()
                } else {
                    text
                });
            } else if !text.is_empty() {
                block.output = Some(text);
            }
        }
    }
    ToolCallBlock::Execute(block)
}

/// An execute card without a terminal: the command (else the title),
/// description and result text, as the ACP `execute` kind renders.
fn execute_block(tc: &acp::ToolCall, success: bool, session_cwd: Option<&Path>) -> ToolCallBlock {
    let command = execute_command_from_tool_call(tc);
    let mut block = ExecuteToolCallBlock::new(command.clone());
    block.header_display = peeled_if_changed(&command, session_cwd);
    if let Some(description) = extract_raw_field(tc, "description") {
        block = block.with_description(description);
    }
    fill_non_shell_execute(&mut block, tc, success);
    ToolCallBlock::Execute(block)
}

/// A file change: hunks from the call's ACP `diff` content (else the view's
/// diffs), "Creating " when every diff of the result is a new file.
fn edit_block(
    tc: &acp::ToolCall,
    result: Option<&DiffView>,
    call: Option<&DiffView>,
    success: bool,
) -> ToolCallBlock {
    let diffs = result
        .or(call)
        .map(|d| d.diffs.as_slice())
        .unwrap_or_default();
    let path = diffs
        .first()
        .map(|d| d.path.clone())
        .unwrap_or_else(|| tool_call_title(tc).into_owned());
    let acp_diffs = tc
        .content
        .iter()
        .filter(|c| matches!(c, acp::ToolCallContent::Diff(_)))
        .count();
    let mut block = if !success {
        EditToolCallBlock::new(path, vec![]).with_error(extract_edit_error(tc))
    } else if acp_diffs > 0 || result.is_none() {
        EditToolCallBlock::new(path, xai_grok_pager_diff::extract_edit_hunks(tc).0)
    } else {
        let from_view = tc.clone().content(
            diffs
                .iter()
                .map(|d| {
                    acp::ToolCallContent::Diff(
                        acp::Diff::new(d.path.clone(), d.new_text.clone())
                            .old_text(d.old_text.clone()),
                    )
                })
                .collect(),
        );
        EditToolCallBlock::new(path, xai_grok_pager_diff::extract_edit_hunks(&from_view).0)
    };
    if acp_diffs.max(diffs.len()) > 1 {
        block = block.with_untrusted_summary();
    }
    // Only a result knows the before-image: a call-time diff has none.
    if let Some(result) = result
        && !result.diffs.is_empty()
        && result.diffs.iter().all(|d| d.old_text.is_none())
    {
        block = block.with_prefix("Creating ");
    }
    ToolCallBlock::Edit(block)
}

/// A file read: the window's lines, its range when it is not the whole file.
fn read_block(read: &ReadResult) -> ToolCallBlock {
    let mut block = ReadToolCallBlock::new(&read.path);
    if let (Some(first), Some(last)) = (read.lines.first(), read.lines.last())
        && (read.offset > 1 || read.lines.len() < read.total_lines)
    {
        block = block.with_line_range(LineRange::new(first.number, last.number));
    }
    let content = read
        .lines
        .iter()
        .map(|line| line.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    ToolCallBlock::Read(block.with_content(content, read.total_lines))
}

/// A search call's pattern: its view's salient input, else its title.
fn search_pattern(tc: &acp::ToolCall, call: Option<&CallView>) -> String {
    match call {
        Some(CallView::Generic(GenericCall {
            raw_input: Some(Value::String(pattern)),
            ..
        })) => pattern.clone(),
        Some(CallView::Generic(call)) => call.title.clone(),
        _ => tool_call_title(tc).into_owned(),
    }
}

/// Grouped matches or a path list, "N of total" when the tool capped them.
fn search_block(
    tc: &acp::ToolCall,
    search: SearchResult,
    call: Option<&CallView>,
) -> ToolCallBlock {
    let mut block = SearchToolCallBlock::new(search_pattern(tc, call));
    block.meta = extract_search_meta(tc);
    match search {
        SearchResult::Matches {
            files,
            truncated,
            total,
        } => {
            let shown = files.iter().map(|file| file.matches.len()).sum();
            block.file_matches = files
                .into_iter()
                .map(|file| SearchFileMatch {
                    path: make_relative_path(&file.path),
                    matches: file
                        .matches
                        .into_iter()
                        .map(|m| SearchLineMatch {
                            line_number: m.line_number,
                            content: m.line,
                        })
                        .collect(),
                })
                .collect();
            block.match_count = total;
            block.shown = truncated.then_some(shown);
        }
        SearchResult::Paths {
            paths,
            truncated,
            total,
        } => {
            block.shown = truncated.then_some(paths.len());
            block.file_paths = paths.iter().map(|path| make_relative_path(path)).collect();
            block.match_count = total;
        }
    }
    ToolCallBlock::Search(block)
}

/// A web search (its cited sources) or a fetch (its URL and status).
fn web_block(
    tc: &acp::ToolCall,
    web: WebResult,
    call: Option<&CallView>,
    success: bool,
) -> ToolCallBlock {
    let text = content_text(tc);
    match web {
        WebResult::Search {
            title,
            sources,
            answer,
        } => {
            let query = title.unwrap_or_else(|| search_pattern(tc, call));
            let mut block = WebSearchToolCallBlock::new(query);
            block.citations = sources.into_iter().map(|source| source.url).collect();
            block.content = if text.is_empty() { answer } else { Some(text) };
            if !success {
                block = block.with_error("Web search failed");
            }
            ToolCallBlock::WebSearch(block)
        }
        WebResult::Fetch { url, status_code } => {
            let mut block = WebFetchToolCallBlock::new(url);
            block.status_code = Some(status_code);
            block.bytes = Some(text.len());
            if !text.is_empty() {
                block.output = Some(text);
            }
            if !success {
                block = block.with_error("Fetch failed");
            }
            ToolCallBlock::WebFetch(block)
        }
    }
}

/// A generic call. A file read on a location stays a Read card, and while
/// it runs a search or fetch of one salient input stays a Search or Fetch
/// card; anything else is the Other card: the view's title, its kind as the
/// summary, its salient input expanded and the (view's or raw) result text.
fn generic_block(
    tc: &acp::ToolCall,
    call: Option<&GenericCall>,
    result: Option<&GenericResult>,
    success: bool,
) -> ToolCallBlock {
    let kind = call.and_then(|c| c.kind.as_deref()).unwrap_or("other");
    let settled = matches!(
        tc.status,
        acp::ToolCallStatus::Completed | acp::ToolCallStatus::Failed
    );
    let salient = call
        .and_then(|c| c.raw_input.as_ref())
        .and_then(Value::as_str);
    if let Some(location) = call.and_then(|c| c.locations.first())
        && kind == "read"
    {
        let mut block = ReadToolCallBlock::new(&location.path);
        if !success {
            let text = content_text(tc);
            block = block.with_error(if text.is_empty() {
                "Read failed".into()
            } else {
                text
            });
        }
        return ToolCallBlock::Read(block);
    }
    match (settled, kind, salient) {
        (false, "search", Some(pattern)) => {
            let mut block = SearchToolCallBlock::new(pattern);
            block.meta = extract_search_meta(tc);
            return ToolCallBlock::Search(block);
        }
        (false, "fetch", Some(url)) => {
            return ToolCallBlock::WebFetch(WebFetchToolCallBlock::new(url));
        }
        _ => {}
    }
    let label = result
        .and_then(|r| r.title.clone())
        .or_else(|| call.map(|c| c.title.clone()))
        .unwrap_or_else(|| tool_call_title(tc).into_owned());
    let skill = tool_name(tc).eq_ignore_ascii_case("skill");
    let summary = if kind == "other" || skill { "" } else { kind };
    let mut block = OtherToolCallBlock::new(label, summary);
    block.input = match call.and_then(|c| c.raw_input.as_ref()) {
        Some(Value::String(text)) => text_display(text),
        Some(value) => value_display(value, &[]),
        None => None,
    };
    let raw = content_text(tc);
    let shown = match (
        result.and_then(|r| r.content.as_deref()),
        call.and_then(|c| c.content.as_deref()),
    ) {
        (Some(content), _) => texts(content),
        (None, _) if settled => raw.clone(),
        (None, Some(pending)) => texts(pending),
        (None, None) => String::new(),
    };
    // As the Other card always has: a failure is the error accent over the
    // same text.
    if !success {
        block.error = Some(if raw.is_empty() { "Failed".into() } else { raw });
    }
    if !shown.is_empty() {
        block.set_output_text(shown);
    }
    if skill {
        return ToolCallBlock::Skill(block);
    }
    ToolCallBlock::Other(block)
}

/// A salient string input as text, capped like any card input.
fn text_display(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return None;
    }
    let mut shown: Vec<String> = lines
        .iter()
        .take(RAW_INPUT_MAX_LINES)
        .map(|line| (*line).to_owned())
        .collect();
    if lines.len() > shown.len() {
        shown.push(format!("\u{2026} +{} lines", lines.len() - shown.len()));
    }
    Some(shown.join("\n"))
}

#[cfg(test)]
#[path = "tool_view_tests.rs"]
mod tests;
