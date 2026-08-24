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

You do not need to install `dsh` globally. The launcher reuses an exactly
compatible `dsh` from `PATH` or installs its own pinned runtime.

## Install

```sh
npx @hqzhao95/dscode
```

The first run creates `~/.dsh/profiles/dscode`, installs the bridge and tested
runtime, downloads the matching TUI binary with checksum verification, and
links `~/.local/bin/dscode`. It does not change the global npm prefix.
It never installs or switches Node for you.
The dsh runtime install and compressed TUI download run in parallel.

A fresh profile has no provider or API key. Open `/provider --add` and choose
a template or Custom; dscode does not restrict which provider you use.

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

- `/model` — choose model and reasoning effort; choices persist
- `/provider` and `/provider --add` — select or add any provider
- `/preset` or `Ctrl+Y` — choose any discovered preset; four ship by default
- `/dsh plugins` — inspect profile plugins
- `Ctrl+W` on the welcome screen — create a managed isolated Git worktree
- `Ctrl+S` — open durable session resume

Run `dscode --help` for the complete CLI.

When switching providers, dscode keeps the current model if the target
provider exposes the same model id; otherwise it selects that provider's first
model. Reasoning effort is remembered separately for each provider/model pair.

## Update

```sh
dscode update --check              # check only
dscode update                      # remembered/current channel
dscode update --stable             # stable channel
dscode update --beta               # beta channel
dscode update --version <version>  # exact version
```

Update keeps the npm bridge, tested dsh runtime, and TUI binary on the same
release channel. Explicit `--stable` and `--beta` selections are remembered.

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
