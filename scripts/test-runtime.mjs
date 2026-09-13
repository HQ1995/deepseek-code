#!/usr/bin/env node
// Product acceptance consumes pinned release artifacts, never an ambient dsh.
import { accessSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const json = path => JSON.parse(readFileSync(path, 'utf8'));

function prepare(root, scratch, buildLog) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('pinned dsh requires Node >=22.19.0');
  const manifest = json(join(root, 'bridge/grok-leader/package.json'));
  const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
  if (manifest.version !== version || !/^[a-f0-9]{40}$/.test(manifest.dsh?.sourceCommit || '')) {
    throw new Error('checkout VERSION and source-pinned bridge manifest are required');
  }
  const platform = { 'linux/x64': 'linux-x86_64', 'darwin/arm64': 'macos-aarch64' }[`${process.platform}/${process.arch}`];
  if (!platform) throw new Error(`unsupported runtime platform: ${process.platform}/${process.arch}`);
  const env = process.env;
  const release = resolve(env.DSCODE_RELEASE_DIR || join(scratch, 'release-assets'));
  let dsh = env.DSCODE_E2E_DSH_BIN ? resolve(env.DSCODE_E2E_DSH_BIN) : undefined;
  const plugin = resolve(env.DSCODE_E2E_PLUGIN_TGZ || join(release, 'dscode-plugin.tgz'));
  if ((!dsh || !env.DSCODE_E2E_PLUGIN_TGZ) && !env.DSCODE_RELEASE_DIR) {
    const args = [join(root, 'scripts/build-release-payload.mjs'), '--out', release, '--version', version];
    if (env.DSCODE_SOURCE_DIR) args.push('--source', resolve(env.DSCODE_SOURCE_DIR));
    if (env.DSCODE_RUNTIME_CONSUMER) args.push('--consumer', resolve(env.DSCODE_RUNTIME_CONSUMER));
    if (dsh) args.push('--plugin-only');
    if (env.DSCODE_E2E_PLUGIN_TGZ) args.push('--runtime-only');
    const log = openSync(buildLog, 'w');
    try {
      execFileSync(process.execPath, args, { stdio: ['ignore', log, log] });
    } catch (cause) {
      throw new Error(`could not build the source release payload; see ${buildLog}`, { cause });
    } finally { closeSync(log); }
  }
  const packed = JSON.parse(execFileSync('tar', ['-xOf', plugin, 'package/package.json'], { encoding: 'utf8', maxBuffer: 1024 * 1024 }));
  if (packed.name !== manifest.name || packed.version !== version || packed.dscode?.release !== version
    || packed.dsh?.testedVersion !== manifest.dsh.testedVersion || packed.dsh?.sourceCommit !== manifest.dsh.sourceCommit) {
    throw new Error('plugin release provenance mismatch; rebuild the payload for this checkout');
  }
  if (!dsh) {
    // A fresh directory prevents stale files in an earlier extraction from passing validation.
    mkdirSync(scratch, { recursive: true });
    const runtime = mkdtempSync(join(scratch, 'runtime-'));
    execFileSync('tar', ['--no-same-owner', '-xzf', join(release, `dscode-runtime-${platform}.tar.gz`), '-C', runtime]);
    dsh = join(runtime, 'bin/dsh');
  }
  accessSync(dsh, constants.X_OK);
  // Accept bin/dsh, node_modules/.bin/dsh or a caller's link to the same runtime.
  let runtime = dirname(realpathSync(dsh));
  while (!existsSync(join(runtime, 'dscode-runtime.json'))) {
    if (dirname(runtime) === runtime) throw new Error('dsh has no source runtime descriptor');
    runtime = dirname(runtime);
  }
  const record = json(join(runtime, 'dscode-runtime.json'));
  const cli = json(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'));
  if (record.schema !== 1 || record.sourceCommit !== manifest.dsh.sourceCommit || record.dshVersion !== manifest.dsh.testedVersion
    || record.platform !== process.platform || record.arch !== process.arch || cli.version !== manifest.dsh.testedVersion
    || realpathSync(dsh) !== realpathSync(join(runtime, 'node_modules/@deepseek-ai/dsh', cli.bin.dsh))) {
    throw new Error('runtime provenance, executable or host mismatch; rebuild the payload for this checkout');
  }
  return [dsh, plugin];
}

try {
  const [root, scratch, buildLog] = process.argv.slice(2);
  if (!root || !scratch || !buildLog) throw new Error('usage: test-runtime.mjs <checkout> <scratch> <build-log>');
  process.stdout.write(prepare(resolve(root), resolve(scratch), resolve(buildLog)).join('\0') + '\0');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
