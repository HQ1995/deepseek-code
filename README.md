# DeepSeek Code (dscode)

A terminal UI for AI coding agents, powered by DeepSeek Harness.

> Not an official DeepSeek or xAI project.

![DeepSeek Code](docs/dscode.png)

## Install

```sh
npx @hqzhao95/dscode
```

Prebuilt on Linux x86_64 and macOS Apple Silicon. Other hosts build the TUI from this repo (`scripts/build-deepseek-tui.sh`).
Requires Node.js `^22.19.0` or `>=24.0.0`.

The first run sets everything up. After that, use:

```sh
dscode
```

## Update

```sh
dscode update
```

This reconciles the npm bridge, tested dsh runtime, and release-pinned TUI.

## Uninstall

```sh
dscode uninstall
```

Shared dsh sessions and storages are kept.

## Presets

Use `/preset` or `Ctrl+Y` to switch presets.

Shipped presets:

- `standard`
- `code`
- `minimal`
- `cordis`

## Plugins

Manage dsh plugins from inside dscode:

```text
/dsh plugins                   list installed plugins
/dsh add <package|git-url>     install a plugin
/dsh remove <name>             uninstall a plugin
```

Or from the CLI:

```sh
dsh plugin --profile dscode add <pkg>
```

## Documentation

See [docs/dscode-usage.md](docs/dscode-usage.md).
