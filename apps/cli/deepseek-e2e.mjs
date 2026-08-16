import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const server = await startMockLlmServer({
  sequence: ['success', 'success', 'success', 'success'],
  apiKey: 'k',
  successText: 'hello from deepseek-build',
})
const home = mkdtempSync(join(tmpdir(), 'deepseek-build-home-'))
const socketPath = '/tmp/deepseek-e2e-' + Date.now() + '.sock'
const SESSION = 'deepseek-e2e-' + Date.now()
const tmux = (args) => execFileSync('tmux', ['-L', SESSION, '-f', '/dev/null', ...args], { encoding: 'utf8' })

const env = [
  'TERM=xterm-256color',
  'DEEPSEEK_LEADER_SOCKET=' + socketPath,
  'DSH_HOME=' + home,
  'DSH_TELEMETRY_DISABLED=1',
  'DEEPSEEK_API_KEY=k',
  'DEEPSEEK_BASE_URL=' + server.baseURL,
  'NO_COLOR=1',
]
tmux(['new-session', '-d', '-s', SESSION, '-x', '240', '-y', '50', 'env ' + env.join(' ') + ' exec /home/hanqing/agents/DST/bin/deepseek'])
await new Promise(r => setTimeout(r, 14000))
tmux(['send-keys', '-t', SESSION, 'say hi', 'Enter'])
let answerSeen = false
let capture = ''
const deadline = Date.now() + 60000
while (Date.now() < deadline) {
  capture = tmux(['capture-pane', '-p', '-t', SESSION])
  if (capture.includes('hello from deepseek-build')) { answerSeen = true; break }
  await new Promise(r => setTimeout(r, 1000))
}
console.log('answer rendered:', answerSeen)
console.log('prompt visible:', capture.includes('say hi'))
tmux(['send-keys', '-t', SESSION, 'q'])
await new Promise(r => setTimeout(r, 4000))
let still = true
try { tmux(['list-sessions']); } catch { still = false }
console.log('session exited:', !still)
console.log('mock requests:', server.requests.length)
console.log('capture bytes:', capture.length)
try { tmux(['kill-session', '-t', SESSION]) } catch {}
await server.close()
process.exit(answerSeen && server.requests.length > 0 ? 0 : 1)
