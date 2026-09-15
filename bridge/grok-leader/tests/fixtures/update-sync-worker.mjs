import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join, sep } from 'node:path'

const [root, mode, updater] = process.argv.slice(2)
const profile = join(root, 'active'), stage = join(root, 'stage')
const prepared = join(stage, 'profile'), tree = join(prepared, 'runtime')
fs.mkdirSync(profile)
fs.mkdirSync(join(tree, 'nested'), { recursive: true })
fs.writeFileSync(join(profile, 'runtime'), 'old runtime')
for (let i = 0; i < 12; i++) fs.writeFileSync(join(tree, 'nested', String(i)), 'new runtime')
fs.writeFileSync(join(tree, 'top'), 'new top')
fs.writeFileSync(join(root, 'outside'), 'unowned')
fs.symlinkSync(join(root, 'outside'), join(tree, 'external-link'))
fs.symlinkSync(join(root, 'missing'), join(tree, 'dangling-link'))

const expected = new Set()
const collect = path => {
  const info = fs.lstatSync(path)
  if (info.isSymbolicLink()) return
  expected.add(path)
  if (info.isDirectory()) for (const name of fs.readdirSync(path)) collect(join(path, name))
}
collect(tree)
const descriptors = new Map(), completed = new Set()
let active = 0, maximum = 0, injected = false
const open = fs.openSync, close = fs.closeSync, sync = fs.fsync
fs.openSync = (path, ...args) => {
  const fd = open(path, ...args)
  if (typeof path === 'string' && path.startsWith(prepared + sep)) descriptors.set(fd, path)
  return fd
}
fs.closeSync = fd => { descriptors.delete(fd); return close(fd) }
fs.fsync = (fd, callback) => {
  const path = descriptors.get(fd)
  if (!path) return sync(fd, callback)
  assert.ok(expected.has(path), 'followed an unowned symlink')
  assert.equal(fs.readFileSync(join(profile, 'runtime'), 'utf8'), 'old runtime')
  assert.ok(!fs.existsSync(join(stage, 'transaction.json')), 'journal preceded tree durability')
  for (const child of expected) if (dirname(child) === path) assert.ok(completed.has(child), 'parent flushed before child')
  maximum = Math.max(maximum, ++active)
  const fail = mode === 'failure' && !injected
  if (fail) injected = true
  setTimeout(() => {
    active--
    if (fail) callback(Object.assign(new Error('fixture flush failure'), { code: 'EIO' }))
    else { completed.add(path); callback(null) }
  }, fail ? 1 : 20)
}
syncBuiltinESMExports()
const { commitInstallation, withProfileLock } = await import(updater)
if (mode === 'failure') {
  await assert.rejects(commitInstallation(profile, stage, ['runtime']), /fixture flush failure/)
  assert.equal(active, 0, 'returned before admitted flushes settled')
  assert.equal(descriptors.size, 0, 'leaked staged descriptors')
  assert.equal(fs.readFileSync(join(profile, 'runtime'), 'utf8'), 'old runtime')
  assert.ok(!fs.existsSync(join(stage, 'transaction.json')))
  await withProfileLock(profile, () => {})
} else {
  await commitInstallation(profile, stage, ['runtime'])
  assert.deepEqual(completed, expected)
  assert.equal(fs.readFileSync(join(profile, 'runtime/nested/0'), 'utf8'), 'new runtime')
  assert.equal(JSON.parse(fs.readFileSync(join(stage, 'transaction.json'), 'utf8')).state, 'committed')
}
assert.equal(active, 0)
assert.equal(descriptors.size, 0)
assert.ok(maximum > 1 && maximum <= 4, `unbounded or serial flushes: ${maximum}`)
assert.equal(fs.readFileSync(join(root, 'outside'), 'utf8'), 'unowned')
console.log(JSON.stringify({ mode, maximum, completed: completed.size, drained: true }))
