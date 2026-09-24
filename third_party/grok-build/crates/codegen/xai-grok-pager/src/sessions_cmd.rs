//! `dscode sessions` — list and search the DSH leader's durable sessions.
//!
//! DIVERGENCE(dscode): upstream read grok's own session storage and remote
//! registry (`xai-grok-shell` merge/search), which never holds a dscode
//! session, so `sessions list` always printed "No sessions found." dscode
//! sessions live in DSH: both subcommands ask the leader over ACP, as
//! headless `--resume` does (`x.ai/session/list`, `x.ai/session/search`).
//! DSH has no session delete, so `delete` stays hidden and only says so.

use std::time::Duration;

use agent_client_protocol as acp;
use anyhow::{Context, Result};
use chrono::{DateTime, Local, Utc};
use clap::Subcommand;
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use xai_acp_lib::acp_send;

#[derive(Debug, clap::Args, Clone)]
pub struct SessionsArgs {
    #[command(subcommand)]
    command: SessionsCommand,
}

#[derive(Debug, Subcommand, Clone)]
enum SessionsCommand {
    /// List recent sessions started in the current directory
    List {
        /// Maximum number of sessions to show (the leader returns at most 50)
        #[arg(short = 'n', long, default_value = "20")]
        limit: usize,
        /// List sessions from every directory
        #[arg(long)]
        all: bool,
    },
    /// Search session titles and content across every directory
    Search {
        /// Search query.
        query: String,
        /// Maximum number of sessions to show
        #[arg(short = 'n', long, default_value = "20")]
        limit: usize,
    },
    /// Unsupported: DSH sessions cannot be deleted
    #[command(hide = true)]
    Delete {
        /// Session id.
        id: String,
    },
}

/// Why `dscode sessions delete` refuses.
const DELETE_UNSUPPORTED: &str = "dscode cannot delete sessions: DSH keeps every session \
     and has no delete (the DSH app can archive a session instead)";

/// How long one leader request may take before the command gives up.
const LEADER_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Longest title printed in a list row or search hit.
const TITLE_MAX_CHARS: usize = 60;

/// Longest search snippet printed under a hit.
const SNIPPET_MAX_CHARS: usize = 100;

pub async fn run(args: SessionsArgs) -> Result<()> {
    let cwd = std::env::current_dir()
        .unwrap_or_else(|_| ".".into())
        .to_string_lossy()
        .into_owned();
    if let SessionsCommand::Delete { .. } = args.command {
        anyhow::bail!(DELETE_UNSUPPORTED);
    }

    let cancel = CancellationToken::new();
    let _stop_bridge = cancel.clone().drop_guard();
    let flags = crate::acp::ConnectFlags {
        client_identifier: Some(crate::client_identity::HEADLESS_CLIENT_TYPE.to_string()),
        ..Default::default()
    };
    let connection =
        crate::acp::connect_via_leader(&cancel, flags, &toml::Value::Table(Default::default()))
            .await
            .context("couldn't reach the DSH leader")?;
    let tx = &connection.tx;

    match args.command {
        SessionsCommand::List { limit, all } => {
            let scope = (!all).then_some(cwd.as_str());
            let response =
                leader_request(tx, "x.ai/session/list", list_params(scope, limit, None)).await?;
            let rows = parse_session_rows(&response)?;
            print!("{}", format_session_list(&rows, scope, limit));
        }
        SessionsCommand::Search { query, limit } => {
            match leader_request(tx, "x.ai/session/search", search_params(&query, limit)).await {
                Ok(response) => {
                    let hits = parse_search_hits(&response)?;
                    print!("{}", format_search_hits(&hits, &query));
                }
                // A leader without full-text search still filters titles
                // and first prompts in its session list.
                Err(error) => {
                    eprintln!(
                        "warning: full-text session search is unavailable ({error:#}); \
                         matching titles and first prompts instead"
                    );
                    let response = leader_request(
                        tx,
                        "x.ai/session/list",
                        list_params(None, limit, Some(&query)),
                    )
                    .await?;
                    let rows = parse_session_rows(&response)?;
                    print!("{}", format_session_list(&rows, None, limit));
                }
            }
        }
        SessionsCommand::Delete { .. } => unreachable!("refused before connecting"),
    }
    Ok(())
}

