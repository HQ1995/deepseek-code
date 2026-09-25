# DeepSeek Code (`dscode`)

Terminal coding agent powered by DeepSeek Harness, with a Rust TUI and a managed
runtime.

> Personal project — not affiliated with or endorsed by DeepSeek or xAI.

![DeepSeek Code](docs/dscode.png)

## Install

Requires macOS Apple Silicon or Linux x86-64, Node.js `>=22.19.0`, npm, and
GitHub access for the first install.
On Apple Silicon, use native ARM64 Node (`node -p process.arch` should print
`arm64`); x64 Node under Rosetta does not select the Mac ARM64 payload.

```sh
npx @hqzhao95/dscode@alpha
```

This page follows `main`, which ships on the alpha channel. Plain
`npx @hqzhao95/dscode` installs the stable channel, which can lag several
releases behind and lack features described here.

The launcher verifies and installs the matching TUI, bridge, and pinned DSH
runtime under `~/.dsh/profiles/dscode`, then links `~/.local/bin/dscode`. Add
`~/.local/bin` to `PATH`. No global DSH installation or compiler is needed.

Open `/provider --add` to configure a provider and paste its API key (the key
alone, not a `NAME=value` line), then `/model` to select a model. `/provider`
rows say when a key is missing or comes from the environment. Fresh sessions
use DSH's `standard` preset; `/preset` selects another preset and remembers it
for future sessions.

## Use

```sh
dscode                              # interactive TUI
dscode "review this repository"     # start with a prompt
dscode -p "explain src/index.ts"     # headless single turn
dscode -c                           # continue the latest session for this cwd
dscode --resume <id-or-title>       # resume a session
dscode sessions list [--all]        # this cwd's sessions (all cwds); also `sessions search <q>`
dscode -w                           # new session in an auto-named worktree
dscode --worktree=feat "fix it"     # named worktree with an initial prompt
dscode worktree list                # inspect managed worktrees
```

`--resume <id> --worktree=try` forks a conversation into a worktree;
`--worktree-ref <ref>` selects its base. `worktree rm` checks for unsaved work
unless `--force` is explicit. Headless formats are `plain`, `json`,
`streaming-json`, and `streaming-messages-json`. Run `dscode --help` for all options.

