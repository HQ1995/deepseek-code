import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as settle } from 'node:timers/promises'

const execute = promisify(execFile)

/** Exercise the compiled product in a real Kitty renderer on an isolated X server. */
export async function kittyImageAcceptance({ kittyBin, tuiBin, baseEnv, cwd, artifacts, waitFor, artifact, sockets, children }) {
  const kitten = join(dirname(kittyBin), 'kitten')
  const listen = join(artifacts, 'kitty.sock')
  const leader = join(artifacts, 'kitty-leader.sock')
  sockets.push(leader)
  const imagePath = join(artifacts, 'square.png')
  const measurePath = join(artifacts, 'kitty-cell.json')
  await execute('python3', ['-c', `
import struct,zlib,sys
def chunk(t,b):return struct.pack('!I',len(b))+t+b+struct.pack('!I',zlib.crc32(t+b))
row=b'\\0'+bytes([240,10,100])*240
open(sys.argv[1],'wb').write(b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR',struct.pack('!2I5B',240,240,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(row*240))+chunk(b'IEND',b''))
`, imagePath])
  const xvfb = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1500x1100x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(xvfb)
  xvfb.stderr.pipe(createWriteStream(join(artifacts, 'xvfb.log')))
  let kitty
  try {
    const number = await new Promise((resolve, reject) => {
      xvfb.stdout.once('data', bytes => resolve(bytes.toString().trim()))
      xvfb.once('error', reject)
      xvfb.once('exit', code => reject(new Error(`Xvfb exited: ${code}`)))
    })
    assert.match(String(number), /^\d+$/)
    const env = { ...baseEnv, DISPLAY: `:${number}`, LP_NUM_THREADS: '4', LIBGL_ALWAYS_SOFTWARE: '1',
      DSCODE_SOCKET: leader, DSCODE_LOG: join(artifacts, 'kitty-leader.log'), GROK_DEBUG_LOG: join(artifacts, 'kitty-tui.log') }
    delete env.TMUX; delete env.STY; delete env.WAYLAND_DISPLAY; delete env.KITTY_LISTEN_ON
    const wrapper = `import fcntl,termios,struct,os,sys,json\nr,c,w,h=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,bytes(8)))\nopen(sys.argv[1],'w').write(json.dumps(dict(rows=r,cols=c,width=w,height=h)))\nos.execv(sys.argv[2],sys.argv[2:])`
    kitty = spawn(kittyBin, ['--config', 'NONE', '--listen-on', `unix:${listen}`,
      '-o', 'allow_remote_control=socket-only', '-o', 'linux_display_server=x11',
      '-o', 'font_family=DejaVu Sans Mono', '-o', 'font_size=14', '-o', 'adjust_line_height=130%',
      '-o', 'remember_window_size=no', '-o', 'initial_window_width=1300', '-o', 'initial_window_height=950',
      '--directory', cwd, 'python3', '-c', wrapper, measurePath, tuiBin,
      '--agent', 'standard', '--model', 'fake-model', '--no-plan', '--always-approve'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(kitty)
    kitty.stdout.pipe(createWriteStream(join(artifacts, 'kitty.stdout')))
    kitty.stderr.pipe(createWriteStream(join(artifacts, 'kitty.stderr')))
    let launchError
    kitty.once('error', error => { launchError = error })
    const remote = async (...args) => {
      if (launchError) throw launchError
      return (await execute(kitten, ['@', '--to', `unix:${listen}`, ...args], { env, timeout: 10000, maxBuffer: 4 * 1024 * 1024 })).stdout
    }
    await waitFor(async () => { try { return await remote('ls') } catch { return '' } }, Boolean, 'kitty-control-ready', 30000)
    const capture = () => remote('get-text')
    const first = await waitFor(capture, screen => /Do you trust|fake-model|Fake Model/.test(screen), 'kitty-product-ready', 30000)
    if (first.includes('Do you trust')) await remote('send-text', 'y')
    await waitFor(capture, screen => /fake-model|Fake Model/.test(screen), 'kitty-model-ready')
    const measure = JSON.parse(await readFile(measurePath, 'utf8'))
    const cellWidth = measure.width / measure.cols, cellHeight = measure.height / measure.rows
    assert.ok(cellWidth / cellHeight >= 0.3 && cellWidth / cellHeight < 0.45, 'Use non-1:2 cells so the old fixed ratio would stretch the square')
    const window = (await execute('xdotool', ['search', '--class', 'kitty'], { env })).stdout.trim().split('\n').at(-1)
    assert.match(window, /^\d+$/)
    const frame = async name => {
      const path = join(artifacts, `${name}.png`)
      await execute('import', ['-display', env.DISPLAY, '-window', window, path], { env, timeout: 10000 })
      const png = await readFile(path), width = png.readUInt32BE(16)
      const { stdout: rgb } = await execute('convert', [path, '-alpha', 'off', '-depth', '8', 'rgb:-'], { env, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })
      let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, count = 0
      for (let p = 0; p < rgb.length; p += 3) {
        if (Math.abs(rgb[p] - 240) > 3 || Math.abs(rgb[p + 1] - 10) > 3 || Math.abs(rgb[p + 2] - 100) > 3) continue
        const x = p / 3 % width, y = Math.floor(p / 3 / width)
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); count++
      }
      await writeFile(join(artifacts, `${name}.txt`), await capture())
      return { path, x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, count }
    }
    const visible = async (name, ready = () => true) => {
      const result = await waitFor(() => frame(name), image => image.count > 2000 && ready(image), name, 20000)
      assert.ok(Math.abs(result.width - result.height) <= Math.max(cellWidth, cellHeight) + 2, `Square stretched: ${JSON.stringify(result)}`)
      assert.ok(result.count > result.width * result.height * 0.95, 'One solid image must not leave disconnected placements')
      return result
    }
    await remote('send-text', '--bracketed-paste', 'enable', `GROK_WRAP_IMG\nimage/png\n${(await readFile(imagePath)).toString('base64')}`)
    await waitFor(capture, screen => /Image #1/.test(screen), 'kitty-image-chip')
    const initial = await visible('kitty-image-initial')
    await remote('resize-os-window', '--width', '1100', '--height', '780', '--unit', 'pixels')
    await settle(500)
    const resized = await visible('kitty-image-resized')
    assert.notEqual(initial.y, resized.y, 'Resize must actually move the preview')
    await remote('send-text', '--bracketed-paste', 'enable', ' after image')
    await waitFor(() => frame('kitty-image-hidden'), image => image.count === 0, 'kitty-no-stale-pixels')
    await remote('send-key', 'ctrl+z')
    // Undo restores the draft, not the ephemeral post-insert preview. Focus its chip.
    await remote('send-key', 'home')
    const reopened = await visible('kitty-image-reopened')
    await remote('send-key', 'enter')
    const modal = await visible('kitty-image-modal', image => image.width > reopened.width)
    await remote('send-key', 'escape')
    const returned = await visible('kitty-image-returned', image => image.width === reopened.width)
    const result = { renderer: (await execute(kittyBin, ['--version'])).stdout.trim(), measure, initial, resized, reopened, modal, returned, cleared: true }
    await artifact('kitty-images', result)
    return result
  } finally {
    if (kitty && kitty.exitCode === null) kitty.kill('SIGTERM')
    await waitFor(async () => {
      try { const pid = Number(await readFile(leader.replace(/\.sock$/, '.lock'), 'utf8')); process.kill(pid, 0); return false }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return true; throw error }
    }, Boolean, 'kitty-owned-leader-exit', 15000).finally(() => { if (xvfb.exitCode === null) xvfb.kill('SIGTERM') })
  }
}
