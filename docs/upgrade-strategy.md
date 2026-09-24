# Upgrade and release

`dscode` ships three versioned parts: the vendored Rust TUI, the
`grok-leader` bridge, and a pinned DSH runtime. A product release identifies one
complete tuple; never follow an unpinned `latest` runtime at user launch.

## TUI sync

The TUI lives in `third_party/grok-build` and is maintained as in-repo source,
not a submodule.

1. Run `scripts/update-tui.sh <upstream-ref>` to prepare a scratch diff.
2. Port selected upstream changes by hand; do not replace the tree wholesale.
3. Update `third_party/grok-build/UPSTREAM_REV`.
4. Record every local difference in
   `third_party/grok-build/TUI-DIVERGENCE.md`.
5. Build and run the full product suite.

Generic fixes should go upstream when practical. Remove their divergence entry
after the upstream baseline contains the fix.

## dsh runtime

Follow only [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
Do not maintain a separate product harness fork. Keep dscode integration in the
external bridge, submit generic fixes upstream, and consume verified official
revisions through the versioned product tuple.

The supported runtime is declared in `bridge/grok-leader/package.json`:

- `dsh.testedVersion`: exact runtime used by the launcher
- `dsh.supportedRange`: compatibility range for profile plugins
- `dsh.sourceCommit`: full upstream revision for a source-built SDK/runtime
- `dsh.sourcePatchSha256`: SHA-256 of the source backport
  `patches/dsh-<sourceCommit>.patch`, when one exists

To upgrade dsh:

1. Bump `dsh.testedVersion`, `dsh.sourceCommit` and, when needed,
   `dsh.supportedRange`.
2. Update the entire `@deepseek-ai/dsh-*` SDK family, plus Cordis, Schemastery
   and `cordis-plugin-include`, to exact versions in both `peerDependencies`
   and `devDependencies` of `bridge/grok-leader/package.json`. Update the
   registry lockfile only when that family is published; otherwise build the
   pinned source family.
3. Move the pinned family's entries in `minimumReleaseAgeExclude` in
   `bridge/grok-leader/pnpm-workspace.yaml` to the new version.
4. Rebase the backport onto the new commit, or drop it once upstream carries
   the change (see `patches/README.md`). Update or remove
   `dsh.sourcePatchSha256`, and delete the old `patches/dsh-<commit>.patch`.
5. Update the DSH version `scripts/e2e-contracts.mjs` asserts.
6. Mirror the pinned dsh dependency tree's Node floor in the launcher and npm
   metadata, but never install or switch the user's Node runtime.
7. Audit the upstream diff of every package, service, event, bundle row and CLI
   flag the bridge uses.
8. Build both platform payloads, rebuild the bridge against them and run the
   complete E2E suite.
9. Run macOS and [Linux acceptance](#linux-acceptance), and redeploy the
   [remote SSH helper](#remote-workspace-over-ssh) on each host.

The current source pin is `0.1.7-rc.2` at
`477b4f420553e8a52c2fbccc464d7561b239c443`. The builder uses the official upstream
package build, compiles the bridge against that installed SDK, bundles ordinary
plugin dependencies without duplicating host peers, and packages the private
runtime including native helpers. Users install those artifacts as a complete
tuple. Never mix SDK families or duplicate Cordis/service scope
identities.

DSH 0.1.7 uses V4 session logs, including first-class tool-role messages.
The bridge normalizes its two historical model-selection event names only for
V0/V1/V2 through an instance-local JSONL decoder adapter. Native migration owns
child facts, validation and generation publication. V3 tool results migrate
through the official V3-to-V4 path. Original generations remain intact; an older
runtime refuses the newer generation. Rolling back the executable does not
downgrade session data or resume a stale copy.

The source patch also exposes completion of the native legacy settings import.
The bridge waits for it before reading the first model catalog, so an upgraded
profile cannot race provider/default migration from `settings.yaml` into its
`cordis.patch.yml`. The original is retained as `settings.yaml.imported`.

Linux runtime payloads now include `node-addon-system` 0.1.2 flock and Landlock
artifacts, built with the official `native/system` scripts.

Source-runtime descriptors record the source revision, DSH version, platform,
and architecture; the launcher validates them and the CLI/native helper before
activation. The helper is discovered from the installed layout and checked
against what its own `prebuilds.json` declares, so an upstream package rename or
renamed identifier cannot block an update the installed launcher would
otherwise refuse. An explicit `DSH_BIN` must report the exact pin. Registry-backed
releases may reuse an exact PATH runtime. Neither path upgrades a global install.

Stable, beta, and alpha are independent product channels. Beta and alpha each
include their own prereleases plus stable releases. Unmarked historical
`channel = "alpha"` resolves beta; canonical settings carry `channel_format = 1`.
Checks never write that migration. The installer commits the channel only after
the exact tuple is ready, restoring moved entries after ordinary commit errors.

### DSH 0.1.7 feature coverage

The [alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-alpha.1)
and [alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-alpha.2)
releases describe the target; the
[rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1)
notes summarize the series since 0.1.5-rc.3. Runtime features use official
implementations. Browser presentation does not automatically become a TUI feature.

[rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2)
moves schedules into a host service with its own storage, adds daily, weekly
and cron schedules and `schedule_update`, and delivers through a host-provided
`sessionController`. It splits the native DeepSeek adapter into an API-key
route and a new account route, lets tools change inside a running
conversation, and gives approval requests a localized reason. dscode adopts
each of these below; the account route stays off.

rc.1 enforces plugin compatibility: every `@deepseek-ai/dsh` and
`@deepseek-ai/dsh-*` peer of a profile bundle or preset row must be satisfied by
the running DSH version, prereleases included. At startup, DSH skips an
incompatible bundle whole, or mounts the row disabled, and says so only in the
leader log. dscode therefore pins its peers exactly and applies the same rule
earlier:

- `/dsh add` checks the package and every package its bundle rows insert,
  resolved as boot resolves them (the DSH installation first). It refuses an
  incompatible one before the profile changes. A package that passes staging but
  installs incompatible rolls back the manifest, lockfile and modules. An
  exempted package installs with its warning in the report.
- `/dsh allow-version <package@version> --accept-risk` and `/dsh revoke-version`
  write the exemption into this exact profile for the running DSH version, so no
  PATH `dsh` or profile name can target the wrong one.
- `dscode doctor --runtime` and `/doctor` evaluate every profile bundle and its
  inserted rows with the runtime's own app-boot. They report skipped bundles and
  disabled rows as errors, and exempted ones as warnings. An unreadable
  `compatibility.json`, or a DSH executable outside an `@deepseek-ai/dsh`
  installation, is reported rather than silently passed.

Exemptions are exact package and DSH versions, stored in the profile's
`compatibility.json`; a dscode update to a new DSH version does not carry them
forward.

Since alpha.2, permission presets refuse to activate when the composed sandbox
and approval defaults match no preset; a profile must then set
`defaultPreset`. DSH's own `dsh plugin add` installs through `pnpm`, which must
be on PATH; dscode's `/dsh add` uses npm.

| Upstream capability | dscode integration |
|---|---|
| V4 logs, immutable migration, SessionHandle and process locks | Native persistence, legacy model-selection adapter and tool-role replay; resume/fork/archive tests |
| Parent-owned subagent catalog and ordered discovery | Native `listDescendants`; `/subagents`, Tasks and child history; catalog survives restart |
| Continuable children, queue/edit/remove/steer/stop | Existing native inbox adapters and TUI controls; terminal states retain readable history |
| Agent Team messaging changes | Included in the runtime and the shipped `teams` preset (see [Agent Teams](#agent-teams)) |
| Goals, explicit pause/resume and turn cancellation | `/goal` and native controls; pausing does not let the model resume itself |
| Reminder scheduling | `/reminders` with `after`, `every`, `at`, `daily`, `weekly` and `cron`; DSH Host Schedule tasks, delivered only while their Session is open in dscode, so one that falls due while it is closed arrives when it next opens. rc.1 session-event reminders are not migrated; each open names them once and shows how to recreate them |
| Mid-conversation tool changes | The next step carries the changed tools; a `Tools added: …` / `Tools removed: …` system line appears live and on resume, and the session's commands refresh |
| Approval reasons | Shown after the tool name, and as the first description line of a shell prompt; see [approval reasons](#approval-reasons) |
| Jobs, retained output and subprocess cleanup | `/tasks`, native non-consuming `readAt`, session-owned events and cancellation; host PID validation remains enforced |
| Completion wakeups after successive background jobs or one-shot subagents | Native `tool-jobs` default: dscode presets set no cap, so each idle completion wakes its owner; a profile may still set `maxConsecutiveWakes` |
| Token-budgeted tool-result retention, including MCP images | Native `spill-policy` with the base bundle's `maxInlineTokens: 12500`; dscode adds no override. A custom `maxInlineBytes` override must move to `maxInlineTokens` |
| Persistent shell and REPL | `terminal` preset and `/tasks terminals`; native interrupt/close and per-session ownership |
| Minimal preset | Follows upstream's persistent shell; `str_replace_editor` is now an explicit opt-in |
| Standard read/write/edit, FS_NOT_OBSERVED and scoped tool guidance | Native tools and permissions; structured errors remain visible |
| PTC execution and nested output | `ptc`; every nested sub-dispatch becomes its own transcript row (name, arguments, output, execute/edit raw shapes, diff fallback) in live and replayed history |
| Workflows and Ralph | `/workflows`, task phases, history and native workflow tools |
| LSP navigation | Opt-in `lsp` preset; installed language server required |
| Session search and long references | `/resume`, `/reference`, `history` tools and native on-demand event reads |
| Long-session performance and projection hydration | Native runtime fixes; bridge keeps its bounded session index and paginated child history |
| New DeepSeek-V41-Flash model | Official native adapter is packaged, including text/image and in-history system-prompt capabilities; add it from `/provider` as described below |
| Existing DeepSeek V4 models | Retained by upstream; saved provider/model selections are preserved |
| Dynamic system prompts | Native request reconstruction follows the selected adapter/model's declared capability |
| Model discovery and reasoning/image metadata | `/provider` and `/model`; native discovery plus the existing bounded endpoint capability reader |
| Invalid pi-ai configurations and failing model listings | Provider remains visible with its native diagnostic or listing error; working models remain selectable and saved routes remain editable/removable |
| Provider Base URL and API key validation | Shared add/edit validation runs before writes; surrounding whitespace is normalized. As on DSH's Models page, a pasted key that is blank, a `NAME=value` or `export NAME=value` line, quoted, or outside printable ASCII is refused with the reason; `/provider` rows say "key missing" or "key from env" |
| HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY | Native runtime proxy support; environment is inherited by the managed runtime |
| Streaming tool-call continuation | Native DeepSeek fix preserves call identifiers and names |
| MCP tool pagination | Native repeated-cursor rejection; `/mcps` and bridge initialization keep diagnostic behavior |
| Skills and commands | `/skills`, skill insertion and native command discovery; TUI search uses its existing picker |
| Declarative preset registry and ordered bundle patches | `/preset manage`, `/dsh`; local editable declaration bundles, read-only legacy import and shared host service identities |
| `present` file delivery | Clickable transcript links from `deliverables/presented`, live and after resume; child/fork paths use the viewed workspace |
| Standard-derived custom presets | `history`, `terminal` and `lsp` snapshots also mount `present`; user copies remain user-owned snapshots |
| General file input | Existing local file references let native file tools read paths; browser upload/progress UI has no terminal transport equivalent |
| Images and read_image | Existing input admission; top-level results and PTC sub-call results both resolve images to viewer paths, plus explicit image opening |
| Markdown/ZIP export | `/export`; ZIP includes logs and attachments, while `present` stores source-file references rather than copies |
| Independent text feedback | Native `/feedback <text>` appends feedback without a model turn; upstream telemetry policy may include session context |
| Feedback rating/category dialogs | Web-only controls; no new TUI rating or category dialog |
| Experimental Agent Teams | The `teams` preset beside the others, plus `/team`; see [Agent Teams](#agent-teams) |
| Experimental browser use (Playwright MCP) | `/browser`, off by default: a per-Session isolated headless browser with origin limits and approvals; see [Browser](#browser) |
| Sidebar tabs, splits, PDF/HTML previews, file icons | Browser UI is not ported; TUI uses transcript links, existing viewers and explicit external opening |
| Workspace editor/file-manager actions | Existing TUI links/editor handoff; no browser desktop toolbar |
| Web layout, localization, scrolling and reconnect fixes; alpha.2 code blocks, Excel previews, speech input, queued-message editing and discovered-model labels | Browser-only changes; TUI keeps its own tested rendering and reconnect paths |
| First-install npm registry probing (alpha.2) | Web plugin-manager service only; `dsh plugin add` and the launcher's npm install keep their existing registry selection |
| Windows UI, persistent PowerShell and Python SDK fixes | Included upstream; dscode's supported targets remain Linux x86-64 and macOS ARM64 |

To use the official DeepSeek adapter, open `/provider`, add the
**DeepSeek (native Messages API)** template, and paste a key or name its
environment variable (`DEEPSEEK_API_KEY` by default). The bridge stores a pasted
key in the DSH credentials store and enables the `llm-deepseek` row through the
plugin manager. It then reconciles the live leader, so `deepseek-official` models
appear in `/model` without a restart. The enabled row persists in the profile's
`cordis.patch.yml`. Removing that provider disables the row again; it is refused
while the provider is in use. Since rc.2 the row is
`@deepseek-ai/dsh-llm-deepseek-api-key` and authenticates only with that key
(`x-api-key`); a signed-in DeepSeek account no longer lends its token to
`deepseek-official`. `scripts/e2e-native-provider.mjs` exercises the whole path
against a loopback Messages fixture.

A custom base URL must be a Messages root: the adapter appends `/v1/messages`
and `/v1/files`, reuses a root that already ends in `/v1`, and does not
translate a Chat endpoint. Its Files reuse covers image request bytes only, not
PDF or Office understanding. File ids are scoped to the credential and
endpoint; an expired id or failed upload falls back to inline bytes and may
permanently offload the oldest image, and a TUI notice says how to reattach
it. Generic `anthropic-messages` pi-ai routes are not this adapter.
DeepSeek-V41-Flash (`deepseek-flash`) declares `toolUpdate: 'addition-only'`:
tools added mid-conversation are declared with `defer_loading` and activated by
later `tool_addition` blocks, sent with
`anthropic-beta: mid-conversation-tool-changes-2026-07-01`. A custom gateway
must accept that header and pass those blocks through.
`experiments/capabilities/messages-smoke.mjs` covers Files reuse, offload and
fallback against a loopback fixture.

The default profile remains provider-neutral. OpenAI-compatible gateway routes
use their own discovered metadata; they do not inherit the native adapter's
vision or system-prompt capabilities just because model names match. Model
catalog and transport tests do not certify a live provider account.

The profile also disables `session-log-deepseek`, which would add the
session's raw events to native DeepSeek requests. It has no hostname
allowlist, so a custom native gateway would receive that field too.

rc.2 also ships the account route `llm-deepseek-account` (provider "DeepSeek
Account"), switched on in its base layer. dscode's patch disables it: `/provider`
cannot manage that route, and it would otherwise sit in the roster with no
models. `/dsh add` flags a bundle that touches it, as it does the other
credential rows.

### Approval reasons

rc.2 approval requests carry why they ask: a sandbox or `run_code` escalation,
a hook, or auto review. The bridge appends it to the prompt's title after the
tool name, e.g. "Allow run_code — Allow this operation with danger-full-access
permissions: …?", choosing DSH's translation for `LC_ALL`, `LC_MESSAGES` or
`LANG` and English otherwise, on one line with control and bidi characters
removed. A shell prompt keeps the command's description as its title and shows
the reason as its first description line. A call that auto review denied and
passed to the user is never answered by always-approve, in the bridge or the
TUI (`_meta.dscodeAlwaysAsks`).

### Agent Teams

The experimental `teams` preset is History without legacy delegation: no
`subagent`, `subagent_fork`, `workflow` or `ralph`. In their place are native
Agent Teams tools: `spawn_teammate`, `send_message`, `list_agents`,
`wait_agent`, `interrupt_agent` and the `team_task_*` board. Legacy delegation
cannot share a preset with them: `tool-subagent-control` registers the same
`send_message`, `list_agents` and `interrupt_agent` names, and legacy one-shot
children would be taken for Leads. Only that preset
mounts the Team tools (`tool-agent-team` is a preset row), so sessions on the
other seven presets keep their own delegation tools. The Team runtime
(`agent-team`) is a host row: it owns each Lead session's roster, mailbox and
task board. For sessions on other presets it only keeps an empty Team
projection. Its row ids match upstream's
`@deepseek-ai/dsh-experimental-agent-team-profile`; installing that profile as
well would give every session Team tools, and `/doctor` warns about any
host-level Team tools row.

Team tools attach when an agent is created, so the preset is chosen as a
session opens. Before a session has history the TUI picker reopens it with the
chosen preset; afterwards the leader refuses any preset change, so the picker
opens a new session with it instead. An in-place `/preset` switch into or out
of `teams` is refused. Copying it with `/preset manage` is refused too:
mounting a copy while dscode runs would reach every open session. Teammates are
continuable children labelled with their names. `/team` shows the roster (with
each teammate's short id) and the task board, and `/subagents` accepts a
teammate's name as well as its id. Hand edits, removals and clears of a
teammate's queued input are refused, because those are Team mailbox
deliveries; viewing, new messages and stopping still work. `/btw` is off in
Teams and says so. Teammate and subagent sessions stay out of `/resume` and the
dashboard; an exact id still resumes one. A settled child reports how long its
last run took, so its `/tasks` row stops counting. All members share one
checkout: write scopes are advisory, not locks. Reopening a `teams` session
needs this dscode version or later.

`scripts/e2e-teams-installed.mjs <runtime> <home>` checks an installed leader
over ACP against a loopback Messages fixture: preset isolation (also across a
live plugin-row reconcile), the Team tools and policy, a task and a teammate,
teammate names, `/team`, the inbox and switch refusals, and a restart.
`DSCODE_TEAMS_SMOKE_HOST_TOOLS=1` is its negative control and must fail at the
isolation check. The product E2E audits the `teams` tool roster through the
headless TUI.

### Browser

`/browser on` enables the shipped-disabled `dscode-browser` row
(`@hqzhao95/dscode/browser`) through the plugin manager and reconciles the live
leader, as `/provider` does for the native adapter. `/browser off` disables it
and closes open browsers. The choice persists in the profile's
`cordis.patch.yml` and applies to running Sessions too: once its settings are
written, `/browser on` starts a browser for each open top-level Session, and
that Session's next step carries the tools. DSH records the change in the
conversation, and the TUI shows a one-line `Tools added: …` / `Tools removed: …`
notice, live and on resume. `/browser off` removes the tools from running
Sessions the same way. Only top-level Sessions get a browser, subagents do not. `/doctor` reports the executable, and warns when none is found
or the sandbox is off.

Each Session starts its own Playwright MCP 0.0.80 through DSH's browser-use
provider, which the plugin loads from the runtime closure rather than declaring
as peers. It runs `--isolated --headless` with a private output directory
removed when the Session closes, and always requests the Chromium sandbox.
Chromium binds a socket under `TMPDIR`, so a `TMPDIR` longer than 60 bytes,
which would abort it at launch, is replaced by `/tmp` for the browser server.
`--no-sandbox` requires `--accept-risk`. The browser is `--executable <path>`
when given. Otherwise it is the first usable system Chrome or Chromium (the
macOS app bundles; `/opt/google/chrome/chrome`, `/usr/bin/google-chrome[-stable]`
or `/usr/bin/chromium` on Linux). Failing that, it is the newest Playwright
Chromium under `PLAYWRIGHT_BROWSERS_PATH` or the default cache. Snap wrappers are
refused, and dscode never downloads a browser.

On Linux, Chromium's sandbox needs unprivileged user namespaces. Ubuntu 23.10 and
later restrict them through AppArmor, except for browsers that have their own
profile, such as Google Chrome in `/opt/google/chrome`. When the restriction is
on and no profile names the chosen browser, `/browser status` and `/doctor` warn
that the sandbox may not start. On Ubuntu 24.04 with the restriction off, a
Chrome for Testing renderer was measured running in its own user namespace
under a seccomp-bpf filter.

`browser_navigate` must target an allowed origin (exact HTTP(S), a plain host
name or IP address, no credentials) unless `--any-origin` was chosen. Unless any
origin is allowed, Playwright also refuses page requests outside the allowed
origins and blocks service workers. That filter is fixed when a Session's
browser starts, so a removed origin is refused at once while an added one
applies to browsers started later (new Sessions, or `/browser off` then
`/browser on`): navigating to it from an older browser is refused
with that explanation rather than Playwright's bare `net::ERR_BLOCKED_BY_CLIENT`.
It is request routing inside the browser, not an OS network sandbox. DSH cannot
restrict per-Session MCP tools, so the plugin drops the refused operations from
the model's tool list at prompt assembly, and a guard still refuses everything
outside 13 reviewed operations: no code evaluation, uploads, tab management,
MCP resource reads, or `filename`, `paths` and `_meta` arguments. Results name
snapshot and screenshot files relative to the private directory
(`./page-….png`); the plugin resolves it first, because on macOS the temp
directory is a symlink and the names would otherwise climb through
`/var/folders/…`. Terminal colour codes are stripped from failed calls' text.

Every call asks for approval. The prompt names the action ("Allow the browser
to open https://…?") and lists its arguments, and tool cards read
"Browser: open …". DSH's always-approve preset (`danger-full-access`) sets the
approval policy to `never`, which rejects every ask without a prompt, so in that
mode the plugin refuses browser calls with an explanation. The TUI never
auto-approves a browser prompt nor offers always-approve on it
(`_meta.dscodeAlwaysAsks`). Cancelling a running call closes that Session's
browser and waits for cleanup; resume the Session for a fresh one.

`scripts/e2e-browser-smoke.mjs <runtime> <chrome>` drives real Chromium through
the SDK: catalog, approvals, origin filtering, cancellation cleanup and unload.
`DSCODE_BROWSER_SMOKE_ANY_ORIGIN=1` is its negative control and must fail. It
needs the compiled bridge `lib/` and a bridge `node_modules` that resolves to
the runtime's closure. `scripts/e2e-browser-installed.mjs <runtime> <home> <chrome>`
checks an installed leader over ACP: off by default, `/browser on` reaching the
running Session (a browser call there plus the tool notice), approvals,
rejection and cancel without late page requests, resume with fresh storage,
then `/browser off`, also in the running Session.

### Remote workspace over SSH

A remote workspace is a dedicated `DSH_HOME` whose dscode profile runs every
tool on one POSIX host. `dscode remote init` writes one marked block into that
profile's `cordis.patch.yml`:
- it disables the local `subprocess`, `sandbox`, `fs-sandbox` and `ptc-runtime` rows;
- it points `sandbox-policy` at the remote workspace;
- it inserts the shipped `@hqzhao95/dscode/ssh` row with literal settings.

That row owns DSH's SSH connection, filesystem, subprocess, sandbox and Node PTC
providers. Like the browser packages, they load from the runtime closure. The
command refuses the default home and edits the patch as text, so user `!!js`
entries survive. The leader socket is per profile, so local and remote sessions
never share a leader. `dscode remote remove` restores a local home.

The host needs the helper and PTC bootstrap from the same DSH release,
installed outside the workspace, plus an absolute path to Node 22 or newer.
`--dsh DIR` names the remote directory where
`npm install @deepseek-ai/dsh-ssh@<release> @deepseek-ai/dsh-ptc-runtime-node@<release>`
ran (`--helper` and `--bootstrap` name the files instead). The pinned digests
default to this dscode's own runtime copies of `dsh-ssh/lib/helper.js` and
`dsh-ptc-runtime-node/lib/process.js`, which are byte-identical to the
release's; `--helper-hash` and `--bootstrap-hash` override them. Reinstall both
on every host at each DSH bump: the default digests follow this dscode's
runtime, and a release can change the helper (alpha.2's imports new subprocess
modules). Before writing
anything, `init` connects the way the leader will and checks the remote Node,
the workspace and both digests, naming the fix and the exact `npm install`
command when a file is missing or different; `--no-check` skips it. It stores
the workspace as the host resolves it, since remote tools report resolved
paths; `remote status --check` names a stored path that now resolves elsewhere.
`dscode remote status --check` and `dscode doctor --runtime` repeat the check.
The connection runs
`ssh -T -M -o BatchMode=yes -o StrictHostKeyChecking=yes <alias>`, so the alias
must already connect non-interactively with a known host key. Digest mismatches
refuse the connection.

The leader reports `_meta.dscodeExecutionWorld` from the configured row,
connected or not, so a failed connection never looks local. Inside that world:
- **Session cwd:** the TUI opens sessions at the remote workspace (or a
  directory inside it). The bridge refuses any other cwd and any ACP stdio MCP
  server.
- **Session paths:** the TUI never links, opens, highlights from disk, previews
  or `@`-completes them; the first `@` says so once. The header reads
  `ssh HOST:PATH` and never shows this computer's directory. It does not scan agent text for local images or videos,
  or discover git in a local directory with the same name.
- **Local context:** it does not use this directory's MCP config, persona files,
  worktrees or location changes, and asks no folder-trust question for it; the
  welcome screen offers no new worktree. It refuses dropped local files; dropped
  images still attach as data.
- **Exports:** relative `.zip` exports land in the home directory on this computer.
- **`/doctor`:** it names the host, workspace and helper digest, and reports
  ERROR while disconnected.
- **Disconnected:** a profile whose SSH row did not connect, or whose
  connection was lost, refuses new sessions and turns; slash commands still
  work. A lost connection says to restart dscode, and the leader then exits as
  soon as its last client leaves so the restart reconnects. The helper does not
  keep ssh's own error, so when a connection never comes up the SSH row probes
  the host once more, the way `dscode remote status --check` does, and the
  refusal names what it found (an unknown alias, a refused key, a missing Node,
  workspace or helper). It then points to `dscode doctor --runtime`, which
  repeats the check with the fix spelled out.

Transcripts, attachments and credentials stay on this computer.

Limits of this first phase:
- The SSH connection does not reconnect; losing it needs a leader restart.
- The sandbox root is fixed to the configured workspace, and there is no remote
  file watching.
- `@` completion, the line viewer, full-file edit highlighting and the git
  branch display are unavailable until a remote read API exists.

`scripts/e2e-remote-installed.mjs <runtime> <home> <config.json>` checks an
installed remote profile against a real host over ACP:
- the advertised world;
- the refused host cwd and stdio MCP server;
- remote `bash`, and a write that lands only remotely;
- the doctor row and the export location.

`scripts/e2e-remote-tui.mjs <runtime> <home> <config.json> <tui>` adds the
real TUI binary from a local project with its own `.mcp.json`. It runs headless
and then interactive in tmux, where the header must name the remote workspace. With a TUI that predates these gates,
the bridge still refuses the host cwd, so an old client fails closed.
`scripts/e2e-ssh-smoke.mjs <runtime> <config.json>` drives the shipped adapter
through the SDK: remote PTY, PTC, cancellation and SSH-master loss.
`scripts/e2e-ssh-integrity.mjs` checks that a helper or bootstrap with the
wrong digest is refused before any provider is exposed.

The leader socket is bound in a private directory, restricted to the owner
and then hard-linked into place, instead of holding a process-wide `0o177`
umask during the bind. The old umask briefly applied to files and directories
other plugins created at boot. It left the SSH adapter's control directory
unsearchable, so the connection failed.

## Bridge changes

- Keep `docs/grok-leader-protocol.md`, the captured handshake fixture, and
  codec/socket tests in sync with wire changes.
- Fail fast on protocol-version mismatches and unsupported CLI metadata.
- After local bridge edits, run `scripts/update-bridge.sh` before manual TUI
  testing. It replaces the plugin transactionally while preserving the profile,
  runtime, and channel; a different tuple requires `scripts/install.sh`. A live
  leader keeps its loaded code until the last client exits.

## Validation

Compile and test against the same SDK as the runtime:

```sh
scripts/dev-bridge-tests.sh            # build the pinned source payload
scripts/dev-bridge-tests.sh --reuse    # use matching artifacts from dist/
DSCODE_E2E_RELEASE_DIR=/path/to/payload scripts/dev-bridge-tests.sh
```

The runner copies the bridge into a temporary workspace and uses the payload's
SDK, leaving the checkout's dependency installation intact. `DSCODE_SOURCE_DIR`
and `DSCODE_RUNTIME_CONSUMER` reuse an exact source checkout and installed SDK.
Consumer reuse requires `dscode-consumer.json` from a completed source build;
the builder verifies the commit, platform, non-SDK dependency inputs and installed
dependency bytes. Changing those dependency inputs requires a fresh consumer.
An old consumer without this record must be rebuilt: omit the consumer override
or point it at a new directory. Existing unverified caches are never relabeled.
`DSCODE_TUI_BIN` selects the compiled TUI for CLI contracts.

Product and release checks:

```sh
scripts/check.sh
node --test scripts/release-payload.test.mjs scripts/test-runtime.test.mjs \
  scripts/e2e-gateway-hold.test.mjs
# Needs bridge/grok-leader/node_modules linked to the runtime's node_modules:
node --test scripts/install-selection.test.mjs
scripts/check-rust.sh
scripts/e2e-product.sh
scripts/e2e-product.sh --full --provider-ui
# On Linux with a working user-systemd manager, also verify escaped descendants:
DSCODE_E2E_CONTAINMENT=1 scripts/e2e-product.sh --full --provider-ui
scripts/e2e-release-lifecycle.sh
node scripts/e2e-update-channels.mjs --plugin dist/dscode-plugin.tgz \
  --runtime dist/dscode-runtime-linux-x86_64.tar.gz --tui dist/dscode-linux-x86_64
```

CI runs script, bridge, Rust, managed-update and real TUI/runtime checks on
Ubuntu and macOS with Node 22.19.0; macOS also runs bridge tests on Node 24.
Tagged releases
build `dscode-linux-x86_64` and `dscode-macos-aarch64` in
`.github/workflows/release.yml`.

Linux Rust tests require user/PID namespace isolation; `scripts/check-rust.sh`
fails if `unshare` cannot provide it. Process-lifecycle tests must not share the
host PID namespace. `scripts/check-rust.sh` reports two tests ignored on
purpose: `picker_visual_smoke_debug` is a manual layout helper, and
`test_groknight_theme` expects accents that drift from the runtime theme. The
full product suite on both platforms also needs tmux >=3.4 and the
[LSP dependencies](../bridge/grok-leader/README.md#optional-lsp).
Mac table links use keyboard acceptance; physical Cmd-click requires a GUI
runner. See [macOS validation boundaries](#macos-validation-boundaries).

`DSCODE_RELEASE_DIR` selects existing payloads for product E2Es.
`DSCODE_E2E_DSH_BIN` and `DSCODE_E2E_PLUGIN_TGZ` select explicit runtime/plugin
artifacts. Source tarball policies in `DSCODE_E2E_PNPM_CONFIG` may override
ordinary dependency edges only; global `file:` peer overrides duplicate DSH
scope identities and are invalid.

Both product E2Es share `scripts/test-runtime.mjs`: it builds only missing
artifacts, or consumes an explicitly supplied release directory without network
fallback. Plugin name/version/release and SDK pins must match the checkout;
the runtime descriptor, CLI package/entrypoint and host architecture must agree.
These are metadata/layout checks, not a replacement for release checksums or
native-runtime validation. Explicit CLI paths must belong to a source-pinned
release runtime, not an unrelated global DSH installation.
Run `node --test scripts/test-runtime.test.mjs` for the local fixture matrix.

The product matrix above uses simulated model replies; it is not live-model
certification. Run `node scripts/e2e-live-models.mjs --help` for the separate,
billable live-model acceptance runner. Supply the built TUI, pinned DSH binary,
an already provisioned disposable `--home` and its `--profile` at
`HOME/profiles/dscode`, the exact `--provider`/`--model`, and a fresh `--out`
directory outside the repository. The runner forwards `OCX_API_KEY` by default;
`DSCODE_LIVE_AUTH_ENV` selects alternative credential environment-variable names.
Use a direct model route, not an alias that can fail over to a different model.

Live results include native tool/child/goal evidence, filesystem assertions,
TUI captures and per-scenario pass/fail/skip records in `results.json`.
`--scenario` selects a focused rerun. Images are capability-reported, not a
vision-understanding test; headless cases are not visual TUI coverage. Neither
a passing finite matrix nor the absence of a credentialed run establishes
exhaustive model compatibility.

### Linux acceptance

Linux acceptance runs on the `swoop` host; get the maintainer's approval before
each use. Run every gate at `nice -n 15` with one worker, in a private root
with private caches, `DSH_HOME` and test homes, without sudo or global
installs. The gates:

- the 15-case built-provider matrix on Node 22.19.0 and 24.19.0 (a test-only
  program, not in this repository): ordinary and PTY cancellation, immediate
  disposals, pre-exec ENOENT/EACCES and escaped-descendant cleanup, each
  checked against its systemd scope;
- `scripts/check.sh` and the script and bridge suites on both Node versions,
  `scripts/check-rust.sh`, and the managed-update, provider, update-channel and
  full product E2Es, the last under `DSCODE_E2E_CONTAINMENT=1`;
- the patched DSH source tests: Linux scope and containment on the host;
  subprocess, bash, terminal and JSONL persistence in a PID namespace
  (`unshare --user --map-root-user --pid --fork --mount-proc`). That lane needs
  an init reaper such as tini: Node as PID 1 does not reap orphan zombies, and
  host-exit assertions fail;
- the snapshot replay corpus. It needs a full `pnpm run build:lib` (host and
  client faces), `TMPDIR` and `HOME` outside any Git repository, links for nine
  optional built workspace packages under the clone's ignored
  `snapshots/node_modules`, and Playwright's Chromium headless shell;
- a post-run audit: no new user scope, no residual process from the run, and
  every recorded PID stopped.

Any change to what ships reopens Linux acceptance. The minimum re-run is the
matrix, `scripts/check.sh`, and the script and bridge suites on Node 22.19.0
and 24.19.0. Add `scripts/check-rust.sh` when `third_party/grok-build`
changes.

- `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` means pnpm tried to purge a
  copied modules directory without a TTY; run
  `CI=true pnpm install --frozen-lockfile`.
- A source-only handoff lacks the bridge dependencies the script and product
  harnesses read; link the runtime's `node_modules` into `bridge/grok-leader/`
  for those gates, then remove exactly that link.

Linux acceptance does not certify older glibc distributions or Linux ARM64.

### macOS validation boundaries

Neither platform certifies physical Cmd-click, Kitty graphics (skipped unless
`DSCODE_E2E_KITTY_BIN` is set), IME or the host clipboard. On macOS, clipboard
image paste, Finder drag and drop, Terminal.app/iTerm2/Ghostty, Intel/Rosetta,
older macOS versions, sleep/wake and network switching are not certified
either. The ignored Rust clipboard tests write the global clipboard; run them
only as an isolated test user or runner. An earlier wrapped-table-copy failure
is intermittent and unexplained; see
[Coverage limits](architecture.md#coverage-limits).

When running the upstream DSH source tests:

- Unset `NoDefaultCurrentDirectoryInExePath` if the shell exports it; the
  Windows executable-search test reads it and fails.
- Run from the physical path, not through the `/tmp` symlink; otherwise
  `bash-local`'s `defaults cwd to process.cwd()` compares `/tmp` with
  `/private/tmp` and fails.
- The full suite, last run at the 0.1.5-rc.2 pin, failed four specs that fail
  identically on the pristine pin: `browser-bundled-externals` (Vite on the
  `/private/var/folders` temp path), the `/tmp` cwd test, `webworker-runtime`
  transform-corpus baselines, and `pdf-license-bundle` without `pnpm` on PATH.

## Release

1. Keep `VERSION` and `bridge/grok-leader/package.json` versions equal.
2. Start with `scripts/release.sh --dry-run` and inspect the staged binaries,
   checksums, plugin tarball, license bundle, and version banner. Reuse an exact
   source checkout/SDK consumer via `DSCODE_SOURCE_DIR` and `DSCODE_RUNTIME_CONSUMER`.
3. Commit a clean tree, then run `scripts/release.sh`. The release gate requires
   the exact tag commit's successful CI workflow and validates draft asset
   checksums, gzip contents, and plugin/runtime provenance before publication.
4. Wait for both platforms' TUI assets and, for source releases, runtime archives
   and checksums, plus the plugin and its checksum, before making the release public.
5. Stable publishes to npm `latest`; beta and alpha use their matching npm tags
   and GitHub prereleases. Release selection never treats alpha as beta.
