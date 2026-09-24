# Experiments

Opt-in developer tools and checks for capabilities dscode does not ship. No
bundle, preset, launcher, release step or CI job loads anything here; features
that shipped moved their acceptance into `scripts/`.

- `inspector/`: the host-only Developer Inspector bundle. `/doctor` reports it
  when a profile mounts it with `DSCODE_INSPECTOR=1`; see its README.
- `capabilities/inspector-installed.mjs <runtime> <home>`: an installed leader
  with and without the Inspector mounted. The home holds dscode plus the
  packed `inspector/` bundle.
- `capabilities/mcp-smoke.mjs <runtime>`: resource-only MCP servers through
  native and PTC calls, per-session isolation and unmount.
- `capabilities/messages-smoke.mjs <runtime>`: the native DeepSeek adapter's
  Files reuse, image offload, inline fallback and resume, against a loopback
  fixture.

`<runtime>` is an extracted `dscode-runtime-*.tar.gz` for this checkout's pin.
The SDK-level checks resolve the SDK through `scripts/release-sdk.mjs`; link
`inspector/node_modules` to the runtime's `node_modules` before running
`inspector/smoke.mjs`.
