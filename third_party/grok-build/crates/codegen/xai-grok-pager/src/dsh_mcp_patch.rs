//! Text-level editor for the dsh profile's `cordis.patch.yml` user patch layer.
//!
//! This MUST NOT round-trip through a YAML (de)serializer: the loader's dialect
//! (js-yaml + a custom `!!js` tag) round-trips as expression nodes, and
//! `serde_yaml` silently strips the `!!js` tag while `yaml-rust` drops it.
//! Destroying it corrupts unrelated entries a user may have added. Everything
//! here operates on raw lines, so `!!js` expressions, comments, and unrelated
//! entries survive byte-for-byte.
//!
//! One `mcp` server is one `- insert:` block (idiomatic here: the shipped
//! grok-leader patch carries four separate `insert` blocks). Add appends a
//! block; remove deletes the block holding the named server.

/// One MCP server read out of the patch file, enough for `mcp list`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerInfo {
    pub name: String,
    pub transport: String,
    /// stdio: the command (args already appended); streamable-http: the URL.
    pub target: String,
}

/// Locate the line index of the `- id: mcp-client-<name>` entry, if present.
fn find_entry(lines: &[&str], name: &str) -> Option<usize> {
    let needle = format!("- id: mcp-client-{name}");
    lines.iter().position(|line| line.trim() == needle)
}

/// Every MCP server entry, in file order.
pub fn list_servers(text: &str) -> Vec<ServerInfo> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let trimmed = lines[i].trim();
        let Some(rest) = trimmed.strip_prefix("- id: mcp-client-") else {
            i += 1;
            continue;
        };
        let name = rest.trim().to_string();
        let entry_indent = leading_spaces(lines[i]);
        let mut transport = String::new();
        let mut server_name = String::new();
        let mut command: Option<String> = None;
        let mut args: Option<Vec<String>> = None;
        let mut url: Option<String> = None;
        let mut j = i + 1;
        // Consume the entry's children (indent strictly deeper than its own).
        while j < lines.len() && (blank(lines[j]) || leading_spaces(lines[j]) > entry_indent) {
            if let Some((key, raw)) = key_value(lines[j]) {
                match key {
                    "transport" => transport = unquote(raw),
                    "serverName" => server_name = unquote(raw),
                    "command" => command = Some(unquote(raw)),
                    "args" => args = parse_flow_vec(raw),
                    "url" => url = Some(unquote(raw)),
                    _ => {}
                }
            }
            j += 1;
        }
        i = j;
        let display_name = if server_name.is_empty() { name } else { server_name };
        let target = match transport.as_str() {
            "stdio" => match (command, args) {
                (Some(cmd), Some(a)) if !a.is_empty() => format!("{cmd} {}", a.join(" ")),
                (Some(cmd), _) => cmd,
                (None, _) => String::new(),
            },
            _ => url.unwrap_or_default(),
        };
        out.push(ServerInfo {
            name: display_name,
            transport,
            target,
        });
    }
    out
}

/// Remove the `- insert:` block holding `mcp-client-<name>`. Returns the new
/// text and whether anything was removed.
pub fn remove_server(text: &str, name: &str) -> (String, bool) {
    let lines: Vec<&str> = text.lines().collect();
    let Some(entry_idx) = find_entry(&lines, name) else {
        return (text.to_string(), false);
    };
    // Walk up to the enclosing top-level `- insert:` line.
    let mut insert_idx = None;
    for k in (0..=entry_idx).rev() {
        if leading_spaces(lines[k]) == 0 && lines[k].trim_start().starts_with("- insert") {
            insert_idx = Some(k);
            break;
        }
    }
    let Some(insert_idx) = insert_idx else {
        // Entry not wrapped in an `insert` block; delete its own item only.
        let end = end_of_item(&lines, entry_idx);
        return (join_excluding(&lines, entry_idx, end), true);
    };
    // The block spans from `insert_idx` to the next top-level entry.
    let end = (insert_idx + 1..lines.len())
        .find(|&k| leading_spaces(lines[k]) == 0)
        .unwrap_or(lines.len());
    (join_excluding(&lines, insert_idx, end), true)
}

