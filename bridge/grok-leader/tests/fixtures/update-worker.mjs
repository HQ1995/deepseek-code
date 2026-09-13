import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

const [root, lane, updater] = process.argv.slice(2)
const { withProfileLock, commitInstallation } = await import(updater)
if (lane === 'hold') {
  await withProfileLock(join(root, 'active'), async () => {
    process.send('locked')
    await new Promise(resolve => process.once('message', resolve))
  })
} else {
  const stageName = ['crash', 'rollback-failure'].includes(lane) ? '.dscode-update-' + lane : lane
  if (lane === 'rollback-failure') {
    const rename = fs.renameSync
    fs.renameSync = (from, to) => {
      if ([join(root, stageName, 'profile/runtime'), join(root, stageName, 'backup/node_modules')].includes(from)) {
        throw new Error('fixture storage failure')
      }
      return rename(from, to)
    }
    syncBuiltinESMExports()
  }
  if (lane === 'A' || lane === 'crash') {
    const rename = fs.renameSync
    fs.renameSync = (from, to) => {
      rename(from, to)
      if (from !== (lane === 'crash' ? join(root, 'active/node_modules') : join(root, lane, 'profile/node_modules'))) return
      fs.writeFileSync(join(root, 'paused'), '')
      const flag = new Int32Array(new SharedArrayBuffer(4))
      const deadline = Date.now() + 10000
      while (!fs.existsSync(join(root, 'resume'))) {
        if (Date.now() > deadline) throw new Error('update test scheduling timeout')
        Atomics.wait(flag, 0, 0, 10)
      }
    }
    syncBuiltinESMExports()
  }
  await commitInstallation(join(root, 'active'), join(root, stageName), ['node_modules', 'runtime', 'bin/dscode', 'config.toml'])
}
