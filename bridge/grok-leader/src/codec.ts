/**
 * Grok leader wire framing: 4-byte big-endian payload length followed by a
 * JSON payload. Mirrors read_frame/write_frame in xai-grok-shell
 * leader/protocol.rs; the envelope JSON layer lives in protocol.ts.
 * @module dscode/codec
 */
import type { Writable } from 'node:stream'

/** Largest accepted frame payload, mirroring MAX_MESSAGE_SIZE in protocol.rs. */
export const MAX_MESSAGE_SIZE = 64 * 1024 * 1024

/** A byte sequence violates the leader framing contract. */
export class FrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrameError'
  }
}

/**
 * Prefix one payload with its 4-byte big-endian length.
 * @param payload - the frame body.
 * @returns the complete length-prefixed frame.
 */
export function encodeFrame(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > MAX_MESSAGE_SIZE) {
    throw new FrameError('message too large: ' + String(payload.byteLength) + ' bytes (max: ' + String(MAX_MESSAGE_SIZE) + ')')
  }
  const frame = new Uint8Array(4 + payload.byteLength)
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(0, payload.byteLength)
  frame.set(payload, 4)
  return frame
}

/**
 * Serialize a value as one length-prefixed JSON frame.
 * @param value - JSON-serializable envelope message.
 * @returns the complete frame.
 */
const textEncoder = new TextEncoder()
export function encodeJsonFrame(value: unknown): Uint8Array {
  return encodeFrame(textEncoder.encode(JSON.stringify(value)))
}

/** Bound queued output when a client stops reading. Node preserves frame order. */
export function writeJsonFrame(socket: Writable, value: unknown): void {
  if (socket.destroyed) return
  const frame = encodeJsonFrame(value)
  if (socket.writableLength + frame.byteLength > MAX_MESSAGE_SIZE + 4) {
    socket.destroy(new FrameError('client is not reading; outgoing frame queue exceeded 64 MiB'))
    return
  }
  socket.write(frame)
}

/** Let an async replay pause without dropping a healthy but slower reader. */
export function waitForDrain(socket: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      socket.off('drain', drained).off('close', closed).off('error', finish)
      if (error === undefined) resolve()
      else reject(error)
    }
    const drained = () => finish()
    const closed = () => finish(new FrameError('client disconnected during replay'))
    socket.once('drain', drained).once('close', closed).once('error', finish)
    if (socket.destroyed) closed()
    else if (!socket.writableNeedDrain) drained()
  })
}

/**
 * Incremental decoder for a byte stream of length-prefixed frames. Each
 * push() returns the frames the new bytes complete; partial frames stay
 * buffered until their body arrives.
 */
export class FrameDecoder {
  #header = new Uint8Array(4)
  #headerBytes = 0
  #body: Uint8Array | undefined
  #bodyBytes = 0

  /**
   * Feed received bytes and collect every newly completed frame.
   * @param chunk - next received byte range.
   * @returns complete frame payloads, in wire order.
   * @throws {FrameError} when a declared payload length exceeds MAX_MESSAGE_SIZE.
   */
  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = []
    let offset = 0
    while (offset < chunk.byteLength) {
      if (this.#body === undefined) {
        const count = Math.min(4 - this.#headerBytes, chunk.byteLength - offset)
        this.#header.set(chunk.subarray(offset, offset + count), this.#headerBytes)
        this.#headerBytes += count
        offset += count
        if (this.#headerBytes < 4) break
        const length = new DataView(this.#header.buffer).getUint32(0)
        if (length > MAX_MESSAGE_SIZE) {
          throw new FrameError('message too large: ' + String(length) + ' bytes (max: ' + String(MAX_MESSAGE_SIZE) + ')')
        }
        // One bounded allocation and one copy per byte, independent of socket
        // fragmentation. Never retain buffers that the caller can mutate.
        this.#body = new Uint8Array(length)
      }
      const count = Math.min(this.#body.byteLength - this.#bodyBytes, chunk.byteLength - offset)
      this.#body.set(chunk.subarray(offset, offset + count), this.#bodyBytes)
      this.#bodyBytes += count
      offset += count
      if (this.#bodyBytes !== this.#body.byteLength) break
      frames.push(this.#body)
      this.#body = undefined
      this.#bodyBytes = this.#headerBytes = 0
    }
    return frames
  }
}