/// One ACP extension request to the leader, bounded by
/// [`LEADER_REQUEST_TIMEOUT`]. Returns the result payload.
async fn leader_request(
    tx: &xai_acp_lib::AcpAgentTx,
    method: &'static str,
    params: Value,
) -> Result<Value> {
    let params = serde_json::value::to_raw_value(&params)
        .with_context(|| format!("serialize {method} params"))?;
    let response = tokio::time::timeout(
        LEADER_REQUEST_TIMEOUT,
        acp_send(acp::ExtRequest::new(method, params.into()), tx),
    )
    .await
    .with_context(|| format!("{method} timed out"))?
    .with_context(|| format!("{method} failed"))?;
    let value: Value = serde_json::from_str(response.0.get())
        .with_context(|| format!("parse {method} response"))?;
    if let Some(error) = value.get("error").filter(|e| !e.is_null()) {
        anyhow::bail!(
            "{method} failed: {}",
            error
                .as_str()
                .map_or_else(|| error.to_string(), str::to_owned)
        );
    }
    Ok(value.get("result").cloned().unwrap_or(value))
}

/// `x.ai/session/list` params: this directory's sessions (`cwd`), or every
/// directory's, optionally filtered by `query`.
fn list_params(cwd: Option<&str>, limit: usize, query: Option<&str>) -> Value {
    let mut params = serde_json::json!({ "limit": limit });
    if let Some(cwd) = cwd {
        params["cwd"] = Value::from(cwd);
    }
    if let Some(query) = query {
        params["query"] = Value::from(query);
    }
    params
}

/// `x.ai/session/search` params; snippets are requested for display.
fn search_params(query: &str, limit: usize) -> Value {
    serde_json::json!({ "query": query, "limit": limit, "includeContent": true })
}

/// One `x.ai/session/list` row, as printed.
#[derive(Debug, Clone, PartialEq)]
struct SessionRow {
    id: String,
    cwd: String,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
    title: String,
}

/// One `x.ai/session/search` hit, as printed.
#[derive(Debug, Clone, PartialEq)]
struct SearchHit {
    id: String,
    cwd: String,
    summary: String,
    updated_at: Option<DateTime<Utc>>,
    snippet: Option<String>,
}

fn text_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

fn time_field(value: &Value, key: &str) -> Option<DateTime<Utc>> {
    text_field(value, key)?.parse().ok()
}

/// The first non-blank line of `text`, trimmed.
fn first_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).find(|line| !line.is_empty())
}

/// Rows of an `x.ai/session/list` result (`{sessions: [...]}`). A row
/// without a `sessionId` is skipped; the title falls back from `title` to
/// `summary` to the first prompt's first line.
fn parse_session_rows(result: &Value) -> Result<Vec<SessionRow>> {
    let sessions = result
        .get("sessions")
        .and_then(Value::as_array)
        .context("session list response has no sessions array")?;
    Ok(sessions
        .iter()
        .filter_map(|row| {
            let id = text_field(row, "sessionId")?.to_owned();
            let title = text_field(row, "title")
                .or_else(|| text_field(row, "summary"))
                .or_else(|| text_field(row, "firstPrompt").and_then(first_line))
                .unwrap_or("(untitled)")
                .to_owned();
            Some(SessionRow {
                id,
                cwd: text_field(row, "cwd").unwrap_or_default().to_owned(),
                created_at: time_field(row, "createdAt"),
                updated_at: time_field(row, "updatedAt"),
                title,
            })
        })
        .collect())
}

/// Hits of an `x.ai/session/search` result (`{results: [...]}`).
fn parse_search_hits(result: &Value) -> Result<Vec<SearchHit>> {
    let results = result
        .get("results")
        .and_then(Value::as_array)
        .context("session search response has no results array")?;
    Ok(results
        .iter()
        .filter_map(|hit| {
            Some(SearchHit {
                id: text_field(hit, "sessionId")?.to_owned(),
                cwd: text_field(hit, "cwd").unwrap_or_default().to_owned(),
                summary: text_field(hit, "summary")
                    .and_then(first_line)
                    .unwrap_or("(untitled)")
                    .to_owned(),
                updated_at: time_field(hit, "updatedAt"),
                snippet: text_field(hit, "snippet")
                    .map(|snippet| snippet.split_whitespace().collect::<Vec<_>>().join(" ")),
            })
        })
        .collect())
}

/// `text` cut to `max` chars, marked with `…` when cut.
fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(max.saturating_sub(1)).collect();
    cut.push('\u{2026}');
    cut
}

fn local_date(at: Option<DateTime<Utc>>) -> String {
    at.map(|at| at.with_timezone(&Local).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "-".to_owned())
}

fn local_time(at: Option<DateTime<Utc>>) -> String {
    at.map(|at| {
        at.with_timezone(&Local)
            .format("%Y-%m-%d %H:%M")
            .to_string()
    })
    .unwrap_or_else(|| "-".to_owned())
}

