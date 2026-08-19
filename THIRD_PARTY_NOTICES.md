# Third-Party Notices

DeepSeek Code is licensed under [Apache-2.0](LICENSE). It contains or depends
on the third-party software below. Each project remains under its own license;
nothing in this file changes those terms.

## NOTICE / modifications

The top-level [NOTICE](NOTICE) identifies the first-party components and
required attributions. Because this project vendors and modifies
[xai-org/grok-build](https://github.com/xai-org/grok-build) (Apache-2.0),
the complete modification ledger is maintained in:

- `third_party/grok-build/TUI-DIVERGENCE.md`
- `third_party/grok-build/VENDORING.md`

Per Apache-2.0 §4(b), modified grok-build files carry or are accompanied by
prominent change notices. Modified files remain under Apache-2.0.

## DeepSeek Harness (npm dependency)

dscode uses the official `@deepseek-ai/dsh` npm packages (MIT). Their full
dependency disclosure is published with the npm packages and in the upstream
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
repository.

## Vendored grok-build TUI

`third_party/grok-build/` is vendored
[xai-org/grok-build](https://github.com/xai-org/grok-build) source
(Apache-2.0). Its own notices live in
`third_party/grok-build/THIRD-PARTY-NOTICES` and
`third_party/grok-build/third_party/NOTICE`.

## grok-leader bridge

`bridge/grok-leader/` is first-party code licensed under Apache-2.0. It depends
on the official `@deepseek-ai/dsh-*` npm packages and their transitive
dependencies (including cordis/schemastery, MIT), resolved from npm. Its
build-only devDependencies are TypeScript (Apache-2.0) and `@types/node` (MIT).
