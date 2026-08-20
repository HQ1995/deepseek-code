# Harness updates

dscode does not vendor DeepSeek Harness source. End users run the
official npm `@deepseek-ai/dsh` package, pinned to the version recorded in
`bridge/grok-leader/package.json` under `dsh.testedVersion` (currently
`0.1.0-rc.8`). The launcher owns its fallback runtime inside the dscode
profile, so upgrading or uninstalling dscode does not mutate a shared global
npm installation.

## Upgrading dsh

A dsh upgrade is a deliberate release step:

1. Bump `dsh.testedVersion` in `bridge/grok-leader/package.json`.
2. Update `dsh.supportedRange` if the compatibility window changes.
3. Run the bridge tests and the dscode e2e suites.
4. Update launcher/installer if the dsh CLI invocation changes.
5. Cut a new dscode release.

The bridge builds and tests against the official npm `@deepseek-ai/dsh-*`
packages declared as devDependencies. No DeepSeek Harness checkout is required.
