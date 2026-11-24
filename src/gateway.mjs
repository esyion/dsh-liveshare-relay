/**
 * Owner gateway registry: the WS half of the wire contract.
 *
 * Registration follows owner-gateway/registration-url.ts exactly: GET {base}/__tunnel_gateway__ with
 * the share's fields as query parameters, `authorization: Bearer <gatewayToken>`, and the optional
 * `x-liveshare-owner-credential` header. A handshake the Relay will not establish is answered with an
 * HTTP status instead of an upgrade (owner-gateway/relay-refusal.ts): 401 credential not accepted,
 * 403 forbidden for this share, 410 share no longer served, 426 unsupported protocol — every other
 * failure is transient and stays with the owner's own reconnect schedule.
 *
 * Frames the Relay sends: share-rpc / share-rpc-cancel / share-access-state
 * (tunnel-protocol.ts RelayFrame). Frames it reads: share-rpc-res only (parseGatewayFrame). The
 * worker heartbeats with pings every 25s; this side pings back the same way and answers its pings
 * automatically through `ws`.
 */

import { WebSocketServer } from 'ws'
import {
  LIVESHARE_PROTOCOL_VERSION,
  parseGatewayFrame,
  rawText,
  sendFrame,
  viewerRefusal,
} from './protocol.mjs'

const HEARTBEAT_INTERVAL_MS = 25_000
/** Consecutive unanswered pongs tolerated before the Relay drops the socket (worker symmetry). */
const MAX_MISSED_PONGS = 2
/** Longest one forwarded viewer request may wait; beyond it the read answers 504 (retryable). */
const RPC_TIMEOUT_MS = 130_000

/**
 * Create the gateway registry.
 * @param options Shared store and identity modules, the URL base path, and a logger.
 */
