# DeepSeek Harness alpha.1 upstream follow-up — 2026-09-22

> Later the same day the candidate was retargeted to `0.1.7-alpha.2`; see the
> [0.1.7 adaptation report](dsh-upstream-refresh-2026-09-22.md). This note
> remains the alpha.1-time record.

Observed **2026-09-22 15:52:28–15:54:51 UTC** through public GitHub/npm APIs and read-only inspection of `/Users/hqzhao/AI/dsh-alpha17/src`. Master and npm were rechecked at 15:54:51 UTC. Source contracts below refer specifically to alpha.1.

- **Verified alpha.1 identity:** official tag `dsh-v0.1.7-alpha.1` resolves directly to `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`, matching the clean local checkout and candidate pin. Its GitHub release is published, immutable, non-draft and marked prerelease; published/updated **2026-09-22T06:16:27Z**. Bilingual release notes exist, with a comparison from `dsh-v0.1.6-alpha.2`. [Tag][tag1] · [Release API][release-api1] · [Notes][release1]
- **Verified upstream movement:** master now resolves to `00102833dfaee1da9f48a3a8eae9d34005a75218` (commit time **15:25:38Z**), also the alpha.2 tag. Alpha.2's GitHub prerelease was published at **15:49:49Z**. The earlier adaptation report's master/tag equality is therefore historical. Alpha.2 notes include a job-completion wakeup fix, `spill-policy.maxInlineBytes` → `maxInlineTokens`, and tighter vendor dependency ranges; these are follow-up considerations, not alpha.1 changes. [Master API][master] · [Alpha.2 tag][tag2] · [Alpha.2 release API/notes][release2]
- **Verified npm snapshot:** `@deepseek-ai/dsh` has `alpha=0.1.7-alpha.1`, `latest=0.1.5-rc.2`, `next=0.1.5-rc.3`; alpha.2 is absent from the returned versions. Alpha.1 was published **2026-09-22T06:23:31.522Z**; registry modification time is **06:23:31.842Z**. Its tarball is `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.7-alpha.1.tgz`, registry SHA-1 `40653f012e24bdb3161be9dba195466fff22d98c`. Metadata declares Cordis `^4.0.3`, Schemastery `^3.18.3`, and js-yaml `^4.2.0`; it supplies no `gitHead`. This checks registry metadata, not tarball bytes or source equivalence. [Registry][npm] · [Version metadata][npm1]

| Surface | Verified alpha.1 upstream contract | Consequence for the existing dscode adaptation |
| --- | --- | --- |
| Native preset registry | Presets are plugin declarations, with ordered bundle patches supported. Registry discovery no longer scans directories or accepts preset paths. `config.id` is the session identity; declaration-row `id` addresses Loader edits. Existing agents retain their composition revision. [Registry][presets] · [Declaration][declaration] · [Release notes][release1] | The report's native declarations and profile-local editable bundles fit this contract. dscode's legacy-directory import and copy/edit UI remain consumer adaptation, not upstream registry operations. |
| V4 tool messages | `tool/result.data.message` is a first-class tool-role message with `toolCallId`, content and optional `isError`; V3 wrapper content is lifted by the migrator. Historical read opens do not publish; write opens publish a verified successor while preserving source bytes. [Tool conversion][tool-role] · [Persistence][persistence] | Transcript, image extraction and pending-call cleanup must consume the V4 message directly. Those paths are present in local `projection.ts`, `image-output.ts` and `session-output.ts`; use native migration rather than rewriting historical generations. |
| Job ownership/output | Operations use caller `SessionId`; omission only permits unowned jobs. `read()` consumes the model cursor; `readAt()` does not. `events.subscribe` supports owner/scope/process filters, and starting owned background work requires a controller serving that owner. [Jobs contract][jobs] | Local `job-output.ts` uses `readAt(..., owner.session.id)`; `native-tasks.ts` subscribes and routes by owner. This supports passive display without consuming model output; it is static evidence, not a new runtime pass. |
| Settings import | Settings persist in profile plugin configuration. After Loader settles, legacy `settings.yaml` is renamed to `.imported` before section writes; rejected sections are logged and retained in that file. Upstream starts this asynchronously and exposes no completion promise here. [Settings source][settings] | The candidate's `SettingsForms.ready` promise is a **local patch**. `model-catalog.ts` awaits it before the first catalog snapshot; the first-boot race and previous validation are documented in the adaptation report. |
| Native subprocess cancellation | Linux records requested termination signals before bootstrap consumption, accepts a matching observed signal, and gives recorded pre-exec errors precedence. Unrequested unconsumed launches still fail. Scope emptiness is checked separately from direct exit; native scope support has host requirements. [Linux implementation][linux] · [Provider contract][subprocess] | The early-cancellation handling is already upstream at this pin, not added by the candidate patch. Source inspection does not establish acceptance on the running Linux host. |

