# deepseek-code

The grok-build terminal UI driving the DeepSeek Harness. Full terminal
experience — mouse, selection, in-scrollback search, queue and todo panes,
markdown and syntax rendering — backed by the dsh agent runtime, providers,
plugins, and presets.

## Install (one line)

```sh
curl -fsSL https://raw.githubusercontent.com/HQ1995/deepseek-code/main/scripts/install.sh | bash
```

Requirements: git, Node `^22.19.0` (or `>=24`), pnpm 11.x. The installer
clones this repo with its `deepseek-harness` submodule, builds dsh from that
submodule, installs the bridge into the `deepseek-leader` profile, and
downloads a prebuilt TUI binary on Linux x86_64 (cargo build elsewhere).

## Use

```sh
dscode                # open the TUI
dscode "run tests"    # with a first prompt
```

Keys: `Enter` send · `/preset` pick preset (session reloads instantly) ·
`Ctrl+S` resume · `/model` pick provider/model · `Ctrl+Q` quit.

Presets: `minimal` (default), `code`, `standard`, `cordis`, plus your own in
`~/.dsh/.agent-presets/`. Plugins:
`dsh plugin --profile deepseek-leader add <pkg>`.

## Update the harness

The harness lives in the `deepseek-harness/` submodule. Upgrading is a pointer
bump plus a rebuild — `git submodule update --remote`, then rebuild dsh and
reinstall the bridge. See `docs/harness-updates.md`.

## Layout

- `third_party/grok-build/` — vendored grok-build TUI (Apache-2.0), binary
  renamed `dscode`
- `deepseek-harness/` — the DeepSeek Harness fork (MIT), pinned as a submodule
- `bridge/grok-leader/` — the leader socket server bridging the TUI to the
  harness, installed as an out-of-tree dsh plugin

See `docs/dscode-usage.md` for the full manual.
