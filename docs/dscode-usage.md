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

Any dsh plugin installs into the leader profile and its tools compose into
every session:

```sh
dsh plugin --profile deepseek-leader add <package>
```

## Sessions

Sessions persist under `$DSH_HOME/sessions`. `Ctrl+S` lists them; resume replays
the full transcript and continues. On exit the TUI prints the resume command.

## Architecture

See docs/upgrade-strategy.md and docs/grok-leader-protocol.md. Harness
upgrades flow as a plain merge of upstream; the compatibility contract is
docs/harness-updates.md.