**Verified local patch identity:** SHA-256 of [the candidate patch][patch] is `a1dbb05991058cd7713acb984ef819a223d3f4bef543a99c0edd94c8d158d853`, matching the supplied digest. Alongside Settings readiness, it contains macOS process-inspection changes and a historical-decoder helper extraction. It does not modify `linux-scope.ts`; none of these local changes should be attributed to the official alpha.1 release.

**Assessment:** alpha.1 remains the verified candidate/tag and observed npm alpha target; it is no longer current master. The five inspected contracts support the adaptation direction, but do not certify the whole product. Alpha.1 release notes also require migration of custom-event-only attachments; arbitrary legacy/custom producers were not comprehensively audited here. [Release notes][release1]

**Provider follow-up:** alpha.1's official `llm-deepseek` adapter accepts Messages only and rejects the old `protocol` field. The current dscode [composition](../bridge/grok-leader/cordis.patch.yml) disables that default adapter, while [provider management](../bridge/grok-leader/src/model-catalog.ts) writes the separate `llm-pi-ai` namespace with `openai-completions`, `openai-responses` or `anthropic-messages`. Those protocols remain supported by [llm-pi-ai][pi-ai]. This source check found no removed official-adapter field in the normal provider-management path. A manually enabled official adapter with legacy `protocol` configuration still needs the [documented upstream migration][deepseek-adapter]; no real DeepSeek account or Messages endpoint was exercised.

The [existing adaptation report][context] owns previously executed gates. This follow-up accessed no swoop host, ran no tests/builds, installed nothing, and changed no refs or candidate code. It makes no complete-upstream-suite or completed-Linux-acceptance claim. Only this note was written; nothing was staged, committed or published.

[tag1]: https://api.github.com/repos/deepseek-ai/deepseek-harness/git/ref/tags/dsh-v0.1.7-alpha.1
[release-api1]: https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/tags/dsh-v0.1.7-alpha.1
[release1]: https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-alpha.1
[master]: https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/master
[tag2]: https://api.github.com/repos/deepseek-ai/deepseek-harness/git/ref/tags/dsh-v0.1.7-alpha.2
[release2]: https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/tags/dsh-v0.1.7-alpha.2
[npm]: https://registry.npmjs.org/@deepseek-ai%2Fdsh
[npm1]: https://registry.npmjs.org/@deepseek-ai%2Fdsh/0.1.7-alpha.1
[presets]: https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/preset/agent-preset-registry/README.md#L46-L58
[declaration]: https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/preset/agent-preset/README.md#L40-L48
[tool-role]: https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/session/session-format-v3-to-v4/src/tool-role.ts#L27-L70
[persistence]: https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/session/session-persistence-jsonl/README.md#L82
[jobs]: https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/jobs/jobs/README.md#L38-L88
[settings]: https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/settings/settings/src/index.ts#L222-L257
[linux]: https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/subprocess/subprocess-local/src/linux-scope.ts#L166-L294
[subprocess]: https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/subprocess/subprocess-local/README.md#L64-L72
[pi-ai]: https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/llm/llm-pi-ai/README.md
[deepseek-adapter]: https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/llm/llm-deepseek/README.md#L113
[patch]: ../patches/dsh-c36a83ff6bb95e3f82cf79f9be7c724270a8aa61.patch
[context]: dsh-upstream-refresh-2026-09-22.md
