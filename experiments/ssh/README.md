# SSH execution candidate

The adapter owns one native SSH connection and mounts all four remote execution
providers together, including digest-pinned Node PTC. The host retains model
transport, attachments and session persistence. Both endpoints must be POSIX.
Use a dedicated DSH_HOME and an existing, verified OpenSSH alias; no credentials
are copied into the profile and host-key checking is not relaxed.

`DSCODE_SSH_CONFIG` is a JSON object with absolute remote `node`, `helper`,
`workspace`, `bootstrapPath`, the corresponding lowercase SHA-256 `helperHash`
and `bootstrapHash`, and `host`. Install code and dependencies outside the
workspace and writable temporary roots. This adapter does not provision them.
The remote helper, its dependencies and the PTC bootstrap must come from the
same DSH release as the host: the 0.1.7 helper imports new subprocess modules
and adds an RPC, so a 0.1.6 remote closure must be redeployed and both digests
recomputed. The sandbox-policy workspace must equal the remote workspace. Never substitute
the Mac's cwd, PATH, Node executable or PTC bootstrap.

The initial composition is SDK/headless only. Its patch disables the local-path
TUI leader deliberately: remote paths are not host paths, including file links,
diff opening and image paths. Do not remove that gate until pager integration
passes end-to-end path tests. Disconnect invalidates the connection, does not
retry commands, and cannot confirm whether a remote effect completed.

For a runnable headless profile, use the matching alpha runtime and a fresh
`DSH_HOME` (not the local dscode profile):

```sh
dsh --profile ssh --from-default-profile headless --dump-config
dsh plugin --profile ssh add /absolute/path/to/dscode-experimental-ssh.tgz
dsh --profile ssh --patch /absolute/path/to/native-messages/cordis.patch.yml "your task"
```

Build that tarball with `npm pack --ignore-scripts` in this directory. Export
`DSCODE_SSH_CONFIG` before boot and configure the native route as described in
`../native-messages/README.md`. The official headless runner resolves cwd through
the remote filesystem. Sessions and attachments remain local to this dedicated
profile home. Use `--session-id <id>` to resume there; never reuse a local-workspace
session. The tool catalog is the shipped headless catalog, not the dscode preset.

Run `../capabilities/ssh-smoke.mjs <extracted-runtime> <config.json>` with Node
22.19+ or 24. This creates a unique `acceptance-<UUID>.txt` in the configured
workspace and removes it on success; a failed run may retain its file for inspection.
It exercises file observations, real sandboxing, PTC, subprocess collection,
PTY input/resize, cancellation and abrupt loss of only the test's SSH master.
`ssh-integrity-smoke.mjs` separately rejects incorrect helper/bootstrap digests.