export function createGatewayRegistry({ store, identity, basePath = '', log = console } = {}) {
  const wss = new WebSocketServer({ noServer: true })
  /** shareId -> connection { row, socket, pending, nextId, heartbeat, ... }. */
  const connections = new Map()

  const offlineAnswer = () => viewerRefusal('owner-offline')

  /** Answer one refused handshake with a plain HTTP status on the upgrade socket. */
  function refuse(socket, status, reason) {
    log.warn?.(`[liveshare-relay] gateway handshake refused status=${String(status)}`)
    socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
  }

  /** Read the Bearer token one Authorization header carries. */
  function bearerToken(header) {
    if (typeof header !== 'string') return undefined
    const match = /^Bearer\s+(.+)$/u.exec(header.trim())
    const token = match?.[1]?.trim()
    return token === undefined || token === '' ? undefined : token
  }

  /** First header value when Node hands back an array. */
  function firstHeader(value) {
    return Array.isArray(value) ? value[0] : value
  }

  /**
   * Handle one HTTP upgrade; called from the server's 'upgrade' event for every request.
   * @param req Upgrade request.
   * @param socket Duplex socket the handshake runs on.
   * @param head First packet bytes.
   */
  function handleUpgrade(req, socket, head) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://relay.internal')
    } catch {
      return refuse(socket, 400, 'Bad Request')
    }
    if (url.pathname !== `${basePath}/__tunnel_gateway__`) return refuse(socket, 404, 'Not Found')

    const params = url.searchParams
    // 1) Protocol version first: it is the one surface an older owner meets a newer Relay on.
    if (params.get('protocolVersion') !== String(LIVESHARE_PROTOCOL_VERSION)) {
      return refuse(socket, 426, 'Upgrade Required')
    }
    // 2) The share's management token, and 3) the owner credential the Relay is the authority for.
    const gatewayToken = bearerToken(req.headers.authorization)
    if (gatewayToken === undefined) return refuse(socket, 401, 'Unauthorized')
    const credentialPayload = identity.verifyOwnerCredential(firstHeader(req.headers['x-liveshare-owner-credential']))
    if (credentialPayload === undefined) return refuse(socket, 401, 'Unauthorized')

    // 4) Registration fields. Optional absents stay absent: a missing sessionMode reads as view and
    // a missing allowsFork as no forking, exactly as registration-url.ts documents.
    const shareId = params.get('shareId') ?? ''
    const sessionId = params.get('sessionId') ?? ''
    const sessionTitle = params.get('sessionTitle') ?? ''
    const ownerDisplayName = params.get('ownerDisplayName') ?? ''
    const accessMode = params.get('accessMode') ?? ''
    if (shareId === '' || sessionId === '' || ownerDisplayName === ''
      || (accessMode !== 'open' && accessMode !== 'selected')) {
      return refuse(socket, 400, 'Bad Request')
    }
    const sessionModeParam = params.get('sessionMode')
    const sessionMode = sessionModeParam === null ? 'view' : sessionModeParam
    if (sessionMode !== 'view' && sessionMode !== 'write') return refuse(socket, 400, 'Bad Request')
    const allowedSubjectIds = [...new Set(params.getAll('allowedSubjectId'))].filter(subject => subject !== '')
    const expiresAtParam = params.get('expiresAt')
    const expiresAt = expiresAtParam === null || expiresAtParam === '' ? undefined : expiresAtParam
    if (expiresAt !== undefined && !Number.isFinite(Date.parse(expiresAt))) return refuse(socket, 400, 'Bad Request')
    const allowsFork = params.get('allowsFork') === '1'

    wss.handleUpgrade(req, socket, head, (client) => {
      attach({
        socket: client,
        row: {
          shareId,
          sessionId,
          sessionTitle,
          accessMode,
          allowedSubjectIds,
          sessionMode,
          allowsFork,
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ownerDisplayName,
          ...(params.get('dshVersion') ?? '') !== '' ? { dshVersion: params.get('dshVersion') } : {},
          ...(params.get('ownerInstanceId') ?? '') !== '' ? { ownerInstanceId: params.get('ownerInstanceId') } : {},
          ...(params.get('ownerProviderId') ?? '') !== '' ? { ownerProviderId: params.get('ownerProviderId') } : {},
          ...(params.get('ownerTenantId') ?? '') !== '' ? { ownerTenantId: params.get('ownerTenantId') } : {},
          owner: {
            providerId: typeof credentialPayload.providerId === 'string' && credentialPayload.providerId !== ''
              ? credentialPayload.providerId
              : identity.providerId,
            tenantId: typeof credentialPayload.tenantId === 'string' && credentialPayload.tenantId !== ''
              ? credentialPayload.tenantId
              : identity.tenantId,
            subjectId: typeof credentialPayload.subjectId === 'string' ? credentialPayload.subjectId : '',
            ...(typeof credentialPayload.displayName === 'string' ? { displayName: credentialPayload.displayName } : {}),
          },
          gatewayToken,
        },
      })
    })
  }

  /** Commit one registration and start serving its socket. */
  function attach({ socket, row }) {
    const previous = store.get(row.shareId)
    // A re-registration replaces the row and keeps its creation time and committed version.
    row.createdAt = previous?.createdAt ?? new Date().toISOString()
    row.accessVersion = previous?.accessVersion ?? 1

    const oldConnection = connections.get(row.shareId)
    if (oldConnection !== undefined) {
      detach(oldConnection)
      try {
        oldConnection.socket.close(1000, 'replaced by re-registration')
      } catch {
        oldConnection.socket.terminate()
      }
    }

    const connection = {
      row,
      socket,
      pending: new Map(),
      nextId: 1,
      awaitingPong: false,
      missedPongs: 0,
      heartbeat: undefined,
    }
    connections.set(row.shareId, connection)
    store.put(row)
    store.recordAudit(row.shareId, 'share.published', {
      actor: row.owner?.subjectId,
      detail: { sessionTitle: row.sessionTitle, sessionId: row.sessionId, accessMode: row.accessMode, sessionMode: row.sessionMode },
    })
    log.log?.(`[liveshare-relay] gateway registered share=${row.shareId} owner=${row.owner?.subjectId ?? 'unknown'}`)

    connection.heartbeat = setInterval(() => {
      if (socket.readyState !== 1) return
      if (connection.awaitingPong) {
        connection.missedPongs += 1
        if (connection.missedPongs >= MAX_MISSED_PONGS) {
          socket.terminate()
          return
        }
        log.warn?.(`[liveshare-relay] gateway heartbeat missed share=${row.shareId} missedPongs=${String(connection.missedPongs)}`)
        return
      }
      connection.awaitingPong = true
      socket.ping()
    }, HEARTBEAT_INTERVAL_MS)

    const sendAccessState = () => {
      const state = store.accessStateOf(row)
      if (state !== undefined) sendFrame(socket, { type: 'share-access-state', ...state })
    }
    if (socket.readyState === 1) sendAccessState()
    else socket.once('open', sendAccessState)

    socket.on('pong', () => {
      connection.awaitingPong = false
      connection.missedPongs = 0
    })
    socket.on('message', (data) => {
      // Any traffic proves the peer is alive, so a late pong does not count as missed.
      connection.awaitingPong = false
      connection.missedPongs = 0
      const frame = parseGatewayFrame(rawText(data))
      if (frame === undefined) {
        log.warn?.(`[liveshare-relay] dropped one malformed gateway frame share=${row.shareId}`)
        return
      }
      const pending = connection.pending.get(frame.id)
      if (pending !== undefined) pending.settle(frame)
      else log.warn?.(`[liveshare-relay] dropped one late read answer share=${row.shareId} relayId=${String(frame.id)}`)
    })
    socket.on('close', () => {
      if (connections.get(row.shareId) !== connection) return
      detach(connection)
      store.recordAudit(row.shareId, 'share.offline', {})
      log.warn?.(`[liveshare-relay] gateway closed share=${row.shareId}`)
    })
    socket.on('error', () => socket.terminate())
  }

  /** Release one connection's timers and in-flight reads without touching the registry mapping. */
  function detach(connection) {
    if (connection.heartbeat !== undefined) clearInterval(connection.heartbeat)
    connection.heartbeat = undefined
    for (const pending of connection.pending.values()) pending.settle(offlineAnswer())
    connection.pending.clear()
  }

  /**
   * Begin one forwarded viewer request: send one share-rpc frame and wait for its share-rpc-res.
   * @param row Share row carrying the request.
   * @param body Opaque viewer request, forwarded unread.
   * @param actor Identity the Relay asserts for this request (travels outside the body).
   * @returns The answer promise and the cancel operation for a viewer that went away.
   */
  function beginCall(row, body, actor) {
    const connection = connections.get(row.shareId)
    if (connection === undefined || connection.socket.readyState !== 1) {
      return { promise: Promise.resolve(offlineAnswer()), cancel() {} }
    }
    const id = connection.nextId += 1
    const pending = { settle: undefined, timer: undefined }
    const promise = new Promise((resolve) => {
      pending.settle = (answer) => {
        if (connection.pending.get(id) !== pending) return
        connection.pending.delete(id)
        if (pending.timer !== undefined) clearTimeout(pending.timer)
        resolve(answer)
      }
      pending.timer = setTimeout(() => pending.settle({
        status: 504,
        body: { error: { code: 'owner-offline', message: 'owner did not answer in time', details: {} } },
      }), RPC_TIMEOUT_MS)
      connection.pending.set(id, pending)
      sendFrame(connection.socket, { type: 'share-rpc', id, body, actor })
    })
    return {
      promise,
      cancel() {
        if (connection.pending.get(id) !== pending) return
        pending.settle(offlineAnswer())
        sendFrame(connection.socket, { type: 'share-rpc-cancel', id })
      },
    }
  }

  /** Close one share's gateway socket; the row stays so a reconnect may re-register it. */
  function closeShare(shareId) {
    const connection = connections.get(shareId)
    if (connection === undefined) return
    connections.delete(shareId)
    detach(connection)
    try {
      connection.socket.close(1000, 'share removed')
    } catch {
      connection.socket.terminate()
    }
  }

  /** Close every gateway socket (shutdown). */
  function closeAll() {
    for (const shareId of [...connections.keys()]) closeShare(shareId)
  }

  return {
    handleUpgrade,
    beginCall,
    closeShare,
    closeAll,
    connectionCount: () => connections.size,
    shareOnline: (shareId) => {
      const connection = connections.get(shareId)
      return connection !== undefined && connection.socket.readyState === 1
    },
  }
}
