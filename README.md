# deepseek-code

`dscode` — a terminal UI for AI coding agents: the vendored
[grok-build](https://github.com/xai-org/grok-build) TUI (Apache-2.0) driving
the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
runtime (`dsh`, MIT), packaged as a dsh plugin.

Personal project — not affiliated with DeepSeek or xAI.

## Install

```sh
npx @hqzhao95/dscode
```

The first run sets everything up; afterwards the command is `dscode`.
Linux x86_64, Node `^22.19.0 || >=24`, pnpm. Other platforms build from a
checkout: `bash scripts/install.sh`.

Uninstall:

```sh
rm -rf ~/.dsh/profiles/deepseek-leader ~/.dsh/dsc-tui ~/.local/bin/dscode
```

(dev checkouts: `bash scripts/uninstall.sh`)

## dsh plugins

Install any dsh plugin from inside dscode:

```
/dsh plugins                     list installed
/dsh add <npm-package|git-url>   install
/dsh remove <name>               uninstall
```

Plugin slash commands, providers, and models surface automatically. Example:
`/dsh add dsh-plugin-subscriptions`, then `/dsh login codex` to use a
ChatGPT/Claude/Grok subscription as a provider. CLI equivalent:
`dsh plugin --profile deepseek-leader add <pkg>`.

## More

Manual: [docs/dscode-usage.md](docs/dscode-usage.md) ·
License: [Apache-2.0](LICENSE)
([NOTICE](NOTICE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md))
