# Submodule-migration feasibility: grok-leader bridge vs published @deepseek-ai/dsh

This probe checks whether the bridge at `packages/bridge/grok-leader/src/index.ts` can run out-of-tree against the published `@deepseek-ai/dsh` packages at `0.1.0-rc.6`, because the harness will be pinned as a git submodule and the bridge installed with `dsh plugin --profile deepseek-leader add`.
The bridge package `@deepseek-ai/dsh-grok-leader` is not published (`npm view` returns E404), so it installs from the submodule path while its `@deepseek-ai/dsh` dependencies resolve from npm.
The published `0.1.0-rc.6` set was extracted from `npm pack <pkg>@0.1.0-rc.6`; the file:line citations below refer to those tarballs.

## Verdict summary

The bridge's API surface is fully covered by the published `0.1.0-rc.6` set: every imported symbol exists at each package's root export and every structural read matches the published `.d.ts`.
The GO is conditional on three blockers: pin the `next`/`0.1.0-rc.6` tag (the `latest` tag is incoherent), fix the bridge `package.json` (runtime imports are devDependencies), and upstream the EMFILE watcher fix (absent from published).

## Bridge dependency surface

The bridge imports eight `@deepseek-ai/*` packages directly (`packages/bridge/grok-leader/src/index.ts:19-26`):

| Package | Imported symbols | Line |
| --- | --- | --- |
| `@deepseek-ai/cordis` | `type Context` | 19 |
| `@deepseek-ai/schemastery` | `Schema` (default) | 20 |
| `@deepseek-ai/dsh-agent` | `installModelSelection`, `Agent`, `AgentOptions`, `ModelSelectionRef` | 21 |
| `@deepseek-ai/dsh-llm` | `ReasoningEffortId`, `createUserMessage`, `errorChain` | 22 |
| `@deepseek-ai/dsh-session` | `SessionId`, `SessionEvent`, `TurnEndReason` | 23 |
| `@deepseek-ai/dsh-session-persistence` | `type {}` (module augmentation) | 24 |
| `@deepseek-ai/dsh-user-approval` | `type {}` (module augmentation) | 25 |
| `@deepseek-ai/dsh-user-questions` | `UserQuestionError`, `AskUserQuestionAnswer`, `AskUserQuestionRequest` | 26 |

It also reaches services through `ctx` without importing their packages: `ctx.agents` (`dsh-agent`, line 200), `ctx.get('llm')` (`dsh-llm`, 201), `ctx.get('sessionPersistence')` (`dsh-session-persistence`, 206), `ctx.get('agentDefaultModel')` (`dsh-agent-default-model`, 207), `ctx.get('agentPresets')` (`dsh-agent-presets`, 209), `ctx.get('userQuestions')` (`dsh-user-questions`, 403), and `ctx.get('sessions')` (`dsh-session` store flush, 697, 846).

## Per-package verdicts

| Package | Published | Verdict | Evidence |
| --- | --- | --- | --- |
| `@deepseek-ai/cordis` | 4.0.1 (`latest`) | covered | `Context` type and `ctx.get/on/effect/logger/agents` are the core runtime the bridge already runs on in-tree |
| `@deepseek-ai/schemastery` | 3.18.1 (`latest`) | covered | `Schema.object` / `Schema.string().default()` are stable schemastery API |
| `@deepseek-ai/dsh-agent` | 0.1.0-rc.6 (`latest`) | covered | root re-exports `./runtime-types.ts` and `./model-selection.ts` (`lib/types/index.d.ts:11,15`); `ModelSelectionRef {current, assembled}` matches the bridge literal (`model-selection.d.ts:17`); `CreateAgentOptions {sessionId, meta{cwd,agentPreset}, agentOptions, setup}` and `ResumeAgentOptions {resumeSessionId, agentOptions, setup}` match `agents.create/resume` (`index.d.ts:65,123`); `AgentRegistry.get(id)` returns `Agent` or `undefined` (`index.d.ts:349`) |
| `@deepseek-ai/dsh-llm` | 0.1.0-rc.6 (`next`) | covered, version-skew | root re-exports `./brand.ts`, `./error.ts`, `./message.ts` (`index.d.ts:15,17,21`); `createUserMessage({content, source:{kind:'user'}})` matches `NewUserMessage` (`message.d.ts:171`); `ReasoningEffortId` (`brand.d.ts:47`), `errorChain` (`error.d.ts:66`); `LlmRuntime.listProviders/listModels` match (`index.d.ts:234,284`) |
| `@deepseek-ai/dsh-session` | 0.1.0-rc.6 (`next`) | covered, version-skew | root re-exports `./types.ts` (`index.d.ts:15`); `SessionId` (`types.d.ts:12`), `SessionEvent` envelope `{type,seq,time,data}` (`types.d.ts:420`), `TurnEndReason` kinds include `completed/max-tokens/aborted/interrupted/blocked/error` (`types.d.ts:135-169`); `session/event` signature `(session, event)` (`index.d.ts:66`); store `flush(session)` (`index.d.ts:385`) |
| `@deepseek-ai/dsh-session-persistence` | 0.1.0-rc.6 (`next`) | covered, version-skew | `SessionInspection {meta: SessionHeader, events}` (`index.d.ts:21`); `SessionHeader.agentPreset?`; `load(id)` (`index.d.ts:132`) and `list(signal?)` (`index.d.ts:176`) |
| `@deepseek-ai/dsh-user-approval` | 0.1.0-rc.6 (`next`) | covered, version-skew | `approval/request` event `(req, next)` (`index.d.ts:24`); `ApprovalRequest {agent, toolName, callId?}` (`index.d.ts:104`); `ApprovalOutcome` includes `allowed-once/rejected/cancelled/unavailable`, so every bridge return is legal (`types.d.ts:23`) |
| `@deepseek-ai/dsh-user-questions` | 0.1.0-rc.6 (`next`) | covered, version-skew | `AskUserQuestionRequest {questions, agent?, signal?}` (`index.d.ts:20`); `UserQuestionError(message, code)` ctor matches `new UserQuestionError(msg,'NO_CLIENT')` (`index.d.ts:33`); `registerProvider({ask})` (`index.d.ts:46`) |
| `@deepseek-ai/dsh-agent-default-model` | 0.1.0-rc.6 (`latest`) | covered | `currentSelection(): ModelSelection` (`index.d.ts:48`) and `saveSelection(next: ModelSelection)` (`index.d.ts:55`); `ModelSelection {provider, model, reasoningEffort?}` matches the bridge's structural read |
| `@deepseek-ai/dsh-agent-presets` | 0.1.0-rc.6 (`next`) | covered, version-skew | `list()` (`index.d.ts:104`), `resolve(id?)` (`index.d.ts:115`), `mount(agentCtx, id?)` (`index.d.ts:159`); `AgentPreset {id, trust: 'system' or 'user', name?, description?}` (`preset.d.ts:18,22`) |
| `@deepseek-ai/dsh-grok-leader` | not published | not-published | the bridge itself is E404 on npm; it must install from the submodule path |

