# Inspector for dscode development

Host-only integration for the matching DSH 0.1.7-rc.2 candidate. It provides
the real Cordis tree, Host Console/Sources/debugger and optional fetch inspection.
It does not start the DSH Web app, attach a browser Client or add model tools.

Build with `npm pack --ignore-scripts`, install the tarball into a dedicated
candidate dscode profile with `dsh plugin --profile dscode add <tarball>`.
Installing does **not** activate it. Restart that profile with:

```sh
DSCODE_INSPECTOR=1 dscode
```

Use `/doctor` for the DevTools URL; the same URL appears in the leader startup
log. Paste it into Chrome. Exit the debug profile and restart without the flag
to disable it. Environment flags cannot change an already running leader.

The endpoint binds only `127.0.0.1` on a random OS-assigned port. **CDP grants
full code execution and has no token.** Other local processes may access it;
do not forward the port or enable it in an untrusted shared environment. This
is a developer tool, not a sandbox or a read-only diagnostics endpoint.

Fetch capture is off by default; it does not wrap global fetch. For an isolated
reproduction using fixture credentials only, explicitly add
`DSCODE_INSPECTOR_UNSAFE_CAPTURE_FETCH=1`. Raw headers/bodies are not redacted;
request/response prefixes are bounded to 256 KiB/1 MiB, retained bodies to 8 MiB
and the request journal to 64 requests. These are retention limits, not a total
process-memory bound. Stopping the profile releases the Worker/sockets and
restores the prior fetch function. No debug data is persisted by this adapter.

The adapter uses the pinned package's public Host `apply` and index-injection
hook to discover its random endpoint. The adapter neither serves nor caches
the unused Web Client bootstrap. Recheck this contract on SDK upgrades; no private exports,
fake Web server or second debugger Worker are used.

Acceptance: `node smoke.mjs <extracted-runtime>` (Node 22.19+ or 24). Resolve
this directory's SDK imports through that same runtime closure; use an ignored
`node_modules` symlink for the standalone source test. The test evaluates only
`6 * 7` in its own process and captures only its own loopback fixture.
