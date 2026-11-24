/**
 * LiveShare wire contract, restated for the Relay from the protocol package's compiled source:
 * @deepseek-ai/dsh-experimental-liveshare-protocol (0.2.2-rc.5) src/tunnel-protocol.ts and
 * src/viewer-states.ts. Values are copied verbatim; do not invent names or shapes here.
 */

/** Relay wire version; a gateway handshake naming another value is refused with HTTP 426. */
export const LIVESHARE_PROTOCOL_VERSION = 1

/**
 * Capabilities the current owner build declares at registration. The Relay only reads this
 * informationally: every name is behavior the owner can observe on the wire, and a Relay relies on
 * the frames it serves rather than on this list. `direct-connection` appears in the list but no
 * current owner ever registers a `direct` connection, so there is nothing to refuse here.
 */
export const LIVESHARE_CAPABILITIES = [
  'session-mode',
  'fork',
  'acl-subjects',
  'expiry',
  'owner-credential',
  'scoped-rpc-response',
  'unsupported-frame-refusal',
  'share-access-state',
  'actor-credential',
  'direct-connection',
]

/** `WebSocket.OPEN`, restated so this module carries no socket dependency. */
const SOCKET_OPEN = 1

/**
 * Send one frame when the socket is open. Verbatim behavior of the protocol package's sendFrame.
 * @param socket Owner gateway socket (a `ws` WebSocket satisfies this).
 * @param frame Wire frame.
 */
export function sendFrame(socket, frame) {
  if (socket.readyState === SOCKET_OPEN) socket.send(JSON.stringify(frame))
}

/**
 * Decode one WebSocket data frame without relying on its representation. Verbatim of rawText.
 * @param data Message bytes supplied by ws.
 * @returns UTF-8 text for one complete message.
 */
export function rawText(data) {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the envelope every accepted frame carries from an already-decoded value.
 * @param value Decoded JSON value.
 */
function frameEnvelope(value) {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || Number(value.id) <= 0) return undefined
  return { value, id: Number(value.id) }
}

/**
 * Parse one gateway-to-Relay frame; unknown or malformed frames are dropped.
 * Verbatim behavior of the protocol package's parseGatewayFrame.
 * @param text Raw socket text.
 */
export function parseGatewayFrame(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  const envelope = frameEnvelope(value)
  if (envelope === undefined) return undefined
  const { value: record, id } = envelope
  if (record.type === 'share-rpc-res') {
    if (!Number.isSafeInteger(record.status) || Number(record.status) < 100 || Number(record.status) > 599) return undefined
    return {
      type: 'share-rpc-res',
      id,
      status: Number(record.status),
      ...(record.body === undefined ? {} : { body: record.body }),
    }
  }
  return undefined
}

/**
 * Validate a committed Relay authority snapshot before it is written or served. Verbatim behavior
 * of the protocol package's parseShareAccessState (minus the `type` field, which the Relay adds).
 * @param value Untrusted snapshot fields without `type`.
 */
export function parseShareAccessStateFields(value) {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.version) || Number(value.version) < 0
    || (value.accessMode !== 'open' && value.accessMode !== 'selected')
    || !isSubjectIds(value.allowedSubjectIds)
    || (value.sessionMode !== 'view' && value.sessionMode !== 'write')
    || (value.allowsFork !== undefined && typeof value.allowsFork !== 'boolean')
    || (value.expiresAt !== undefined
      && (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))))) {
    return undefined
  }
  return {
    version: Number(value.version),
    accessMode: value.accessMode,
    allowedSubjectIds: [...value.allowedSubjectIds],
    sessionMode: value.sessionMode,
    ...(value.allowsFork === undefined ? {} : { allowsFork: value.allowsFork }),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
  }
}

function isSubjectIds(value) {
  return Array.isArray(value) && value.every(id => typeof id === 'string' && id !== '')
}

/**
 * Canonical ACL key for one identity triple (protocol package identityKeyOf).
 * @param identity Provider, tenant, and subject triple.
 */
export function identityKeyOf(identity) {
  return [
    encodeURIComponent(identity.providerId),
    encodeURIComponent(identity.tenantId),
    encodeURIComponent(identity.subjectId),
  ].join(':')
}

/**
 * The Relay's own admission rule, restated from owner relay-authority.ts requesterStillAdmitted:
 * an open share admits everyone once its own ACL is empty; every share admits the subjects its ACL
 * names, by bare subject id or by canonical identity key.
 * @param state Committed share access state.
 * @param actor Actor the Relay asserts for one viewer request.
 */
export function viewerAdmitted(state, actor) {
  if (state.allowedSubjectIds.length === 0) return state.accessMode === 'open'
  return state.allowedSubjectIds.includes(actor.subjectId)
    || state.allowedSubjectIds.includes(identityKeyOf(actor))
}

/**
 * Whether a share's ISO deadline has passed.
 * @param expiresAt ISO deadline, or undefined for never.
 */
export function isExpired(expiresAt) {
  if (expiresAt === undefined) return false
  const at = Date.parse(expiresAt)
  return Number.isFinite(at) && at <= Date.now()
}

/**
 * Viewer conditions the Relay answers with, each paired with the one answer that means it
 * (protocol package viewer-states.ts; HTTP statuses and error codes are the Relay's to choose).
 *
 * The carrier (viewer-carrier.ts) classifies answers as: 401/403 terminal whatever the code;
 * 408/429/502/503/504 retryable carrier loss; codes `stream-not-found`/`gateway/cancelled`
 * retryable; every other code a terminal remote refusal. The mapping below keeps each condition on
 * the side of that line its VIEWER_STATE_REACH definition states.
 */
export const VIEWER_REFUSALS = {
  'share-not-found': { status: 404, code: 'share-not-found', message: 'this link names no share' },
  'share-stopped': { status: 410, code: 'share-stopped', message: 'the owner stopped this share' },
  'share-expired': { status: 410, code: 'share-expired', message: 'this share has expired' },
  'owner-offline': { status: 503, code: 'owner-offline', message: 'no live owner gateway holds this share' },
  'sign-in-expired': { status: 401, code: 'sign-in-expired', message: 'viewer sign-in expired' },
  'access-denied': { status: 403, code: 'access-denied', message: 'this share does not admit this viewer' },
}

/**
 * Build one viewer refusal answer body.
 * @param condition Viewer state condition.
 * @param detail Optional message override.
 */
export function viewerRefusal(condition, detail) {
  const entry = VIEWER_REFUSALS[condition]
  return {
    status: entry.status,
    body: { error: { code: entry.code, message: detail ?? entry.message, details: {} } },
  }
}

/** Routing fields an opaque viewer request carries, for logging only (protocol viewerRequestFields). */
export function viewerRequestFields(body) {
  if (typeof body !== 'object' || body === null) return { op: 'unknown', streamId: '-' }
  const value = body
  return {
    op: typeof value.op === 'string' ? value.op : 'unknown',
    streamId: typeof value.id === 'number' ? String(value.id) : '-',
  }
}