/// The list table, grouped under a line naming each directory (groups in
/// the order the leader returned their newest session). `scope` is the one
/// directory listed, or `None` for every directory.
fn format_session_list(rows: &[SessionRow], scope: Option<&str>, limit: usize) -> String {
    use std::fmt::Write as _;
    if rows.is_empty() {
        return match scope {
            Some(cwd) => format!(
                "No sessions found in {cwd}.\n\
                 Run `dscode sessions list --all` to list sessions from every directory.\n"
            ),
            None => "No sessions found.\n".to_owned(),
        };
    }
    let rows = &rows[..rows.len().min(limit.max(1))];
    let id_width = rows
        .iter()
        .map(|row| row.id.chars().count())
        .max()
        .unwrap_or(0)
        .max("SESSION ID".len());
    let mut groups: Vec<(&str, Vec<&SessionRow>)> = Vec::new();
    for row in rows {
        match groups.iter_mut().find(|(cwd, _)| *cwd == row.cwd) {
            Some((_, members)) => members.push(row),
            None => groups.push((row.cwd.as_str(), vec![row])),
        }
    }
    let mut out = String::new();
    for (index, (cwd, members)) in groups.iter().enumerate() {
        if index > 0 {
            out.push('\n');
        }
        let _ = writeln!(
            out,
            "{}",
            if cwd.is_empty() {
                "(no directory)"
            } else {
                cwd
            }
        );
        let _ = writeln!(
            out,
            "{:<id_width$}  {:<10}  {:<16}  TITLE",
            "SESSION ID", "CREATED", "UPDATED"
        );
        for row in members {
            let _ = writeln!(
                out,
                "{:<id_width$}  {:<10}  {:<16}  {}",
                row.id,
                local_date(row.created_at),
                local_time(row.updated_at),
                truncate(&row.title, TITLE_MAX_CHARS)
            );
        }
    }
    out
}

