import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { copyClosure, recordConsumerProvenance, validateConsumer, releaseAssets, releaseChannel, sourceBuildEnvironment } from './build-release-payload.mjs';
import { assertReleaseRun, releasedManifest, verifyReleaseAssets } from './verify-release-assets.mjs';

test('consumer reuse requires the exact source, installed bytes, and copied runtime tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'dscode-consumer-provenance-'));
  const manifest = { dsh: { testedVersion: '0.1.5-rc.2', sourceCommit: 'a'.repeat(40) } };
  const modules = join(root, 'node_modules');
  try {
    mkdirSync(join(modules, '@deepseek-ai/dsh'), { recursive: true });
    const pkg = join(modules, '@deepseek-ai/dsh/package.json');
    writeFileSync(pkg, JSON.stringify({ version: manifest.dsh.testedVersion }));
    assert.throws(() => validateConsumer(root, manifest), /no build provenance/);
    recordConsumerProvenance(root, manifest);
    validateConsumer(root, manifest);
    assert.throws(() => validateConsumer(root, { dsh: { ...manifest.dsh, sourceCommit: 'b'.repeat(40) } }), /mismatch/);
    cpSync(modules, join(root, 'copied'), { recursive: true });
    validateConsumer(root, manifest, join(root, 'copied'));
    writeFileSync(join(root, 'copied/@deepseek-ai/dsh/new-code.js'), 'stale cached SDK');
    assert.throws(() => validateConsumer(root, manifest, join(root, 'copied')), /mismatch/);
    writeFileSync(pkg, JSON.stringify({ version: manifest.dsh.testedVersion, stale: true }));
    assert.throws(() => validateConsumer(root, manifest), /mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('terminal acceptance rejects old tmux before creating a test profile', () => {
  const work = mkdtempSync(join(tmpdir(), 'dscode-old-tmux-'));
  try {
    const bin = join(work, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'tmux'), '#!/bin/sh\n[ "$1" != -V ] || echo "tmux 3.2a"\n', { mode: 0o755 });
    const output = join(work, 'output');
    const result = spawnSync('bash', [fileURLToPath(new URL('./e2e-tui-bridge.sh', import.meta.url))], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, DSCODE_E2E_NODE_BIN: process.execPath,
        DSCODE_TUI_BIN: process.execPath, DSCODE_E2E_OUT_DIR: output },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /requires tmux >=3\.4/);
    assert.equal(existsSync(output), false);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('Linux Rust test launcher restores signals ignored by its parent', { skip: process.platform !== 'linux' }, () => {
  const work = mkdtempSync(join(tmpdir(), 'dscode-rust-signals-'));
  try {
    mkdirSync(join(work, 'scripts'));
    mkdirSync(join(work, 'bin'));
    mkdirSync(join(work, 'third_party/grok-build'), { recursive: true });
    cpSync(fileURLToPath(new URL('./check-rust.sh', import.meta.url)), join(work, 'scripts/check-rust.sh'));
    writeFileSync(join(work, 'bin/cargo'), `#!/bin/sh
for sig in TERM INT; do
  /bin/sh -c 'kill -s "$1" "$$"; exit 99' sh "$sig"
  result=$?
  case "$sig:$result" in TERM:143|INT:130) ;; *) exit 91 ;; esac
done
`, { mode: 0o755 });
    const result = spawnSync('env', ['--ignore-signal=INT,TERM', 'bash', join(work, 'scripts/check-rust.sh')], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PATH: `${join(work, 'bin')}${delimiter}${process.env.PATH}`, DSCODE_RUST_TESTS_ISOLATED: '' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS Rust product contracts/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('local bridge runner preserves absent, linked, and installed dependencies on success and failure', () => {
  const work = mkdtempSync(join(tmpdir(), 'dscode-dev-runner-'));
  const bridge = join(work, 'bridge/grok-leader');
  const modules = join(bridge, 'node_modules');
  const payload = join(work, 'payload');
  const runtime = join(work, 'runtime');
  const manifest = { version: '1.2.3', dsh: { testedVersion: '0.1.5-alpha.1', sourceCommit: 'a'.repeat(40) } };
  try {
    for (const path of ['scripts', 'tmp', 'existing', 'payload/package', 'runtime/bin',
      'runtime/node_modules/typescript/bin', 'runtime/node_modules/vitest',
      ...['src', 'bin', 'tests', 'presets'].map(name => `bridge/grok-leader/${name}`)]) mkdirSync(join(work, path), { recursive: true });
    for (const name of ['dev-bridge-tests.sh', 'platform.sh']) cpSync(fileURLToPath(new URL(name, import.meta.url)), join(work, 'scripts', name));
    writeFileSync(join(work, 'VERSION'), manifest.version);
    writeFileSync(join(bridge, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(bridge, 'tsconfig.json'), '{}');
    writeFileSync(join(bridge, 'cordis.patch.yml'), '[]');
    writeFileSync(join(payload, 'package/package.json'), JSON.stringify(manifest));
    execFileSync('tar', ['-czf', join(payload, 'dscode-plugin.tgz'), '-C', payload, 'package']);
    writeFileSync(join(runtime, 'bin/dsh'), 'fixture');
    writeFileSync(join(runtime, 'dscode-runtime.json'), JSON.stringify({ schema: 1, dshVersion: manifest.dsh.testedVersion, sourceCommit: manifest.dsh.sourceCommit, platform: process.platform, arch: process.arch }));
    writeFileSync(join(runtime, 'node_modules/typescript/bin/tsc'), 'process.exit(Number(process.env.DSCODE_TEST_EXIT));');
    writeFileSync(join(runtime, 'node_modules/vitest/vitest.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync(process.env.DSCODE_TEST_RAN, 'ran');");
    const platform = process.platform === 'darwin' ? 'macos-aarch64' : 'linux-x86_64';
    execFileSync('tar', ['-czf', join(payload, `dscode-runtime-${platform}.tar.gz`), '-C', runtime, '.']);
    const sentinel = join(work, 'existing/sentinel');
    writeFileSync(sentinel, 'keep');
    for (const kind of ['absent', 'symlink', 'directory']) {
      if (kind === 'symlink') symlinkSync('../../existing', modules);
      if (kind === 'directory') cpSync(join(work, 'existing'), modules, { recursive: true });
      const before = lstatSync(modules, { throwIfNoEntry: false })?.ino;
      for (const code of [0, 17]) {
        const ran = join(work, 'ran');
        rmSync(ran, { force: true });
        const result = spawnSync('bash', [join(work, 'scripts/dev-bridge-tests.sh')], {
          cwd: work, encoding: 'utf8', timeout: 30000,
          env: { ...process.env, DSCODE_E2E_NODE_BIN: process.execPath, DSCODE_E2E_RELEASE_DIR: 'payload', DSCODE_DEV_TMPDIR: join(work, 'tmp'), DSCODE_TEST_EXIT: String(code), DSCODE_TEST_RAN: ran },
        });
        assert.ifError(result.error);
        assert.equal(result.status, code, result.stderr);
        assert.equal(existsSync(ran), code === 0);
        assert.equal(lstatSync(modules, { throwIfNoEntry: false })?.ino, before);
        if (kind === 'symlink') assert.equal(readlinkSync(modules), '../../existing');
        if (kind !== 'absent') assert.equal(readFileSync(join(modules, 'sentinel'), 'utf8'), 'keep');
        assert.deepEqual(readdirSync(join(work, 'tmp')), []);
      }
      rmSync(modules, { recursive: true, force: true });
    }
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('release gate requires successful checks for the exact commit and tag', () => {
  const run = { headSha: 'a'.repeat(40), headBranch: 'v1.2.3', status: 'completed', conclusion: 'success' };
  assertReleaseRun(run, run.headSha, run.headBranch);
  assert.throws(() => assertReleaseRun(null, run.headSha, run.headBranch), /have not succeeded/);
  for (const change of [{ headSha: 'b'.repeat(40) }, { headBranch: 'main' }, { status: 'in_progress' }, { conclusion: 'failure' }, { conclusion: 'cancelled' }]) {
    assert.throws(() => assertReleaseRun({ ...run, ...change }, run.headSha, run.headBranch), /have not succeeded/);
  }
});

test('release provenance reads the tagged commit, not a later working-tree bump', () => {
  const work = mkdtempSync(join(tmpdir(), 'dscode-release-manifest-'));
  try {
    const manifest = join(work, 'bridge/grok-leader/package.json');
    mkdirSync(join(work, 'bridge/grok-leader'), { recursive: true });
    const git = (...args) => execFileSync('git', ['-C', work, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'release@example.test');
    git('config', 'user.name', 'release test');
    writeFileSync(manifest, JSON.stringify({ name: '@hqzhao95/dscode', version: '1.2.3' }));
    git('add', '.');
    git('commit', '-qm', 'release 1.2.3');
    const sha = git('rev-parse', 'HEAD').trim();
    // A release waits hours for CI; bumping VERSION meanwhile must not change
    // what the released payloads are verified against.
    writeFileSync(manifest, JSON.stringify({ name: '@hqzhao95/dscode', version: '1.2.4' }));
    assert.equal(releasedManifest(sha, work).version, '1.2.3');
    assert.throws(() => releasedManifest('f'.repeat(40), work), /cannot read the manifest/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('draft validation detects missing, corrupted, mixed-version and mismatched compressed assets', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dscode-release-verify-'));
  const manifest = { name: '@hqzhao95/dscode', version: '1.2.3', dsh: { sourceCommit: 'a'.repeat(40), testedVersion: '0.1.5-alpha.1' } };
  const writeAsset = (name, bytes) => {
    writeFileSync(join(work, name), bytes);
    writeFileSync(join(work, name + '.sha256'), createHash('sha256').update(bytes).digest('hex') + '  ' + name + '\n');
  };
  const archive = (name, path, value) => {
    const source = join(work, 'source');
    mkdirSync(join(source, 'package'), { recursive: true });
    writeFileSync(join(source, path), JSON.stringify(value));
    execFileSync('tar', ['-czf', join(work, name), '-C', source, path]);
    writeAsset(name, readFileSync(join(work, name)));
  };
  try {
    for (const name of ['dscode-linux-x86_64', 'dscode-macos-aarch64']) {
      writeAsset(name, 'fixture TUI');
      writeFileSync(join(work, name + '.gz'), gzipSync('fixture TUI'));
    }
    writeFileSync(join(work, 'dscode-licenses.tar.gz'), 'license fixture');
    const plugin = { ...manifest, dscode: { release: manifest.version } };
    archive('dscode-plugin.tgz', 'package/package.json', plugin);
    const descriptor = { schema: 1, sourceCommit: manifest.dsh.sourceCommit, dshVersion: manifest.dsh.testedVersion };
    for (const [asset, platform, arch] of [['linux-x86_64', 'linux', 'x64'], ['macos-aarch64', 'darwin', 'arm64']]) {
      archive(`dscode-runtime-${asset}.tar.gz`, './dscode-runtime.json', { ...descriptor, platform, arch });
    }
    await verifyReleaseAssets(work, manifest);
    writeFileSync(join(work, 'dscode-linux-x86_64'), 'corrupt');
    await assert.rejects(verifyReleaseAssets(work, manifest), /checksum mismatch/);
    writeAsset('dscode-linux-x86_64', 'fixture TUI');
    writeFileSync(join(work, 'dscode-linux-x86_64.gz'), gzipSync('another TUI'));
    await assert.rejects(verifyReleaseAssets(work, manifest), /compressed binary mismatch/);
    writeFileSync(join(work, 'dscode-linux-x86_64.gz'), gzipSync('fixture TUI'));
    archive('dscode-plugin.tgz', 'package/package.json', { ...plugin, version: '1.2.2' });
    await assert.rejects(verifyReleaseAssets(work, manifest), /plugin release provenance/);
    archive('dscode-plugin.tgz', 'package/package.json', plugin);
    archive('dscode-runtime-macos-aarch64.tar.gz', './dscode-runtime.json', { ...descriptor, platform: 'linux', arch: 'x64' });
    await assert.rejects(verifyReleaseAssets(work, manifest), /runtime release provenance/);
    rmSync(join(work, 'dscode-macos-aarch64.gz'));
    await assert.rejects(verifyReleaseAssets(work, manifest), /ENOENT/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('nested source scripts use the pinned pnpm even with a conflicting global pnpm', () => {
  const work = mkdtempSync(join(tmpdir(), 'dscode-pnpm-test-'));
  try {
    const globalBin = join(work, 'global-bin');
    mkdirSync(globalBin);
    writeFileSync(join(globalBin, 'pnpm'), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
    writeFileSync(join(work, 'package.json'), JSON.stringify({
      private: true, packageManager: 'pnpm@11.7.0',
      devEngines: { packageManager: { name: 'pnpm', version: '11.7.0', onFail: 'error' } },
      scripts: { nested: 'pnpm --version' },
    }));
    const env = sourceBuildEnvironment(join(work, 'bin'), { ...process.env, PATH: `${globalBin}${delimiter}${process.env.PATH}` });
    const output = execFileSync('pnpm', ['--silent', 'run', 'nested'], { cwd: work, env, encoding: 'utf8' });
    assert.equal(output.trim(), '11.7.0');
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('release lanes and source asset completeness are explicit', () => {
  assert.equal(releaseChannel('1.2.3'), 'stable');
  assert.equal(releaseChannel('1.2.3-beta.1'), 'beta');
  assert.equal(releaseChannel('1.2.3-alpha.1'), 'alpha');
  assert.throws(() => releaseChannel('1.2.3-rc.1'));
  const source = releaseAssets('a'.repeat(40));
  assert(source.includes('dscode-plugin.tgz.sha256'));
  assert(source.includes('dscode-runtime-linux-x86_64.tar.gz.sha256'));
  assert(source.includes('dscode-runtime-macos-aarch64.tar.gz.sha256'));
  assert(!releaseAssets().some(name => name.startsWith('dscode-runtime-')));
});

test('packed ordinary closure installs offline without unpublished host peers', () => {
  const work = mkdtempSync(join(tmpdir(), 'dscode-payload-test-'));
  const save = (path, value) => writeFileSync(path, JSON.stringify(value));
  try {
    const consumer = join(work, 'consumer');
    const stage = join(work, 'stage');
    const installed = join(work, 'installed');
    for (const dir of [consumer, stage, installed]) mkdirSync(dir);
    save(join(installed, 'package.json'), { private: true });
    for (const [name, extra] of [['ordinary-tool', { dependencies: { helper: '1.0.0' }, peerDependencies: { 'unpublished-host-sdk': '99.0.0-alpha.1' } }], ['helper', {}], ['unpublished-host-sdk', {}]]) {
      const dir = join(consumer, 'node_modules', name);
      mkdirSync(dir, { recursive: true });
      save(join(dir, 'package.json'), { name, version: '1.0.0', main: 'index.js', ...extra });
      writeFileSync(join(dir, 'index.js'), 'module.exports = 42;\n');
    }
    copyClosure('ordinary-tool', consumer, join(stage, 'node_modules'));
    assert(!existsSync(join(stage, 'node_modules/unpublished-host-sdk')));
    assert.equal(JSON.parse(readFileSync(join(stage, 'node_modules/ordinary-tool/package.json'))).peerDependenciesMeta['unpublished-host-sdk'].optional, true);
    save(join(stage, 'package.json'), { name: 'payload-contract', version: '1.0.0', dependencies: { 'ordinary-tool': '1.0.0' }, bundleDependencies: ['ordinary-tool'] });
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts'], { cwd: stage, encoding: 'utf8' }));
    execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(stage, packed[0].filename)], { cwd: installed, stdio: 'pipe', env: { ...process.env, npm_config_cache: join(work, 'empty-cache') } });
    assert(existsSync(join(installed, 'node_modules/payload-contract/node_modules/ordinary-tool/index.js')));
    assert(!existsSync(join(installed, 'node_modules/unpublished-host-sdk')));
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('actual publish script authenticates historical and source assets before selecting npm tags', () => {
  const work = mkdtempSync(join(tmpdir(), 'dscode-publish-test-'));
  const script = fileURLToPath(new URL('./publish-npm.sh', import.meta.url));
  const bin = join(work, 'bin');
  mkdirSync(bin);
  // Hermetic child environment: only PATH and HOME, so no ambient npm credential
  // variable can decide whether the publish script authenticated itself.
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: work };
  // These wrappers never delegate: unexpected commands/URLs fail closed.
  writeFileSync(join(bin, 'curl'), `#!${process.execPath}
const fs = require('node:fs');
const c = JSON.parse(fs.readFileSync(process.env.PUBLISH_CASE, 'utf8'));
const args = process.argv.slice(2);
const url = args.find(arg => arg.startsWith('https://'));
const base = 'https://github.com/HQ1995/deepseek-code/releases/download/v' + c.version + '/';
const api = 'https://api.github.com/repos/HQ1995/deepseek-code/releases/tags/v' + c.version;
if (!url || (url !== api && !url.startsWith(base))) process.exit(91);
const asset = url === api ? 'api' : url.slice(base.length);
fs.appendFileSync(c.requests, asset + '\\n');
let status = asset === 'dscode-plugin.tgz.sha256' ? c.sidecarStatus : c.missing === asset ? 404 : 200;
if (args.includes('-fsIL')) process.exit(status === 200 ? 0 : 22);
const output = args[args.indexOf('-o') + 1];
if (!args.includes('-o')) process.exit(92);
if (asset === 'dscode-plugin.tgz') fs.copyFileSync(c.archive, output);
else if (asset === 'dscode-plugin.tgz.sha256') fs.writeFileSync(output, c.digest + '  dscode-plugin.tgz\\n');
else if (asset === 'api') fs.writeFileSync(output, JSON.stringify({tag_name:'v' + c.version,draft:false,assets:[{name:'dscode-plugin.tgz',browser_download_url:base + 'dscode-plugin.tgz',digest:'sha256:' + c.digest}]}));
else process.exit(93);
if (args.includes('-w')) process.stdout.write(String(status));
else if (status !== 200) process.exit(22);
`, { mode: 0o755 });
  writeFileSync(join(bin, 'npm'), `#!${process.execPath}
const fs = require('node:fs');
const c = JSON.parse(fs.readFileSync(process.env.PUBLISH_CASE, 'utf8'));
const args = process.argv.slice(2);
const reject = why => { process.stderr.write('npm fixture rejected: ' + why + '\\n'); process.exit(94); };
if (args.some(arg => /authToken|otp/.test(arg))) reject('credential in argv: ' + args.join(' '));
if (c.token) {
  if (process.env.NPM_TOKEN !== c.token || !process.env.NPM_CONFIG_USERCONFIG) reject('token was not exported with its userconfig');
  const config = fs.readFileSync(process.env.NPM_CONFIG_USERCONFIG, 'utf8');
  if (!config.includes('$' + '{NPM_TOKEN}') || config.includes(c.token)
    || (fs.statSync(process.env.NPM_CONFIG_USERCONFIG).mode & 0o077)) reject('npmrc leaks the literal token or is world readable');
} else if (process.env.NPM_TOKEN) reject('inherited NPM_TOKEN without a pinned case token');
if (c.otp && process.env.NPM_CONFIG_OTP !== c.otp) reject('otp was not exported for the pinned case');
if (args[0] === 'publish') {
  if (!fs.existsSync(args[1]) || !args.includes('--tag')) process.exit(95);
  fs.writeFileSync(c.published, args[args.indexOf('--tag') + 1]);
} else if (args[0] === 'view') process.stdout.write(c.version);
else process.exit(96);
`, { mode: 0o755 });
  const cases = [
    { label: 'historical beta digest', version: '0.0.13-beta.13', sidecarStatus: 404, tag: 'beta' },
    { label: 'stable latest', version: '1.0.0', sidecarStatus: 200, tag: 'latest' },
    { label: 'source alpha', version: '1.0.1-alpha.1', source: true, sidecarStatus: 200, tag: 'alpha' },
    { label: 'environment publish credentials', version: '1.0.1-alpha.1', source: true, sidecarStatus: 200, tag: 'alpha', token: 'fixture-publish-token', otp: '123456' },
    { label: 'source missing Linux runtime', version: '1.0.1-alpha.1', source: true, sidecarStatus: 200, missing: 'dscode-runtime-linux-x86_64.tar.gz' },
    { label: 'source missing macOS runtime', version: '1.0.1-alpha.1', source: true, sidecarStatus: 200, missing: 'dscode-runtime-macos-aarch64.tar.gz' },
    { label: 'wrong authenticated package', version: '1.0.0', sidecarStatus: 200, wrongName: true },
    { label: 'checksum server failure', version: '1.0.0', sidecarStatus: 503 },
    { label: 'historical digest mismatch', version: '0.0.13-beta.13', sidecarStatus: 404, corruptDigest: true },
  ];
  try {
    for (const [index, scenario] of cases.entries()) {
      const dir = join(work, String(index));
      mkdirSync(join(dir, 'package'), { recursive: true });
      const pkg = { name: scenario.wrongName ? 'wrong-product' : '@hqzhao95/dscode', version: scenario.version, dscode: { release: scenario.version }, ...(scenario.source ? { dsh: { sourceCommit: 'a'.repeat(40) } } : {}) };
      writeFileSync(join(dir, 'package/package.json'), JSON.stringify(pkg));
      const archive = join(dir, 'dscode-plugin.tgz');
      execFileSync('tar', ['-czf', archive, '-C', dir, 'package']);
      const fixture = { ...scenario, archive, digest: scenario.corruptDigest ? '0'.repeat(64) : createHash('sha256').update(readFileSync(archive)).digest('hex'), requests: join(dir, 'requests'), published: join(dir, 'published') };
      const input = join(dir, 'case.json');
      writeFileSync(input, JSON.stringify(fixture));
      const result = spawnSync('bash', [script, '--pin', scenario.version], { env: { ...env, PUBLISH_CASE: input, ...(scenario.token ? { NPM_TOKEN: scenario.token, NPM_OTP: scenario.otp } : {}) }, encoding: 'utf8', timeout: 30000 });
      assert.ifError(result.error);
      const requests = readFileSync(fixture.requests, 'utf8').trim().split('\n');
      if (scenario.tag) {
        assert.equal(result.status, 0, `${scenario.label}: exit ${result.status} ${result.stderr}${result.stdout}`);
        assert.equal(readFileSync(fixture.published, 'utf8'), scenario.tag);
        if (scenario.source) {
          for (const platform of ['linux-x86_64', 'macos-aarch64']) {
            assert(requests.includes(`dscode-runtime-${platform}.tar.gz`));
            assert(requests.includes(`dscode-runtime-${platform}.tar.gz.sha256`));
          }
        } else assert(!requests.some(asset => asset.startsWith('dscode-runtime-')));
      } else {
        assert.notEqual(result.status, 0, scenario.label);
        assert(!existsSync(fixture.published), scenario.label);
      }
      if (scenario.sidecarStatus === 404) assert(requests.includes('api'));
      else assert(!requests.includes('api'));
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
});
