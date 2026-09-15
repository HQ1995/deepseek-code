# Runtime image candidate — 2026-09-15

Read-only primary-source assessment against pinned DSH
`fb2c4b9e698e30edb738bca4cf0618587db7d203` (`0.1.5-rc.2`).
The assessment records source and test-definition evidence; executed checks are
recorded separately below. Neither is provider billing measurement or release
approval. The main checkout's runtime pin, package manifest, daily profile and
Linux host remain unchanged.

## Recommended candidate boundary

Take the estimator pair together: [`a64dc3a`][estimator-commit] introduces the
v41 calculation; its direct child [`f24bc3c`][correction-commit] corrects the
impact claims and adds important aspect-ratio evidence. Independently,
[`d911a7b`][cache-commit] moves regenerable request variants into the shared cache.
It needs [`e4e0e78`][helper-commit], which first adds `dshCachePath`; the intervening
`85df0e76322a17ce06a39d8bfa3d06537f27a9d3` only aligns the helper's documentation.

These are selective patches, not a linear version upgrade. The official
[pin-to-cache comparison][comparison] is divergent. The target branch manifests
still say `0.1.5-rc.1`, while the pin says `0.1.5-rc.2`; copying whole manifests or
the lockfile would therefore import unrelated changes and revert version
metadata. In the relevant packages, pin-to-candidate production diffs are limited
to the estimator, pricing comments, home helper, attachment-store cache routing,
and request-image comments. [Pinned attachment manifest][pinned-manifest],
[candidate attachment manifest][candidate-manifest].

The utility prerequisite is transplantable without dependency churn: the pinned
home helper already imports `join` and implements `resolveDshHome`; the new
function composes those. Attachment-local already declares home-paths as a
peer/dev dependency. Add the helper and its tests, then the cache change's
explicit-home overload; do not add another home resolver or a new dependency.
[Pinned helper][pinned-home], [helper patch][helper-commit],
[cache patch][cache-commit], [pinned manifest][pinned-manifest].

## Estimator: what changes, and what does not

The new implementation uses 14-pixel patches, 3:1 per-axis downsampling, a
544² total-pixel floor, and a 1024-token cap. Its grid is
`rows * (columns + 1) + 2`, without the previous odd-row/parity corrections,
alignment allowance, or width-ratio clamp. Over-budget images use a closed-form
solver, including one-row/one-column cases; projected dimensions are iterated
to a fixed point with the existing ten-pass limit. [Estimator source][estimator].

Freshly opened provider documentation confirms the new floor/cap and that the
legacy vision name routes to current Flash. The currently served calculator
JavaScript instantiates `v41` with these parameters. Search-index snippets still
exposed the old 384 rule during this check, so they were not treated as current
evidence. The calculator remains an estimate: API-returned usage is authoritative.
[Vision guide][vision], [calculator page][calculator],
[served calculator implementation][calculator-js].

The effect depends on geometry, not merely image count:

| Request geometry | Previous estimate | Candidate estimate |
| --- | ---: | ---: |
| 800 × 800 | 349 | 422 |
| 640 × 480 | 209 | 206 |
| 512 × 512 | 201 | 184 |
| 8192 × 1 or 1 × 8192 | — | 1024 |

These are upstream source/test values, not observed invoice amounts.
In particular, the unchanged 640,000-pixel request budget **does not imply a
422-token ceiling**: a thin image can stay under that pixel budget yet reach
1024 tokens. Do not promise every image gets more expensive or every image-heavy
session compacts earlier. [Correction and its vectors][correction-commit].

The pricing service applies this estimator only to retained images on
image-capable routes registered with the DeepSeek adapter. It first applies the
route's request dimensions and oldest-first byte/count offload. Text-only or
uncatalogued routes price deterministic text substitutions; offloaded images
have zero visual tokens plus placeholder text. Handle/path text is priced
separately. The adapter's tighter base64-fallback budget is not reproduced by
this preflight estimate. No model IDs, monetary tariffs, request pixel/byte
budgets, normalization settings, or encoded image contents change in the
estimator pair. [Pricing source][pricing], [estimator commit][estimator-commit].

The existing token meter obtains pricing through the routed adapter, so changed
visual estimates can change pre-request pressure and automatic-compaction
decisions; completed-request usage remains its anchor. Replay fixtures instead
use their configured `imageRequestTokens` and cannot independently prove the
new DeepSeek calculation. [Token-meter owner][meter], [replay owner][replay].

