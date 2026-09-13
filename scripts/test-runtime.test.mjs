import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const save = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
};
function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dscode-runtime-test-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, `owner's "checkout" with spaces`);
  const scratch = join(base, `scratch's space`);
  const release = join(base, 'release');
  const runtime = join(base, 'runtime');
  const dsh = join(runtime, 'bin/dsh');
  const plugin = join(release, 'dscode-plugin.tgz');
  const manifest = { name: '@test/dscode', version: '0.0.14-alpha.12', dscode: { release: '0.0.14-alpha.12' },
    dsh: { sourceCommit: 'a'.repeat(40), testedVersion: '0.1.5-rc.2' } };
  const descriptor = { schema: 1, dshVersion: manifest.dsh.testedVersion, sourceCommit: manifest.dsh.sourceCommit,
    platform: process.platform, arch: process.arch };
  save(join(root, 'VERSION'), manifest.version + '\n');
  save(join(root, 'bridge/grok-leader/package.json'), manifest);
  mkdirSync(join(root, 'scripts'));
  cpSync(new URL('./test-runtime.mjs', import.meta.url), join(root, 'scripts/test-runtime.mjs'));
  mkdirSync(release);
  mkdirSync(scratch);
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  save(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), { version: descriptor.dshVersion, bin: { dsh: 'bin.js' } });
  save(join(runtime, 'node_modules/@deepseek-ai/dsh/bin.js'), '#!/usr/bin/env node\n');
  chmodSync(join(runtime, 'node_modules/@deepseek-ai/dsh/bin.js'), 0o755);
  symlinkSync('../node_modules/@deepseek-ai/dsh/bin.js', dsh);
  const packPlugin = (pkg = manifest) => {
    save(join(base, 'packed/package/package.json'), pkg);
    execFileSync('tar', ['-czf', plugin, '-C', join(base, 'packed'), 'package']);
  };
  const packRuntime = (record = descriptor) => {
    save(join(runtime, 'dscode-runtime.json'), record);
    const host = { 'linux/x64': 'linux-x86_64', 'darwin/arm64': 'macos-aarch64' }[`${process.platform}/${process.arch}`];
    execFileSync('tar', ['-czf', join(release, `dscode-runtime-${host}.tar.gz`), '-C', runtime, '.']);
  };
  packPlugin();
  packRuntime();
  save(join(root, 'scripts/build-release-payload.mjs'), `
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
console.log('fixture build log');
writeFileSync(process.env.BUILD_ARGS_RECORD, JSON.stringify(args));
if (process.env.FAIL_FIXTURE_BUILD) process.exit(7);
const out = args[args.indexOf('--out') + 1];
mkdirSync(out, { recursive: true });
cpSync(process.env.FIXTURE_PAYLOAD, out, { recursive: true });
`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSCODE_') && key !== 'NODE_OPTIONS'));
  Object.assign(env, { FIXTURE_PAYLOAD: release, BUILD_ARGS_RECORD: join(base, 'build-args.json') });
  const invoke = overrides => spawnSync(process.execPath, [join(root, 'scripts/test-runtime.mjs'), root, scratch, join(base, 'build.log')],
    { cwd: root, encoding: 'utf8', env: { ...env, ...overrides } });
  const paths = result => {
    assert.equal(result.status, 0, result.stderr);
    const [bin, tgz, tail] = result.stdout.split('\0');
    assert.equal(tail, '');
    assert.ok(existsSync(bin));
    assert.ok(existsSync(tgz));
    return [bin, tgz];
  };
  return { base, root, scratch, release, runtime, dsh, plugin, manifest, descriptor, env, invoke, paths, packPlugin, packRuntime };
}

test('explicit runtime and plugin accept literal paths and need no build', t => {
  const f = fixture(t);
  const result = f.paths(f.invoke({ DSCODE_E2E_DSH_BIN: relative(f.root, f.dsh), DSCODE_E2E_PLUGIN_TGZ: relative(f.root, f.plugin) }));
  assert.deepEqual(result, [f.dsh, f.plugin]);
  assert.equal(existsSync(f.env.BUILD_ARGS_RECORD), false);
});

test('existing release uses a fresh extraction and accepts a link to its pinned CLI', t => {
  const f = fixture(t);
  const first = f.paths(f.invoke({ DSCODE_RELEASE_DIR: f.release }));
  const second = f.paths(f.invoke({ DSCODE_RELEASE_DIR: f.release }));
  assert.notEqual(first[0], second[0]);
  symlinkSync(first[0], join(f.base, 'dsh link'));
  f.paths(f.invoke({ DSCODE_E2E_DSH_BIN: join(f.base, 'dsh link'), DSCODE_E2E_PLUGIN_TGZ: f.plugin }));
  assert.equal(existsSync(f.env.BUILD_ARGS_RECORD), false);
});

for (const selection of ['both', 'plugin-only', 'runtime-only']) test(`builds only the missing ${selection} payload`, t => {
  const f = fixture(t);
  const overrides = { DSCODE_SOURCE_DIR: '../source dir', DSCODE_RUNTIME_CONSUMER: '../consumer dir' };
  if (selection === 'plugin-only') overrides.DSCODE_E2E_DSH_BIN = f.dsh;
  if (selection === 'runtime-only') overrides.DSCODE_E2E_PLUGIN_TGZ = f.plugin;
  f.paths(f.invoke(overrides));
  const args = JSON.parse(readFileSync(f.env.BUILD_ARGS_RECORD, 'utf8'));
  assert.deepEqual(args, ['--out', join(f.scratch, 'release-assets'), '--version', f.manifest.version,
    '--source', join(f.base, 'source dir'), '--consumer', join(f.base, 'consumer dir'), ...(selection === 'both' ? [] : [`--${selection}`])]);
  assert.match(readFileSync(join(f.base, 'build.log'), 'utf8'), /fixture build log/);
});

