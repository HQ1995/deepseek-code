# dscode 使用手册

`dscode` is the deepseek-build terminal interface: the grok-build TUI (vendored,
Apache-2.0) driving the DeepSeek Harness agent runtime.

## Build / update

```sh
dscode update                   # self-update the TUI (stable channel: latest deepseek-code GitHub release)
dscode update --beta            # switch to the beta channel (prereleases; --stable switches back)
scripts/install.sh              # install official dsh (npm/npx), build+install the bridge, fetch the TUI
DSC_CHANNEL=beta scripts/install.sh  # install from the beta channel
scripts/release.sh              # cut a release from the repo VERSION file (X.Y.Z stable, X.Y.Z-beta.N prerelease)
scripts/update-bridge.sh        # (dev) rebuild the bridge and force-refresh the leader profile copy
scripts/build-deepseek-tui.sh   # (dev) cargo build --release of the vendored TUI (version from VERSION + -dev)
scripts/uninstall.sh            # remove launchers, leader profile, TUI state (identity-checked)
```

Plugin-native install — dscode itself is a dsh plugin, published on npm as
[`@hqzhao95/dscode`](https://www.npmjs.com/package/@hqzhao95/dscode) (`scripts/publish-npm.sh`;
the npm version equals the product release it pins). One package carries the
grok-leader bridge plus a `dscode` launcher that materializes the
release-pinned TUI binary on first run (GitHub Releases, SHA-256 verified,
cached at `~/.dsh/dsc-tui/bin/`):

```sh
npm i -g @deepseek-ai/dsh@next
dsh plugin --profile deepseek-leader add @hqzhao95/dscode
~/.dsh/profiles/deepseek-leader/node_modules/.bin/dscode   # first run links ~/.local/bin/dscode
```

(`add dscode-plugin.tgz` from the GitHub release assets is the equivalent
registry-free form, published from v0.0.6 on.) Updating means updating the
plugin: the launcher follows the package's release pin. It never replaces a
newer or `-dev` binary in the cache (dev builds are developer-managed;
`dscode update` remains the in-TUI escape hatch).

Dev loop on a repo checkout (the launcher is not involved;
`~/.local/bin/dscode` symlinks straight to the build output):

```sh
scripts/build-deepseek-tui.sh   # TUI (Rust) change -> next dscode launch runs it
scripts/update-bridge.sh        # bridge (TS) change -> restart dscode to reload
```

The version shown on the hero screen and by `--version` comes from the repo
`VERSION` file (compiled in via `GROK_VERSION`); release builds carry the
exact tag version, dev builds a `-dev` suffix. The status-bar channel label
(`[stable]` / `[beta]`) compares the running version against the cached
stable release pointer.

## Launch

```sh
dscode                            # after install; the TUI binary bootstraps the dsh leader itself
third_party/grok-build/target/release/dscode "run the tests"   # dev: direct binary, with an initial prompt
```

## Keys

- `Enter` send · `Alt+Enter` newline · `Shift+Tab` mode
- `/preset` or `Ctrl+Y` open the preset picker; Enter selects, the session reloads immediately
- `Ctrl+S` resume session · `Ctrl+W` new worktree · `Ctrl+Q` quit
- `/model` pick provider and model; the harness catalog is live from your dsh settings

## Providers and models

The harness owns providers: the shipped `deepseek-official` route plus any
`llm-pi-ai` routes configured in `$DSH_HOME/settings.yaml` (OpenAI-compatible
gateways included). `/model` lists them live; the selection is saved as the
harness default.

## Presets

Four shipped presets: `standard`, `code`, `minimal`, `cordis`, plus any custom
presets in `~/.dsh/.agent-presets/`. Select in the picker (`/preset`); the
current session reloads under the chosen preset and the footer shows it.

Default preset override (profile layer):

```sh
cat >> ~/.dsh/profiles/deepseek-leader/cordis.patch.yml <<'YAML'
- id: agent-presets
  config:
    default: minimal
YAML
```

## Plugins

Any dsh plugin installs into the leader profile and its capabilities compose
into every session (the grok-leader bridge itself is installed through the
same mechanism). Manage plugins from inside dscode — no CLI or web profile
needed:

**Design rule (plugin-first, any plugin kind):** the TUI keeps core
interaction only (transcript, composer, pickers) and renders generic data;
the bridge adapts protocol and manages plugin packages; every feature lives
in a dsh plugin, reaching the TUI through generic rails — plugin-registered
commands auto-surface as slash commands, `llm`-service providers surface in
`/provider` & `/model`, and free-text provider notes are relayed verbatim.
Neither the TUI nor the bridge grows per-plugin code; the one existing
exception (`/dsh login` for the pre-registry subscriptions plugin) is marked
as a compat shim in the bridge and retires once that plugin registers its
own commands.

```
/dsh plugins                      list installed plugins
/dsh add <package|git-url>        install a plugin into the leader profile
/dsh remove <name>                uninstall a plugin
/dsh login <codex|claude|grok>    subscription OAuth login (subscriptions plugin)
/dsh code <pasted-callback-url>   finish a login over SSH (manual code paste)
```

Plugins that register human commands (the `@deepseek-ai/dsh-commands`
registry, `ctx.commands.register(...)`) surface automatically as top-level
slash commands in dscode — with completion and hints — and route back to the
plugin's handler; nothing to configure per plugin. `/dsh` itself stays narrow:
it is the bridge-owned profile manager (install/remove/login), not a bucket
for plugin commands. (Unrelated: the TUI's builtin `/plugin` manages grok-build's
own pager plugins, not dsh plugins — use `/dsh` for those.)

`/dsh add` runs the package's install scripts — only add plugins you trust.
Restart dscode after add/remove (the leader exits with its last client and
reloads the profile on the next launch). LLM-provider plugins surface
automatically in `/provider` and `/model` through the bridge's model catalog.
The CLI equivalent remains `dsh plugin --profile deepseek-leader add <spec>`.

Verified example — [dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions)
(use ChatGPT/Claude/Grok subscriptions as providers via OAuth):

```sh
dsh plugin --profile deepseek-leader add dsh-plugin-subscriptions
```

Its providers (ChatGPT (Codex), Claude (Subscription), Grok (Subscription))
appear in the roster immediately; models appear after the one-time OAuth
login. Log in from the terminal — no web profile needed:

```sh
node scripts/subscriptions-login.mjs codex    # or claude / grok
node scripts/subscriptions-login.mjs status   # login state + token store path
```

The script drives the plugin's own OAuth engine: open the printed authorize
URL in any browser (same machine: the loopback callback finishes
automatically; remote/SSH: paste the callback URL back into the prompt).
Tokens land in the plugin's 0600 store shared by every dsh profile; restart
dscode afterwards. (The plugin's built-in login UI lives in the dsh web
profile's Settings page — that route also works if you already run one.)

## Sessions

Sessions persist under `$DSH_HOME/sessions`. `Ctrl+S` lists them; resume replays
the full transcript and continues. On exit the TUI prints the resume command.

## Architecture

See docs/upgrade-strategy.md and docs/grok-leader-protocol.md. Harness
upgrades flow as a plain merge of upstream; the compatibility contract is
docs/harness-updates.md.
