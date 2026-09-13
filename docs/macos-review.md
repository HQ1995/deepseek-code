# macOS review and minimal fixes (2026-09-12)

Follow-up performance work and newer verification are tracked in
[performance.md](performance.md).

Base: `34332fae64857c176e5055562a8d39efcc4808f3`, dscode
`0.0.14-alpha.12`, pinned DSH `0.1.5-rc.2`. Host: Apple Silicon,
macOS 26.5.2, system Bash 3.2, tmux 3.7b. These are checkout changes,
not a newly published or installed release.

## Decisions

- **Native integrity:** Darwin previously skipped the declared native files,
  so removing `system.node` passed validation but broke the installation lock.
  Installer and payload builder now share a dependency-free validator for
  platform metadata, regular files and required access modes. A complete legacy
  helper cannot mask missing/empty current-family metadata. The real update
  E2E removes only the native helper, leaving the version-reporting CLIs intact.
  `doctor` explicitly distinguishes file checks from a native load/PTY smoke.
- **Workflow navigation:** captured ANSI frames proved both Tabs selected the
  intended member; Enter could not open a child that the bridge had never
  announced. Native workflow membership can precede publication in the session
  corpus, and scoped child lifecycle events need not reach the host listener.
  Refreshing just on membership or agent-start was insufficient in real tests.
  The existing 500ms host timer now reconciles only undiscovered workflow
  members, stops when found, and expires 30 seconds after the latest membership
  event. Re-review exposed a second race: the workflow row appeared about 400ms
  before its child view, so an immediate Enter was lost. Pending member updates
  now follow `subagent_spawned`; a regression asserts that wire order. Workflow
  transitions also refresh terminal child state. No Rust input or
  keyboard-protocol changes were necessary.
- **Tool error visibility:** real Mac TUI logs revealed that ACP rejected
  `status: error` and dropped the whole tool result, including after resume.
  Both normal tools and PTC sub-calls now use the accepted `failed` status.
  Tests cover both mappings, and the goal E2E requires the real TUI decoder to
  accept the rejected-tool frame as `Failed`, not only return it to the model.
  Goal control cards are intentionally hidden by the existing pager; this does
  not claim they now render as ordinary tool cards.
- **Terminal cost:** the pinned Darwin inspector cannot positively detect a
  REPL waiting for stdin. Keep the 3-second silence guard and Linux defaults;
  set Darwin polling to 200ms through the supported profile configuration.
  Do not patch compiled upstream JS, infer completion from prompt-looking text,
  or switch the Bash protocol to zsh just because zsh is the login shell.
- **CI:** run the real product suite on macOS as well as Linux, with artifacts
  per OS. Test the minimum Node 22.19.0, plus bridge compatibility on Node 24.
  macOS PTY cleanup now checks the actual process, not a nonexistent `/proc`
  entry. tmux cannot synthesize the physical Cmd key read through CoreGraphics;
  Mac table-link acceptance uses real keyboard navigation and records that
  input mode. Linux retains Ctrl-click coverage. The existing `macos-latest`
  label currently selects ARM64 standard runners, matching the shipped Mac
  target ([GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), checked 2026-09-12).
- **Diagnostics:** include Node version, executable and architecture, OS/kernel,
  and the shipped Bash version. The x64-on-Mac message distinguishes native
  ARM64 Node on Apple Silicon from Intel Macs requiring a source build.

## Performance evidence and remaining work

One-host measurements using the same real `BashTerminalBackend` and
`LocalSubprocessRuntime`, Node 24.19.0 and system Bash:

| Operation | 50ms polling | 200ms polling |
| --- | --- | --- |
| Shell printf | 101ms; 4 ps calls | 252ms; 4 ps calls |
| Start Python REPL | 3075ms; 82 ps calls; 1027ms in ps | 3204ms; 30 ps calls; 386ms in ps |
| REPL `print(6 * 7)` | 3041ms; 82 ps calls; 993ms in ps | 3199ms; 30 ps calls; 378ms in ps |

This reduces synchronous process-query cost by about 62%, not total application
CPU by 62%. It trades roughly 150ms of shell response time for lower polling
cost. REPL readiness latency remains about 3 seconds. Exact Darwin stdin
detection and shared process snapshots belong in a tested upstream change or
an explicitly versioned backport, not a blind shorter silence timeout.

The published Mac runtime is approximately 272MiB compressed / 875MiB installed;
the TUI adds about 164MiB. No package-size reduction is claimed. The substantial
Codex/Claude native provider distributions implement shipped capabilities;
deleting them is not a safe cleanup. Separating the build/test SDK from the
production runtime requires dependency-closure and cold-install verification
(the current local test runner deliberately consumes that SDK). Provider
splitting and release-size budgets remain a separate packaging change.

## Verification boundaries

Final local verification:

- TypeScript compilation against the pinned SDK: passed.
- Bridge suites: **17 files / 364 tests passed** on each of Node **22.19.0**
  and **24.19.0**, including the packaged CLI product tests (none skipped).
- `scripts/check.sh`: passed using system Bash 3.2.
- Node script suites: **12 passed / 1 Linux-only test skipped**.
- `scripts/e2e-update.mjs`: passed with the final local test package, including
  native-only damage repair, legacy overlay repair, checksum rejection,
  same-version no-op and preservation of user files.
- Full `scripts/e2e-tui-bridge.sh`: **passed** on Mac / Node 24 with the final
  test package, run **91685**. Evidence:
  `/tmp/dscmac-review2/contracts-91685/PASS.json` and
  `/tmp/dscfix.bSQBob/review2-e2e.log`. This includes workflow child navigation
  twice plus restart, accepted failed-tool frames, real TypeScript LSP,
  Python REPL, interrupt/reuse, ownership isolation, archive validation,
  runtime doctor and actual PTY PID reaping. Kitty-specific image tests were
  not configured; the Mac table-link cases use keyboard input, not Cmd-click.
- `git diff --check`, changed script syntax checks and CI YAML parsing: passed.

The test logs and managed-update report remain in `/tmp/dscfix.bSQBob` for
inspection; these are temporary local evidence, not published release assets.
Model responses are local fixtures, not paid-provider certification. The
edited GitHub CI is not remotely verified until it runs on a pushed commit.

Compilation and tests use the pinned SDK in an isolated workspace, not the
checkout's stale `node_modules`. The product E2E uses a locally packaged patched
bridge plus the existing official Mac runtime and TUI from the matching source
revision. Rust and the full native source-runtime producer were not rebuilt;
no TUI/native source was changed, and no newly published release is claimed.

Physical Cmd-click, Terminal.app/iTerm2/Ghostty, Chinese IME, clipboard image
paste, Finder drag/drop, Intel/Rosetta, older macOS versions, actual sleep/wake
and network switching still require dedicated validation. Existing ignored
clipboard tests write the global clipboard and should run only in an isolated
test user/runner. Do not count keyboard navigation as physical Cmd-click
coverage, file presence as addon loading, or a successful `--version` as PTY
functionality.
