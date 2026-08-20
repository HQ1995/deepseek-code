# DeepSeek Code (`dscode`)

Terminal coding agent UI powered by DeepSeek Harness. The product bundles a
Rust TUI, an isolated `dsh` profile, and the bridge between them.

> Personal project — not affiliated with or endorsed by DeepSeek or xAI.

![DeepSeek Code](docs/dscode.png)

## Prerequisites

- macOS Apple Silicon or Linux x86-64
- Node.js `^22.19.0` or `>=24.0.0`
- npm and GitHub network access for the first install
- `~/.local/bin` on `PATH` after installation

You do not need to install `dsh` globally. The launcher reuses an exactly
compatible `dsh` from `PATH` or installs its own pinned runtime.

## Install

```sh
npx @hqzhao95/dscode
```

The first run creates `~/.dsh/profiles/dscode`, installs the bridge and tested
runtime, downloads the matching TUI binary with checksum verification, and
links `~/.local/bin/dscode`. It does not change the global npm prefix.

## Use

```sh
dscode                              # interactive TUI
dscode "review this repository"     # start with a prompt
dscode -p "explain src/index.ts"     # headless single turn
dscode -c                           # continue the latest session for this cwd
dscode --resume <id-or-title>       # resume a session
dscode sessions list                # list durable sessions
```

Headless output formats are `plain`, `json`, `streaming-json`, and
`streaming-messages-json`.

Useful in-app commands:

- `/model` — choose model and reasoning effort
- `/provider` and `/provider --add` — select or add a provider
- `/preset` or `Ctrl+Y` — choose `standard`, `code`, `minimal`, or `cordis`
- `/dsh plugins` — inspect profile plugins
- `Ctrl+S` — open durable session resume

Run `dscode --help` for the complete CLI.

## Update

```sh
dscode update --check              # check only
dscode update                      # stable channel
dscode update --alpha              # beta channel
dscode update --version <version>  # exact version
```

Update keeps the npm bridge, tested dsh runtime, and TUI binary on the same
release channel.

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