## Cache: ownership and migration behavior

`LocalAttachmentStore` resolves `config.dshHome` once, keeps durable objects
under `<resolved-home>/attachments/v1`, and routes request variants to
`<resolved-home>/cache/attachments/request-images/<prefix>/<variant-hash>`.
`dshCachePath({ dshHome }, ...)` preserves explicit configuration over `DSH_HOME`,
with the existing tilde/relative-path rules; blank environment values still
fall back to the default home. The helper only resolves a path, without creating
it. This is the DSH home cache, **not** macOS `~/Library/Caches` or XDG cache-home
integration. [Store/helper patch][cache-commit], [pinned home rules][pinned-home].

No old cache entries are copied, read as fallback, or deleted. A miss regenerates
from durable attachment bytes. Transform identity, encoding, validation,
in-flight sharing, and cancellation ownership stay unchanged. In-budget
byte-identical passthrough images still need not create a cache file; transformed
variants use the existing private-directory/temporary-file/rename write path.
Thus upgrading can temporarily leave both old and new cached variants on disk;
this patch is not a cache garbage collector. [Store patch][cache-commit],
[request-image implementation][request-image].

The added test creates an image and generic file, removes the new cache between
requests, opens a new store, and checks unchanged durable contents plus equal
regenerated request bytes/identity. Existing tests cover malformed cached
variants, separate route budgets, shared transformation with independent waiter
cancellation, cancellation of the sole waiter, and replacement of an aborted
operation. Those are test definitions inspected here, not test-run results.
Concurrent deletion during an active cache write is not established by the new
between-requests deletion test. [Cache tests][cache-tests],
[home precedence tests][home-tests].

## Exact validation gates before adopting a runtime

1. Apply only the identified source/test changes to an isolated copy of the pin;
   verify the full diff and unchanged manifests/lockfile. Build home-paths and
   attachment-local together: mixing a new store with the old helper is invalid.
2. On Node 22 and 24, run `llm-deepseek/tests/image-tokens.spec.ts` and
   `request-pricing.spec.ts`; retain square, low-budget, extreme thin, repeated
   projection, unknown/text-only, access-text, byte-offload and count-offload
   cases. Run token-meter route-pricing and compaction regression suites too;
   replay-only acceptance does not exercise the DeepSeek estimator.
3. Run `home-paths/tests/home-paths.spec.ts` and the full attachment-local suite
   with real Sharp on macOS arm64. Explicitly test a configured home different
   from `DSH_HOME`, unchanged durable image/file data after cache clearing,
   reopen/regeneration, old-cache non-use, warm reuse and cancellation/retry.
4. Build and install the candidate runtime/plugin in a temporary profile; verify
   the actual loaded helper export, native dependency loading, image send/reopen,
   and cache paths. Repeat bridge/package regression; source tests alone do not
   establish installed compatibility. Do not change the daily profile to test it.
5. Keep provider billing and live image-quality/compaction claims unverified
   until separately measured with actual API usage. Preserve the 640,000-pixel
   budget in this candidate; increasing it changes request contents and requires
   a separate quality, latency, byte-budget and snapshot assessment.

These gates are recommendations derived from the ownership/dependency boundaries
above, not claims that those runtime checks have already passed.

## Executed isolated validation

