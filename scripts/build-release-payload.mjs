#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, cwd, env = process.env) => execFileSync(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 }).toString().trim();
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
export function releaseChannel(version) {
  const match = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(alpha|beta)\.(?:0|[1-9]\d*)(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match) throw new Error(`Unsupported release version/lane: ${version}`);
  return match[1] || 'stable';
}
export function releaseAssets(sourceCommit) {
  return ['dscode-linux-x86_64', 'dscode-macos-aarch64'].flatMap(name => [name, `${name}.sha256`, `${name}.gz`])
    .concat(['dscode-plugin.tgz', 'dscode-plugin.tgz.sha256', 'dscode-licenses.tar.gz'])
    .concat(sourceCommit ? ['linux-x86_64', 'macos-aarch64'].flatMap(platform => [`dscode-runtime-${platform}.tar.gz`, `dscode-runtime-${platform}.tar.gz.sha256`]) : []);
}
function checksum(path) {
  writeFileSync(`${path}.sha256`, `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${basename(path)}\n`);
}
function locate(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(`Missing production dependency ${name} from ${from}`);
  }
}
// Copy only ordinary dependencies. Peers belong to the host, not the plugin.
export function copyClosure(name, from, modules, seen = new Map()) {
  const source = locate(name, from);
  const pkg = json(join(source, 'package.json'));
  const destination = join(modules, name);
  if (seen.has(destination)) {
    if (seen.get(destination) !== source) throw new Error(`Conflicting dependency ${name}`);
    return;
  }
  seen.set(destination, source);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: true, filter: path => !['node_modules', '.cache', '.npmrc', 'package-lock.json', 'pnpm-lock.yaml'].includes(basename(path)) });
  delete pkg.devDependencies;
  pkg.peerDependenciesMeta = Object.fromEntries(Object.keys(pkg.peerDependencies || {}).map(peer => [peer, { optional: true }]));
  save(join(destination, 'package.json'), pkg);
  for (const [dep, spec] of Object.entries(pkg.dependencies || {})) {
    if (/^(file:|link:|workspace:)/.test(spec)) throw new Error(`Nonportable dependency ${name}: ${dep}=${spec}`);
    copyClosure(dep, source, modules, seen);
  }
  for (const dep of Object.keys(pkg.optionalDependencies || {})) {
    let installed;
    try { installed = locate(dep, source); } catch { continue; }
    const optional = json(join(installed, 'package.json'));
    if ((!optional.os || optional.os.includes(process.platform)) && (!optional.cpu || optional.cpu.includes(process.arch))) copyClosure(dep, source, modules, seen);
  }
}
function sourceConsumer(source, consumer, manifest, reuse) {
  const commit = manifest.dsh.sourceCommit;
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('dsh.sourceCommit must be a full revision');
  if (!existsSync(source)) {
    run('git', ['clone', 'https://github.com/deepseek-ai/deepseek-harness.git', source]);
    run('git', ['checkout', '--detach', commit], source);
  }
  if (run('git', ['rev-parse', 'HEAD'], source) !== commit || run('git', ['status', '--porcelain', '--untracked-files=no'], source)) throw new Error('Upstream source must be clean and exactly pinned');
  if (json(join(source, 'package.json')).version !== manifest.dsh.testedVersion) throw new Error('Source version mismatch');
  if (reuse) {
    if (!existsSync(join(consumer, 'node_modules/@deepseek-ai/dsh/package.json'))) throw new Error('Missing installed source consumer');
    return;
  }
  run('corepack', ['pnpm', 'install', '--frozen-lockfile'], source);
  run('corepack', ['pnpm', 'run', 'build:official'], source, { ...process.env, DSH_CLIENT_COMMIT_HASH: commit });
  for (const [family, out] of [['dsh', 'dist/npm'], ['vendor', 'dist/npm-vendor']]) run('corepack', ['pnpm', 'run', 'release:pack', '--family', family, '--out', out], source);
  const native = join(source, 'native/landlock-run');
  if (process.platform === 'linux') run('corepack', ['pnpm', 'run', 'build:native'], native);
  const packed = join(source, 'dist/npm-landlock');
  mkdirSync(packed, { recursive: true });
  for (const name of ['entry', ...(process.platform === 'linux' ? [`linux-${process.arch}`] : [])]) run('corepack', ['pnpm', '--dir', join(native, 'packages', name), 'pack', '--pack-destination', packed], source);
  const dependencies = {};
  for (const dir of ['dist/npm', 'dist/npm-vendor', 'dist/npm-landlock']) {
    for (const file of readdirSync(join(source, dir)).filter(file => file.endsWith('.tgz'))) {
      const path = join(source, dir, file);
      const pkg = JSON.parse(run('tar', ['-xOf', path, 'package/package.json']));
      if ((!pkg.os || pkg.os.includes(process.platform)) && (!pkg.cpu || pkg.cpu.includes(process.arch))) dependencies[pkg.name] = pathToFileURL(path).href;
    }
  }
  Object.assign(dependencies, Object.fromEntries(Object.entries(manifest.dependencies || {}).filter(([name]) => !name.startsWith('@deepseek-ai/'))));
  mkdirSync(consumer, { recursive: true });
  save(join(consumer, 'package.json'), { private: true, dependencies, devDependencies: Object.fromEntries(Object.entries(manifest.devDependencies).filter(([name]) => !name.startsWith('@deepseek-ai/'))) });
  run('npm', ['install', '--no-audit', '--no-fund', '--package-lock=false'], consumer);
}
function buildRuntime(consumer, source, manifest, out, work) {
  const platform = { 'linux/x64': 'linux-x86_64', 'darwin/arm64': 'macos-aarch64' }[`${process.platform}/${process.arch}`];
  if (!platform) throw new Error('Unsupported runtime platform');
  const stage = join(work, 'runtime');
  mkdirSync(join(stage, 'bin'), { recursive: true });
  // Preserve the real installed layout, native helpers and relative npm links.
  // Only package payloads are copied: never the consumer's lock, auth or profile.
  cpSync(join(consumer, 'node_modules'), join(stage, 'node_modules'), { recursive: true, verbatimSymlinks: true, filter: path => !['.cache', '.npmrc', '.package-lock.json'].includes(basename(path)) });
  const cli = json(join(stage, 'node_modules/@deepseek-ai/dsh/package.json'));
  if (cli.version !== manifest.dsh.testedVersion) throw new Error('Runtime CLI manifest version mismatch');
  symlinkSync(`../node_modules/@deepseek-ai/dsh/${cli.bin.dsh}`, join(stage, 'bin/dsh'));
  if (process.platform === 'linux') {
    const native = join(stage, `node_modules/@deepseek-ai/node-addon-landlock-run-linux-${process.arch}`);
    const descriptor = json(join(native, 'prebuilds.json'));
    if (descriptor.platform !== `linux-${process.arch}` || !descriptor.binaries.some(binary => binary.tool === 'landlock-run' && binary.kind === 'static-musl')) throw new Error('Native helper platform/format mismatch');
    for (const binary of descriptor.binaries) if (!(statSync(join(native, binary.path)).mode & 0o111)) throw new Error(`Missing executable native helper ${binary.path}`);
  }
  const version = run(process.execPath, [join(stage, 'bin/dsh'), '--version'], stage);
  if (version !== manifest.dsh.testedVersion) throw new Error(`Runtime CLI reports ${version}`);
  save(join(stage, 'dscode-runtime.json'), { schema: 1, dshVersion: version, sourceCommit: manifest.dsh.sourceCommit, platform: process.platform, arch: process.arch });
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) if (existsSync(join(source, name))) cpSync(join(source, name), join(stage, name));
  const asset = join(out, `dscode-runtime-${platform}.tar.gz`);
  run('tar', ['-czf', asset, '-C', stage, '.']);
  checksum(asset);
}
function buildPlugin(consumer, manifest, version, out, work) {
  const stage = join(work, 'plugin');
  mkdirSync(stage);
  for (const name of ['src', 'bin', 'presets', 'cordis.patch.yml', 'tsconfig.json']) cpSync(join(root, 'bridge/grok-leader', name), join(stage, name), { recursive: true });
  // A temporary compilation tree consumes the source-built SDK, never registry alpha SDKs.
  symlinkSync(join(consumer, 'node_modules'), join(stage, 'node_modules'));
  save(join(stage, 'package.json'), manifest);
  run(process.execPath, [join(consumer, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--tsBuildInfoFile', join(stage, '.tsbuildinfo')], stage);
  rmSync(join(stage, 'node_modules'));
  const pkg = structuredClone(manifest);
  pkg.version = version;
  pkg.dscode = { ...pkg.dscode, release: version };
  delete pkg.devDependencies;
  delete pkg.scripts;
  delete pkg.packageManager;
  pkg.peerDependenciesMeta = Object.fromEntries(Object.keys(pkg.peerDependencies || {}).map(name => [name, { optional: true }]));
  pkg.bundleDependencies = Object.keys(pkg.dependencies || {});
  const seen = new Map();
  for (const name of pkg.bundleDependencies) copyClosure(name, consumer, join(stage, 'node_modules'), seen);
  pkg.files = [...pkg.files, 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'];
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) cpSync(join(root, name), join(stage, name));
  save(join(stage, 'package.json'), pkg);
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', out], stage));
  const asset = join(out, 'dscode-plugin.tgz');
  cpSync(join(out, packed[0].filename), asset);
  rmSync(join(out, packed[0].filename));
  checksum(asset);
}
function main() {
  const { values } = parseArgs({ options: { source: { type: 'string' }, consumer: { type: 'string' }, out: { type: 'string' }, version: { type: 'string' }, 'runtime-only': { type: 'boolean' }, 'plugin-only': { type: 'boolean' }, assets: { type: 'boolean' }, channel: { type: 'boolean' } } });
  const manifest = json(join(root, 'bridge/grok-leader/package.json'));
  const version = values.version || readFileSync(join(root, 'VERSION'), 'utf8').trim();
  const channel = releaseChannel(version);
  if (values.channel) return console.log(channel);
  if (values.assets) return console.log(releaseAssets(manifest.dsh?.sourceCommit).join('\n'));
  if (values['runtime-only'] && values['plugin-only']) throw new Error('Choose only one payload selector');
  if (values['runtime-only'] && !manifest.dsh?.sourceCommit) return;
  const out = resolve(values.out || join(root, 'dist'));
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'dscode-release-'));
  try {
    const source = resolve(values.source || join(work, 'source'));
    const consumer = resolve(values.consumer || join(work, 'consumer'));
    if (manifest.dsh?.sourceCommit) sourceConsumer(source, consumer, manifest, Boolean(values.consumer));
    else {
      mkdirSync(consumer, { recursive: true });
      save(join(consumer, 'package.json'), { ...manifest, private: true, scripts: {} });
      run('npm', ['install', '--no-audit', '--no-fund'], consumer);
    }
    if (!values['runtime-only']) {
      buildPlugin(consumer, manifest, version, out, work);
    }
    if (manifest.dsh?.sourceCommit && !values['plugin-only']) buildRuntime(consumer, source, manifest, out, work);
  } finally { rmSync(work, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