/// Add or update a server: drop any existing `mcp-client-<name>` block, then
/// append a freshly rendered one.
pub fn upsert_server(text: &str, name: &str, block: &str) -> String {
    let (stripped, _) = remove_server(text, name);
    let mut stripped = stripped;
    let trimmed_end = stripped.trim_end();
    if !trimmed_end.is_empty() {
        stripped.truncate(trimmed_end.len());
        stripped.push('\n');
    }
    stripped.push_str(block);
    if !stripped.ends_with('\n') {
        stripped.push('\n');
    }
    stripped
}

/// Render one `- insert:` block for a stdio or streamable-http server using
/// flow-style JSON for `args`/`env`/`headers` (JSON is valid YAML flow).
pub fn render_block_stdio(
    name: &str,
    command: &str,
    args: &[String],
    env: Option<&std::collections::HashMap<String, String>>,
) -> String {
    let mut out = format!(
        "- insert:\n    - id: mcp-client-{name}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: 'stdio'\n        serverName: {name}\n        command: {}\n",
        json_string(command)
    );
    if !args.is_empty() {
        out.push_str(&format!(
            "        args: {}\n",
            serde_json::to_string(args).unwrap_or_else(|_| "[]".into())
        ));
    }
    if let Some(env) = env.filter(|e| !e.is_empty()) {
        out.push_str(&format!(
            "        env: {}\n",
            serde_json::to_string(env).unwrap_or_else(|_| "{}".into())
        ));
    }
    out.push_str("        failOnStartupError: true\n");
    out
}

/// Render one `- insert:` block for a streamable-http server.
pub fn render_block_http(
    name: &str,
    url: &str,
    headers: Option<&std::collections::HashMap<String, String>>,
) -> String {
    let mut out = format!(
        "- insert:\n    - id: mcp-client-{name}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: 'streamable-http'\n        serverName: {name}\n        url: {}\n",
        json_string(url)
    );
    if let Some(headers) = headers.filter(|h| !h.is_empty()) {
        out.push_str(&format!(
            "        headers: {}\n",
            serde_json::to_string(headers).unwrap_or_else(|_| "{}".into())
        ));
    }
    out.push_str("        failOnStartupError: true\n");
    out
}

// --- line helpers ----------------------------------------------------------

fn leading_spaces(line: &str) -> usize {
    line.bytes().take_while(|b| *b == b' ').count()
}

fn blank(line: &str) -> bool {
    line.trim().is_empty()
}

/// `"    key: value"` -> `Some(("key", " value"))`; `None` for lines without a
/// colon key (comments, list dashes, `config:` containers still yield a key).
fn key_value(line: &str) -> Option<(&str, &str)> {
    let trimmed = line.trim_start();
    if trimmed.starts_with('-') || trimmed.starts_with('#') {
        return None;
    }
    let (key, value) = trimmed.split_once(':')?;
    if key.is_empty() || key.contains(' ') {
        return None;
    }
    Some((key, value.trim()))
}

/// Unquote a scalar value already trimmed of its key.
fn unquote(raw: &str) -> String {
    let raw = raw.trim();
    if raw.len() >= 2 && raw.starts_with('\'') && raw.ends_with('\'') {
        raw[1..raw.len() - 1].replace("''", "'")
    } else if raw.len() >= 2 && raw.starts_with('"') && raw.ends_with('"') {
        raw[1..raw.len() - 1].to_string()
    } else {
        raw.to_string()
    }
}

/// Parse a flow-style array of scalars, e.g. `['a', "b"]`.
fn parse_flow_vec(raw: &str) -> Option<Vec<String>> {
    let raw = raw.trim();
    let raw = raw.strip_prefix('[')?.strip_suffix(']')?;
    let mut out = Vec::new();
    for piece in raw.split(',') {
        let piece = piece.trim();
        if piece.is_empty() {
            continue;
        }
        out.push(unquote(piece));
    }
    Some(out)
}