/// Search hits, one block each, then the total.
fn format_search_hits(hits: &[SearchHit], query: &str) -> String {
    use std::fmt::Write as _;
    if hits.is_empty() {
        return format!("No sessions match {query:?}.\n");
    }
    let mut out = String::new();
    for hit in hits {
        let _ = writeln!(
            out,
            "{}  {}  {}",
            hit.id,
            local_time(hit.updated_at),
            hit.cwd
        );
        let _ = writeln!(out, "  {}", truncate(&hit.summary, TITLE_MAX_CHARS));
        if let Some(snippet) = hit.snippet.as_deref() {
            let _ = writeln!(out, "  {}", truncate(snippet, SNIPPET_MAX_CHARS));
        }
    }
    let _ = writeln!(out, "\nTotal: {}", hits.len());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser as _;

    #[derive(Debug, clap::Parser)]
    struct Cli {
        #[command(subcommand)]
        command: Top,
    }

    #[derive(Debug, clap::Subcommand)]
    enum Top {
        Sessions(SessionsArgs),
    }

    fn parse(args: &[&str]) -> Result<SessionsCommand, clap::Error> {
        let mut argv = vec!["dscode", "sessions"];
        argv.extend_from_slice(args);
        Cli::try_parse_from(argv).map(|cli| match cli.command {
            Top::Sessions(sessions) => sessions.command,
        })
    }

    fn at(rfc3339: &str) -> Option<DateTime<Utc>> {
        Some(rfc3339.parse().unwrap())
    }

    #[test]
    fn sessions_cmd_parses_list_search_and_hides_delete() {
        assert!(matches!(
            parse(&["list"]).unwrap(),
            SessionsCommand::List {
                limit: 20,
                all: false
            }
        ));
        assert!(matches!(
            parse(&["list", "--all", "-n", "5"]).unwrap(),
            SessionsCommand::List {
                limit: 5,
                all: true
            }
        ));
        assert!(matches!(
            parse(&["search", "rate limit"]).unwrap(),
            SessionsCommand::Search { ref query, limit: 20 } if query == "rate limit"
        ));
        // Still parses (so it can explain itself) but is not advertised.
        assert!(matches!(
            parse(&["delete", "abc"]).unwrap(),
            SessionsCommand::Delete { .. }
        ));
        let help = parse(&["--help"]).unwrap_err().to_string();
        assert!(help.contains("list") && help.contains("search"), "{help}");
        assert!(!help.contains("delete"), "{help}");
    }

    #[tokio::test]
    async fn sessions_cmd_delete_refuses_without_touching_the_leader() {
        let args = SessionsArgs {
            command: SessionsCommand::Delete { id: "abc".into() },
        };
        let error = run(args).await.unwrap_err().to_string();
        assert!(error.contains("cannot delete sessions"), "{error}");
        assert!(error.contains("archive"), "{error}");
    }

    #[test]
    fn sessions_cmd_request_params_match_the_leader_methods() {
        assert_eq!(
            list_params(Some("/work"), 20, None),
            serde_json::json!({"cwd": "/work", "limit": 20})
        );
        assert_eq!(
            list_params(None, 5, Some("auth")),
            serde_json::json!({"limit": 5, "query": "auth"})
        );
        assert_eq!(
            search_params("rate limit", 20),
            serde_json::json!({"query": "rate limit", "limit": 20, "includeContent": true})
        );
    }

    #[test]
    fn sessions_cmd_parses_list_rows_and_falls_back_for_titles() {
        let result = serde_json::json!({"sessions": [
            {"sessionId": "s-1", "cwd": "/work", "createdAt": "2026-09-01T10:00:00.000Z",
             "updatedAt": "2026-09-02T11:30:00.000Z", "title": "Fix auth", "summary": "Fix auth",
             "firstPrompt": "fix the auth flow", "_meta": {"x.ai/session": {"kind": "chat"}}},
            {"sessionId": "s-2", "cwd": "/work", "title": "", "summary": "",
             "firstPrompt": "\n  add tests\nplease"},
            {"sessionId": "s-3", "cwd": "", "title": ""},
            {"cwd": "/no-id"},
        ]});
        let rows = parse_session_rows(&result).unwrap();
        assert_eq!(
            rows,
            vec![
                SessionRow {
                    id: "s-1".into(),
                    cwd: "/work".into(),
                    created_at: at("2026-09-01T10:00:00Z"),
                    updated_at: at("2026-09-02T11:30:00Z"),
                    title: "Fix auth".into(),
                },
                SessionRow {
                    id: "s-2".into(),
                    cwd: "/work".into(),
                    created_at: None,
                    updated_at: None,
                    title: "add tests".into(),
                },
                SessionRow {
                    id: "s-3".into(),
                    cwd: String::new(),
                    created_at: None,
                    updated_at: None,
                    title: "(untitled)".into(),
                },
            ]
        );
        assert!(parse_session_rows(&serde_json::json!({"results": []})).is_err());
    }

    #[test]
    fn sessions_cmd_formats_the_list_grouped_by_directory() {
        let row = |id: &str, cwd: &str, title: &str| SessionRow {
            id: id.into(),
            cwd: cwd.into(),
            created_at: at("2026-09-01T10:00:00Z"),
            updated_at: at("2026-09-02T11:30:00Z"),
            title: title.into(),
        };
        let long = "x".repeat(80);
        let rows = vec![
            row("s-1", "/b", "newest"),
            row("s-22", "/a", &long),
            row("s-3", "/b", "older"),
        ];
        let created = local_date(at("2026-09-01T10:00:00Z"));
        let updated = local_time(at("2026-09-02T11:30:00Z"));
        let header = "SESSION ID  CREATED     UPDATED           TITLE";
        let line =
            |id: &str, title: &str| format!("{id:<10}  {created:<10}  {updated:<16}  {title}");
        let expected = [
            "/b".to_owned(),
            header.to_owned(),
            line("s-1", "newest"),
            line("s-3", "older"),
            String::new(),
            "/a".to_owned(),
            header.to_owned(),
            line("s-22", &format!("{}\u{2026}", "x".repeat(59))),
        ]
        .join("\n")
            + "\n";
        assert_eq!(format_session_list(&rows, None, 20), expected);
        // The limit caps the rows printed.
        assert!(!format_session_list(&rows, None, 1).contains("s-22"));
        assert_eq!(
            format_session_list(&[], Some("/work"), 20),
            "No sessions found in /work.\n\
             Run `dscode sessions list --all` to list sessions from every directory.\n"
        );
        assert_eq!(format_session_list(&[], None, 20), "No sessions found.\n");
    }

    #[test]
    fn sessions_cmd_parses_and_formats_search_hits() {
        let result = serde_json::json!({
            "results": [
                {"sessionId": "s-1", "cwd": "/work", "summary": "Fix auth\nmore",
                 "updatedAt": "2026-09-02T11:30:00.000Z", "score": 0,
                 "matchedFields": ["content"], "snippet": "the  rate\nlimit hit"},
                {"sessionId": "s-2", "cwd": "/other", "summary": ""},
            ],
            "nextCursor": null,
        });
        let hits = parse_search_hits(&result).unwrap();
        assert_eq!(hits[0].summary, "Fix auth");
        assert_eq!(hits[0].snippet.as_deref(), Some("the rate limit hit"));
        assert_eq!(hits[1].summary, "(untitled)");
        let updated = local_time(at("2026-09-02T11:30:00Z"));
        assert_eq!(
            format_search_hits(&hits, "rate limit"),
            format!(
                "s-1  {updated}  /work\n  Fix auth\n  the rate limit hit\n\
                 s-2  -  /other\n  (untitled)\n\nTotal: 2\n"
            )
        );
        assert_eq!(
            format_search_hits(&[], "nothing"),
            "No sessions match \"nothing\".\n"
        );
        assert!(parse_search_hits(&serde_json::json!({"sessions": []})).is_err());
    }
}
