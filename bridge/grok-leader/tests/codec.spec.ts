/**
 * Frame codec and envelope tests pinned to the real grok TUI capture in
 * tests/fixtures/grok-tui-messages.jsonl and docs/grok-leader-protocol.md.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FrameDecoder, FrameError, MAX_MESSAGE_SIZE, MAX_PENDING_BUFFER, encodeFrame, encodeJsonFrame } from '../src/codec.ts'
import { decodeClientMessage, encodeServerMessage, type ServerMessage } from '../src/protocol.ts'

interface CaptureLine {
  ts: string
  dir: 'in' | 'out'
  msg: unknown
}

function capture(): CaptureLine[] {
  const url = new URL('./fixtures/grok-tui-messages.jsonl', import.meta.url)
  return readFileSync(fileURLToPath(url), 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as CaptureLine)
}

const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** Push a frame one byte at a time and return the parsed payload. */
function decodeByteWise(frame: Uint8Array): unknown {
  const decoder = new FrameDecoder()
  let out: Uint8Array | undefined
  for (const byte of frame) {
    const frames = decoder.push(new Uint8Array([byte]))
    if (frames.length > 0) out = frames[0]
  }
  if (out === undefined) throw new Error('no frame decoded')
  return JSON.parse(textOf(out)) as unknown
}

describe('grok leader frame codec', () => {
  it('roundtrips every captured inbound message through frame encode and byte-wise decode', () => {
    for (const line of capture()) {
      if (line.dir !== 'in') continue
      expect(() => decodeClientMessage(line.msg)).not.toThrow()
      expect(decodeByteWise(encodeJsonFrame(line.msg))).toEqual(line.msg)
    }
  })

  it('reproduces the captured registered reply exactly', () => {
    const reply: ServerMessage = {
      type: 'registered',
      clientId: 1,
      ready: true,
      leaderProtocolVersion: 1,
      leaderBinaryVersion: '1.0.4',
      leaderCapabilities: { controlV1: true, workspaceExposure: false, relaunchV1: false },
    }
    const capturedRegistered = capture().find(line =>
      line.dir === 'out' && (line.msg as { type?: string }).type === 'registered')?.msg
    expect(capturedRegistered).toBeDefined()
    expect(JSON.parse(JSON.stringify(encodeServerMessage(reply)))).toEqual(capturedRegistered)
    expect(decodeByteWise(encodeJsonFrame(encodeServerMessage(reply)))).toEqual(capturedRegistered)
  })

  it('reproduces the captured pong reply exactly', () => {
    const capturedPong = capture().find(line =>
      line.dir === 'out' && (line.msg as { type?: string }).type === 'pong')?.msg
    expect(JSON.parse(JSON.stringify(encodeServerMessage({ type: 'pong' })))).toEqual(capturedPong)
  })

  it('pins the serde snake_case control_result wire tag', () => {
    expect(encodeServerMessage({
      type: 'controlResult',
      requestId: 'r1',
      result: { Err: { code: 'internal_error', message: 'not implemented' } },
    })).toEqual({
      type: 'control_result',
      request_id: 'r1',
      result: { Err: { code: 'internal_error', message: 'not implemented' } },
    })
  })

  it('decodes several frames from one chunk and across chunk splits', () => {
    const a = encodeFrame(new TextEncoder().encode('first'))
    const b = encodeFrame(new TextEncoder().encode('second'))
    const whole = new Uint8Array(a.byteLength + b.byteLength)
    whole.set(a, 0)
    whole.set(b, a.byteLength)

    const decoder = new FrameDecoder()
    expect(decoder.push(whole).map(textOf)).toEqual(['first', 'second'])

    const split = new FrameDecoder()
    expect(split.push(whole.slice(0, 2))).toEqual([])
    expect(split.push(whole.slice(2)).map(textOf)).toEqual(['first', 'second'])
  })

  it('decodes an empty payload frame', () => {
    const decoder = new FrameDecoder()
    expect(decoder.push(encodeFrame(new Uint8Array(0)))).toEqual([new Uint8Array(0)])
  })

  it('decodes the original bytes when the source chunk is mutated after a partial push', () => {
    const payload = new TextEncoder().encode('original payload bytes')
    const frame = encodeFrame(payload)
    // The shared backing store the caller may still mutate: a byte larger than
    // the frame so the DataView never touches foreign buffer bytes.
    const buffer = new Uint8Array(frame.byteLength + 8)
    buffer.set(frame, 4)
    const chunk = buffer.subarray(4, 4 + frame.byteLength)
    const decoder = new FrameDecoder()
    // Partial push buffers the header + first bytes; the rest arrives later.
    const rest = chunk.slice(7)
    expect(decoder.push(chunk.slice(0, 7))).toEqual([])
    buffer.fill(0x2a, 4) // caller reuses/mutates the source buffer
    const frames = decoder.push(rest)
    expect(frames).toHaveLength(1)
    expect(textOf(frames[0]!)).toBe('original payload bytes')
  })

  it('rejects a frame declaring more than MAX_MESSAGE_SIZE bytes', () => {
    const header = new Uint8Array(4)
    new DataView(header.buffer).setUint32(0, MAX_MESSAGE_SIZE + 1)
    expect(() => new FrameDecoder().push(header)).toThrow(FrameError)
  })

  it('drops a peer whose incomplete frame exceeds the pending cap', () => {
    const header = new Uint8Array(4)
    new DataView(header.buffer).setUint32(0, MAX_MESSAGE_SIZE)
    const decoder = new FrameDecoder()
    expect(() => decoder.push(header)).not.toThrow()
    expect(() => decoder.push(new Uint8Array(MAX_PENDING_BUFFER))).toThrow(FrameError)
  })

  it('rejects encoding a payload larger than MAX_MESSAGE_SIZE', () => {
    expect(() => encodeFrame(new Uint8Array(MAX_MESSAGE_SIZE + 1))).toThrow(FrameError)
  })

  it('rejects non-object and contract-violating envelopes on decode', () => {
    expect(() => decodeClientMessage(null)).toThrow(FrameError)
    expect(() => decodeClientMessage({ type: 'nope' })).toThrow(FrameError)
    expect(() => decodeClientMessage({ type: 'register', clientType: 'x' })).toThrow(FrameError)
    expect(() => decodeClientMessage({ type: 'acp', payload: 1 })).toThrow(FrameError)
    expect(() => decodeClientMessage({ type: 'register', client_type: 'x', mode: 'stdio', capabilities: null })).toThrow(FrameError)
    expect(() => decodeClientMessage({ type: 'register', client_type: 'x', mode: 'stdio', capabilities: 7 })).toThrow(FrameError)
    expect(() => decodeClientMessage({ type: 'register', client_type: 'x', mode: 'stdio', capabilities: 'yolo' })).toThrow(FrameError)
  })

  it('accepts the captured wrapped _x.ai/log notification shape', () => {
    const log = capture().find(line =>
      line.dir === 'in' && (line.msg as { type?: string }).type === 'acp'
      && ((line.msg as { payload?: string }).payload ?? '').includes('_x.ai/log'))?.msg
    expect(log).toBeDefined()
    expect(() => decodeClientMessage(log)).not.toThrow()
    const payload = JSON.parse((log as { payload: string }).payload) as Record<string, unknown>
    expect(payload.method).toBe('_x.ai/log')
    expect(payload.id).toBeUndefined()
  })
})
