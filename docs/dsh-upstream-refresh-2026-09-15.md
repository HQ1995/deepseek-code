# DSH upstream refresh — 2026-09-15

## Release facts

Checked against official GitHub and npm APIs at approximately
`2026-09-15T13:19Z`. DSH has a newly published **prerelease**, `0.1.6-alpha.1`.
The [GitHub release][release] was published at `2026-09-15T04:57:57Z`;
its actual tag, `dsh-v0.1.6-alpha.1`, resolves directly to commit
`0a15e36e7f82b6ed45af6fa9759f29b40dcd965d`, whose commit time is
`2026-09-15T02:42:33Z`. These are separate timestamps.
[Release API][release-api], [tag API][tag-api], [commit API][commit-api].

The existing compatibility pin remains `0.1.5-rc.2` /
`fb2c4b9e698e30edb738bca4cf0618587db7d203` in
[the bridge manifest](../bridge/grok-leader/package.json); that SHA matches the
[official `dsh-v0.1.5-rc.2` tag][old-tag]. The observed official `master` is
`0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`, committed at
`2026-09-15T03:16:06Z`, and is a different source revision from the release.
[Master commit API][master-api]. Source manifest versions alone do not establish
that a package was published.

The [npm registry record for `@deepseek-ai/dsh`][npm-dsh] reports:

| npm dist-tag | Published package version | Package publication time (UTC) |
| --- | --- | --- |
| `alpha` | `0.1.6-alpha.1` | `2026-09-15T03:23:13.750Z` |
| `next` | `0.1.5-rc.2` | `2026-09-10T14:57:10.790Z` |
| `latest` | `0.1.5-rc.1` | `2026-09-10T03:12:53.293Z` |

Thus the newest publication is available on `alpha`; neither `latest` nor
`next` currently selects it. All 17 public entries returned by the
[GitHub releases API][releases-api] are marked `prerelease: true`; this is not a
new stable release.

The 32 distinct `@deepseek-ai/dsh-*` dependencies declared across the bridge's
peer, development, and ordinary dependencies were each checked through
`https://registry.npmjs.org/<encoded-package-name>`. Every queried package has
an actual `0.1.6-alpha.1` version record, with `alpha=0.1.6-alpha.1` and
`next=0.1.5-rc.2`; individual SDK `latest` tags can still name older versions.
Selected exact publication times, including the runtime's local subprocess
backend, are:

| Package | `0.1.6-alpha.1` publication time (UTC) |
| --- | --- |
| [`@deepseek-ai/dsh-agent`][npm-agent] | `2026-09-15T03:10:49.150Z` |
| [`@deepseek-ai/dsh-subprocess-local`][npm-subprocess-local] | `2026-09-15T03:16:19.407Z` |
| [`@deepseek-ai/dsh-terminal-bash`][npm-terminal-bash] | `2026-09-15T03:21:56.073Z` |

The shared support packages remain at the bridge's existing versions:
[`@deepseek-ai/cordis`][npm-cordis] `4.0.2`
(`2026-08-30T13:13:14.302Z`),
[`@deepseek-ai/schemastery`][npm-schemastery] `3.18.2`
(`2026-08-30T13:14:16.636Z`), and
[`@deepseek-ai/node-addon-system`][npm-node-addon-system] `0.1.2`
(`2026-09-08T14:34:51.575Z`), all selected by their respective `latest` tags.

This check establishes published version/channel metadata and official tag
identity. It does not establish byte equivalence between npm tarballs and the
Git tree, or runtime compatibility with dscode. No package was installed and
no runtime/SDK pin was changed.

## Effect on the validated candidate and next upgrade

