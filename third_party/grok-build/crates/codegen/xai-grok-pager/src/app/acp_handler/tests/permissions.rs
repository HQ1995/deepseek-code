#![cfg_attr(rustfmt, rustfmt::skip)]
    use super::*;

    /// The permission prompt must surface the payload an MCP call would
    /// send — both `UseTool` (meta-dispatch) and `MCPTool` (natively
    /// registered) raw_input shapes.
    #[test]
    fn mcp_args_lines_extracts_planned_tool_input() {
        for variant in ["UseTool", "MCPTool"] {
            let req = permission_req_with_raw_input(Some(serde_json::json!({
                "variant": variant,
                "tool_name": "jira__AddjiraComment",
                "tool_input": {"issue": "ABC-123", "body": "hello"},
            })));
            let lines = mcp_args_lines(&req);
            let joined = lines.join("\n");
            assert!(
                joined.contains("\"issue\": \"ABC-123\""),
                "{variant}: {joined}"
            );
            assert!(
                joined.contains("\"body\": \"hello\""),
                "{variant}: {joined}"
            );
        }
    }

    /// Non-MCP raw_input (bash, edit, gateway `{command}` shapes) must not
    /// grow a JSON dump — those prompts have dedicated displays.
    #[test]
    fn mcp_args_lines_empty_for_non_mcp_shapes() {
        for raw in [
            None,
            Some(serde_json::json!({"variant": "Bash", "command": "ls", "description": "d"})),
            Some(serde_json::json!({"command": "rm -rf /"})),
            Some(serde_json::json!({"file_path": "/tmp/x"})),
            Some(serde_json::json!("not-an-object")),
        ] {
            let req = permission_req_with_raw_input(raw.clone());
            assert!(
                mcp_args_lines(&req).is_empty(),
                "expected empty for {raw:?}"
            );
        }
    }

    /// DIVERGENCE(dscode): an execute prompt keeps the command's own
    /// description as its title, and a leader-supplied tool title (DSH's
    /// approval reason, "bash — <reason>") leads the lines under the command.
    /// Grok's "Execute `…`" title only repeats the command and stays hidden.
    #[test]
    fn execute_prompt_shows_leader_title_as_first_description_line() {
        let raw = serde_json::json!({"command": "rm -rf build", "description": "Clean the build"});
        let display = |title: Option<&str>| {
            let mut req = permission_req_with_raw_input(Some(raw.clone()));
            req.tool_call.fields.title = title.map(str::to_string);
            build_permission_display(&req, None, false)
        };
        let (title, description, command) = display(Some("bash — Command writes outside the workspace"));
        assert_eq!(title, "Clean the build");
        assert_eq!(description, vec!["bash — Command writes outside the workspace".to_string()]);
        assert_eq!(command.as_deref(), Some("rm -rf build"));
        for missing in [None, Some(""), Some("   "), Some("Execute `rm -rf build`")] {
            let (title, description, command) = display(missing);
            assert_eq!(title, "Clean the build", "{missing:?}");
            assert!(description.is_empty(), "{missing:?}: {description:?}");
            assert_eq!(command.as_deref(), Some("rm -rf build"), "{missing:?}");
        }
        // Other prompts already read "Allow <title>?"; their lines stay the planned arguments.
        let mut req = permission_req_with_raw_input(Some(serde_json::json!({
            "variant": "MCPTool", "tool_name": "mcp__fixture__probe", "tool_input": {"k": 1},
        })));
        req.tool_call.fields.title = Some("mcp__fixture__probe — Reviewer asked".into());
        let (title, description, command) = build_permission_display(&req, None, false);
        assert!(title.starts_with("Allow ") && title.contains("Reviewer asked"), "{title}");
        assert!(!description.iter().any(|line| line.contains("Reviewer asked")), "{description:?}");
        assert!(command.is_none());
    }

    /// DIVERGENCE(dscode): a request carrying the call's own view, as the
    /// bridge sends it: the view in the tool call's `_meta`, the view title
    /// (then " — " and the asker's reason) as the tool title.
    fn approval_view_request(title: &str, raw: serde_json::Value, view: serde_json::Value) -> acp::RequestPermissionRequest {
        let mut req = permission_req_with_raw_input(Some(raw));
        req.tool_call.fields.title = Some(title.to_string());
        req.tool_call.meta = Some(serde_json::Map::from_iter([("dscode/view".to_string(), view)]));
        req.options = vec![
            acp::PermissionOption::new(acp::PermissionOptionId::new(std::sync::Arc::from("allow-once")), "Allow once", acp::PermissionOptionKind::AllowOnce),
            acp::PermissionOption::new(acp::PermissionOptionId::new(std::sync::Arc::from("reject-once")), "Reject", acp::PermissionOptionKind::RejectOnce),
        ];
        req
    }
    const APPROVAL_REASON: &str = "Allow this operation with danger-full-access permissions: fix perms";

    /// A terminal view: the command's description titles the prompt, the
    /// command is the body, and the reason and the working directory lead the
    /// lines. The shell-input parsing is only the fallback.
    #[test]
    fn approval_view_terminal_shows_command_cwd_and_reason() {
        let view = serde_json::json!({ "card": "terminal", "title": "chmod -R u+w build", "description": "Fix build permissions", "cwd": "/w/pkg" });
        // Arguments the grok shell input would not parse: the view alone decides.
        let raw = serde_json::json!({ "cmd": "ignored" });
        let req = approval_view_request(&format!("chmod -R u+w build \u{2014} {APPROVAL_REASON}"), raw.clone(), view.clone());
        let (title, description, command) = build_permission_display(&req, None, false);
        assert_eq!(title, "Fix build permissions");
        assert_eq!(description, vec![APPROVAL_REASON.to_string(), "cwd: /w/pkg".to_string()]);
        assert_eq!(command.as_deref(), Some("chmod -R u+w build"));
        // No reason: the title is the view's own and no line repeats it.
        let req = approval_view_request("chmod -R u+w build", raw.clone(), view);
        assert_eq!(build_permission_display(&req, None, false).1, vec!["cwd: /w/pkg".to_string()]);
        // A background run (a generic execute) is a command too.
        let background = serde_json::json!({ "card": "generic", "title": "sleep 60", "kind": "execute", "rawInput": "sleep 60", "content": [{ "type": "text", "text": "Wait a minute" }] });
        let (title, description, command) = build_permission_display(&approval_view_request("sleep 60", raw, background), None, false);
        assert_eq!((title.as_str(), description.len(), command.as_deref()), ("Wait a minute", 0, Some("sleep 60")));
    }

    /// A diff view: "Allow <view title>?" over the change as unified lines,
    /// the reason first; a new file is all insertions; several files are
    /// headed by their paths.
    #[test]
    fn approval_view_diff_previews_the_change() {
        let edit = serde_json::json!({ "card": "diff", "title": "Edit /w/a.ts", "diffs": [{ "path": "/w/a.ts", "oldText": "const a = 1", "newText": "const a = 2" }] });
        let req = approval_view_request(&format!("Edit /w/a.ts \u{2014} {APPROVAL_REASON}"), serde_json::json!({ "file_path": "/w/a.ts" }), edit);
        let (title, description, command) = build_permission_display(&req, None, false);
        assert_eq!(title, "Allow Edit /w/a.ts?");
        assert_eq!(description, vec![APPROVAL_REASON, "-const a = 1", "+const a = 2"]);
        assert!(command.is_none());
        let write = serde_json::json!({ "card": "diff", "title": "Write /w/new.txt", "diffs": [{ "path": "/w/new.txt", "oldText": null, "newText": "one\ntwo\n" }] });
        let (title, description, _) = build_permission_display(&approval_view_request("Write /w/new.txt", serde_json::json!({}), write), None, false);
        assert_eq!((title.as_str(), description), ("Allow Write /w/new.txt?", vec!["+one".to_string(), "+two".to_string()]));
        let patch = serde_json::json!({ "card": "diff", "title": "Apply patch", "diffs": [
            { "path": "a", "oldText": "x", "newText": "y" }, { "path": "b", "newText": "z" }] });
        let (_, description, _) = build_permission_display(&approval_view_request("Apply patch", serde_json::json!({}), patch), None, false);
        assert_eq!(description, vec!["a", "-x", "+y", "b", "+z"]);
    }

    /// A generic view: "Allow <view title>?" over its salient input, else the
    /// planned arguments, capped by the same formatter as MCP arguments.
    #[test]
    fn approval_view_generic_shows_salient_input() {
        let salient = serde_json::json!({ "card": "generic", "title": "Schedule nightly", "kind": "other", "rawInput": "0 3 * * *" });
        let req = approval_view_request(&format!("Schedule nightly \u{2014} {APPROVAL_REASON}"), serde_json::json!({ "cron": "0 3 * * *" }), salient);
        let (title, description, command) = build_permission_display(&req, None, false);
        assert_eq!(title, "Allow Schedule nightly?");
        assert_eq!(description, vec![APPROVAL_REASON, "0 3 * * *"]);
        assert!(command.is_none());
        let bare = serde_json::json!({ "card": "generic", "title": "Update todos" });
        let (_, description, _) = build_permission_display(&approval_view_request("Update todos", serde_json::json!({ "todos": [1] }), bare.clone()), None, false);
        assert_eq!(description.join("\n"), "{\n  \"todos\": [\n    1\n  ]\n}");
        let big = serde_json::json!({ "card": "generic", "title": "Big", "rawInput": (0..MCP_ARGS_MAX_LINES + 5).map(|i| i.to_string()).collect::<Vec<_>>().join("\n") });
        let (_, description, _) = build_permission_display(&approval_view_request("Big", serde_json::json!({}), big), None, false);
        assert_eq!(description.len(), MCP_ARGS_MAX_LINES + 1);
        assert_eq!(description.last().map(String::as_str), Some("… (+5 more lines)"));
        // An unknown card is no view: the prompt renders as before.
        let unknown = serde_json::json!({ "card": "hologram", "title": "x" });
        let (title, _, _) = build_permission_display(&approval_view_request("mcp__x__y \u{2014} why", serde_json::json!({}), unknown), None, false);
        assert!(title.starts_with("Allow ") && title.contains("why"), "{title}");
    }

    /// The prompt as it renders, per view kind.
    #[test]
    fn approval_view_renders_each_kind() {
        let render = |req: acp::RequestPermissionRequest| -> String {
            let mut app = make_app_with_agent("sess-1");
            let mut req = req;
            req.session_id = acp::SessionId::new("sess-1");
            let (tx, _rx) = tokio::sync::oneshot::channel();
            handle(AcpClientMessage::RequestPermission(xai_acp_lib::AcpArgs { request: req, response_tx: tx }), &mut app);
            let state = app.agents[&AgentId(0)].permission_queue.front().expect("queued");
            let theme = crate::theme::Theme::current();
            let area = ratatui::layout::Rect::new(0, 0, 72, 12);
            let mut buf = ratatui::buffer::Buffer::empty(area);
            let _ = crate::views::permission_view::render_permission_view(&mut buf, area, state, "", None, None, &theme, true);
            (0..area.height)
                .map(|row| (0..area.width).map(|col| buf[(col, row)].symbol().to_string()).collect::<String>().trim_end().to_string())
                .collect::<Vec<_>>()
                .join("\n")
        };
        let terminal = serde_json::json!({ "card": "terminal", "title": "chmod -R u+w build", "description": "Fix build permissions", "cwd": "/w/pkg" });
        insta::assert_snapshot!("approval_view_terminal", render(approval_view_request(&format!("chmod -R u+w build \u{2014} {APPROVAL_REASON}"), serde_json::json!({}), terminal)));
        let edit = serde_json::json!({ "card": "diff", "title": "Edit /w/a.ts", "diffs": [{ "path": "/w/a.ts", "oldText": "const a = 1", "newText": "const a = 2" }] });
        insta::assert_snapshot!("approval_view_diff", render(approval_view_request(&format!("Edit /w/a.ts \u{2014} {APPROVAL_REASON}"), serde_json::json!({}), edit)));
        let generic = serde_json::json!({ "card": "generic", "title": "Schedule nightly", "kind": "other", "rawInput": { "cron": "0 3 * * *", "prompt": "Summarize the day" } });
        insta::assert_snapshot!("approval_view_generic", render(approval_view_request("Schedule nightly", serde_json::json!({}), generic)));
    }

    /// A `tool_input` that is missing or JSON null renders nothing rather
    /// than a misleading `null`.
    #[test]
    fn mcp_args_lines_empty_for_missing_or_null_input() {
        for raw in [
            serde_json::json!({"variant": "UseTool", "tool_name": "t"}),
            serde_json::json!({"variant": "UseTool", "tool_name": "t", "tool_input": null}),
        ] {
            let req = permission_req_with_raw_input(Some(raw));
            assert!(mcp_args_lines(&req).is_empty());
        }
    }

    /// A pathological single-line value (e.g. an embedded base64 blob) is
    /// elided at `MCP_ARGS_MAX_LINE_CHARS` so per-frame wrap cost stays
    /// bounded. Uses a multi-byte char to pin char (not byte) slicing.
    #[test]
    fn mcp_args_lines_caps_line_length() {
        let req = permission_req_with_raw_input(Some(serde_json::json!({
            "variant": "UseTool",
            "tool_name": "t",
            "tool_input": {"blob": "é".repeat(MCP_ARGS_MAX_LINE_CHARS * 2)},
        })));
        let lines = mcp_args_lines(&req);
        let long = lines
            .iter()
            .find(|l| l.contains("é"))
            .expect("blob line present");
        assert_eq!(long.chars().count(), MCP_ARGS_MAX_LINE_CHARS + 1);
        assert!(long.ends_with('…'));
    }

    /// Pathologically large payloads are capped in storage with an explicit
    /// hidden-line count (the overlay clips further at render time).
    #[test]
    fn mcp_args_lines_caps_stored_lines() {
        let big: serde_json::Map<String, serde_json::Value> = (0..MCP_ARGS_MAX_LINES + 50)
            .map(|i| (format!("k{i:04}"), serde_json::Value::from(i)))
            .collect();
        let req = permission_req_with_raw_input(Some(serde_json::json!({
            "variant": "UseTool",
            "tool_name": "t",
            "tool_input": big,
        })));
        let lines = mcp_args_lines(&req);
        assert_eq!(lines.len(), MCP_ARGS_MAX_LINES + 1);
        let last = lines.last().unwrap();
        assert!(
            last.starts_with("… (+") && last.ends_with(" more lines)"),
            "unexpected tail: {last}"
        );
    }

    /// Manual recap with an uncommitted in-flight spinner: filled in place
    /// (no second block), animation stopped.
    #[test]
    fn recap_fills_uncommitted_spinner_in_place() {
        let mut agent = make_agent(Some("s1"));
        let spinner = agent
            .scrollback
            .push(crate::scrollback::entry::ScrollbackEntry::running(
                recap_block(""),
            ));
        agent.pending_recap_entry = Some(spinner);

        apply_recap_block(&mut agent, false, recap_block("THE RECAP"));

        assert_eq!(agent.scrollback.len(), 1, "filled in place, not appended");
        let entry = agent.scrollback.get_by_id(spinner).expect("entry kept");
        assert!(!entry.is_running, "spinner animation stopped");
        assert!(agent.pending_recap_entry.is_none());
    }

    /// Regression (minimal mode): the spinner was already committed into
    /// native scrollback (print-once) — an in-place fill would never reach the
    /// terminal. The stale committed entry is dropped from state and the recap
    /// appended as a fresh (uncommitted) block so the commit pass prints it.
    #[test]
    fn recap_reprints_fresh_block_when_spinner_already_committed() {
        let mut agent = make_agent(Some("s1"));
        let spinner = agent
            .scrollback
            .push(crate::scrollback::entry::ScrollbackEntry::running(
                recap_block(""),
            ));
        agent.pending_recap_entry = Some(spinner);
        // The minimal idle commit pass consumed the spinner.
        agent.scrollback.finish_running(spinner);
        agent.scrollback.mark_committed(0);
        agent.scrollback.set_commit_scan_cursor(1);
        assert!(agent.scrollback.is_committed(spinner));

        apply_recap_block(&mut agent, false, recap_block("THE RECAP"));

        assert_eq!(
            agent.scrollback.len(),
            1,
            "stale committed spinner dropped, fresh block appended"
        );
        let fresh = agent.scrollback.get(0).expect("fresh block");
        assert_ne!(fresh.id, spinner, "a NEW entry, not the committed one");
        assert!(
            !agent.scrollback.is_committed(fresh.id),
            "fresh block is uncommitted so the commit pass will print it"
        );
    }

    /// An automatic recap never consumes the manual loading slot — it always
    /// appends its own block and leaves the pending spinner alone.
    #[test]
    fn auto_recap_appends_and_leaves_manual_spinner_pending() {
        let mut agent = make_agent(Some("s1"));
        let spinner = agent
            .scrollback
            .push(crate::scrollback::entry::ScrollbackEntry::running(
                recap_block(""),
            ));
        agent.pending_recap_entry = Some(spinner);

        apply_recap_block(&mut agent, true, recap_block("AUTO RECAP"));

        assert_eq!(agent.scrollback.len(), 2, "auto recap appended");
        assert_eq!(agent.pending_recap_entry, Some(spinner));
    }

    #[test]
    fn late_auto_recap_dropped_when_agent_not_idle() {
        let idle = make_agent(Some("s1"));
        let mut busy = make_agent(Some("s1"));
        busy.session.state = crate::app::agent::AgentState::TurnRunning;

        assert!(should_drop_late_auto_recap(true, false, &busy));
        assert!(
            !should_drop_late_auto_recap(true, false, &idle),
            "idle agent: show auto recap"
        );
        assert!(
            !should_drop_late_auto_recap(false, false, &busy),
            "manual /recap always shown"
        );
        assert!(
            !should_drop_late_auto_recap(true, true, &busy),
            "history replay rebuilds scrollback even mid-turn"
        );
    }

    fn running_bg_task(is_monitor: bool) -> crate::app::agent::BgTaskState {
        crate::app::agent::BgTaskState { native_task: None, task_id: "t1".into(),
        tool_call_id: "c1".into(),
        command: "sleep 5".into(),
        description: None,
        cwd: "/tmp".into(),
        output_file: "/tmp/out".into(),
        status: crate::app::agent::BgTaskStatus::Running,
        start_time: std::time::SystemTime::now(),
        end_time: None,
        exit_code: None,
        signal: None,
        stdout: String::new(),
        stdout_line_count: 0,
        truncated: false,
        pending_kill: false,
        kill_requested_at: None,
        scrollback_entry_id: None,
        is_monitor,
        restored_from_replay: false, }
    }

    #[test]
    fn recap_idle_allows_monitors_but_not_subagents_or_turn_wait() {
        let mut agent = make_agent(Some("s1"));
        agent.scrollback.push_block(
            crate::scrollback::block::RenderBlock::agent_message("done"),
        );
        assert!(
            !should_drop_late_auto_recap(true, false, &agent),
            "agent message + idle"
        );

        agent.session.bg_tasks.insert("mon".into(), running_bg_task(true));
        assert!(
            !should_drop_late_auto_recap(true, false, &agent),
            "running monitors must not block recap"
        );

        agent
            .session
            .bg_tasks
            .insert("bash".into(), running_bg_task(false));
        assert!(
            should_drop_late_auto_recap(true, false, &agent),
            "non-monitor bg task is not idle"
        );
        agent.session.bg_tasks.remove("bash");

        agent
            .subagent_sessions
            .insert("child".into(), make_subagent_info("child"));
        assert!(
            should_drop_late_auto_recap(true, false, &agent),
            "running subagent is not idle"
        );
        agent.subagent_sessions.get_mut("child").unwrap().finished = true;
        assert!(
            !should_drop_late_auto_recap(true, false, &agent),
            "finished subagent is idle again"
        );

        agent.session.enqueue_prompt("queued follow-up".into());
        assert!(
            should_drop_late_auto_recap(true, false, &agent),
            "queued prompt is a turn wait"
        );
        agent.session.pending_prompts.clear();

        agent.shared_queue = vec![crate::app::prompt_queue::QueueEntryWire {
            id: "sq-1".into(),
            version: 0,
            owner: None,
            last_editor: None,
            kind: "prompt".into(),
            text: "server follow-up".into(),
            position: 0,
            combined_texts: None,
        }];
        assert!(
            should_drop_late_auto_recap(true, false, &agent),
            "shared_queue follow-up is a turn wait"
        );
        agent.shared_queue.clear();

        agent.session.in_flight_prompt = Some(crate::app::agent::InFlightPrompt {
            text: "hi".into(),
            images: Vec::new(),
            scrollback_entry: crate::scrollback::entry::EntryId::new(1),
            combined_scrollback_entries: Vec::new(),
            chip_elements: Vec::new(),
        });
        assert!(
            should_drop_late_auto_recap(true, false, &agent),
            "in-flight prompt is a turn wait"
        );
        agent.session.in_flight_prompt = None;

        agent
            .scrollback
            .push_block(crate::scrollback::block::RenderBlock::user_prompt(
                "so wait, what was the issue",
            ));
        assert!(
            should_drop_late_auto_recap(true, false, &agent),
            "trailing user prompt is waiting on a turn"
        );
        agent.scrollback.push_block(
            crate::scrollback::block::RenderBlock::bg_task("monitor logs", "mon-1"),
        );
        assert!(
            should_drop_late_auto_recap(true, false, &agent),
            "bg-task trailer after a waiting user prompt is still a turn wait"
        );
        agent.scrollback.push_block(crate::scrollback::block::RenderBlock::session_event(
            crate::scrollback::blocks::SessionEvent::TurnCancelled {
                elapsed: std::time::Duration::from_secs(1),
            },
        ));
        assert!(
            !should_drop_late_auto_recap(true, false, &agent),
            "turn terminal after a user prompt is idle"
        );

        let mut failed = make_agent(Some("s1"));
        failed.scrollback.push_block(
            crate::scrollback::block::RenderBlock::user_prompt("try again"),
        );
        failed.scrollback.push_block(
            crate::scrollback::block::RenderBlock::session_event(
                crate::scrollback::blocks::SessionEvent::ReAuthRequired,
            ),
        );
        assert!(
            !should_drop_late_auto_recap(true, false, &failed),
            "ReAuthRequired settles the turn without TurnFailed"
        );
        failed.scrollback.push_block(
            crate::scrollback::block::RenderBlock::session_event(
                crate::scrollback::blocks::SessionEvent::ContextTooLarge,
            ),
        );
        assert!(
            !should_drop_late_auto_recap(true, false, &failed),
            "ContextTooLarge settles the turn without TurnFailed"
        );
    }

    #[test]
    fn duplicate_live_auto_recap_dropped_after_existing_recap() {
        let mut agent = make_agent(Some("s1"));
        agent.scrollback.push_block(recap_block("first"));
        assert!(should_drop_duplicate_auto_recap(
            true,
            false,
            &agent.scrollback
        ));
        assert!(
            !should_drop_duplicate_auto_recap(true, true, &agent.scrollback),
            "replay must still paint stored recaps"
        );
        assert!(
            !should_drop_duplicate_auto_recap(false, false, &agent.scrollback),
            "manual /recap still allowed"
        );
    }

    #[test]
    fn duplicate_auto_recap_allowed_after_new_user_prompt() {
        let mut agent = make_agent(Some("s1"));
        agent.scrollback.push_block(recap_block("old"));
        agent
            .scrollback
            .push_block(crate::scrollback::block::RenderBlock::user_prompt(
                "next question",
            ));
        assert!(
            !should_drop_duplicate_auto_recap(true, false, &agent.scrollback),
            "new user turn re-arms auto recap"
        );
    }

    #[test]
    fn enqueue_while_scrollback_steals_focus_to_prompt() {
        use crate::app::agent_view::AgentPane;

        let mut app = make_app_with_agent("sess-1");
        app.agents
            .get_mut(&AgentId(0))
            .unwrap()
            .set_active_pane(AgentPane::Scrollback, true);

        let (msg, _rx) = make_permission_message("sess-1");
        handle(msg, &mut app);

        let agent = &app.agents[&AgentId(0)];
        assert_eq!(agent.permission_queue.len(), 1);
        assert_eq!(agent.active_pane, AgentPane::Prompt);
        assert_eq!(agent.permission_stashed_pane, Some(AgentPane::Scrollback));
    }

    #[test]
    fn enqueue_while_prompt_does_not_stash_pane() {
        use crate::app::agent_view::AgentPane;

        let mut app = make_app_with_agent("sess-1");
        app.agents
            .get_mut(&AgentId(0))
            .unwrap()
            .set_active_pane(AgentPane::Prompt, true);

        let (msg, _rx) = make_permission_message("sess-1");
        handle(msg, &mut app);

        let agent = &app.agents[&AgentId(0)];
        assert_eq!(agent.permission_queue.len(), 1);
        assert_eq!(agent.active_pane, AgentPane::Prompt);
        assert!(agent.permission_stashed_pane.is_none());
    }

    #[test]
    fn enqueue_while_queue_or_tasks_does_not_steal() {
        use crate::app::agent_view::AgentPane;

        for pane in [AgentPane::Queue, AgentPane::Tasks] {
            let mut app = make_app_with_agent("sess-1");
            app.agents
                .get_mut(&AgentId(0))
                .unwrap()
                .set_active_pane(pane, true);

            let (msg, _rx) = make_permission_message("sess-1");
            handle(msg, &mut app);

            let agent = &app.agents[&AgentId(0)];
            assert_eq!(agent.permission_queue.len(), 1, "pane={pane:?}");
            assert_eq!(agent.active_pane, pane);
            assert!(agent.permission_stashed_pane.is_none(), "pane={pane:?}");
        }
    }

    #[test]
    fn second_enqueue_does_not_resteal_if_user_returned_to_scrollback() {
        use crate::app::agent_view::AgentPane;

        let mut app = make_app_with_agent("sess-1");
        app.agents
            .get_mut(&AgentId(0))
            .unwrap()
            .set_active_pane(AgentPane::Scrollback, true);

        let (msg1, _rx1) = make_permission_message("sess-1");
        handle(msg1, &mut app);
        app.agents
            .get_mut(&AgentId(0))
            .unwrap()
            .set_active_pane(AgentPane::Scrollback, true);

        let (msg2, _rx2) = make_permission_message("sess-1");
        handle(msg2, &mut app);

        let agent = &app.agents[&AgentId(0)];
        assert_eq!(agent.permission_queue.len(), 2);
        assert_eq!(agent.active_pane, AgentPane::Scrollback);
        assert_eq!(agent.permission_stashed_pane, Some(AgentPane::Scrollback));
    }

    #[test]
    fn enqueue_while_scrollback_then_select_restores_scrollback() {
        use crate::app::actions::Action;
        use crate::app::agent_view::AgentPane;
        use crate::app::dispatch::dispatch;
        use std::sync::Arc;

        let mut app = make_app_with_agent("sess-1");
        app.agents
            .get_mut(&AgentId(0))
            .unwrap()
            .set_active_pane(AgentPane::Scrollback, true);

        let (msg, _rx) = make_permission_message("sess-1");
        handle(msg, &mut app);
        {
            let agent = &app.agents[&AgentId(0)];
            assert_eq!(agent.active_pane, AgentPane::Prompt);
            assert_eq!(agent.permission_stashed_pane, Some(AgentPane::Scrollback));
        }

        let _ = dispatch(
            Action::PermissionSelect(acp::PermissionOptionId::new(Arc::from("allow-once"))),
            &mut app,
        );

        let agent = &app.agents[&AgentId(0)];
        assert!(agent.permission_queue.is_empty());
        assert_eq!(agent.active_pane, AgentPane::Scrollback);
        assert!(agent.permission_stashed_pane.is_none());
    }

