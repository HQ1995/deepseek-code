# dscode

DeepSeek Harness coding TUI, distributed with its managed launcher and
`grok-leader` bridge.

```sh
npx @hqzhao95/dscode
```

Requires Node.js `>=22.19.0`, npm, and macOS Apple Silicon or Linux x86-64.
The launcher installs the matching TUI, bridge, and runtime in a private DSH
profile. Open `/provider --add` to configure a provider.

> Personal project — not affiliated with or endorsed by DeepSeek or xAI.

[Usage](https://github.com/HQ1995/deepseek-code#readme) ·
[Protocol](https://github.com/HQ1995/deepseek-code/blob/main/docs/grok-leader-protocol.md) ·
[Development and release](https://github.com/HQ1995/deepseek-code/blob/main/docs/upgrade-strategy.md)

## Bridge configuration

The Cordis plugin maps the TUI's Unix-socket leader protocol onto native DSH
agents, tools, sessions, and services. Rendering belongs to the Rust TUI;
model execution and durable storage belong to DSH. `cordis.patch.yml` composes
the profile with a provider-neutral default. The ordered bundle patch array
adds the eight shipped preset declarations to the native registry.

The DSH base owns the PTC runtime; shipped workflow presets mount their own
isolated `workflow-ptc` engine. Native DeepSeek session-log contribution is
explicitly disabled in the profile, independently of telemetry settings.
The isolated browser ships as a disabled `dscode-browser` row that `/browser on`
enables. `@hqzhao95/dscode/ssh` is the execution world that `dscode remote`
inserts for SSH workspaces.

| Setting | Default | Meaning |
|---|---|---|
| `socketPath` | `$DSCODE_SOCKET`, set by the TUI | Leader socket path; `/tmp/dsh-grok-leader.sock` when unset |
| `provider`, `model` | unset | Initial model route |
| `combineQueuedPrompts` | `false` | Combine plain queued prompts; `DSCODE_COMBINE_QUEUED=1` also enables it |
| `followUpBehavior` | `queue` | Queue follow-ups or `steer` at the next native step; overrides `DSCODE_FOLLOW_UP` |

Presets, tools, commands, providers, models, settings, and session services use
native DSH interfaces. Browser-only panels, private protocols, or new durable
event vocabularies require an explicit bridge adapter. SDK peers must share the
host's Cordis and service identities; do not bundle independent peer copies.

## Optional LSP

The shipped `lsp` preset adds definitions, references, implementations, and
hover to Standard. Install a language server separately; the tested pair is:

```sh
npm install -g typescript-language-server@5.0.0 typescript@6.0.3
dscode --agent lsp
```

Use `/preset manage` to copy the preset and edit its `servers` mapping for other
installed language servers. Copies are snapshots stored at
`$DSH_HOME/profiles/dscode/preset-bundles/<id>/cordis.patch.yml`; restart after
editing. Historical `$DSH_HOME/.agent-presets/<id>` directories are imported
without rewriting their files. Invalid local declarations retain diagnostics
without blocking valid presets. The legacy default is imported once per profile
when no new default has been selected.

## License

Apache-2.0. See [LICENSE](LICENSE).
