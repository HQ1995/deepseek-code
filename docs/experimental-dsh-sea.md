# Experimental: single-file dsh exe (pkg --sea)

Status: abandoned in favor of installing the official npm dsh + our bridge.
Kept as a reference recipe; the binary itself is regenerable via
scripts/build-dsh-sea.sh.

## Session notes (raw)


## 2026-08-16 session (resume after capacity error)
- Worktree verified: worker/dsh-sea @ a2d933aa, clean, submodule @ 9cf50430 checked out.
- Live credential store has DEEPSEEK_API_KEY (usable for real E2E turn; never printed).
- Plan: frozen install in submodule (node1) -> harness build:lib -> closure manifest + bridge build -> pnpm deploy -> SEA pack -> E2E -> repo wiring -> commits.
- PoC: symlinkSync into /snapshot VFS succeeds but kernel resolves it as dangling -> healProfilesModuleFallback-style symlink farm CANNOT work inside SEA. Decided: packaged entry boots leader composition directly with bareModuleBaseUrl=file:///snapshot/.../node_modules (public app-boot API, same pattern as sdk jsonrpc packaged-bin).
- Deploy mechanics test: pnpm deploy --filter REJECTS a temp manifest (needs workspace member + lockfile entry). Chosen route: throwaway git worktree of the submodule at the pinned commit, manifest + bridge copied in as members, exact frozen lockfile, submodule stays pristine.
- sea-entry.js written (bridge/grok-leader): boots leader composition via public boot(bareModuleBaseUrl) seam, bare names resolve inside the snapshot; profile fallback symlinks are impossible per PoC.

## Build/E2E status (mid-session)
- Closure generator fixed: BFS over workspace graph seeded from base+bridge+preset rows AND bridge peers (patch layers flatten insert lists; bridge member added to globs). 136 deps; verify-runtime-closure passes (135 workspace packages).
- deploy needs CI=true (lefthook postinstall skips); worktree must build:lib (deploy packs files lists); node-pty guard added (already present).
- pkg assets must include **/*.so and **/*.so.* — sharp's bundled libvips (18MB) is dlopened at boot; without it attachment-local fails ERR_DLOPEN_FAILED.
- dist/dsh boots: --version/--help OK in fresh HOME; leader socket UP with fresh HOME.
- EMFILE fix: isWatchCapacityError x5 in embedded app-boot lib + x5 in exe binary; installUncaughtWatchCapacityGuard x2 in exe binary.
- Next: real deepseek-v4-flash turn via probe (key from live credential store into env, never printed).
- E2E PASS: fresh-HOME --version (0.1.0-rc.5) + --help OK; leader socket UP with fresh HOME; REAL deepseek-v4-flash turn through the bridge: register->registered, initialize, session/new, session/prompt -> stopReason=end_turn, assistant text contains SEA_TURN_OK, PASS=1. Transcript: /tmp/dsh-sea-e2e/turn-transcript.json (30 frames). Probe: /tmp/dsh-sea-e2e/probe.mjs.
- Probe gotcha: leader stdin EOF exits the exe (SDK-bin semantics); E2E holds stdin open with tail -f /dev/null under setsid.

## DONE (final)
- Commits on worker/dsh-sea (never pushed): feff50a8 entry+data, 8f7637fd build script, 0b9b69c4 release wiring.
- Final exe from the script: dist/dsh 227M; --version 0.1.0-rc.5 in fresh HOME; isWatchCapacityError x5 + installUncaughtWatchCapacityGuard x2 in binary; socket boots with fresh HOME.
- Real model turn PASS transcript: /tmp/dsh-sea-e2e/turn-transcript.json.
