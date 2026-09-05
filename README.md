# DeepSeek Code (`dscode`)

Terminal coding agent UI powered by DeepSeek Harness. The product bundles a
Rust TUI, an isolated `dsh` profile, and the bridge between them.

> Personal project — not affiliated with or endorsed by DeepSeek or xAI.

![DeepSeek Code](docs/dscode.png)

## Prerequisites

- macOS Apple Silicon or Linux x86-64
- Node.js `>=22.19.0` and npm (the floor comes from pinned `dsh`)
- GitHub network access for the first install
- `~/.local/bin` on `PATH` after installation

You do not need to install `dsh` globally. Source-runtime releases use the
profile-owned, provenance-checked runtime. Registry-backed releases may reuse
an exactly compatible `dsh` from `PATH`; an explicit `DSH_BIN` must match the pin.

## Install

```sh
npx @hqzhao95/dscode
```

The first run prepares the matching bridge, tested runtime, and TUI under
`~/.dsh/profiles/dscode`, verifies their versions and SHA-256 digests, and links
`~/.local/bin/dscode`. Source-runtime releases include the built SDK and native
helpers, so users do not need unpublished upstream npm packages or a compiler.
It does not change the global npm prefix or install/switch Node for you.

A fresh profile has no provider or API key. Open `/provider --add` and choose
a template or Custom; dscode does not restrict which provider you use.
Fresh profiles start new sessions with dsh's `standard` preset: native coding
tools, automatic compaction, planning, skills, goals, subagents, and workflows.
Choose `code`, `minimal`, `cordis`, `history`, or an installed preset with `/preset`; a
successful manual choice becomes the default for later new sessions.

## Use

```sh
dscode                              # interactive TUI
dscode "review this repository"     # start with a prompt
dscode -p "explain src/index.ts"     # headless single turn
dscode -c                           # continue the latest session for this cwd
dscode --resume <id-or-title>       # resume a session
dscode sessions list                # list durable sessions
dscode -w                           # new session in an auto-named worktree
dscode --worktree=feat "fix it"     # named worktree with an initial prompt
dscode --resume <id> --worktree=try # fork a conversation into a worktree
dscode worktree list                # inspect managed worktrees
```

`--worktree-ref <branch|tag|commit>` selects the clean base. Management stays
local: `dscode worktree list|show|rm|gc|db`; `rm` uses the upstream
no-data-loss gate unless `--force` is explicit.

Headless output formats are `plain`, `json`, `streaming-json`, and
`streaming-messages-json`.

Interactive prompts accept pasted or dragged PNG, JPEG, WebP, and GIF images
when the selected model advertises image input. dscode stores them through
dsh's durable attachment service; the provider adapter handles request resizing
and encoding. The status row shows the cumulative prompt-cache hit percentage.
Question cards preserve multiline detail and accept Shift+Enter in free-form
answers.

Useful in-app commands:

- `/model` — choose model and reasoning effort; choices persist
- `/provider` and `/provider --add` — select or add any provider
- `/preset` or `Ctrl+Y` — choose any discovered preset; `history` adds five official workspace-scoped history tools to `standard` without changing other presets
- `/compact` — manually compact older history when the active preset provides dsh compaction
- `/goal` — control native goals when the preset provides them; `/goal pause` stops future rounds but leaves the current turn running, and Ctrl+C cancels that turn. `/auto` remains unsupported and does not change permissions.
- `/mcps` — inspect live per-session MCP servers and refresh their tool status
- `/skills` — inspect and filter skills mounted by the active dsh preset
- `/rewind` or `/undo` — fork at an earlier prompt and continue without destroying the source session
- `/export [filename]` — copy or save the complete loaded transcript as Markdown
- `/dsh plugins` — inspect profile plugins
- `Ctrl+W` on the welcome screen — create a managed isolated Git worktree
- `Ctrl+S` — resume durable sessions; content search follows opaque result pages up to 100 matches

Run `dscode --help` for the complete CLI.

When switching providers, dscode keeps the current model if the target
provider exposes the same model id; otherwise it selects that provider's first
model. Reasoning effort is remembered separately for each provider/model pair.

## Per-run configuration

Use the dscode namespace for process-local overrides:

```sh
DSCODE_CONFIG='{"models":{"default_reasoning_effort":"high"}}' dscode
DSCODE_CONFIG_PATH=./dscode-overlay.toml dscode
DSCODE_CONNECT_UI_TIMEOUT_SECS=60 dscode
```

The first value is inline JSON; the path accepts JSON or TOML. These soft
overrides do not persist and cannot set credentials, providers, plugins, MCP
servers, or command hooks. Ambient `GROK_CONFIG`, `GROK_CONFIG_PATH`, and
`GROK_CONNECT_UI_TIMEOUT_SECS` are ignored so a co-installed grok-build keeps
an independent configuration namespace.

## Update

```sh
dscode update --check              # check only
dscode update                      # remembered/current channel
dscode update --stable             # stable channel
dscode update --beta               # beta channel
dscode update --alpha              # independent experimental channel
dscode update --version <version>  # exact version
```

Each update resolves one exact product version, then installs its bridge, TUI,
and pinned runtime together. Stable excludes prereleases; beta and alpha each
accept only their own prereleases plus stable releases. `--check` is read-only;
add `--json` for machine-readable output. Channel selections persist only after
successful installation; download, validation, or ordinary commit failures
retain the previous installation and channel.

Historical `channel = "alpha"` settings without `channel_format = 1` meant beta
and continue to resolve beta without rewriting the file. An explicit successful
`--alpha` selection records the independent alpha channel and format marker.
Fresh prerelease installs use `npx @hqzhao95/dscode@beta` or
`npx @hqzhao95/dscode@alpha` once that product release is published.

## Uninstall

```sh
dscode uninstall
```

This removes the dscode profile, product-owned runtime and TUI cache, and the
owned launcher link. Shared `~/.dsh/sessions` and `~/.dsh/storages` remain.

If the launcher is unavailable, remove only the owned paths manually:

```sh
rm -rf ~/.dsh/profiles/dscode ~/.local/bin/dscode
```

## Maintainers

- [Bridge implementation](bridge/grok-leader/README.md)
- [Leader bridge protocol](docs/grok-leader-protocol.md)
- [Upgrade and release](docs/upgrade-strategy.md)
- [License and third-party notices](THIRD_PARTY_NOTICES.md)
