import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const freePort = () => new Promise(resolve => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('mock gateway release rendezvous-waits for a hold the client has not registered yet', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dscode-gateway-hold-'));
  const script = readFileSync(new URL('./e2e-tui-bridge.sh', import.meta.url), 'utf8');
  const gateway = script.split('cat >"$SCRATCH/mock-gateway.mjs" <<\'EOF\'\n')[1]?.split('\nEOF\n')[0];
  assert.ok(gateway, 'scripts/e2e-tui-bridge.sh must define the mock gateway heredoc');
  writeFileSync(join(work, 'mock-gateway.mjs'), gateway);
  writeFileSync(join(work, 'fixture.mjs'),
    "export const contractReply = () => ({ text: 'HELD', hold: true, releaseKey: 'race', releaseText: ' RELEASED' })\n");
  const port = await freePort();
  const gatewayProcess = spawn(process.execPath, [join(work, 'mock-gateway.mjs'), String(port), join(work, 'requests.log')], {
    env: { ...process.env, DSCODE_E2E_MODEL_FIXTURE: join(work, 'fixture.mjs') },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}/v1`;
  try {
    const deadline = Date.now() + 10000;
    for (;;) {
      try { if ((await fetch(`${base}/models`)).ok) break; } catch {}
      assert.ok(Date.now() < deadline, 'mock gateway did not start');
      await wait(50);
    }
    let settled = false;
    const release = fetch(`${base}/preset-probe/release?key=race`, { method: 'POST' });
    release.then(() => { settled = true; }, () => { settled = true; });
    await wait(500);
    assert.equal(settled, false, 'release must wait for the held stream, not fail the client');
    const stream = await fetch(`${base}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-model', stream: true, messages: [{ role: 'user', content: 'hold it' }] }),
    });
    const sse = await stream.text();
    const released = await release;
    assert.equal(released.status, 200);
    assert.equal(await released.text(), 'released');
    assert.match(sse, /RELEASED/);
  } finally {
    gatewayProcess.kill('SIGTERM');
    rmSync(work, { recursive: true, force: true });
  }
});
