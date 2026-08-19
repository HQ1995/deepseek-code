# deepseek-code

`dscode` — a terminal UI for AI coding agents: the vendored
[grok-build](https://github.com/xai-org/grok-build) TUI (Apache-2.0) driving
the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
runtime (`dsh`, MIT), packaged as a dsh plugin.

Personal project — not affiliated with DeepSeek or xAI.

## What it is

- **dsh plugin**: `@hqzhao95/dscode` installs into the `dscode` dsh profile
  and provides the grok-leader bridge that lets the TUI drive DeepSeek Harness.
- **TUI**: a prebuilt Rust terminal UI, distributed through GitHub Releases and
  cached locally at `~/.dsh/dsc-tui/bin/dscode`.

## Install

### Quick start

```sh
npx @hqzhao95/dscode
```

The first run:

1. Resolves `dsh` (see [dsh resolution](#dsh-resolution)).
2. Registers the dscode plugin in `~/.dsh/profiles/dscode`.
3. Downloads the pinned TUI binary to `~/.dsh/dsc-tui/bin/`.
4. Links `~/.local/bin/dscode`.

After that, run:

```sh
dscode
```

### Prerequisites

- Node.js `^22.19.0 || >=24`
- `pnpm` (required by dsh plugin installation; enable with `corepack enable`)
- Linux x86_64 and macOS Apple Silicon (arm64) for prebuilt TUI binaries; other platforms build from a checkout
- Other platforms: build from a checkout with `bash scripts/install.sh`

### dsh resolution

`dscode` uses `dsh` in this order:

```text
DSH_BIN environment variable
  → `dsh` on PATH
  → `npx --yes @deepseek-ai/dsh@0.1.0-rc.8`
```

If you already have `dsh` installed, it is used directly. You do **not** need to
install dsh manually before running dscode.

### dsh version policy

- Tested: `0.1.0-rc.8`
- Supported: `>=0.1.0-rc.7 <0.2.0`

The authoritative values live in `bridge/grok-leader/package.json` under
`dsh.testedVersion` and `dsh.supportedRange`.

## Upgrade

### Update the TUI binary

```sh
dscode update          # stable channel
dscode update --beta   # beta channel
```

### Update the full dscode package

```sh
npm i -g @hqzhao95/dscode@latest
npx @hqzhao95/dscode
```

If the profile still has an old plugin copy, re-register it explicitly:

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

Optionally remove the official dsh CLI too:

```sh
npm uninstall -g @deepseek-ai/dsh
```

For source-checkout installs:

```sh
bash scripts/uninstall.sh            # dscode only
bash scripts/uninstall.sh --remove-dsh
```

## dsh plugins

Manage plugins from inside dscode:

```text
/dsh plugins                     list installed
/dsh add <npm-package|git-url>   install
/dsh remove <name>               uninstall
```

CLI equivalent:

```sh
dsh plugin --profile dscode add <pkg>
```

## More

Manual: [docs/dscode-usage.md](docs/dscode-usage.md) ·
License: [Apache-2.0](LICENSE)
([NOTICE](NOTICE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md))