| In the TUI | Action |
|---|---|
| `/model`, `/provider` | Choose model, reasoning effort, and provider; selections persist |
| `/preset`, `Ctrl+Y` | Choose an installed preset |
| `/preset manage` | Search, copy (`c`), view (`v`), or edit (`e`) presets; restart after editing |
| `/resume`, `/reference` | Search sessions or insert a reference into the draft |
| `/compact`, `/goal` | Use the selected preset's native compaction and goal controls |
| `/subagents`, `/inbox` | Inspect children; queue, steer, edit, remove, or stop pending work |
| `/tasks`, `/workflows` | Read jobs, child transcripts, workflow phases, and retained output |
| `/tasks terminals` | Inspect persistent shells; `i` interrupts, `x` then Enter closes |
| `/reminders` | Schedule `after 10m <text>`, `every 1h <text>`, `at <ISO time> <text>`, `daily 09:00 <text>`, `weekly mon,wed 09:00 <text>` or `cron "0 9 * * 1-5" <text>` (local time zone) |
| `/skills`, `/mcps` | Browse session skills and MCP servers; `u` inserts a selected skill |
| `/rewind`, `/undo` | Continue from an earlier prompt in a new session |
| `/export [filename]` | Copy/save Markdown; `.zip` exports logs, descendants, and attachments |
| `/team` | Show the roster and task board of a `teams` session's Agent Team |
| `/browser` | Turn the isolated headless browser on or off and edit its allowed origins |
| `/dsh plugins` | List, switch, add and remove dsh plugins; see [Plugins](#plugins) |
| `/doctor` | Check terminal, installation, and optional LSP/PTY dependencies |
| `Ctrl+P` | Open commands while keeping the current draft |
| `Ctrl+S`, `Alt+S` | Stash or restore one prompt draft |
| `Ctrl+T` | View the native Todo list |
| `Enter` in a block viewer | Quote the selection into the draft |

Paste or drag PNG, JPEG, WebP, or GIF images when the model supports image input.
Completed child transcripts remain readable after restart. A reminder is
delivered while its session is open; one that falls due while it is closed
arrives when the session next opens. Session ZIP export refuses existing files.
Native `present` deliveries appear as file links and survive transcript replay;
links open the current source file. `/feedback <text>` records native feedback
without a model turn and may share session context under DSH's telemetry policy.

Optional presets: `history` adds workspace-scoped session search tools;
`terminal` adds persistent shell/REPL tools; `lsp` adds code navigation and needs
`typescript-language-server` and `typescript` on `PATH`; `teams` (experimental)
replaces subagents and workflows with native Agent Teams: named teammates you ask
for, durable messages and a shared task board, all in one checkout. Pick it when
a session opens; see the [Agent Teams notes](docs/upgrade-strategy.md#agent-teams).
Minimal follows DSH's shell-only configuration. See the
[DSH feature coverage](docs/upgrade-strategy.md#dsh-017-feature-coverage) for
native DeepSeek-V41-Flash setup and platform/UI limits.

The browser is off by default. `/browser on --origin https://example.com` gives
open and new sessions a private headless Chrome or Chromium that may open only
the listed origins; `/browser origins add <origin>` extends the list for browsers
started afterwards.
Every browser action asks for your approval and shows what it will do, so
always-approve mode refuses browser actions. It is not an OS network or host
sandbox; see the [browser notes](docs/upgrade-strategy.md#browser) for browser
discovery, the Chromium sandbox and origin filtering.

## Plugins

dscode runs as a DSH profile, and its plugins are DSH bundles: npm packages whose
patch layer adds or changes rows (components) of that profile. `/dsh plugins`
lists them as DSH's own Plugins page does: title and one-line description,
package and version, on or off, kind (`core`, `official · optional`,
`installed`, `removable`, `experimental`) and the rows by state (`18 rows · 17
running · 1 off`), then the reason for each problem bundle. The pinned runtime
ships three official bundles switched off: Agent Teams, Voice input and Auto
Authorization Review.

| Command | Action |
|---|---|
| `/dsh plugins` | The table above |
| `/dsh enable <bundle>`, `/dsh disable <bundle>` | Select or deselect a bundle; its package stays installed |
| `/dsh enable <bundle>#<row>`, `/dsh disable <bundle>#<row>` | Switch one component of a bundle that is on |
| `/dsh inspect <bundle>` | Its components, their state and the services they provide |
| `/dsh add [--trust] <package>`, `/dsh remove <bundle>` | Audit and install with npm, or uninstall |

Switches go through DSH's plugin manager and apply to the running leader at
once. The reply uses the Plugins page's outcomes: applied, saved but overridden
by a higher-priority configuration (a `cordis.patch.yml` in the DSH home or a
`--patch` overlay), or could not enable with the reason. A bundle or component
whose rows do not start is switched off again, so the next start is unaffected.
dscode's own bundles (`@deepseek-ai/dsh-base`, `@hqzhao95/dscode`) stay on;
their rows follow the commands that own them, such as `/browser` and
`/provider`. Agent Teams gives every session Team tools, which `/doctor` warns
about; `/preset teams` mounts them in one session instead.

dscode keeps this profile with npm. Add and remove its plugins with `/dsh add`
and `/dsh remove` only: `dsh plugin --profile dscode …` and DSH's plugin manager
install with pnpm, and `/doctor` warns when the profile holds a `pnpm-lock.yaml`.

A bundle that cannot load is skipped at startup: dscode starts without it and
the next session you open says which one and why. `/doctor` and
`dscode doctor --runtime` report skipped bundles, rows that failed or wait for a
service, and the leader log. If a plugin keeps dscode from starting at all, the
TUI ends its error with `If a plugin broke startup, run dscode doctor
--reset-plugins.` That safe mode backs up the profile's `cordis.patch.yml`,
selects only dscode's shipped bundles and keeps installed packages; it prints
what changed and the `mv` command that restores the patch. Row switches (the
native DeepSeek route `llm-deepseek` from `/provider`, `/browser on`), provider
and model settings, MCP servers and a remote workspace live in that patch and
are off until you restore it; API keys are kept.

## Remote workspace over SSH (experimental)

A remote workspace is its own dscode home: every tool, shell, file edit and
code run happens on one POSIX host over SSH, while the TUI, model access and
session history stay on this computer. The host needs Node 22 or newer and this
dscode's DSH release of `@deepseek-ai/dsh-ssh` and
`@deepseek-ai/dsh-ptc-runtime-node` npm-installed in one directory; `init`
checks the host before it writes anything and prints the install command when
they are missing. See the
[remote workspace notes](docs/upgrade-strategy.md#remote-workspace-over-ssh).

```sh
DSH_HOME=~/.dsh-remote/build dscode remote init --host build --workspace /srv/work \
  --node /opt/node/bin/node --dsh /opt/dscode-dsh
DSH_HOME=~/.dsh-remote/build dscode        # sessions open in build:/srv/work
DSH_HOME=~/.dsh-remote/build dscode remote status --check
```

The host alias must already work with `ssh -o BatchMode=yes <alias>` and a
known host key. The header shows `ssh build:/srv/work`. Session paths are
remote, so the TUI never links, opens or previews them here, and it does not
use this directory's project settings or worktrees. The connection does not
reconnect: after it drops, restart dscode. `dscode remote remove` makes the
home local again.

## Per-run configuration

```sh
DSCODE_CONFIG='{"models":{"default_reasoning_effort":"high"}}' dscode
DSCODE_CONFIG_PATH=./dscode-overlay.toml dscode
DSCODE_CONNECT_UI_TIMEOUT_SECS=60 dscode
```

Inline configuration is JSON; files accept JSON or TOML. These temporary
overrides cannot set credentials, providers, plugins, MCP servers, or command
hooks. Ambient `GROK_CONFIG`, `GROK_CONFIG_PATH`, and
`GROK_CONNECT_UI_TIMEOUT_SECS` are ignored.

## Update and uninstall

```sh
dscode update --check              # read-only; add --json for structured output
dscode update                      # remembered/current channel
dscode update --stable             # stable releases
dscode update --beta               # beta or stable releases
dscode update --alpha              # alpha or stable releases
dscode update --version <version>  # exact version
dscode doctor --runtime            # diagnose even when normal startup fails
dscode doctor --reset-plugins      # safe mode: only dscode's shipped plugins
dscode uninstall
```

DSH checks every profile bundle's `@deepseek-ai/dsh*` peers against the running
runtime and skips an incompatible one at startup, so an update to a new DSH can
turn off a third-party bundle that pins the old one. `dscode doctor --runtime`
and `/doctor` list such bundles. Inside dscode, `/dsh add` refuses them before
changing the profile, and `/dsh allow-version <package@version> --accept-risk`
grants an exact-version exemption.

Uninstall removes the product binaries and keeps profile sessions, settings and shared DSH data. Use `dscode uninstall --remove-dsh` to also remove the global DSH package.

Updates install the matching bridge, TUI, and runtime together and save the
channel only after success. Failed validation or ordinary commit errors retain
the previous installation. Fresh prerelease installs use
`npx @hqzhao95/dscode@beta` or `npx @hqzhao95/dscode@alpha`.

An installation older than `0.0.14-alpha.4` predates the dsh native helper
package rename and cannot validate a current runtime; re-run
`npx @hqzhao95/dscode@<channel>` once to re-bootstrap, then `dscode update`
keeps working.

## Maintainers

- [Bridge development](bridge/grok-leader/README.md)
- [Protocol contract](docs/grok-leader-protocol.md)
- [Upgrade, testing, and release](docs/upgrade-strategy.md)
- [Architecture](docs/architecture.md) and [performance](docs/performance.md)
- Current records: [DSH 0.1.7 adaptation](docs/dsh-upstream-refresh-2026-09-22.md)
  and [capability port and UX audit](docs/dsh-capability-candidate.md)
- [License and third-party notices](THIRD_PARTY_NOTICES.md)