/// Quote a string as a JSON string literal (valid YAML scalar).
fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// End index (exclusive) of a list item starting at `idx`: the next line whose
/// indent is `<=` the item's own indent, or EOF.
fn end_of_item(lines: &[&str], idx: usize) -> usize {
    let indent = leading_spaces(lines[idx]);
    (idx + 1..lines.len())
        .find(|&k| !blank(lines[k]) && leading_spaces(lines[k]) <= indent)
        .unwrap_or(lines.len())
}

/// Join `lines` excluding the half-open range `[start, end)`.
fn join_excluding(lines: &[&str], start: usize, end: usize) -> String {
    let mut out = String::new();
    for (i, line) in lines.iter().enumerate() {
        if i >= start && i < end {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    // Collapse a removed block that left a run of trailing blank lines.
    while out.ends_with("\n\n") {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const ONE: &str = "- insert:\n    - id: mcp-client-httptest\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: 'stdio'\n        serverName: httptest\n        command: 'python3'\n        args: ['/tmp/mcp-stdio-test.py']\n        failOnStartupError: true\n";

    const TWO: &str = "- id: system-prompt\n  config:\n    persona: 'x'\n\n- insert:\n    - id: mcp-client-a\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: 'stdio'\n        serverName: a\n        command: 'py'\n        failOnStartupError: true\n\n- insert:\n    - id: mcp-client-b\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: 'streamable-http'\n        serverName: b\n        url: 'https://x/mcp'\n        failOnStartupError: true\n";

    #[test]
    fn lists_both_servers() {
        let servers = list_servers(TWO);
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].name, "a");
        assert_eq!(servers[0].transport, "stdio");
        assert_eq!(servers[0].target, "py");
        assert_eq!(servers[1].name, "b");
        assert_eq!(servers[1].transport, "streamable-http");
        assert_eq!(servers[1].target, "https://x/mcp");
    }

    #[test]
    fn lists_stdio_with_args() {
        let servers = list_servers(ONE);
        assert_eq!(servers[0].target, "python3 /tmp/mcp-stdio-test.py");
    }

    #[test]
    fn remove_deletes_whole_block() {
        let (text, removed) = remove_server(TWO, "a");
        assert!(removed);
        assert!(!text.contains("mcp-client-a"));
        assert!(text.contains("mcp-client-b"));
        assert!(text.contains("system-prompt"));
    }

    #[test]
    fn remove_missing_is_noop() {
        let (text, removed) = remove_server(TWO, "nope");
        assert!(!removed);
        assert_eq!(text, TWO);
    }

    #[test]
    fn upsert_replaces_existing() {
        let block = render_block_stdio("a", "newpy", &[], None);
        let text = upsert_server(TWO, "a", &block);
        assert!(!text.contains("command: 'py'"));
        assert!(text.contains("command: \"newpy\""));
        // Still exactly the other server + the unrelated entry.
        assert_eq!(list_servers(&text).len(), 2);
    }

    #[test]
    fn upsert_onto_empty_file() {
        let block = render_block_stdio("x", "py", &["--flag".into()], None);
        let text = upsert_server("", "x", &block);
        assert_eq!(list_servers(&text).len(), 1);
        assert!(text.starts_with("- insert:\n"));
    }

    #[test]
    fn preserves_js_expr_and_comments() {
        // A `!!js` expression and a comment in an unrelated entry must survive.
        let text = "# top comment\n- id: grok-leader\n  config:\n    socketPath: !!js process.env.DSCODE_SOCKET\n";
        let block = render_block_stdio("x", "py", &[], None);
        let merged = upsert_server(text, "x", &block);
        assert!(merged.contains("# top comment"));
        assert!(merged.contains("!!js process.env.DSCODE_SOCKET"));
    }
}