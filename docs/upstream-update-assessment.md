# Upstream update assessment

Date: 2026-08-28

## Decision

| Upstream | Current dscode baseline | New upstream state | Recommendation |
|---|---|---|---|
| grok-build | `19d42e35c07a9c9244f03f6df0c4c353f970d4f9` / pager 1.0.6 | `9684fa3cdbf2995e30ea8b9b637f1db008f144fc` / pager 1.0.10 | Do not full-sync now. Manually port only reproduced, self-contained fixes. |
| dsh | npm `0.1.1-rc.2` | GitHub prerelease `0.1.2-alpha.1` at `cd5ef8148158c3a752a658978873241fdf8e2bbc` | Do not change the production pin now. Start a source-only pilot after a coherent package family is published; promote only after the alpha stabilizes. |

The two upgrades should not be combined. dsh changes the runtime, event log, preset vocabulary, and composition rows behind the bridge; grok changes the TUI, queue/terminal completion model, startup, and worktree graph in the files where dscode carries its heaviest divergence. Upgrading both together would make failures hard to attribute.

## Current pins and release maturity

- The grok baseline is recorded in [`third_party/grok-build/TUI-DIVERGENCE.md`](../third_party/grok-build/TUI-DIVERGENCE.md). Upstream main is four public sync commits ahead:
  - [`07b2f7144f`](https://github.com/xai-org/grok-build/commit/07b2f7144fd5c5c9d3dd1966937a87852d2dbdb8)
  - [`c2ad97f87a`](https://github.com/xai-org/grok-build/commit/c2ad97f87aea4303b6000a2c22128bc91ee76c9b)
  - [`77cd7eb675`](https://github.com/xai-org/grok-build/commit/77cd7eb675ba911c225c3aaeeece3a20cbccc426)
  - [`9684fa3cdb`](https://github.com/xai-org/grok-build/commit/9684fa3cdbf2995e30ea8b9b637f1db008f144fc)
- Those four exports represent 1,023 changed files (`+108,066/-17,995`), including 595 pager/shell files. Of the 24 TUI files changed for dscode 0.0.13-beta.5, upstream also changed 20; those 20 alone contain `+2,392/-310` upstream churn. The repositories have no Git merge base, so this is a content-based three-way sync, not a normal merge/cherry-pick.
- dscode pins dsh in [`bridge/grok-leader/package.json`](../bridge/grok-leader/package.json) at npm `0.1.1-rc.2`.
- [`dsh-v0.1.2-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.1) is explicitly a GitHub prerelease and has no release assets. The npm registry still reports both `latest` and `next` as `0.1.1-rc.2`; neither `@deepseek-ai/dsh@0.1.2-alpha.1` nor `@deepseek-ai/dsh-agent@0.1.2-alpha.1` exists. dscode's launcher provisions an exact npm version, so the alpha cannot currently be a distributable production pin.
- The dsh alpha is 1,079 commits after rc.2. The package areas used by the bridge account for 777 changed files (`+42,492/-8,315`). See the [official release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.1) and [full comparison](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.1.1-rc.2...dsh-v0.1.2-alpha.1).

## grok-build: value and cost

### Selective ports

1. **Queue-first Up-arrow behavior** — ported from `07b2f7144f`. Up on an empty composer now focuses the bottom merged queue row before prompt history. Four focused Rust contracts and an actual dscode TUI queue/edit scenario passed.
2. **Fragmented X10 mouse-report reassembly** — ported from `77cd7eb675`. `app/x10_filter.rs` and the event-loop integration are in place; all 13 upstream reconstruction/pass-through contracts passed.
3. **Minimal-mode status-line row** — not ported. First verify that the current dscode minimal surface still lacks it.

These are manual ports, not commit cherry-picks: every public commit is a large monorepo export.

### Useful, but not clean ports

The official 1.0.7–1.0.10 changelogs document prompt stashing, workflow catalogs/runs, MCP elicitation, slash-menu recency, prompt-history completeness, faster concurrent subagents, session-picker routing, hot minimal/fullscreen switching, linked-checkout reuse, and follow-ups while waiting on subagents:

- [1.0.7](https://github.com/xai-org/grok-build/blob/9684fa3cdbf2995e30ea8b9b637f1db008f144fc/crates/codegen/xai-grok-shell/changelogs/1.0.7.md)
- [1.0.8](https://github.com/xai-org/grok-build/blob/9684fa3cdbf2995e30ea8b9b637f1db008f144fc/crates/codegen/xai-grok-shell/changelogs/1.0.8.md)
- [1.0.9](https://github.com/xai-org/grok-build/blob/9684fa3cdbf2995e30ea8b9b637f1db008f144fc/crates/codegen/xai-grok-shell/changelogs/1.0.9.md)
- [1.0.10](https://github.com/xai-org/grok-build/blob/9684fa3cdbf2995e30ea8b9b637f1db008f144fc/crates/codegen/xai-grok-shell/changelogs/1.0.10.md)

Several do not pay off yet:

- dscode's `x.ai/workflows/list` adapter still returns no workflow catalog, so importing the workflow UI first would expose an empty surface.
- MCP elicitation and feedback-image work target xAI Host/API contracts that dscode intentionally does not mount.
- xAI subagent retry/routing changes live partly in the embedded grok shell; dscode executes children through external dsh.
- upstream send-now now backgrounds foreground commands and aborts the turn. dscode currently promises a different, tested dsh cancellation contract; a pager-only port would lie to users.

### Full-sync conflict hotspots

A full sync rewrites the exact load-bearing seams in dscode:

- `xai-grok-pager-bin/src/main.rs`: external dsh leader bootstrap and DSCODE environment isolation versus upstream startup/headless rewrites.
- `app/app_view.rs`, `app/dispatch/prompt.rs`, `app/acp_handler/{queue,prompt_origin}.rs`, `app/turn_completion.rs`, and `views/queue_pane.rs`: dscode prompt-id fallback, queue sequence watermark, optimistic echo retirement, viewer-finalize drain, steer/send-now behavior versus upstream terminal-marker and blocked-hook queue architecture.
- `app/agent_view/{mod,paste,render,session}.rs`: dscode provider state, fail-closed image capability, cache display, and preset state versus upstream stash, elicitation, feedback-image, and history work.
- `app/actions.rs`, `views/modal.rs`, `slash/commands/mod.rs`, and `slash/registry.rs`: dscode provider/preset UI and hard-hidden commands versus upstream workflow/elicitation/plugin additions.
- Workspace graph changes include terminal extraction into `xai-grok-shell-terminal`, `xai-grok-home` → `xai-dirs`, and a new dashboard store.

Therefore the full sync should wait for a dedicated branch and its own release cycle.

## dsh 0.1.2 alpha: value and blockers

### High-value changes for dscode

1. **Persistent terminal correctness** — lower-level terminal fixes address PowerShell protocol/startup/output errors, Linux pipeline reads incorrectly treated as input waits, and host stalls from large Bash process trees. Representative commits: [`4f3a47d792`](https://github.com/deepseek-ai/deepseek-harness/commit/4f3a47d792e82cfa33967325b7c4425212b97553), [`9a12505f86`](https://github.com/deepseek-ai/deepseek-harness/commit/9a12505f86), and [`32ddfcd89c`](https://github.com/deepseek-ai/deepseek-harness/commit/32ddfcd89c). Standard/minimal dscode presets use this stack directly.
2. **Image-aware compaction pressure** — [`42164508c8`](https://github.com/deepseek-ai/deepseek-harness/commit/42164508c86a37e8da2ca9d213ee9dbfce8353ea) prices images using the resolved route in attachment → LLM adapter → token meter → compaction, with correction [`5183bc2b65`](https://github.com/deepseek-ai/deepseek-harness/commit/5183bc2b652f324a5e30fd52aa70e68e7ce84d92). This is genuinely new; dscode's durable image transport does not solve context-pressure accounting.
3. **Preset-root correctness** — PR merge [`02d6af9d05`](https://github.com/deepseek-ai/deepseek-harness/commit/02d6af9d050126a7bc9e1ab4b5c9e7afe20d12cf) moves shipped presets into the preset package and stops launcher boot from overwriting configured roots. This can remove dscode's profile-boot assumption after migration.
4. **Per-child model routing** — subagents can receive provider, model, and reasoning-effort overrides through `AgentOptions`, with explicit capability/allowlist checks. Relevant work includes [`f76a225a7d`](https://github.com/deepseek-ai/deepseek-harness/commit/f76a225a7db1560e1ed8b77d30fe4f2e7b774d65) and [`aefc083be7`](https://github.com/deepseek-ai/deepseek-harness/commit/aefc083be7). This is more capable than dscode's current parent-route inheritance fix.
5. **Storage/session loading** — [`df76bc695b`](https://github.com/deepseek-ai/deepseek-harness/commit/df76bc695b4bdff093369ab22a506cd37ca087c1) reduces persisted session footprint; the base profile also gains projection caching.
6. **Preset diagnostics and Minimal correctness** — [`f7890f591a`](https://github.com/deepseek-ai/deepseek-harness/commit/f7890f591a) reports unresolved preset failures at the selection boundary; PR #2777 removes `/goal` from Minimal.

### Breaking or policy-sensitive migration work

1. **`code` preset becomes `ptc`** — [`3ca9c7d489`](https://github.com/deepseek-ai/deepseek-harness/commit/3ca9c7d4891760ba366123bf9f5d45ed7133c088) renames the shipped non-durable preset id. dscode hard-codes `code` in display copy, tests, docs, E2E, and durable `agent-preset/selected` handling. Existing sessions containing `code` need an explicit compatibility decision; unrelated durable `tool/code-dispatch*` vocabulary intentionally remains unchanged upstream.
2. **Session/event surface changes** — message-producing events now carry ordered `surfaceOp` metadata, persistence uses chunk-run/storage/projection layers, strict known-event handling has no supported downstream registration API, and new event types include upstream model selection and subagent policy. dscode mutates `KNOWN_SESSION_EVENT_TYPES` to admit its private model-selection events; that remains an unsupported, load-bearing restore seam.
3. **Composition rows and privacy** — the alpha base adds rows such as `tool-subagent-report`, plugin inventory, session log, storage, projection, and telemetry. dscode's host-plane cutout does not disable the new report row. The alpha changes telemetry posture to feedback-only and introduces optional DeepSeek session-log upload; a provider-neutral product must explicitly choose and test its policy rather than inherit it accidentally.
4. **Preset roots move ownership** — dscode comments and profile-boot logic reference `apps/cli/config/agent-presets`; alpha makes the package own shipped roots and gives `roots`, `includeShippedRoot`, and `includeUserRoot` distinct meanings.
5. **ApiProxy removal and app launch convergence** — the legacy Host ApiProxy is removed in favor of Remote/API gateway, and ACP/SDK apps converge on dsh profiles. dscode does not depend directly on ApiProxy, but provider CRUD, reverse questions/permissions, and custom profile boot must be re-exercised because they use adjacent structural services.
6. **No coherent published package family** — mixing source alpha packages with rc.2 npm packages risks duplicate Cordis/service/type identities. The entire family must move together.

## Recommended sequence

1. **Keep dscode 0.0.13-beta.5 on dsh 0.1.1-rc.2.** The runtime is published, fully exercised on Linux/macOS, and the new alpha is not installable through the current release pipeline.
2. **Completed:** queue-first Up and fragmented X10 mouse filtering were manually ported with focused tests and the existing dscode product E2E. Do not import the full four-sync range.
3. **Wait for dsh 0.1.2 packages on npm** (prefer an rc over `alpha.1`). Then make a dsh-only compatibility branch and move every `@deepseek-ai/dsh-*` package together.
4. In that branch: migrate `code`/`ptc`, update preset-root semantics, add all new base rows to the composition audit, choose telemetry/session-log policy, and replace or formally own the private model-selection event mechanism.
5. Run old-log compatibility tests before any new-session test: rc.2 standard/code/minimal/cordis sessions, private model-selection events, image sessions, compaction checkpoints, resume, and fork.
6. Then run the complete bridge suite, real TUI E2E, provider/credential CRUD, text and multi-image real-model scenarios, persistent shell pipeline/fan-out cases, Linux release lifecycle, and macOS arm64 CI/artifact checks.
7. **Only after the dsh cutover is stable**, evaluate a grok 1.0.10 full sync on a separate branch. Combining the migrations provides no diagnostic advantage and multiplies the conflict surface.

## Upgrade gates

A proposed pin/sync is acceptable only when all of these remain true:

- exact runtime/package version agreement and clean cold install;
- old rc.2 sessions resume without silent preset/model/event drift;
- standard, ptc/code compatibility, minimal, cordis, and custom presets expose the intended tool/command rosters;
- provider add/edit/delete and credentials survive restart;
- text, image, cache, compaction, question, permission, goal, workflow, and subagent paths pass with deterministic and real models;
- queue sequence, steer, send-now, cancellation, reconnect, and prompt completion contracts remain monotonic;
- no host-plane tool leaks from new base rows;
- telemetry and session-log upload behavior are explicit;
- Linux x86_64 and macOS arm64 builds, checksums, and install lifecycle pass.