No package is marked shape-risk: every field name, option key, event name, and outcome literal the bridge uses exists in the published `0.1.0-rc.6` `.d.ts`.

## Version-skew: latest vs next

Most `@deepseek-ai/dsh-*` packages resolve `latest` to stale `0.0.1-rc.*`: the bridge's `dsh-session`, `dsh-llm`, `dsh-user-approval`, `dsh-agent-presets`, and `dsh-session-persistence` are `0.0.1-rc.1` (and `dsh-user-questions` is `0.0.1-rc.3`), while their `next` tag is `0.1.0-rc.6`.
Only `dsh-agent` and `dsh-agent-default-model` have `latest = 0.1.0-rc.6`.
A `latest`-tagged install is incoherent: `dsh-agent@0.1.0-rc.6` peer-requires `dsh-llm ^0.1.0-rc.6` and `dsh-session ^0.1.0-rc.6`, which `0.0.1-rc.1` does not satisfy, so the bridge must pin the `next` tag (or explicit `0.1.0-rc.6`) across every `@deepseek-ai/dsh-*` dependency.

## Bridge package.json gaps

`packages/bridge/grok-leader/package.json` declares `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-user-questions` only under `devDependencies`, but both are imported at runtime (`index.ts:22,26`).
An out-of-tree install does not install devDependencies, so those imports would fail to resolve; both must move to `dependencies` or `peerDependencies`.
`@deepseek-ai/dsh-agent-default-model` is undeclared in the bridge manifest and only reached via `ctx.get('agentDefaultModel')`, so it is a composition dependency (the profile must provide the service) rather than a direct install dependency.
All dependency specifiers currently use `workspace:^`, which only resolves inside the pnpm workspace and must be rewritten to concrete semver ranges before the bridge can install outside the monorepo.

## Bridge-side tool/result field bug

`sessionEventToUpdates` reads the tool-result block's `callId` (`index.ts:1238-1242`), but the type is `toolCallId` in both the tree (`packages/llm/llm/src/types.ts:90`) and the published `dsh-llm@0.1.0-rc.6` (`lib/types/types.d.ts:69-73`), so the emitted `tool_call_update.toolCallId` is always `"undefined"`.
This is a bridge bug, not a published-package gap; it fires identically in-tree and out-of-tree.

## EMFILE watcher fix

The tree carries a watch-capacity fix across four parts: `isWatchCapacityError` (`packages/boot/app-boot/src/index.ts:235`), the EMFILE/ENOSPC swallow inside `installFailLoud` (`index.ts:654`, branch at `:664`), the EMFILE degrade in the `watchUserPatches` catch (`index.ts:248`, `:281`), and `installUncaughtWatchCapacityGuard` (`index.ts:613`) plus the CLI's guard around `watchUserPatches` (`apps/cli/src/profile-boot.ts:25,224,276,291,296`).

The published `@deepseek-ai/dsh-app-boot@0.1.0-rc.6` does not carry the fix: its `lib/index.js` contains no `EMFILE`/`ENOSPC`/`isWatchCapacityError`/`installUncaughtWatchCapacityGuard` occurrences, its `installFailLoud` (`lib/index.js:1042-1062`) has no watch-capacity swallow, and its `.d.ts` exports only `watchUserPatches` and `installFailLoud` (`lib/types/index.d.ts:72,197`) without the two guard helpers.
The published `@deepseek-ai/dsh@0.1.0-rc.6` CLI calls `installFailLoud` but never `installUncaughtWatchCapacityGuard`.

Verdict: not present.
The fix is an upstream-PR item for `@deepseek-ai/dsh-app-boot` and `@deepseek-ai/dsh`; pinning the harness as a submodule without upstreaming it drops the EMFILE degradation (a saturated inotify budget would crash the surface instead of degrading to no-hot-reload).

## GO/NO-GO

GO — the bridge can run out-of-tree against the published `0.1.0-rc.6` packages once the three blockers are resolved: pin `next`/`0.1.0-rc.6`, promote `dsh-llm` and `dsh-user-questions` out of devDependencies (and rewrite `workspace:^`), and upstream the EMFILE watcher fix.
The `tool/result` field bug should also be fixed in the bridge before the migration, but it is not a blocker for the out-of-tree question.