The official tag contains all eight upstream Linux cancellation commits listed
in [the tested candidate](runtime-linux-candidate.md#refreshed-scope), plus the
image estimator/follow-up and cache/helper commits selected for
[the image candidate](runtime-image-candidate.md). This was checked against the
full local Git graph with `git merge-base --is-ancestor`; it does not mean the
whole release tree equals local backport `5922e6a2`. The tag has 800 commits
reachable beyond pinned `fb2c4b9e` (including merges), not just those selected
fixes. [Official pin-to-release comparison][pin-compare].

The release provides a remotely fetchable official source revision, making a
new official-version candidate practical without publishing our local backport.
However, the existing macOS/swoop passes validate `5922e6a2`, not this alpha.
Static inspection found concrete adaptation work before changing the pin:

- [The profile](../bridge/grok-leader/cordis.patch.yml) still mounts
  `@deepseek-ai/dsh-code-runtime-worker-thread`. The release removes that
  package and provides `ptc-runtime-node`; this also changes execution from
  worker threads to confined child processes, so a string replacement alone
  does not establish PTC compatibility. [PTC migration][ptc-migration].
- The history, LSP and terminal presets still mount
  `@deepseek-ai/dsh-workflow-worker-thread`. The release replaces it with
  `workflow-ptc`, with sandboxed orchestration and different dependencies.
  [Workflow migration][workflow-migration].
- [Native status subscriptions](../bridge/grok-leader/src/native-session-status.ts)
  still listen for `agent/session-start`; the release uses awaited serial
  `agent/created`. Review initialization and publication timing as well as the
  event name. [Agent lifecycle migration][agent-migration].

The release also changes native DeepSeek defaults to Messages/Files and adds
experimental session-event reporting. Follow-up source inspection found no
official-hostname allowlist: native-provider requests can include the extension
when routed through a custom gateway as well. dscode's current fresh profile
disables `llm-deepseek`; the isolated adaptation additionally disables
`session-log-deepseek` explicitly. This is separate from telemetry settings.
See the [source-backed adaptation review](runtime-alpha16-adaptation.md)
and [official release notes][release].

`master` is unchanged from the source inspected for the previous candidate and
is five reachable commits beyond the release (four changes plus their merge).
These include optional native dependency loading and first-use Typert schemas;
they are **not in this published alpha**. The native-loading commit touches
Sharp, node-pty and Koffi, and also handles terminal-session construction
failure cleanup. It is relevant to a later startup-performance investigation,
but no dscode speedup or compatibility was measured here.
[Release-to-master comparison][master-compare], [native loading][native-lazy],
[Typert schemas][typert-lazy].

Recommended next step: an isolated candidate pinned to the official release,
with the PTC/workflow/lifecycle adaptations, then Node 22/24 bridge checks and
release-shaped macOS/Linux installed-product acceptance. Keep the proven
backport and its full bundle until that candidate passes. No implementation,
new build/test run, installation, push or release was performed by this refresh.
Subsequent isolated implementation and validation are tracked in the
[adaptation review](runtime-alpha16-adaptation.md); they do not change the main
product pin described above.

[release]: https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.1
[release-api]: https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/tags/dsh-v0.1.6-alpha.1
[releases-api]: https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=100
[tag-api]: https://api.github.com/repos/deepseek-ai/deepseek-harness/git/ref/tags/dsh-v0.1.6-alpha.1
[commit-api]: https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/0a15e36e7f82b6ed45af6fa9759f29b40dcd965d
[old-tag]: https://api.github.com/repos/deepseek-ai/deepseek-harness/git/ref/tags/dsh-v0.1.5-rc.2
[master-api]: https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720
[npm-dsh]: https://registry.npmjs.org/@deepseek-ai%2Fdsh
[npm-agent]: https://registry.npmjs.org/@deepseek-ai%2Fdsh-agent
[npm-subprocess-local]: https://registry.npmjs.org/@deepseek-ai%2Fdsh-subprocess-local
[npm-terminal-bash]: https://registry.npmjs.org/@deepseek-ai%2Fdsh-terminal-bash
[npm-cordis]: https://registry.npmjs.org/@deepseek-ai%2Fcordis
[npm-schemastery]: https://registry.npmjs.org/@deepseek-ai%2Fschemastery
[npm-node-addon-system]: https://registry.npmjs.org/@deepseek-ai%2Fnode-addon-system
[pin-compare]: https://github.com/deepseek-ai/deepseek-harness/compare/fb2c4b9e698e30edb738bca4cf0618587db7d203...0a15e36e7f82b6ed45af6fa9759f29b40dcd965d
[ptc-migration]: https://github.com/deepseek-ai/deepseek-harness/commit/7c9bb5914cedec80e46197a8c894037fcfd12faf
[workflow-migration]: https://github.com/deepseek-ai/deepseek-harness/commit/35af8698c24c1b7654cd5c83dcbec224e50f2337
[agent-migration]: https://github.com/deepseek-ai/deepseek-harness/commit/9b7a8ccc9fabc2e87386acf7f8b0741baf978022
[master-compare]: https://github.com/deepseek-ai/deepseek-harness/compare/0a15e36e7f82b6ed45af6fa9759f29b40dcd965d...0d1f50007f9bca3f52b06e1c3074fa14d5fb0720
[native-lazy]: https://github.com/deepseek-ai/deepseek-harness/commit/232ab768a94d5b18c683f60285907f5891a190f5
[typert-lazy]: https://github.com/deepseek-ai/deepseek-harness/commit/e459e3263733075bd806d9ba6dd92bbc4bf3983f
