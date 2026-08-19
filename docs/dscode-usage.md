# dscode 使用手册

`dscode` is the DeepSeek Harness terminal UI: the grok-build TUI (vendored,
Apache-2.0) driving the DeepSeek Harness runtime through a dsh plugin.

## Install

### Quick start

```sh
npx @hqzhao95/dscode
```

First run registers the plugin, downloads the TUI binary, and creates the
`dscode` launcher:

```sh
dscode
```

`dscode` is distributed as a dsh plugin (`@hqzhao95/dscode`) plus a launcher
that materializes the release-pinned TUI binary. The plugin lives in the
`dscode` dsh profile at `~/.dsh/profiles/dscode`; the TUI binary is cached at
`~/.dsh/dsc-tui/bin/dscode`.

### Prerequisites

- Node.js `^22.19.0 || >=24`
- `pnpm` (required by dsh plugin installs; enable with `corepack enable`)
- Linux x86_64 and macOS Apple Silicon (arm64) for prebuilt TUI binaries; other platforms build from a checkout
- Other platforms: use a source checkout and `bash scripts/install.sh`

## dsh resolution

When dscode needs dsh, it resolves in this order:

```text
DSH_BIN environment variable
  → `dsh` on PATH
  → `npx --yes @deepseek-ai/dsh@0.1.0-rc.8`
```

- If you already have dsh installed and on PATH, dscode uses it directly.
- If you set `DSH_BIN`, that path is authoritative.
- If no dsh is found, dscode falls back to the pinned npm version.

### dsh version policy

- Tested: `0.1.0-rc.8`
- Supported: `>=0.1.0-rc.7 <0.2.0`

The values are recorded in `bridge/grok-leader/package.json`:

```json
"dsh": {
  "testedVersion": "0.1.0-rc.8",
  "supportedRange": ">=0.1.0-rc.7 <0.2.0"
}
```

`testedVersion` is the release dscode was validated against. `supportedRange`
is the compatibility window for existing installs.

## Upgrade

### Update the TUI binary

```sh
dscode update          # stable
dscode update --beta   # beta channel
```

This updates only the Rust TUI binary.

### Update the full dscode package

To get a new bridge, new dsh pin, or new launcher behavior:

```sh
npm i -g @hqzhao95/dscode@latest
npx @hqzhao95/dscode
```

If the profile still has the old plugin, re-register it:

```sh
dsh plugin --profile dscode remove @hqzhao95/dscode
dsh plugin --profile dscode add @hqzhao95/dscode@latest
```

From a source checkout:

```sh
bash scripts/install.sh
```

## Uninstall

Remove dscode's own files:

```sh
rm -rf ~/.dsh/profiles/dscode \
       ~/.dsh/dsc-tui \
       ~/.local/bin/dscode
```

Optionally remove the official dsh CLI:

```sh
npm uninstall -g @deepseek-ai/dsh
```

For source-checkout installs:

```sh
bash scripts/uninstall.sh
bash scripts/uninstall.sh --remove-dsh   # also remove official dsh
```

## Development / source checkout

```sh
bash scripts/install.sh                 # full install from a checkout
DSC_CHANNEL=beta bash scripts/install.sh  # install from the beta channel
bash scripts/update-bridge.sh           # rebuild the bridge and refresh the profile copy
bash scripts/build-deepseek-tui.sh      # cargo build the TUI (version from VERSION + -dev)
bash scripts/release.sh                 # cut a release from the repo VERSION file
```

Dev launchers point directly at the build output, so after changing TUI or
bridge code, restart `dscode` to pick up the new build.

## Launch

```sh
dscode                            # normal launch
dscode "run the tests"            # launch with an initial prompt
```

The TUI bootstraps the dsh leader itself through the `dscode` profile.

## Keys

- `Enter` send · `Alt+Enter` newline · `Shift+Tab` mode
- `/preset` or `Ctrl+Y` open the preset picker
- `Ctrl+S` resume session · `Ctrl+W` new worktree · `Ctrl+Q` quit
- `/model` pick provider and model

## Providers and models

The harness owns providers. The shipped `deepseek-official` route is always
available; additional `llm-pi-ai` routes can be configured in
`$DSH_HOME/settings.yaml`.

- `/model` lists models live and saves the selection as the harness default.
- `/provider --add` adds a provider: pick a template, fill base URL, paste an
  API key (stored in the dsh credentials store, not in settings.yaml).

## Presets

Shipped presets: `standard`, `code`, `minimal`, `cordis`, plus custom presets
in `~/.dsh/.agent-presets/`.

Select with `/preset` or `Ctrl+Y`. Override the default in the profile layer:

```sh
cat >> ~/.dsh/profiles/dscode/cordis.patch.yml <<'YAML'
- id: agent-presets
  config:
    default: minimal
YAML
```

## Plugins

Any dsh plugin can be installed into the `dscode` profile and its capabilities
compose into every session.

From inside dscode:

```text
/dsh plugins                      list installed plugins
/dsh add <package|git-url>        install a plugin
/dsh remove <name>                uninstall a plugin
/dsh inspect <name>               inspect what a plugin brought
```

CLI equivalent:

```sh
dsh plugin --profile dscode add <pkg>
```

Restart dscode after adding or removing plugins so the leader reloads the
profile.

## Sessions

Sessions persist under `$DSH_HOME/sessions`. Use `Ctrl+S` to list and resume;
on exit dscode prints the resume command.

## Architecture

- TUI: vendored grok-build, speaks the grok leader protocol.
- Bridge: `bridge/grok-leader`, a dsh plugin that adapts the leader protocol
  to DeepSeek Harness services.
- Harness: official `@deepseek-ai/dsh` npm package, pinned per release.

See also:

- [docs/upgrade-strategy.md](upgrade-strategy.md)
- [docs/harness-updates.md](harness-updates.md)
- [docs/grok-leader-protocol.md](grok-leader-protocol.md)
