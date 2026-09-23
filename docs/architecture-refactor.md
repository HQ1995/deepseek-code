# Architecture refactor

Status: complete in the shared source after the user confirmed that the
performance task had finished. Node 22/24 builds and full suites, managed-update
and fresh full Mac acceptance pass. The authoritative requirement review
is [architecture-review.md](architecture-review.md).
Baseline: the verified macOS/performance worktree on
`34332fae64857c176e5055562a8d39efcc4808f3` (373 bridge tests, Mac E2E 35828).
Those behavior fixes were preserved in the integrated commits.

## Objective and invariants

Turn the bridge's 6,033-line entrypoint and shared closure into modules with
explicit ownership, bounded interfaces and independently testable behavior.
The entrypoint must become composition, not a renamed or relocated monolith.
The three product layers remain: the selectively vendored Rust TUI, the DSH
bridge/plugin, and the managed installation/release tooling. Preserve their
existing wire protocol, capabilities, install layout and release provenance.

The refactor must preserve session ownership checks; prompt admission/FIFO/
steering and settlement order; durable flush-before-dispose; late async-result
guards; stream/replay dedup; reverse-request cancellation; provider credential
handling; native-runtime repair; and the preceding performance improvements.
No credentials move to the UI, no provider is removed, and no vendored runtime
fork or published release is implied.

## Work plan

1. **Model/provider ownership:** move catalog caches, discovery, provider
   mutations and credential-reference handling behind a module. Inject the
   actual optional DSH capabilities lazily; do not pass the whole bridge state.
2. **Transport lifecycle:** separate Unix socket/framing, registration,
   ACP request/reply and reverse-request lifetimes from feature handlers.
3. **Session and prompt lifecycle:** give accepted sessions, admission/queue
   state and teardown one owner; isolate persistence/preset/model integration.
4. **Feature projections and controls:** group coherent native features and
   their subscriptions/snapshots instead of placing every new feature in
   `apply()`. Preserve workflow child visibility and event ordering.
5. **Profile/package operations:** isolate bundle audit/install and package
   discovery from interactive session dispatch; review launcher/install seams
   for ownership and cycles without gratuitous rewrites of already deep modules.
6. **Composition and verification:** remove superseded wiring, document the
   resulting dependency direction, add a dependency gate, and re-review the
   architecture and product behavior.

Each step is part of the full objective; completing one module is not completion
of the goal. Dependency categories follow the codebase-design skill: pure
state/projection logic is tested directly, owned local transports through real
fixtures, and external DSH/provider capabilities through narrow test adapters.

## Completion evidence required

- Entry composition contains no provider mutation, socket protocol engine,
  prompt queue engine or feature-specific projection implementation.
- Stateful modules own their caches/subscriptions/pending work and disposal;
  no shared untyped dependency bag, reverse import into the entrypoint, or
  circular runtime import graph replaces the current closure coupling.
- Behavioral tests exercise the new module interfaces. Keep protocol/product
  integration tests; replace obsolete helper-only tests when fully superseded.
- TypeScript builds and bridge suites pass on Node 22.19 and 24.19 against the
  pinned SDK. Managed update E2E and full Mac TUI/runtime E2E pass with a freshly
  packaged bridge. Script and dependency gates pass. Linux execution is only
  claimed if actually run, not inferred from a green Mac test.
- Final review records invariant evidence, remaining platform coverage gaps,
  source-versus-installed state and any unresolved architectural work.

## Review history

The six requirements above remain the acceptance contract. Completed module
ownership and dependency checks are recorded in [architecture-review.md](architecture-review.md);
remote integration and later repairs are in [upstream-integration.md](upstream-integration.md)
and [bugfix-review.md](bugfix-review.md). The 2026-09-22 module-depth pass (model
catalog split, socket-spec split and exhaustive gate) is recorded in the same review.

Superseded candidate and intermediate checkpoint notes were removed from this
working document; their full history remains in Git at `16cadde:docs/architecture-refactor.md`.
Do not reapply historical patches. Temporary artifact paths in prior reviews
are historical evidence locations, not guaranteed persistent build inputs.
