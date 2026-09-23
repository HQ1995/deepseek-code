/** Explicit Host-only developer inspection; never a Web UI or model tool. */
import Schema from '@deepseek-ai/schemastery'
import * as Inspector from '@deepseek-ai/dsh-experimental-inspector'

export const name = 'dscode-experimental-inspector'
export const Config = Schema.object({
  unsafeCaptureFetch: Schema.boolean().default(false),
})

export async function apply(ctx, config) {
  ctx.logger.warn('Inspector enabled: the loopback debugger grants full host code execution. Do not forward its port.'
    + (config.unsafeCaptureFetch ? ' RAW FETCH CAPTURE ENABLED: headers and bodies can contain credentials.' : ' Fetch capture is off.'))
  // The pinned public Host apply only uses webServer's index-inject hook;
  // it does not read that service. A TUI host needs no HTTP/Web Client stack.
  await Inspector.apply(ctx, Inspector.Config({
    host: '127.0.0.1', port: 0, captureFetch: config.unsafeCaptureFetch === true,
    clientOrigins: [], maxRetainedRequests: 64, maxJournalBytes: 8 * 1024 * 1024,
    maxRequestBodyBytes: 256 * 1024, maxResponseBodyBytes: 1024 * 1024,
    maxQueuedBytes: 2 * 1024 * 1024, maxDisconnectedCordisTrees: 0,
  }))
  // Consume the public bootstrap hook to discover the OS-assigned endpoint.
  // No browser Client is attached and its ingest credential is not retained.
  const injections = []
  await ctx.parallel('webserver/index-inject', injections)
  const bootstrap = injections.find(item => item.kind === 'global' && item.name === '__DSH_INSPECTOR__')?.value
  const endpoint = new URL(bootstrap?.endpoint)
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port) throw new Error('Inspector did not publish a loopback endpoint')
  const httpUrl = `http://127.0.0.1:${endpoint.port}/`
  const targets = await (await fetch(httpUrl + 'json/list', { signal: AbortSignal.timeout(3000) })).json()
  const target = targets.find(target => target.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${endpoint.port}/`))
  if (!target?.devtoolsFrontendUrl) throw new Error('Inspector did not publish a DevTools target')
  ctx.effect(() => ctx.provide('dscodeInspector', { url: target.devtoolsFrontendUrl, httpUrl, captureFetch: config.unsafeCaptureFetch === true }))
}
