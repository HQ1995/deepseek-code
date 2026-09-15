# DSH 0.1.6-alpha.1 adaptation audit

Static source audit, 2026-09-15. Target: official tag `dsh-v0.1.6-alpha.1`,
`0a15e36e7f82b6ed45af6fa9759f29b40dcd965d`, read with `git show` / `git grep`
from the existing upstream checkout. Product baseline: `db43b24`, with
`0.1.5-rc.2` / `fb2c4b9e` compatibility metadata. This record does not establish
installed-package compatibility; this research lane ran no installs or tests.

## Minimum composition migration

1. In [cordis.patch.yml](../bridge/grok-leader/cordis.patch.yml), remove the
   inserted `code-runtime` / `@deepseek-ai/dsh-code-runtime-worker-thread` row
   (current lines 110–113). Do **not** replace it with another inserted runtime:
   alpha's base already mounts `ptc-runtime` /
   `@deepseek-ai/dsh-ptc-runtime-node`. Change the host disabled row
   `workflow-worker-thread` to `workflow-ptc`, matching the official web profile.
   Keep `tool-workflow` disabled on the host. [Base rows][base-runtime],
   [web profile][web-workflow].
2. In the owned [history](../bridge/grok-leader/presets/history/agent.cordis.yml)
   (223–226), [LSP](../bridge/grok-leader/presets/lsp/agent.cordis.yml) and
   [terminal](../bridge/grok-leader/presets/terminal/agent.cordis.yml) presets
   (both 140–143), change the row id to `workflow-ptc` and package to
   `@deepseek-ai/dsh-workflow-ptc`; retain `config.provider: spawn`. Keep that
   engine, `tool-workflow`, and `tool-ralph` within their existing
   `delegation` group with `isolate.workflowEngine: true`. This is the released
   standard preset's engine/service composition. [Standard preset][standard].
3. Preserve host ownership of `subagents`, its `spawn` provider, `ptcRuntime`,
   `sandboxPolicy`, `sandbox`, `fs`, and `subprocess`. The new engine injects
   `subagents`, `ptcRuntime`, `sandboxPolicy` and rejects a runtime whose language
   is not `typescript`; the Node runtime injects `fs`, `subprocess`, `sandbox`,
   `sandboxPolicy`. Adding only a renamed package to an old fixture leaves it
   incomplete. [Engine injection][engine], [runtime injection][runtime].
4. Keep runtime-owned packages supplied by the alpha runtime closure. Base
   declares both concrete new packages as dependencies; no additional ordinary
   bridge dependency is required merely to reference these YAML rows. If a
   standalone composition test imports them, add the matching SDK to that test
   environment. Verify release staging resolves the runtime package's exported
   `./process` file (`lib/process.js`), not only its main module.
   [Base dependencies][base-deps], [runtime exports/peers][runtime-package].
5. Update SDK/compatibility metadata only in the isolated candidate until its
   checks pass. Separately migrate the known `agent/session-start` listener in
   [native-session-status.ts](../bridge/grok-leader/src/native-session-status.ts)
   (27, 89) to the awaited serial `agent/created` lifecycle, including its timing
   tests; this is not just a PTC composition issue. [Publication point][created].

One deliberate product delta should not be hidden by copying the new standard
preset wholesale: alpha disables `tool-ralph` in standard; the three owned
presets currently enable it. This does not change the engine's required service
composition, but changing tool availability is a separate behavior decision. Alpha's shipped
PTC preset disables both `workflow-ptc` and `tool-workflow`, while exposing
`run_code` through `agent-tool-presentation`; leave that shipped arrangement
intact. [Standard][standard], [PTC composition][ptc-preset].

## Execution and permission differences to verify

The new runtime executes erasable TypeScript in a fresh managed Node process,
with direct Node APIs and an empty model environment. It resolves the executable
through `subprocess`, launches using the filesystem-backed bootstrap path, and
uses `sandbox.confine` unless the resolved mode is `danger-full-access`.
Confinement/launch failures remain errors; cleanup waits for process exit and
output draining. Therefore old worker-thread success does not prove the new
package, executable, control-pipe, or platform sandbox path works.
[Runtime contract][runtime], [launch][runtime-launch], [cleanup][runtime-cleanup].

`run_code` resolves sandbox policy from the calling agent's session, then routes
an explicit `sandbox_permissions`/`justification` request through the native
approval service for that execution. Its tool description states that nested
tools retain their own policies and approvals and programs are not replayed
automatically. The numeric runtime deadline includes nested tool and approval
waits (default 120 s, maximum 600 s). [Session policy lookup][tool-policy],
[escalation][ptc-escalation], [transport description][ptc-description],
[defaults][runtime].

