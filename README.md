# deepseek-code

The grok-build terminal UI driving the DeepSeek Harness. Full terminal
experience — mouse, selection, in-scrollback search, queue and todo panes,
markdown and syntax rendering — backed by the dsh agent runtime, providers,
plugins, and presets.

## Install (two steps)

```sh
npm i -g @deepseek-ai/dsh@next   # the official dsh CLI (0.1.0-rc.6)
git clone --depth 1 https://github.com/HQ1995/deepseek-code.git && cd deepseek-code
bash scripts/install.sh
```

`scripts/install.sh` downloads the prebuilt TUI, builds the `grok-leader`
bridge and registers it in the `deepseek-leader` profile, and links `dscode`
into `~/.local/bin`. If the global npm install fails, the launcher falls back
to `npx --yes @deepseek-ai/dsh` on demand.

Requirements: Node `^22.19.0` (or `>=24`) with npm, pnpm (the official dsh
plugin command drives it), and curl on Linux x86_64 (cargo build elsewhere).

Known gap: npm dsh `0.1.0-rc.6` lacks the EMFILE/ENOSPC watch-capacity fix;
the `deepseek-harness` fork carries it on `dev`. Re-evaluate on every upstream
release. Affected users can build dsh from the fork instead of npm (see
docs/harness-updates.md).

## Use

```sh
dscode                # open the TUI
dscode "run tests"    # with a first prompt
```

TUI local state lives under `$DSC_HOME` (default `~/.dsh/dsc-tui`);
set `DSC_HOME` to relocate it. `~/.grok` is never touched and a
`GROK_HOME` in the environment is ignored, so a real grok-build install can
coexist on the same machine.

Keys: `Enter` send · `Alt+Enter` newline · `Shift+Tab` mode ·
`Ctrl+Y`/`/preset` pick preset (session reloads instantly) ·
`Ctrl+S` resume · `Ctrl+W` worktree · `/model` pick provider/model ·
`Ctrl+Q` quit.

Presets: `minimal` (default), `code`, `standard`, `cordis`, plus your own in
`~/.dsh/.agent-presets/`. Plugins:
`dsh plugin --profile deepseek-leader add <pkg>`.

## Update

`dscode update` self-updates the TUI binary from the deepseek-code GitHub
releases: the stable channel (default) follows the latest release, the beta
channel (`dscode update --beta`, sticky until `--stable`) also picks up
prereleases. The installer honors the same channels via `DSC_CHANNEL=beta
bash scripts/install.sh`. Releases are cut with `scripts/release.sh` from the
repo `VERSION` file (a `-beta.N` suffix publishes a prerelease; a plain
version publishes stable). The harness comes from npm
(`npm i -g @deepseek-ai/dsh@next`); the `deepseek-harness/` submodule stays for
dev/upgrade tracking of the fork (see `docs/harness-updates.md`). To pick up
full repo changes (including the bridge), re-run `bash scripts/install.sh` — it
rebuilds and re-registers the bridge. `bash scripts/uninstall.sh` removes the
launchers, the leader profile, and the TUI state (identity-checked; add
`--remove-dsh` to also drop the npm CLI).

## Layout

- `third_party/grok-build/` — vendored grok-build TUI (Apache-2.0), binary
  renamed `dscode`
- `bridge/grok-leader/` — the leader socket server bridging the TUI to the
  harness, installed as an out-of-tree dsh plugin
- `deepseek-harness/` — the DeepSeek Harness fork (MIT), pinned as a
  submodule; dev/upgrade tracking only, never required by the installer

See `docs/dscode-usage.md` for the full manual.

## License

The deepseek-code project is licensed under [Apache-2.0](LICENSE). See
[NOTICE](NOTICE) for first-party attribution and the grok-build modification
ledger, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party
notices. The vendored `third_party/grok-build/` remains Apache-2.0 and the
`deepseek-harness/` submodule remains MIT.
