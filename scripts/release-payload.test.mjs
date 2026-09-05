import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { copyClosure, releaseAssets, releaseChannel } from './build-release-payload.mjs';

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
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: work };
  for (const name of Object.keys(env)) if (/npm.*(?:token|otp|auth)|^(?:NPM_TOKEN|NPM_OTP)$/i.test(name)) delete env[name];
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
if (process.env.NPM_TOKEN || process.env.NPM_OTP || args.some(arg => /authToken|otp/.test(arg))) process.exit(94);
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
      const result = spawnSync('bash', [script, '--pin', scenario.version], { env: { ...env, PUBLISH_CASE: input }, encoding: 'utf8', timeout: 30000 });
      assert.ifError(result.error);
      const requests = readFileSync(fixture.requests, 'utf8').trim().split('\n');
      if (scenario.tag) {
        assert.equal(result.status, 0, `${scenario.label}: ${result.stderr}`);
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