Workflow execution captures `sandboxPolicy.resolve({ session: parent.session })`
and passes that policy plus its workspace root to the runtime. It explicitly
uses `timeoutMs: null`; the ordinary PTC numeric deadline does not bound a
workflow waiting for children or human responses. Cancellation must settle the
program and admitted children before returning. [Engine start][engine-start],
[workflow execution/cleanup][workflow-drive].

## Native DeepSeek session-event contribution

The exact new control is the **composition** row `session-log-deepseek` with
`config.enabled: false` (or disabling that row). Base mounts it by default;
its schema defaults `enabled` to `true`, and `apply` registers `dsh_session_log`
only when enabled. It is not an `llm-deepseek` option or the OTel sharing mode.
To preserve the existing product behavior, add this explicit profile override:

```yaml
- id: session-log-deepseek
  config:
    enabled: false
```

Keep the current empty `agent-default-model` provider/model and disabled
`llm-deepseek` row. They preserve fresh-profile neutrality; the explicit new
override also prevents an intentional later native-provider enablement from
silently opting into the added session-log field. [Current profile][product-patch],
[base contributor][base-log], [actual switch and contribution][session-log].

The contributor obtains the live session by request `sessionId`, serializes the
session header and canonical event suffix (including raw `event.data`), and
records an accepted sequence after successful HTTP acceptance. Missing/stale
session ids or empty logs contribute no field. This is an extra field on a model
request, not an independent periodic upload. [Contributor][session-log],
[payload merge][request-extensions].

Do **not** describe this as an official-hostname allowlist. Both native
protocols prepare extensions and POST them to their resolved `connection.baseURL`;
neither the contributor nor the registry checks the endpoint. A configured
native DeepSeek gateway can therefore receive the field too. The native
adapter registers route `deepseek-official`; its name is not an endpoint check.
Other adapters are not wired through this callback in the inspected native
registration. [Messages request][messages], [Chat Completions request][chat],
[native registration][native-registration].

`session-telemetry-otel` remains a separate base row configured with
`DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'`; changing the session-log contributor does
not disable it. Nor does this audit prove the absence of every other outbound
extension. Native DeepSeek's protocol default is now `messages`; route tests
must set a protocol explicitly when expecting the older Chat Completions wire
shape. [OTel configuration][otel], [native protocol config][native-config].

## Reusable checks and remaining evidence

- Bridge tests already cover provider-neutral empty catalogs
  (`tests/leader.spec.ts:809`), preset ownership/recomposition
  (`tests/session-presets.spec.ts:66`), approval ownership and native permission
  precedence (`tests/native-interactions.spec.ts:53`), PTC subcall projection
  (`tests/controls.spec.ts:109`), workflow replay (`tests/workflows.spec.ts:27`),
  and delayed workflow-child publication (`tests/leader.spec.ts:2098`). These
  remain useful bridge contracts; mocked services do not validate confinement.
- [Existing installed TUI audit](../scripts/e2e-tui-bridge.sh) already captures
  Responses tool rosters for minimal/standard/history/PTC/creator/custom
  (604–686), including PTC's `run_code` surface. Add LSP/terminal to the new
  candidate's roster/mount checks and exercise an actual `run_code` binding and
  workflow child, rather than treating a roster response as execution proof.
- Useful released upstream tests are [runtime execution][runtime-tests]
  (42, 178, 245, 282: environment, descendant cleanup, read-only and workspace
  confinement), [host failures][host-tests] (139, 203, 229: unavailable sandbox,
  null deadline, cancellation race), [installed workflow][workflow-built-test],
  [workflow cancellation][workflow-tests] (583 onwards), and
  [workflow ambient-state isolation][egress-test]. Some confinement tests skip
  when the host sandbox is unavailable; record executed versus skipped cases.
- Reuse [contributor upload tests][upload-tests] (149: explicit disable) and
  [native Messages extension tests][extension-tests] (36–41: custom base URL).
  Capture candidate requests for fresh neutral, explicitly enabled native, and
  custom native gateway profiles; assert `dsh_session_log` is absent with the
  override, and distinguish this result from OTel behavior.

These are proposed gates, not passes from this audit. Main production files,
pins, installs, tests, commits, and the upstream checkout were left unchanged
by this research lane; only this record was added.

## Subsequent isolated implementation and macOS checks

