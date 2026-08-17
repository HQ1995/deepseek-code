/**
 * Grok leader envelope types and wire mapping. Outer frames carry one tagged
 * JSON message with snake_case wire names (protocol.rs); an acp payload embeds
 * one JSON-RPC 2.0 request/notification STRING in the ACP camelCase dialect.
 * Wire names and defaults mirror the real TUI capture in
 * tests/fixtures/grok-tui-messages.jsonl.
 * @module @deepseek-ai/dsh-grok-leader/protocol
 */

import { FrameError } from './codec.ts'

/** Leader wire version advertised on registration (protocol.rs). */
export const LEADER_PROTOCOL_VERSION = 1

/** How the client exchanges ACP traffic with the leader (protocol.rs ClientMode). */
export type ClientMode = 'headless' | 'stdio'

/** Client capabilities reported during registration (protocol.rs ClientCapabilities). */
export interface ClientCapabilities {
  yoloMode?: boolean
  autoMode?: boolean
  defaultModel?: string | null
  clientVersion?: string | null
  codeNavEnabled?: boolean
  terminal?: boolean
  fsRead?: boolean
  fsWrite?: boolean
}

/** Registration handshake request. First message every client must send. */
export interface RegisterMessage {
  type: 'register'
  clientType: string
  mode: ClientMode
  capabilities?: ClientCapabilities
}

/** One embedded ACP JSON-RPC message from the client. */
export interface AcpMessage {
  type: 'acp'
  payload: string
}

/** Leader control-plane request; this leader implements no control commands. */
export interface ControlMessage {
  type: 'control'
  requestId: string
  command: unknown
}

export interface PingMessage {
  type: 'ping'
}

export interface DisconnectMessage {
  type: 'disconnect'
}

export type ClientMessage = RegisterMessage | AcpMessage | ControlMessage | PingMessage | DisconnectMessage

/** Leader capabilities advertised on registration (protocol.rs LeaderCapabilities). */
export interface LeaderCapabilities {
  controlV1?: boolean
  runtimeCpuProfile?: boolean
  profileFormats?: string[]
  workspaceExposure?: boolean
  relaunchV1?: boolean
}

/** Registration confirmation (protocol.rs ServerMessage::Registered). */
export interface RegisteredMessage {
  type: 'registered'
  clientId: number
  ready: boolean
  leaderProtocolVersion?: number
  leaderBinaryVersion?: string
  leaderCapabilities?: LeaderCapabilities
}

/** One embedded ACP JSON-RPC message for the client. */
export interface ServerAcpMessage {
  type: 'acp'
  payload: string
}

export interface PongMessage {
  type: 'pong'
}

export interface ErrorMessage {
  type: 'error'
  code: number
  message: string
}

/** ControlResult with the serde Err arm; only the unsupported error is sent. */
export interface ControlResultMessage {
  type: 'controlResult'
  requestId: string
  result: { Err: { code: string; message: string } }
}

export type ServerMessage = RegisteredMessage | ServerAcpMessage | PongMessage | ErrorMessage | ControlResultMessage

/**
 * Serialize a typed server envelope to its snake_case wire form. The wire
 * names are pinned by the capture in tests/fixtures/grok-tui-messages.jsonl.
 * @param msg - typed envelope message.
 * @returns the wire object, ready for JSON framing.
 */
export function encodeServerMessage(msg: ServerMessage): Record<string, unknown> {
  switch (msg.type) {
    case 'registered': {
      const capabilities = msg.leaderCapabilities
      return {
        type: 'registered',
        client_id: msg.clientId,
        ready: msg.ready,
        ...msg.leaderProtocolVersion === undefined ? {} : { leader_protocol_version: msg.leaderProtocolVersion },
        ...msg.leaderBinaryVersion === undefined ? {} : { leader_binary_version: msg.leaderBinaryVersion },
        ...capabilities === undefined ? {} : {
          leader_capabilities: {
            ...capabilities.controlV1 === undefined ? {} : { control_v1: capabilities.controlV1 },
            ...capabilities.runtimeCpuProfile === undefined ? {} : { runtime_cpu_profile: capabilities.runtimeCpuProfile },
            ...capabilities.profileFormats === undefined ? {} : { profile_formats: capabilities.profileFormats },
            ...capabilities.workspaceExposure === undefined ? {} : { workspace_exposure: capabilities.workspaceExposure },
            ...capabilities.relaunchV1 === undefined ? {} : { relaunch_v1: capabilities.relaunchV1 },
          },
        },
      }
    }
    case 'acp':
      return { type: 'acp', payload: msg.payload }
    case 'pong':
      return { type: 'pong' }
    case 'error':
      return { type: 'error', code: msg.code, message: msg.message }
    case 'controlResult':
      return { type: 'control_result', request_id: msg.requestId, result: msg.result }
  }
}

/**
 * Validate one decoded envelope object and map its snake_case wire fields to
 * the typed camelCase form.
 * @param value - parsed envelope JSON.
 * @returns the typed client message.
 * @throws {FrameError} when the object violates the leader wire contract.
 */
export function decodeClientMessage(value: unknown): ClientMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FrameError('leader frame payload is not a JSON object')
  }
  const msg = value as Record<string, unknown>
  switch (msg.type) {
    case 'register': {
      if (typeof msg.client_type !== 'string') throw new FrameError('register message must carry a string client_type')
      if (msg.mode !== 'headless' && msg.mode !== 'stdio') throw new FrameError('register message must carry a headless/stdio mode')
      const raw = msg.capabilities
      if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
        throw new FrameError('register capabilities must be an object')
      }
      const capabilities = raw as Record<string, unknown> | undefined
      return {
        type: 'register',
        clientType: msg.client_type,
        mode: msg.mode,
        ...capabilities === undefined ? {} : {
          capabilities: {
            ...capabilities.yolo_mode === undefined ? {} : { yoloMode: capabilities.yolo_mode === true },
            ...capabilities.auto_mode === undefined ? {} : { autoMode: capabilities.auto_mode === true },
            ...capabilities.default_model === undefined ? {} : { defaultModel: typeof capabilities.default_model === 'string' ? capabilities.default_model : null },
            ...capabilities.client_version === undefined ? {} : { clientVersion: typeof capabilities.client_version === 'string' ? capabilities.client_version : null },
            ...capabilities.code_nav_enabled === undefined ? {} : { codeNavEnabled: capabilities.code_nav_enabled === true },
            ...capabilities.terminal === undefined ? {} : { terminal: capabilities.terminal === true },
            ...capabilities.fs_read === undefined ? {} : { fsRead: capabilities.fs_read === true },
            ...capabilities.fs_write === undefined ? {} : { fsWrite: capabilities.fs_write === true },
          },
        },
      }
    }
    case 'acp':
      if (typeof msg.payload !== 'string') throw new FrameError('acp message must carry a string payload')
      return { type: 'acp', payload: msg.payload }
    case 'control':
      if (typeof msg.request_id !== 'string') throw new FrameError('control message must carry a string request_id')
      return { type: 'control', requestId: msg.request_id, command: msg.command }
    case 'ping':
      return { type: 'ping' }
    case 'disconnect':
      return { type: 'disconnect' }
    default:
      throw new FrameError('unknown leader message type: ' + String(msg.type))
  }
}

/** Inner JSON-RPC 2.0 request/notification; an absent id means notification. */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: unknown
}

/** Inner JSON-RPC 2.0 response object. */
export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** A dispatch error carrying its JSON-RPC error code. */
export class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
    this.name = 'RpcError'
  }
}
