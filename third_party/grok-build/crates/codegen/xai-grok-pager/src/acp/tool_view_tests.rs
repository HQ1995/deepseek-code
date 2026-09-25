//! Tool-view cards against the cards the same calls rendered before views:
//! `legacy` builds a call as the bridge sent it from its name tables,
//! `viewed` as it sends it with the tool's own views.
use super::super::{AcpUpdateTracker, merge_tool_call_update, tool_call_to_block};
use super::*;
use crate::acp::meta::NotificationMeta;
use crate::scrollback::block::BlockContent as _;
use crate::scrollback::state::ScrollbackState;
use crate::scrollback::types::{BlockContext, DisplayMode};
use serde_json::json;
use std::sync::Arc;

fn id() -> acp::ToolCallId {
    acp::ToolCallId::new(Arc::from("t1"))
}
fn text(body: &str) -> acp::ToolCallContent {
    acp::ToolCallContent::from(acp::ContentBlock::Text(acp::TextContent::new(
        body.to_string(),
    )))
}
fn diff(path: &str, old: Option<&str>, new: &str) -> acp::ToolCallContent {
    acp::ToolCallContent::Diff(
        acp::Diff::new(path.to_string(), new.to_string()).old_text(old.map(str::to_owned)),
    )
}
fn meta(entries: &[(&str, Value)]) -> acp::Meta {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}
fn update(
    status: acp::ToolCallStatus,
    content: Vec<acp::ToolCallContent>,
    raw_output: Option<Value>,
    view: Option<Value>,
) -> acp::ToolCallUpdate {
    let fields = acp::ToolCallUpdateFields::new()
        .status(Some(status))
        .content(Some(content))
        .raw_output(raw_output);
    let update = acp::ToolCallUpdate::new(id(), fields);
    match view {
        Some(view) => update.meta(meta(&[(VIEW_KEY, view)])),
        None => update,
    }
}
/// A settled call as the bridge sent it before views: its name as the title.
fn legacy(
    name: &str,
    kind: acp::ToolKind,
    args: Value,
    content: Vec<acp::ToolCallContent>,
    raw_output: Option<Value>,
) -> acp::ToolCall {
    let start = acp::ToolCall::new(id(), name)
        .kind(kind)
        .status(acp::ToolCallStatus::InProgress)
        .raw_input(Some(args));
    merge_tool_call_update(
        start,
        update(acp::ToolCallStatus::Completed, content, raw_output, None),
    )
}
/// The pending call as the bridge sends it with the tool's call view.
fn started(name: &str, kind: acp::ToolKind, args: Value, call: Value) -> acp::ToolCall {
    let title = call["title"].as_str().unwrap_or(name).to_owned();
    acp::ToolCall::new(id(), title)
        .kind(kind)
        .status(acp::ToolCallStatus::InProgress)
        .raw_input(Some(args))
        .meta(meta(&[
            ("x.ai/tool", json!({ "name": name })),
            (VIEW_KEY, call),
        ]))
}
/// The settled call with its call view and, when the tool presents one, its
/// result view.
fn viewed(
    name: &str,
    kind: acp::ToolKind,
    args: Value,
    call: Value,
    result: Option<Value>,
    status: acp::ToolCallStatus,
    content: Vec<acp::ToolCallContent>,
) -> acp::ToolCall {
    merge_tool_call_update(
        started(name, kind, args, call),
        update(status, content, None, result),
    )
}
fn render(tc: &acp::ToolCall, mode: DisplayMode) -> String {
    let ctx = BlockContext {
        width: 100,
        mode,
        is_running: false,
        raw: false,
        max_lines: None,
        appearance: Default::default(),
        is_selected: false,
        cwd: None,
    };
    tool_call_to_block(tc, Some(Path::new("/w")))
        .output(&ctx)
        .lines
        .iter()
        .map(|line| {
            line.content
                .spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}
fn both(tc: &acp::ToolCall) -> String {
    format!(
        "{}\n---\n{}",
        render(tc, DisplayMode::Collapsed),
        render(tc, DisplayMode::Expanded)
    )
}
fn bash_output(text: &str, exit: i64) -> Value {
    json!({ "type": "Bash", "output": text.as_bytes(), "output_for_prompt": text, "exit_code": exit,
        "command": "echo hi", "truncated": false, "signal": null, "timed_out": false, "description": "Say hi",
        "current_dir": "", "output_file": "", "total_bytes": text.len() })
}

#[test]
fn tool_view_terminal_renders_the_execute_card() {
    let _theme = crate::theme::cache::pin_theme();
    let args = json!({ "command": "echo hi", "description": "Say hi" });
    let call = json!({ "card": "terminal", "title": "echo hi", "description": "Say hi" });
    let ok = viewed(
        "bash",
        acp::ToolKind::Execute,
        args.clone(),
        call.clone(),
        Some(json!({ "card": "terminal", "output": "hi\n", "exitCode": 0 })),
        acp::ToolCallStatus::Completed,
        vec![text("hi\n")],
    );
    let before = legacy(
        "bash",
        acp::ToolKind::Execute,
        args.clone(),
        vec![text("hi\n")],
        Some(bash_output("hi\n", 0)),
    );
    assert_eq!(both(&ok), both(&before));
    insta::assert_snapshot!("tool_view_terminal", both(&ok));

    // A non-zero exit is the card's error; the marker is not repeated in
    // the output, which the result view already stripped.
    let failed = viewed(
        "bash",
        acp::ToolKind::Execute,
        args.clone(),
        call.clone(),
        Some(json!({ "card": "terminal", "output": "boom", "exitCode": 1 })),
        acp::ToolCallStatus::Completed,
        vec![text("boom\n[exit code: 1]")],
    );
    let RenderBlock::ToolCall(ToolCallBlock::Execute(block)) = tool_call_to_block(&failed, None)
    else {
        panic!("expected an execute card");
    };
    assert_eq!(block.error.as_deref(), Some("exit code 1"));
    assert_eq!(block.output.as_deref(), Some("boom\n[exit code: 1]"));
    let before = legacy(
        "bash",
        acp::ToolKind::Execute,
        args.clone(),
        vec![text("boom\n[exit code: 1]")],
        Some(bash_output("boom\n[exit code: 1]", 1)),
    );
    assert_eq!(both(&failed), both(&before));

    // A background run is a generic execute view: the Execute card any
    // execute call has, with its description (the Tasks row reads it).
    let background =
        json!({ "command": "sleep 60", "description": "Wait a minute", "run_in_background": true });
    let bg = viewed(
        "bash",
        acp::ToolKind::Execute,
        background.clone(),
        json!({ "card": "generic", "title": "sleep 60", "kind": "execute", "rawInput": "sleep 60",
            "content": [{ "type": "text", "text": "Wait a minute" }] }),
        Some(
            json!({ "card": "generic", "content": [{ "type": "text", "text": "```console\nstarted job j1\n```" }] }),
        ),
        acp::ToolCallStatus::Completed,
        vec![text("started job j1")],
    );
    let before = legacy(
        "bash",
        acp::ToolKind::Execute,
        background,
        vec![text("started job j1")],
        None,
    );
    assert_eq!(both(&bg), both(&before));
    let RenderBlock::ToolCall(ToolCallBlock::Execute(block)) = tool_call_to_block(&bg, None) else {
        panic!("expected an execute card");
    };
    assert_eq!(block.description.as_deref(), Some("Wait a minute"));

    // A generic result (an execution error) keeps the terminal card and
    // shows the raw text, not the view's fenced copy.
    let errored = viewed(
        "bash",
        acp::ToolKind::Execute,
        args.clone(),
        json!({ "card": "terminal", "title": "echo hi", "cwd": "/w/pkg" }),
        Some(
            json!({ "card": "generic", "content": [{ "type": "text", "text": "```console\nno shell\n```" }] }),
        ),
        acp::ToolCallStatus::Failed,
        vec![text("no shell")],
    );
    let RenderBlock::ToolCall(ToolCallBlock::Execute(block)) =
        tool_call_to_block(&errored, Some(Path::new("/w")))
    else {
        panic!("expected an execute card");
    };
    assert_eq!(block.error.as_deref(), Some("no shell"));
    assert_eq!(block.input.as_deref(), Some("cwd: /w/pkg"));
}

#[test]
fn tool_view_diff_renders_the_edit_card() {
    let _theme = crate::theme::cache::pin_theme();
    let args = json!({ "file_path": "/w/a.ts", "old_string": "1", "new_string": "2" });
    let hunk = json!({ "path": "/w/a.ts", "oldText": "const a = 1", "newText": "const a = 2" });
    let edit = viewed(
        "edit",
        acp::ToolKind::Edit,
        args.clone(),
        json!({ "card": "diff", "title": "Edit /w/a.ts", "diffs": [{ "path": "/w/a.ts", "oldText": "1", "newText": "2" }] }),
        Some(json!({ "card": "diff", "title": "Edit /w/a.ts", "diffs": [hunk] })),
        acp::ToolCallStatus::Completed,
        vec![
            text("Edited /w/a.ts"),
            diff("/w/a.ts", Some("const a = 1"), "const a = 2"),
        ],
    );
    let before = legacy(
        "edit",
        acp::ToolKind::Edit,
        args,
        vec![
            text("Edited /w/a.ts"),
            diff("/w/a.ts", Some("const a = 1"), "const a = 2"),
        ],
        None,
    );
    assert_eq!(both(&edit), both(&before));
    insta::assert_snapshot!("tool_view_edit", both(&edit));

    // A new file reads "Creating"; the diff rides the view when no ACP diff does.
    let created = viewed(
        "write",
        acp::ToolKind::Edit,
        json!({ "file_path": "/w/new.txt", "content": "one\ntwo\n" }),
        json!({ "card": "diff", "title": "Write /w/new.txt", "diffs": [{ "path": "/w/new.txt", "oldText": null, "newText": "one\ntwo\n" }] }),
        Some(
            json!({ "card": "diff", "title": "Write /w/new.txt", "diffs": [{ "path": "/w/new.txt", "oldText": null, "newText": "one\ntwo\n" }] }),
        ),
        acp::ToolCallStatus::Completed,
        vec![text("Wrote /w/new.txt")],
    );
    let shown = render(&created, DisplayMode::Collapsed);
    assert!(shown.contains("Creating new.txt"), "{shown}");
    insta::assert_snapshot!("tool_view_write", both(&created));

    // Pending, or failed without a result view: the path, no invented diff.
    let failed = viewed(
        "write",
        acp::ToolKind::Edit,
        json!({ "file_path": "/w/new.txt", "content": "x" }),
        json!({ "card": "diff", "title": "Write /w/new.txt", "diffs": [{ "path": "/w/new.txt", "oldText": null, "newText": "x" }] }),
        None,
        acp::ToolCallStatus::Failed,
        vec![text("permission denied")],
    );
    let RenderBlock::ToolCall(ToolCallBlock::Edit(block)) = tool_call_to_block(&failed, None)
    else {
        panic!("expected an edit card");
    };
    assert_eq!(block.path, "/w/new.txt");
    assert!(block.error.is_some());
}

#[test]
fn tool_view_read_renders_the_read_card_with_its_true_range() {
    let _theme = crate::theme::cache::pin_theme();
    let lines: Vec<Value> = (10..=12)
        .map(|n| json!({ "number": n, "text": format!("line {n}") }))
        .collect();
    let window = viewed(
        "read",
        acp::ToolKind::Read,
        json!({ "file_path": "/w/a.ts", "offset": 10, "limit": 3 }),
        json!({ "card": "generic", "title": "Read /w/a.ts (10 - 12)", "kind": "read", "locations": [{ "path": "/w/a.ts", "line": 10 }] }),
        Some(
            json!({ "card": "read", "path": "/w/a.ts", "offset": 10, "lines": lines, "totalLines": 40, "lang": "ts" }),
        ),
        acp::ToolCallStatus::Completed,
        vec![text("<path>/w/a.ts</path>")],
    );
    let RenderBlock::ToolCall(ToolCallBlock::Read(block)) = tool_call_to_block(&window, None)
    else {
        panic!("expected a read card");
    };
    assert_eq!(block.line_range.map(|r| (r.start, r.end)), Some((10, 12)));
    assert_eq!(block.content.as_deref(), Some("line 10\nline 11\nline 12"));
    assert_eq!(block.total_lines, Some(40));
    insta::assert_snapshot!("tool_view_read", both(&window));

    // A whole-file read names no range.
    let whole = viewed(
        "read",
        acp::ToolKind::Read,
        json!({ "file_path": "/w/a.ts" }),
        json!({ "card": "generic", "title": "Read /w/a.ts", "kind": "read", "locations": [{ "path": "/w/a.ts", "line": 1 }] }),
        Some(
            json!({ "card": "read", "path": "/w/a.ts", "offset": 1, "lines": [{ "number": 1, "text": "x" }], "totalLines": 1 }),
        ),
        acp::ToolCallStatus::Completed,
        vec![text("x")],
    );
    let RenderBlock::ToolCall(ToolCallBlock::Read(block)) = tool_call_to_block(&whole, None) else {
        panic!("expected a read card");
    };
    assert!(block.line_range.is_none());

    // A failed read has no result view: still a Read card, with the error.
    let missing = viewed(
        "read",
        acp::ToolKind::Read,
        json!({ "file_path": "/w/gone.ts" }),
        json!({ "card": "generic", "title": "Read /w/gone.ts", "kind": "read", "locations": [{ "path": "/w/gone.ts", "line": 1 }] }),
        None,
        acp::ToolCallStatus::Failed,
        vec![text("File not found: /w/gone.ts")],
    );
    let RenderBlock::ToolCall(ToolCallBlock::Read(block)) = tool_call_to_block(&missing, None)
    else {
        panic!("expected a read card");
    };
    assert_eq!(block.path, "/w/gone.ts");
    assert_eq!(block.error.as_deref(), Some("File not found: /w/gone.ts"));
}

#[test]
fn tool_view_search_renders_the_search_card() {
    let _theme = crate::theme::cache::pin_theme();
    let matches = json!([{ "path": "a.ts", "matches": [{ "lineNumber": 1, "line": "const a = 2" }] },
        { "path": "b.ts", "matches": [{ "lineNumber": 4, "line": "const b = 3" }] }]);
    let grep = viewed(
        "grep",
        acp::ToolKind::Search,
        json!({ "pattern": "const", "path": "src" }),
        json!({ "card": "generic", "title": "Grep const in src", "kind": "search", "rawInput": "const" }),
        Some(
            json!({ "card": "search", "shape": "matches", "files": matches, "truncated": false, "total": 2 }),
        ),
        acp::ToolCallStatus::Completed,
        vec![text("Found 2 matches")],
    );
    let before = legacy(
        "grep",
        acp::ToolKind::Search,
        json!({ "pattern": "const", "path": "src" }),
        vec![text("Found 2 matches")],
        Some(
            json!({ "type": "GrepSearch", "stdout": [], "stderr": [], "exit_code": 0, "match_count": 2,
            "file_matches": [{ "path": "a.ts", "matches": [{ "line_number": 1, "content": "const a = 2" }] },
                { "path": "b.ts", "matches": [{ "line_number": 4, "content": "const b = 3" }] }] }),
        ),
    );
    assert_eq!(both(&grep), both(&before));
    insta::assert_snapshot!("tool_view_grep", both(&grep));

    let paths = |truncated: bool, total: usize| {
        viewed(
            "glob",
            acp::ToolKind::Search,
            json!({ "pattern": "**/*.ts" }),
            json!({ "card": "generic", "title": "Glob **/*.ts", "kind": "search", "rawInput": "**/*.ts" }),
            Some(
                json!({ "card": "search", "shape": "paths", "paths": ["a.ts", "b.ts"], "truncated": truncated, "total": total }),
            ),
            acp::ToolCallStatus::Completed,
            vec![text("a.ts\nb.ts")],
        )
    };
    let before = legacy(
        "glob",
        acp::ToolKind::Search,
        json!({ "pattern": "**/*.ts" }),
        vec![text("a.ts\nb.ts")],
        Some(
            json!({ "type": "GrepSearch", "stdout": "a.ts\nb.ts".as_bytes(), "stderr": [], "exit_code": 0, "match_count": 2, "file_matches": [] }),
        ),
    );
    assert_eq!(both(&paths(false, 2)), both(&before));
    insta::assert_snapshot!("tool_view_glob", both(&paths(false, 2)));
    // A capped result says how much of it is shown.
    let capped = render(&paths(true, 90), DisplayMode::Collapsed);
    assert!(capped.contains("(2 of 90 matches)"), "{capped}");
}

#[test]
fn tool_view_web_renders_the_web_cards() {
    let _theme = crate::theme::cache::pin_theme();
    let fetch = viewed(
        "web_fetch",
        acp::ToolKind::Fetch,
        json!({ "url": "https://example.test/" }),
        json!({ "card": "generic", "title": "https://example.test/", "kind": "fetch", "rawInput": "https://example.test/" }),
        Some(
            json!({ "card": "web", "kind": "fetch", "title": "https://example.test/", "url": "https://example.test/", "statusCode": 200, "truncated": false }),
        ),
        acp::ToolCallStatus::Completed,
        vec![text("# Example")],
    );
    let RenderBlock::ToolCall(ToolCallBlock::WebFetch(block)) = tool_call_to_block(&fetch, None)
    else {
        panic!("expected a fetch card");
    };
    assert_eq!(
        (block.url.as_str(), block.status_code, block.bytes),
        ("https://example.test/", Some(200), Some(9))
    );
    assert_eq!(block.output.as_deref(), Some("# Example"));
    insta::assert_snapshot!("tool_view_web_fetch", both(&fetch));

    let search = viewed(
        "web_search",
        acp::ToolKind::Search,
        json!({ "queries": ["rust", "ratatui"] }),
        json!({ "card": "generic", "title": "rust, ratatui", "kind": "search", "rawInput": "rust, ratatui" }),
        Some(
            json!({ "card": "web", "kind": "search", "title": "rust, ratatui", "sources": [{ "url": "https://a.test" }], "truncated": false }),
        ),
        acp::ToolCallStatus::Completed,
        vec![text("1. A")],
    );
    let RenderBlock::ToolCall(ToolCallBlock::WebSearch(block)) = tool_call_to_block(&search, None)
    else {
        panic!("expected a web search card");
    };
    assert_eq!(block.query, "rust, ratatui");
    assert_eq!(block.citations, ["https://a.test"]);
    assert_eq!(block.content.as_deref(), Some("1. A"));
}

#[test]
fn tool_view_generic_renders_the_other_card() {
    let _theme = crate::theme::cache::pin_theme();
    let plan = viewed(
        "exit_plan_mode",
        acp::ToolKind::Other,
        json!({ "plan": "# Ship\n\n1. Do it" }),
        json!({ "card": "generic", "title": "Ship", "kind": "other", "content": [{ "type": "text", "text": "# Ship\n\n1. Do it" }] }),
        Some(json!({ "card": "generic", "title": "Plan review" })),
        acp::ToolCallStatus::Completed,
        vec![text("Plan approved.")],
    );
    let RenderBlock::ToolCall(ToolCallBlock::Other(block)) = tool_call_to_block(&plan, None) else {
        panic!("expected an other card");
    };
    assert_eq!(
        (block.name.as_str(), block.summary.as_str()),
        ("Plan review", "")
    );
    assert_eq!(block.output.as_deref(), Some("Plan approved."));
    insta::assert_snapshot!("tool_view_generic", both(&plan));

    // A skill keeps the Skill card, titled by what it loads.
    let skill = viewed(
        "skill",
        acp::ToolKind::Read,
        json!({ "name": "review" }),
        json!({ "card": "generic", "title": "Load skill review", "kind": "read" }),
        None,
        acp::ToolCallStatus::Completed,
        vec![text("loaded")],
    );
    let RenderBlock::ToolCall(ToolCallBlock::Skill(block)) = tool_call_to_block(&skill, None)
    else {
        panic!("expected a skill card");
    };
    assert_eq!(
        (block.name.as_str(), block.summary.as_str()),
        ("Load skill review", "")
    );

    // A kind rides as the summary; a salient input shows expanded, capped.
    let long: String = (0..50).map(|i| format!("step {i}\n")).collect();
    let job = viewed(
        "job_output",
        acp::ToolKind::Read,
        json!({ "job_id": "j1" }),
        json!({ "card": "generic", "title": "Read output from background job j1", "kind": "read", "rawInput": long }),
        None,
        acp::ToolCallStatus::Completed,
        vec![text("killed")],
    );
    let RenderBlock::ToolCall(ToolCallBlock::Other(block)) = tool_call_to_block(&job, None) else {
        panic!("expected an other card");
    };
    assert_eq!(block.summary, "read");
    let input = block.input.as_deref().unwrap();
    assert!(input.starts_with("step 0\nstep 1\n"), "{input}");
    assert!(input.ends_with("\u{2026} +10 lines"), "{input}");

    // An object input is shown as fields; a failure shows the raw text.
    let failed = viewed(
        "lookup",
        acp::ToolKind::Other,
        json!({}),
        json!({ "card": "generic", "title": "Look up", "rawInput": { "id": "T-1" } }),
        None,
        acp::ToolCallStatus::Failed,
        vec![text("not found")],
    );
    let RenderBlock::ToolCall(ToolCallBlock::Other(block)) = tool_call_to_block(&failed, None)
    else {
        panic!("expected an other card");
    };
    assert_eq!(block.input.as_deref(), Some("id: T-1"));
    assert_eq!(block.error.as_deref(), Some("not found"));
    assert_eq!(block.output.as_deref(), Some("not found"));
}

#[test]
fn tool_view_pending_cards_keep_their_card_family() {
    let _theme = crate::theme::cache::pin_theme();
    let pending = |name: &str, call: Value| {
        tool_call_to_block(&started(name, acp::ToolKind::Other, json!({}), call), None)
    };
    assert!(matches!(
        pending(
            "read",
            json!({ "card": "generic", "title": "Read a", "kind": "read", "locations": [{ "path": "a" }] })
        ),
        RenderBlock::ToolCall(ToolCallBlock::Read(_))
    ));
    assert!(matches!(
        pending(
            "grep",
            json!({ "card": "generic", "title": "Grep x", "kind": "search", "rawInput": "x" })
        ),
        RenderBlock::ToolCall(ToolCallBlock::Search(_))
    ));
    assert!(matches!(
        pending(
            "web_fetch",
            json!({ "card": "generic", "title": "u", "kind": "fetch", "rawInput": "https://u.test" })
        ),
        RenderBlock::ToolCall(ToolCallBlock::WebFetch(_))
    ));
    assert!(matches!(
        pending("bash", json!({ "card": "terminal", "title": "ls" })),
        RenderBlock::ToolCall(ToolCallBlock::Execute(_))
    ));
    // A read with no file, or a settled search without a search view, is
    // the Other card with its text.
    assert!(matches!(
        pending(
            "skill",
            json!({ "card": "generic", "title": "Load skill x", "kind": "read" })
        ),
        RenderBlock::ToolCall(ToolCallBlock::Skill(_))
    ));
    let settled = viewed(
        "session_search",
        acp::ToolKind::Search,
        json!({ "query": "x" }),
        json!({ "card": "generic", "title": "Search prior sessions", "kind": "search", "rawInput": "x" }),
        None,
        acp::ToolCallStatus::Completed,
        vec![text("Session s1")],
    );
    let RenderBlock::ToolCall(ToolCallBlock::Other(block)) = tool_call_to_block(&settled, None)
    else {
        panic!("expected an other card");
    };
    assert_eq!(block.output.as_deref(), Some("Session s1"));
}

#[test]
fn tool_view_result_view_is_kept_beside_the_call_view() {
    let call = json!({ "card": "terminal", "title": "ls" });
    let result = json!({ "card": "terminal", "output": "a", "exitCode": 0 });
    let merged = viewed(
        "bash",
        acp::ToolKind::Execute,
        json!({}),
        call.clone(),
        Some(result.clone()),
        acp::ToolCallStatus::Completed,
        vec![],
    );
    let meta = merged.meta.as_ref().unwrap();
    assert_eq!(meta[VIEW_KEY], call);
    assert_eq!(meta[RESULT_VIEW_KEY], result);
    assert_eq!(meta["x.ai/tool"], json!({ "name": "bash" }));

    // Through the tracker, live or replayed: the settled card uses both.
    let mut sb = ScrollbackState::new();
    let mut tracker = AcpUpdateTracker::new();
    tracker.handle_update(
        acp::SessionUpdate::ToolCall(started("bash", acp::ToolKind::Execute, json!({}), call)),
        &NotificationMeta::default(),
        &mut sb,
    );
    tracker.handle_update(
        acp::SessionUpdate::ToolCallUpdate(update(
            acp::ToolCallStatus::Completed,
            vec![text("a")],
            None,
            Some(result),
        )),
        &NotificationMeta::default(),
        &mut sb,
    );
    assert_eq!(sb.len(), 1);
    let entry = sb.get(0).unwrap();
    let RenderBlock::ToolCall(ToolCallBlock::Execute(block)) = &entry.block else {
        panic!("expected an execute card");
    };
    assert_eq!(
        (block.command.as_str(), block.output.as_deref()),
        ("ls", Some("a"))
    );

    // No view anywhere: the name tables, as before.
    let plain = legacy(
        "lookup",
        acp::ToolKind::Other,
        json!({}),
        vec![text("ok")],
        None,
    );
    assert!(view_block(&plain, None).is_none());
}