Candidate `079a0d76a62ea45e40450d2c080d780a2f98f198` selectively applies the four
named commits over the existing pin. Production source and tests in the three
affected packages match their respective upstream targets byte-for-byte; all
package manifests and the lockfile remain unchanged. Only bilingual README and
pairing conflicts needed resolution. The source checkout is clean at
`/tmp/dscode-image-follow.MKEh5o/source`; `candidate/images` retains the commit.
The original local Git bundle is
`.git/integration-backups/dsh-images-079a0d76.bundle`, SHA-256
`0d147b1fbd852914d9162a743cb1d796920baf32455406635bae5ec986cc440b`.
Its earlier in-repository verification did not prove standalone restoration.
The [full combined candidate backup](runtime-linux-candidate.md#executed-local-checks)
now preserves this image commit and all its ancestry, with independent clones
and full object checks on macOS and Linux. The original bundle is retained but
superseded as the recovery authority. Neither backup is a tracked release asset
or remote publication.
This is a local candidate, not an official upstream revision to publish as a pin.

macOS arm64 evidence:

- Node 22.19.0 and 24.19.0 each passed 128 estimator/pricing/attachment/home tests
  (12 files), with one Windows-only object-publication test skipped. Each also
  passed 328 token-meter and compaction tests (16 files). These owner tests
  establish route/offload and compaction behavior, not live provider billing.
- `pnpm run build:official` passed. The first invocation lacked a `pnpm` shim
  for nested scripts; retry used the existing release builder's local Corepack
  PATH setup. No source change addressed that environment failure.
- `test:docs` passed all 16 checks and `doc-sync` all 34. The candidate commit's
  staged lint, pairing, whitespace and vendor guard passed.
- Ten image-related official recorded-session snapshots passed against built
  libraries (`DSH_EXAMPLE_MODE=lib`, `DSH_SNAPSHOT=replay`, `-t image`). The other
  128 tests were unselected, not additional passes. An initial concurrent run
  raced doc-sync's library rebuild and briefly lacked `apps/cli/lib/bin.js`;
  the same snapshot selection passed once doc-sync finished. Do not run
  doc-sync's rebuilding form beside artifact-consuming tests in this checkout.
- `image-artifacts.mjs` uses the old pinned packaged runtime to write a durable
  image, generic file and legacy request variant, then opens the same data with
  the candidate's built exports. Sixteen concurrent reads produce the same
  variant ID and bytes in the new cache. Moving only the fixture's new cache
  aside and reopening regenerates identical bytes; durable image/file hashes
  and the old cache are unchanged. Explicit `dshHome` wins over a different
  `DSH_HOME`, whose directory remains absent. This is a built-library migration
  check; the separately executed installed-runtime checks follow below.
- The built exports also reproduce the geometry table above and retained-image
  offload prices `[0, 1024]` for an older square followed by a thin image. The
  baseline thin-image values observed here are 113 (8192×1) and 381 (1×8192).
  Transform/normalization budgets were not enlarged.

Logs and the small retained fixtures are under
`/tmp/dscode-image-follow.MKEh5o/`: `targeted22.log`, `targeted24.log`,
`context22.log`, `context24.log`, `build-r2.log`, `docs.log`, `doc-sync.log`,
`snapshots-r2.log`, `artifact-baseline.json`, and `artifact-candidate.json`.
The probe script is `image-artifacts.mjs`; all its data belongs to this temporary
directory, not the user's attachment store. No old user cache was deleted.

## Packaged-runtime and product validation

The standard release builder used a temporary clone of product `d119625` whose
only tracked change selects the candidate source commit. It rebuilt the official
DSH packages with that source fingerprint and produced these macOS arm64 assets
under `/tmp/dscode-image-follow.MKEh5o/packages/`:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `dscode-plugin.tgz` | 1,447,586 | `555c1b8ecc6c4a836dddc180419544afff561ad30be51630a5f3b0c203fe27ed` |
| `dscode-runtime-macos-aarch64.tar.gz` | 288,553,253 | `249a4a805fe889366a68d37ea1950313186349dd9cb23df11504da430b7e41b8` |

The extracted runtime descriptor binds `079a0d76` to `darwin/arm64`, while
preserving `0.1.5-rc.2` version metadata. The existing consumer validator also
confirmed the complete extracted dependency tree matches the recorded
source-built consumer. The old-to-new migration probe then passed again through
the packaged runtime's public exports, including real Sharp transforms,
configured-home precedence, sixteen concurrent requests, cache regeneration,
unchanged durable bytes and legacy cache, and the native pricing vectors above.
Evidence: `package-build.log`, `installed-baseline.json`,
`installed-candidate.json` and `installed-fixture/` in the same temporary root.

The bridge's candidate-SDK TypeScript build passed. Full Node 22.19.0 and
24.19.0 suites each passed all 47 files / 923 tests, including the compiled
public type entry and CLI contracts. The first test attempt had not built
`bridge/grok-leader/lib` in the temporary clone: 922 tests passed and the public
type-entry gate failed on the missing artifact. Building that clone and rerunning
both full suites resolved it without a source or assertion change. Final logs
are `bridge22-final.log` and `bridge24-final.log`.

Full installed TUI/DSH/bridge acceptance passed on Node 24.19.0, run 41234, with
no scenario-only flags: `e2e.log` and `e2e/contracts-41234/PASS.json`.
`packaging.json` in that contracts directory records the installed plugin entry
and runtime dependency paths. All 135 installed source/compiled/bin/preset files
match the temporary product clone used for the bridge suites, and the installed
plugin's DSH metadata exactly identifies the candidate. The run covers image
submission and text-only rejection, draft image stash/restore, resume/fork,
goals, workflows, reminders,
native history, permissions, presets/LSP, archives, real terminal/Python and
owner-isolated interruption. Interactive rewind also restores the draft without
resending and preserves the shortened transcript across a fresh leader.
The unchanged compiled TUI has SHA-256
`38b0eae22994cf53636c91f069e57f2a823eac6379897bcd7908d136b704042c`.

The product run uses a controlled gateway, not live DeepSeek billing. Native
estimator evidence comes from the separate adapter/pricing tests and packaged
export probe. Nonempty compaction, graphical Kitty and physical Cmd-click remain
outside this run. Linux/systemd cancellation remains an independent pending
runtime gate. A read-only recheck found `swoop`'s user manager running, but its
evaluation-reservation notice requires workload approval; no tests or builds
were launched there. The root filesystem also had only about 3.4 GB available.

The research skill's dependency-closure check kept the estimator correction and
cache helper with their owners, without a wholesale upstream or manifest sync.
Final `scripts/check.sh` and `git diff --check` passed in the main checkout.
Adoption still needs a distributable exact-source strategy: this locally owned
backport cannot silently be substituted for an official source revision. The
main pin, daily profile, package version and remote remain unchanged.

[estimator-commit]: https://github.com/deepseek-ai/deepseek-harness/commit/a64dc3a690cf31a1bc87bd23dec15ab988301820
[correction-commit]: https://github.com/deepseek-ai/deepseek-harness/commit/f24bc3c83228f35ba65968beaa04ec0ca322d39c
[cache-commit]: https://github.com/deepseek-ai/deepseek-harness/commit/d911a7b422bcec506f8687a102215ced97950c2a
[helper-commit]: https://github.com/deepseek-ai/deepseek-harness/commit/e4e0e78dd2d95aed7f5828fb5cd6dc71bd43dac7
[comparison]: https://github.com/deepseek-ai/deepseek-harness/compare/fb2c4b9e698e30edb738bca4cf0618587db7d203...d911a7b422bcec506f8687a102215ced97950c2a
[pinned-manifest]: https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/attachment/attachment-local/package.json
[candidate-manifest]: https://github.com/deepseek-ai/deepseek-harness/blob/d911a7b422bcec506f8687a102215ced97950c2a/packages/attachment/attachment-local/package.json
[pinned-home]: https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/util/home-paths/src/index.ts
[estimator]: https://github.com/deepseek-ai/deepseek-harness/blob/f24bc3c83228f35ba65968beaa04ec0ca322d39c/packages/llm/llm-deepseek/src/image-tokens.ts
[pricing]: https://github.com/deepseek-ai/deepseek-harness/blob/f24bc3c83228f35ba65968beaa04ec0ca322d39c/packages/llm/llm-deepseek/src/request-pricing.ts
[vision]: https://api-docs.deepseek.com/guides/vision/
[calculator]: https://api-docs.deepseek.com/quick_start/token_usage/
[calculator-js]: https://api-docs.deepseek.com/assets/js/1e0da2c4.9d2e6179.js
[meter]: https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/llm/token-meter/src/index.ts
[replay]: https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/test-support/llm-replay/src/index.ts
[request-image]: https://github.com/deepseek-ai/deepseek-harness/blob/d911a7b422bcec506f8687a102215ced97950c2a/packages/attachment/attachment-local/src/request-image.ts
[cache-tests]: https://github.com/deepseek-ai/deepseek-harness/blob/d911a7b422bcec506f8687a102215ced97950c2a/packages/attachment/attachment-local/tests/request-image.spec.ts
[home-tests]: https://github.com/deepseek-ai/deepseek-harness/blob/d911a7b422bcec506f8687a102215ced97950c2a/packages/util/home-paths/tests/home-paths.spec.ts