Work root: `/tmp/dscode-alpha16.c6NG8h`. `product/` is an independent clone of
`db43b24`; `source/` is an unchanged checkout of the exact official alpha tag.
The main repository still pins `0.1.5-rc.2`; no daily profile, release, remote,
or swoop workload was changed. Browser/computer capabilities were investigated
separately in [this record](runtime-alpha16-browser-computer.md), not enabled.

The candidate updates the 32 distinct DSH SDK dependencies and compatibility
metadata, regenerates the lock, removes the obsolete code-runtime insertion,
migrates the three owned workflows and the lifecycle subscription, and adds
the explicit session-log opt-out. Koffi's required build is explicitly approved
in the candidate pnpm workspace; no blanket build-script bypass was used.
The codebase-design review retained existing runtime ownership and the awaited
create/attach/publish sequence; no parallel compatibility layer was added.

Verified so far on Darwin arm64:

| Surface | Node 22.19.0 | Node 24.19.0 | Evidence under work root |
| --- | --- | --- | --- |
| npm SDK bridge suite | 931 passed | 931 passed | `tests-adapted22.log`, `tests-adapted24.log` |
| Extracted source-built SDK compile + bridge suite | 931 passed | 931 passed | `bridge-packaged22.log`, `bridge-packaged24.log` |
| PTC/workflow owners + native request-extension/contributor tests | 348 passed, 1 Windows-only skipped | 348 passed, 1 Windows-only skipped | `owners22.log`, `owners24.log` |
| Built workflow smoke through package exports | 1 passed | 1 passed | `workflow-built22.log`, `workflow-built24.log` |
| Extracted runtime probe | passed | passed | `runtime-probe22.log`, `runtime-probe24.log`, `runtime-probe.mjs` |

The six new composition/lifecycle tests first failed against the old composition
(`migration-negative24.log`). The earlier 921-pass baseline omitted four
compiled-TUI CLI tests because the isolated clone lacked a binary; the final
931-pass runs above include those tests by explicitly selecting the unchanged
main TUI binary. None of these tests enables experimental browser/computer use.

The extracted-runtime probe runs plain Node against the release's package
exports, including `ptc-runtime-node/process`. It verifies TypeScript execution
and a host binding with an empty model environment, actual read-only denial,
workspace-write success, cancellation followed by process disappearance, and
a workflow's structured child binding. It also reads the candidate's actual
session-log config and verifies no contribution, with enabled contribution as
its positive control. That last probe tests the contributor registry, not every
possible profile or outbound HTTP request; the native wire unit tests use a
controlled fetch fixture.

The standard runtime/plugin builder completed, both archive SHA files verified,
and the consumer's content provenance remained intact after validation:

- Runtime SHA-256: `72f16e22bd64f0e4bd9352ce0ccdbb51a990dff601e0af46edc496870c2f85ec`.
- Plugin SHA-256: `e63aec90d795f1828f880edbf18a92b280f10f3cfe8b74491b2d5bd6282aaf9a`.
- TUI SHA-256: `38b0eae22994cf53636c91f069e57f2a823eac6379897bcd7908d136b704042c`.
- `scripts/check.sh` passed; Node script tests passed 37, skipped 1 Linux-only
  signal-launcher test, failed 0.

Installed TUI acceptance passed on Node 24 in the complete run **74958**:
`e2e24-verified.log`, `e2e-verified/contracts-74958/PASS.json`. This includes
all eight shipped/custom roster checks, native lifecycle and workflows, paged
child history and quoting, four real LSP queries, persistent shell/Python REPL,
terminal interruption and owner isolation, archives and attachments, and all
14 workspace-history access cases. The run used private
`typescript-language-server@5.0.0` + `typescript@6.0.3`, unchanged compiled TUI,
and the exact source-built runtime/plugin above. No alpha test processes
remained in the final process inventory. Kitty pixel rendering was skipped
because no Kitty executable was configured; physical macOS Cmd-click was not
covered. Browser/computer screenshots and real-provider paid calls were not run.

Earlier failed attempts are retained. The first roster assertion
correctly detected that upstream Standard **and Creator** now disable Ralph;
the candidate assertions now distinguish those from the three owned presets,
which retain Ralph, and additionally inspect LSP/terminal rosters. The history
suite's separate roster assertion was updated consistently. A child-history
quote check had insufficient input/selection synchronization: the fixture now
waits for the parent composer to receive its draft and, after replay, uses
PageDown and verifies that the final message is selected before opening it.
An intermediate `G` navigation experiment was incorrect for non-vim input and
was removed; no TUI or bridge production workaround was introduced.
A separate LSP failure reported a missing TypeScript installation, so final
tests use private `typescript-language-server@5.0.0` + `typescript@6.0.3` rather
than the incomplete ambient npx cache, and the test preflight now also requires
`tsserver` on PATH.

