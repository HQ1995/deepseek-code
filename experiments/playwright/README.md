# Playwright opt-in candidate

Private, macOS-only validation candidate for DSH `0.1.7-rc.1` and Playwright MCP `0.0.80`. Not referenced by the dscode bundle, presets, launcher, or release builder. Install only into a dedicated matching candidate profile, not a daily profile. See [the candidate summary](../../docs/dsh-capability-candidate.md).

## Interface and ownership

This single Cordis plugin owns mandatory execution policy and launch-only composition together. It reuses native `SessionResources` for per-Session queues and native `Scope`/`McpClient` for process ownership; it does not mount the upstream Playwright provider as a second owner. The operation module adds active cancellation and timeout cleanup at that same interface. Runtime-provided core SDK packages remain exact peers; there is no second Cordis/tools/agents or approval implementation.

Configuration requires an absolute `executablePath` and a nonempty `navigationOrigins` array of exact HTTP(S) origins, without paths or trailing slashes. `toolCallTimeoutMs` defaults to 30,000. Installation does not activate the plugin: restart the candidate profile with `DSCODE_BROWSER=1`, `DSCODE_BROWSER_EXECUTABLE` and JSON `DSCODE_BROWSER_ORIGINS`; missing configuration fails closed when enabled. There is no attach, user-data-dir, storage-state, headed, or arbitrary-arguments option. Chromium starts headless with isolated browser state. Flags cannot change an already-running leader.

The reviewed 13-operation allowlist admits snapshot, click, drag, hover, select, close, resize, fill, key, type, navigate, screenshot and wait. All other browser tools, including unsafe Node code, evaluate, upload/drop, tabs, and future additions, are hard-denied by `tools.guard()`. The complete upstream 24-tool catalog is still advertised; this is execution denial, not schema filtering. Explicit `filename`, `paths`, and private `_meta` parameters are rejected. Direct navigation checks scheme, credentials and exact origin. Every otherwise permitted browser call requests native approval, preserving existing deny/cancel decisions; missing approval fails closed. Other trusted policy plugins can affect the extensible ask stage but cannot override the hard-deny guard.

## Limits

- Isolated browser state is **not** a host or network sandbox. Clicks, page scripts, redirects, downloads, subresources and browser background traffic are not confined by `navigationOrigins`. Only trusted, controlled pages belong in this experiment; use a disposable workspace with no secrets. This wrapper does not constrain unrelated shell/PTC tools.
- No daily browser attachment or macOS permission grants are needed. Selecting an installed Chrome executable does not select its user profile. Linux/browser sandbox policy has not been validated here.
- Snapshots and screenshots still write `.playwright-mcp` artifacts. Navigation/click results normally link snapshot files; call `browser_snapshot` explicitly for inline accessibility text. Screenshot without `filename` returns an image through DSH attachments only if the model declares image input; otherwise it returns an explicit diagnostic.
- Physical TUI permission-dialog presentation and rendered image pixels, external real-model behavior, child inheritance, and Linux acceptance remain untested for this bundle. Installed ACP approval, screenshot file delivery and persisted-session resume were tested; those are not a physical TUI test.
- **Cancellation gate repaired:** active cancel/timeout closes that Session's MCP scope and browser before the operation settles. The bridge also waits for native cancellation cleanup before terminal prompt completion. Queued cancellation does not close a sibling operation. After active cancellation the affected browser tools are removed; close/reopen the Session to create a fresh browser. No automatic reconnect, replay or cookie recovery occurs. Other live Sessions remain independent. Operations completed before cancellation cannot be rolled back.

## Reproduce the bounded checks

Use this checkout's compiled bridge (`bridge/grok-leader/lib/`) and an extracted source-built runtime of the pinned DSH release; do not use a daily installation. Link this directory's ignored `node_modules` to that runtime's `node_modules` once. The smoke imports SDK implementations only from the supplied runtime and its peer link, boots a real Loader composition, and starts its own loopback fixture. It performs no external model requests, uploads or desktop operations.

```sh
node --test experiments/playwright/policy.test.mjs experiments/playwright/operation.test.mjs
node experiments/playwright/smoke.mjs /absolute/extracted/alpha-runtime '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
```

Use an explicit Node 22.19.0 or 24.19.0 executable for the verified matrix. The smoke prints its private evidence directory, retains controlled-page artifacts, and closes the fixture plus owned resources even on assertion failure. It checks immediate observed-process exit at cancel/timeout completion, late page effects and sibling isolation. Exit 1 means a check failed; exit 2 means the browser cancellation promotion gate failed; exit 0 is not a release acceptance signal. Unit tests do not start a browser.

For installed ACP coverage, pack/install the matching bridge and both experiment plugins into a fresh profile, then run `experiments/capabilities/browser-inspector-installed.mjs <runtime> <profile-home> <chrome-path>`. It starts a private leader and local Messages/Files fixture, explicitly turns both plugins off and on, exercises approval/rejection/screenshots/cancel/resume, and tears down the owned leader. Node 22 requires `--experimental-strip-types` for its imported bridge codec.
