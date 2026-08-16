# deepseek-code

The grok-build terminal UI driving the DeepSeek Harness. Full terminal experience — mouse, selection, in-scrollback search, queue and todo panes, markdown and syntax rendering — backed by the dsh agent runtime, providers, plugins, and presets.

## Install (one line)

```sh
curl -fsSL https://raw.githubusercontent.com/HQ1995/deepseek-code/main/scripts/install.sh | bash
```

Requirements: git, Node 22+, pnpm. Linux x86_64 downloads a prebuilt TUI binary; other platforms build it with cargo.

## Use

```sh
dscode                # open the TUI
dscode "run tests"    # with a first prompt
```

Keys: `Enter` send · `/preset` pick preset (session reloads instantly) · `Ctrl+S` resume · `/model` pick provider/model · `Ctrl+Q` quit.

Presets: `minimal` (default), `code`, `standard`, `cordis`, plus your own in `~/.dsh/.agent-presets/`. Plugins: `dsh plugin --profile deepseek-leader add <pkg>`.

## Update the harness

The harness fork merges upstream with a plain git merge; the compatibility contract and divergence list live in `docs/harness-updates.md`.

## Layout

- `third_party/grok-build/` — vendored grok-build TUI (Apache-2.0), binary renamed `dscode`
- `packages/`, `apps/cli` — the DeepSeek Harness fork (MIT)
- `packages/bridge/grok-leader/` — the leader socket server bridging the TUI to the harness

See `docs/dscode-usage.md` for the full manual.
