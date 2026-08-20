# DeepSeek Code (dscode) usage

A terminal UI for AI coding agents, powered by DeepSeek Harness.

## Install

```sh
npx @hqzhao95/dscode
```

Prebuilt on Linux x86_64 and macOS Apple Silicon.
Requires Node.js `^22.19.0` or `>=24.0.0`.

The first run sets everything up. After that, use:

```sh
dscode
```

## Update

```sh
dscode update          # stable
dscode update --beta   # beta channel
```

The launcher first updates the profile bridge from the matching npm ref
(`latest`, `beta`, or `--version`), reconciles the tested profile-owned dsh
runtime, then updates the same TUI channel.

## Uninstall

```sh
dscode uninstall
```

This removes the launcher, dscode profile, cached TUI, and product-owned dsh
runtime. Shared `$DSH_HOME/sessions` and `$DSH_HOME/storages` remain. If the
launcher is broken, the manual fallback is:

```sh
rm -rf ~/.dsh/profiles/dscode ~/.local/bin/dscode
```

## Launch

```sh
dscode
dscode "run the tests"
```

## Keys

- `Enter` send · `Alt+Enter` newline · `Shift+Tab` mode
- `Ctrl+S` resume session · `Ctrl+W` new worktree · `Ctrl+Q` quit
- `/model` pick provider and model
- `/preset` or `Ctrl+Y` open preset picker

## Providers and models

- `/model` lists models and saves your selection.
- `/provider --add` adds a provider (base URL + API key).

## Presets

Shipped presets: `standard`, `code`, `minimal`, `cordis`.

Select with `/preset` or `Ctrl+Y`.

## Plugins

From inside dscode:

```text
/dsh plugins                   list installed plugins
/dsh add <package|git-url>     install a plugin
/dsh remove <name>             uninstall a plugin
```

CLI:

```sh
dsh plugin --profile dscode add <pkg>
```

Restart dscode after adding/removing plugins.

## Sessions

Sessions are stored under `$DSH_HOME/sessions`. Use `Ctrl+S` to list and resume.

## More

- [docs/upgrade-strategy.md](upgrade-strategy.md)
- [docs/harness-updates.md](harness-updates.md)
- [docs/grok-leader-protocol.md](grok-leader-protocol.md)