test('explicit incomplete release fails without silently building or using an ambient CLI', t => {
  const f = fixture(t);
  rmSync(f.plugin);
  const result = f.invoke({ DSCODE_RELEASE_DIR: f.release });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(f.env.BUILD_ARGS_RECORD), false);
});

test('failed build reports its log, never publishes partial paths', t => {
  const f = fixture(t);
  const result = f.invoke({ FAIL_FIXTURE_BUILD: '1' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /could not build.*build.log/);
  assert.match(readFileSync(join(f.base, 'build.log'), 'utf8'), /fixture build log/);
});

for (const field of ['name', 'version', 'release', 'testedVersion', 'sourceCommit']) test(`rejects wrong plugin ${field}`, t => {
  const f = fixture(t);
  const pkg = structuredClone(f.manifest);
  if (field === 'release') pkg.dscode.release = 'wrong';
  else if (field in pkg.dsh) pkg.dsh[field] = 'wrong';
  else pkg[field] = 'wrong';
  f.packPlugin(pkg);
  const result = f.invoke({ DSCODE_E2E_DSH_BIN: f.dsh, DSCODE_E2E_PLUGIN_TGZ: f.plugin });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin release provenance mismatch/);
});

for (const field of ['schema', 'dshVersion', 'sourceCommit', 'platform', 'arch']) test(`rejects wrong runtime ${field}`, t => {
  const f = fixture(t);
  f.packRuntime({ ...f.descriptor, [field]: 'wrong' });
  const result = f.invoke({ DSCODE_RELEASE_DIR: f.release });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /runtime provenance/);
});

test('descriptor alone cannot bless a different CLI package or executable', t => {
  const f = fixture(t);
  const options = { DSCODE_E2E_DSH_BIN: f.dsh, DSCODE_E2E_PLUGIN_TGZ: f.plugin };
  save(join(f.runtime, 'node_modules/@deepseek-ai/dsh/package.json'), { version: 'old', bin: { dsh: 'bin.js' } });
  assert.match(f.invoke(options).stderr, /runtime provenance/);
  save(join(f.runtime, 'node_modules/@deepseek-ai/dsh/package.json'), { version: f.descriptor.dshVersion, bin: { dsh: 'bin.js' } });
  save(join(f.runtime, 'other'), '#!/bin/sh\n');
  chmodSync(join(f.runtime, 'other'), 0o755);
  options.DSCODE_E2E_DSH_BIN = join(f.runtime, 'other');
  assert.match(f.invoke(options).stderr, /runtime provenance/);
  rmSync(join(f.runtime, 'dscode-runtime.json'));
  assert.match(f.invoke(options).stderr, /no source runtime descriptor/);
});

test('checkout requires coherent version and full source pin', t => {
  const f = fixture(t);
  save(join(f.root, 'VERSION'), 'wrong');
  assert.match(f.invoke({ DSCODE_RELEASE_DIR: f.release }).stderr, /checkout VERSION/);
  save(join(f.root, 'VERSION'), f.manifest.version);
  save(join(f.root, 'bridge/grok-leader/package.json'), { ...f.manifest, dsh: {} });
  assert.match(f.invoke({ DSCODE_RELEASE_DIR: f.release }).stderr, /source-pinned/);
});

test('shell interface preserves both paths and propagates preparation failure', t => {
  const f = fixture(t);
  const script = fileURLToPath(new URL('./test-environment.sh', import.meta.url));
  const run = plugin => spawnSync('bash', ['-c', `set -eu
source "$1"
dscode_prepare_test_runtime "$2" "$3" "$4" "$5"
printf '%s\\0%s\\0' "$DSH_BIN" "$BRIDGE_ARCHIVE"
`, 'fixture', script, f.root, f.scratch, process.execPath, join(f.base, 'build.log')], {
    encoding: 'utf8', env: { ...f.env, DSCODE_E2E_DSH_BIN: f.dsh, DSCODE_E2E_PLUGIN_TGZ: plugin },
  });
  assert.deepEqual(f.paths(run(f.plugin)), [f.dsh, f.plugin]);
  const failed = run(join(f.base, 'missing.tgz'));
  assert.notEqual(failed.status, 0);
  assert.equal(failed.stdout, '');
});

test('tmux shell command keeps literal argv, including quotes and substitutions', () => {
  const script = fileURLToPath(new URL('./test-environment.sh', import.meta.url));
  const args = ['', `owner's "folder"`, '$(exit 91)', '`exit 92`', 'line\nbreak', 'back\\slash', '中文'];
  const encoded = execFileSync('bash', ['-c', 'source "$1"; shift; dscode_shell_command "$@"', 'fixture', script,
    process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args], { encoding: 'utf8' });
  for (const shell of ['sh', 'bash', ...(process.platform === 'darwin' ? ['zsh'] : [])]) {
    assert.deepEqual(JSON.parse(execFileSync(shell, ['-c', encoded], { encoding: 'utf8' })), args);
  }
});