The final patch review checked the SDK pin set (32 installed versions match),
runtime ownership, lifecycle identity/initial-publication timing, retained
provider neutrality, separate session-log opt-out, all remaining old runtime
references, and test-only synchronization fixes. Candidate checkout is clean at
`5aa44f1a722f9c8982ff487a28b7677c213a2aef`, branch `candidate/dsh-alpha16`:

- `fa1b5b9`: minimal runtime/config/lifecycle migration and regression checks.
- `5aa44f1`: align the history acceptance roster with the upstream default.

Recoverable backups under the main repository's `.git/integration-backups/`:

- `dsh-alpha16-5aa44f1.bundle`, SHA-256
  `5f2f2189d3980144bdac640d96528e213fe06171bc9df69493c26b06b22a53e1`.
  Verified in the main repository; **incremental**, requires baseline
  `db43b2465eaeb73648dbe236ba2b60b8f06fba00` (not a standalone source bundle).
- `dsh-alpha16-macos-5aa44f1-evidence.tar.gz`, SHA-256
  `4344adb5528dabed89d7e9d702ea0503cdc87bda545489365cf61921a609ee94`.
  Includes probes, unit/build logs, failed E2E logs, and final installed evidence;
  excludes the isolated profile home and observer directory.

Remaining before product adoption/release: fresh Linux alpha-specific
acceptance (prior swoop passes cover the backport, not this tag), then the
intended product version and release/update lifecycle checks. No full-alpha
Linux or real-provider/API-key test is claimed here; the main product pin and
daily installation remain unchanged.

[product-patch]: ../bridge/grok-leader/cordis.patch.yml
[base-runtime]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/bundle/base/cordis.patch.yml#L369-L378
[web-workflow]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/bundle/web-app/cordis.patch.yml#L459-L469
[standard]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/preset/agent-presets/presets/standard/agent.cordis.yml#L169-L240
[ptc-preset]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/preset/agent-presets/presets/ptc/agent.cordis.yml#L229-L280
[engine]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/workflow/workflow-ptc/src/index.ts#L102-L120
[engine-start]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/workflow/workflow-ptc/src/index.ts#L133-L174
[runtime]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/ptc-runtime/ptc-runtime-node/src/index.ts#L51-L118
[runtime-launch]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/ptc-runtime/ptc-runtime-node/src/index.ts#L217-L239
[runtime-cleanup]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/ptc-runtime/ptc-runtime-node/src/index.ts#L165-L193
[base-deps]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/bundle/base/package.json#L121-L123
[runtime-package]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/ptc-runtime/ptc-runtime-node/package.json#L22-L41
[created]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/core/agent/src/index.ts#L540-L555
[tool-policy]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/core/tools/src/index.ts#L924-L936
[ptc-description]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/core/tools/src/ptc.ts#L103-L124
[ptc-escalation]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/core/tools/src/ptc.ts#L372-L398
[workflow-drive]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/workflow/workflow-ptc/src/host.ts#L273-L303
[base-log]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/bundle/base/cordis.patch.yml#L30-L37
[session-log]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/session/session-log-deepseek/src/index.ts#L35-L194
[request-extensions]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/llm/llm-deepseek/src/common/request-extensions.ts#L15-L39
[messages]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/llm/llm-deepseek/src/protocols/messages/adapter.ts#L116-L146
[chat]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/llm/llm-deepseek/src/protocols/chat-completions/adapter.ts#L320-L335
[native-registration]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/llm/llm-deepseek/src/index.ts#L122-L133
[otel]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/bundle/base/cordis.patch.yml#L184-L197
[native-config]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/llm/llm-deepseek/src/config.ts#L80-L83
[runtime-tests]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/ptc-runtime/ptc-runtime-node/tests/runtime.spec.ts
[host-tests]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/ptc-runtime/ptc-runtime-node/tests/host-failures.spec.ts
[workflow-built-test]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/workflow/workflow-ptc/tests/built-runtime.e2e.ts#L20
[workflow-tests]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/workflow/workflow-ptc/tests/workflow-ptc.spec.ts#L583
[egress-test]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/workflow/workflow-ptc/tests/egress.spec.ts#L9
[upload-tests]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/session/session-log-deepseek/tests/upload.spec.ts#L149
[extension-tests]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/llm/llm-deepseek/tests/messages/extensions.spec.ts#L36
