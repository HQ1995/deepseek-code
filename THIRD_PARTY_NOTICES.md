# Third-Party Notices

deepseek-code is licensed under [Apache-2.0](LICENSE). It contains or depends
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

## deepseek-harness (submodule)

The `deepseek-harness/` submodule is the DeepSeek Harness fork (MIT). Its full
dependency disclosure is recorded in
`deepseek-harness/THIRD_PARTY_NOTICES.md` and
`deepseek-harness/pnpm-lock.yaml`.

## Vendored grok-build TUI

`third_party/grok-build/` is vendored
[xai-org/grok-build](https://github.com/xai-org/grok-build) source
(Apache-2.0). Its own notices live in
`third_party/grok-build/THIRD-PARTY-NOTICES` and
`third_party/grok-build/third_party/NOTICE`.

## grok-leader bridge

`bridge/grok-leader/` is first-party code licensed under Apache-2.0. It has no
external npm dependencies beyond the `@deepseek-ai/dsh-*` packages and vendored
cordis/schemastery (all MIT), resolved from the deepseek-harness submodule. Its
build-only devDependencies are TypeScript (Apache-2.0) and `@types/node` (MIT).
