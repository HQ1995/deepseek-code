# deepseek-code

`dscode` — a full terminal UI for AI coding agents: mouse, scrollback
search, queue and todo panes, markdown and syntax rendering, sessions,
presets, and a plugin ecosystem, in one binary.

It is built from two open-source upstreams: the
[grok-build](https://github.com/xai-org/grok-build) TUI (vendored,
Apache-2.0) driving the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent
runtime (`dsh`, MIT) over a unix-socket bridge.

> **This is a personal project.** It is not affiliated with, endorsed by,
> or sponsored by DeepSeek or xAI. "DeepSeek" and "Grok" are trademarks of
> their respective owners; they appear here only to describe the
> open-source components this project builds on.

## Install

dscode ships as a dsh plugin
([`@hqzhao95/dscode`](https://www.npmjs.com/package/@hqzhao95/dscode)):

```sh
npm i -g @deepseek-ai/dsh@next
dsh plugin --profile deepseek-leader add @hqzhao95/dscode
~/.dsh/profiles/deepseek-leader/node_modules/.bin/dscode
```

The first run downloads the release-pinned TUI binary (SHA-256 verified)
and links `dscode` into `~/.local/bin`. Prebuilt binaries are Linux x86_64;
other platforms build from this repo (`bash scripts/install.sh`, which is
also the dev-checkout installer). Requires Node `^22.19.0 || >=24` and pnpm.

## Use

```sh
dscode                # open the TUI
dscode "run tests"    # with a first prompt
```

`Enter` send · `Alt+Enter` newline · `Shift+Tab` mode · `Ctrl+Y` presets ·
`Ctrl+S` resume · `/model` provider + model · `/dsh` manage plugins ·
`Ctrl+Q` quit

Local state lives under `~/.dsh/dsc-tui` (`DSC_HOME` relocates it);
`~/.grok` is never touched, so a real grok-build install can coexist.

Full manual: [docs/dscode-usage.md](docs/dscode-usage.md).

## Update / uninstall

`dscode update` self-updates from GitHub releases (stable by default,
`--beta` for prereleases). Plugin installs follow the npm package's release
pin instead. Releases are cut with `scripts/release.sh` from the `VERSION`
file; `bash scripts/uninstall.sh` removes the launchers, the leader
profile, and the TUI state.

## Layout

- `third_party/grok-build/` — vendored grok-build TUI (Apache-2.0);
  modification ledger in `TUI-DIVERGENCE.md`
- `bridge/grok-leader/` — the dsh plugin: leader-socket server bridging the
  TUI to the harness, plus the `dscode` launcher (published as
  `@hqzhao95/dscode`)
- `deepseek-harness/` — harness fork (MIT), submodule for dev/upgrade
  tracking only; the installer never needs it
- `docs/` — manual, wire-protocol reference, upgrade strategy

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution and the
grok-build modification ledger, and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party notices.
The vendored `third_party/grok-build/` remains Apache-2.0; the
`deepseek-harness/` submodule remains MIT.
