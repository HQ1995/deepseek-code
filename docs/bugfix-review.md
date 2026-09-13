# Post-integration bug review — 2026-09-13

Baseline: `f29716a`. This follows [upstream-integration.md](upstream-integration.md)
and checks failure paths not established by the previous missing-file repair test.
No SDK/version change, publication, or daily-profile installation is included.

## Findings and minimal fixes

1. **Present but corrupt native addon blocked automatic startup repair.**
   The cheap preflight accepts a present file. The pinned SDK's flock entrypoint
   loads `system.node` lazily, so both module resolution and import can succeed
   before the first lock attempt rejects with `ERR_DLOPEN_FAILED`. Actual Mac
   installation reproduced this with an invalid Mach-O file. Binding admission
   now tries the available runtime locations, including the lazy-loading phase;
   if none is usable, managed startup downloads and validates a replacement
   runtime and acquires its lock before committing the installation.
2. **A malformed native scope directory prevented healthy-runtime fallback.**
   A file in place of `runtime/node_modules/@deepseek-ai` made native enumeration
   throw `ENOTDIR` before a healthy candidate could be considered. Enumeration
   now treats missing/non-directory scopes as absent, while propagating other
   filesystem failures. Validation still rejects the damaged runtime.
3. **Two acceptance scripts did not actually disable automatic updates.**
   Their `DSCODE_CONFIG` value set `cli.auto_update`, but the pinned config
   overlay explicitly excludes `cli`. A real TUI inspect result identified the
   override as ignored. Both scripts now set `[cli].auto_update = false` in their
   private profile files; no security/config allowlist was broadened.

## Safety re-review

- Binding admission failures may fall back; genuine flock syscall failures and
  action failures propagate unchanged. Busy locks still wait on the same inode.
- No usable binding means no action. There is no unlocked install, permission
  bypass, or best-effort mutation. The descriptor closes only after the awaited
  lock/action settles, preserving crash-release and transaction recovery.
- Healthy startup still uses one actual TUI and one DSH version probe. No new
  subprocess, timer, dependency, or steady-state extra lock attempt was added.
- The final package retains all seven checked host peers as unbundled peers.
  Bridge source and Rust TUI source are unchanged by this follow-up.

## Evidence

Checkpoint: `/tmp/dsc-bugs.9IYJvZ`. Reproductions are retained in
`corrupt-before.log`, `binding-before.log`, `scope-before.log`, and
`lazy-before.log`. `update-after.log` records why an import-only intermediate
fix was insufficient; the final implementation also handles lazy admission.

- Node 22.19.0 and 24.19.0: each **46 files / 846 tests**, no skips
  (`node22-final.log`, `node24-final.log`). The 68 focused ownership/launcher/
  transaction tests pass (`lazy-after.log`), including existing real concurrent
  update and crash-recovery cases.
- Release/script tests: **15 pass, one Linux-only skip** (`scripts-tests-final.log`).
  `scripts/check.sh` and `git diff --check` pass.
- `bugs-final.tgz` matches 106 source/test/config files and 126 shipped
  source/compiled/launcher files. SHA-256:
  `40a2a4971d2107ae70b3100c77f17edbde1cecb1ec2944bb3063a7b3f2d7ef79`.
- Final-package provider-management E2E passes, run **62469**
  (`providers-final.log`), and the private profile retains `auto_update = false`
  after the real interaction.
- Final-package managed update passes (`update-final/update-PASS.json`): both
  missing and corrupt native artifact startup repairs, same-version no-op,
  rejection of corrupt downloads, and preserved user fixture files/config.
- Final-package Mac acceptance passes with script exit **0**, run **43055**:
  `/tmp/dscmac21.tcFu67/contracts-43055/PASS.json` (`macos-final.log`). Covers
  model/provider/preset controls, editing/paste/copy, durable resume and 14
  history-isolation cases, native child/task/question controls, four real
  TypeScript LSP queries, archive CRC/attachments, Python REPL, interrupt and
  owner isolation, runtime doctor and actual child-process reaping.

Re-review confirms the three reproduced defects are fixed and their safety
boundaries remain intact in the verified source and final package. This does
not assert that an arbitrary future failure or every possible repository bug
has been exhausted.

Linux execution, Kitty graphics, and physical Cmd-click are outside this Mac
verification. The previous Rust acceptance is not recounted as a new test run.
