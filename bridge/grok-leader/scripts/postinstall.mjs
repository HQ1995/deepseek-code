#!/usr/bin/env node
// Best-effort postinstall: warm the TUI binary cache and heal the
// ~/.local/bin/dscode launcher link. Everything here is optional — pnpm
// blocks dependency build scripts by default, so the launcher
// (bin/dscode.mjs) must and does self-materialize on first run. This script
// only saves that first-run download when it is allowed to run. It never
// fails the install.
const skip = (reason) => {
  console.error(`dscode postinstall: ${reason}`)
  process.exit(0)
}

if (process.env.DSCODE_SKIP_DOWNLOAD === '1') skip('DSCODE_SKIP_DOWNLOAD=1, skipping binary warm-up')
if (process.platform !== 'linux' || process.arch !== 'x64') skip(`no prebuilt TUI for ${process.platform}/${process.arch}`)

try {
  const { ensureBinary, healLauncherLink } = await import('../bin/dscode.mjs')
  healLauncherLink()
  await ensureBinary()
  console.error('dscode postinstall: TUI binary ready')
} catch (error) {
  skip(`binary warm-up failed (${error instanceof Error ? error.message : String(error)}); the dscode launcher will retry on first run`)
}
