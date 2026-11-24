/**
 * The Relay's share registry and per-share audit trail: an in-memory map keyed by shareId, with an
 * optional JSON file so rows survive restarts. This is the MVP state store the task allows; the
 * official Relay owns a durable store with a monotonic revision, which the access-state `version`
 * field stands for here (starting at 1 per registration, raised on every committed change).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { base64Url } from './base64url.mjs'
import { parseShareAccessStateFields } from './protocol.mjs'

/** Longest audit trail kept per share; the owner panel reads it through GET /__liveshare/audit. */
const AUDIT_LIMIT = 200

/**
 * Create the relay store.
 * @param options State file path (absent keeps everything in memory) and the clock.
 */
export function createRelayStore({ stateFile = '', now = Date.now } = {}) {
  /** shareId -> normalized share row. */
  const shares = new Map()
  /** shareId -> audit entries (in-memory only). */
  const audits = new Map()
  /** Metadata persisted beside the rows: the mock identity signing secret. */
  const meta = { mockSecret: '' }
  let auditCounter = 0

  /** Keep only the fields the wire and the audit read consume; unknown input is dropped. */
  function normalizeRow(value) {
    if (typeof value.shareId !== 'string' || value.shareId === '') return undefined
    if (typeof value.sessionId !== 'string' || typeof value.sessionTitle !== 'string') return undefined
    if (value.accessMode !== 'open' && value.accessMode !== 'selected') return undefined
    if (value.sessionMode !== 'view' && value.sessionMode !== 'write') return undefined
    if (typeof value.gatewayToken !== 'string' || value.gatewayToken === '') return undefined
    if (!Array.isArray(value.allowedSubjectIds) || value.allowedSubjectIds.some(id => typeof id !== 'string' || id === '')) return undefined
    if (value.expiresAt !== undefined && (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)))) return undefined
    let owner
    if (typeof value.owner === 'object' && value.owner !== null
      && typeof value.owner.providerId === 'string' && value.owner.providerId !== ''
      && typeof value.owner.tenantId === 'string' && value.owner.tenantId !== ''
      && typeof value.owner.subjectId === 'string' && value.owner.subjectId !== '') {
      owner = {
        providerId: value.owner.providerId,
        tenantId: value.owner.tenantId,
        subjectId: value.owner.subjectId,
        ...(typeof value.owner.displayName === 'string' ? { displayName: value.owner.displayName } : {}),
      }
    }
    const version = Number.isSafeInteger(value.accessVersion) && value.accessVersion >= 1 ? value.accessVersion : 1
    return {
      shareId: value.shareId,
      sessionId: value.sessionId,
      sessionTitle: value.sessionTitle,
      accessMode: value.accessMode,
      allowedSubjectIds: [...value.allowedSubjectIds],
      sessionMode: value.sessionMode,
      allowsFork: value.allowsFork === true,
      ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
      ownerDisplayName: typeof value.ownerDisplayName === 'string' ? value.ownerDisplayName : value.shareId,
      ...(typeof value.dshVersion === 'string' && value.dshVersion !== '' ? { dshVersion: value.dshVersion } : {}),
      ...(typeof value.ownerInstanceId === 'string' && value.ownerInstanceId !== '' ? { ownerInstanceId: value.ownerInstanceId } : {}),
      ...(typeof value.ownerProviderId === 'string' && value.ownerProviderId !== '' ? { ownerProviderId: value.ownerProviderId } : {}),
      ...(typeof value.ownerTenantId === 'string' && value.ownerTenantId !== '' ? { ownerTenantId: value.ownerTenantId } : {}),
      ...(owner === undefined ? {} : { owner }),
      gatewayToken: value.gatewayToken,
      createdAt: typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
        ? value.createdAt
        : new Date(now()).toISOString(),
      accessVersion: version,
    }
  }

  /**
   * Committed access state of one share, in the exact shape ShareAccessStateFrame carries minus its
   * `type` field (the owner re-adds `type: 'share-access-state'` before parsing).
   * @param row Stored share row.
   */
  function accessStateOf(row) {
    return parseShareAccessStateFields({
      version: row.accessVersion,
      accessMode: row.accessMode,
      allowedSubjectIds: row.allowedSubjectIds,
      sessionMode: row.sessionMode,
      allowsFork: row.allowsFork,
      ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
    })
  }

  /** Commit one share row. */
  function put(row) {
    const normalized = normalizeRow(row)
    if (normalized === undefined) throw new Error('relay store refused an invalid share row')
    shares.set(normalized.shareId, normalized)
    save()
    return normalized
  }

  /** Read one share row. */
  function get(shareId) {
    return shares.get(shareId)
  }

  /** Drop one share row and its audit trail. */
  function remove(shareId) {
    shares.delete(shareId)
    audits.delete(shareId)
    save()
  }

  /** Every stored row. */
  function list() {
    return [...shares.values()]
  }

  /**
   * Append one audit entry for one share.
   * @param shareId Share the entry belongs to.
   * @param action Stable action name.
   * @param extra Actor label and JSON detail.
   */
  function recordAudit(shareId, action, { actor, detail } = {}) {
    auditCounter += 1
    const entry = {
      id: `evt-${String(auditCounter)}`,
      action,
      createdAt: new Date(now()).toISOString(),
      ...(typeof actor === 'string' && actor !== '' ? { actor } : {}),
      ...(detail === undefined ? {} : { detail }),
    }
    const trail = audits.get(shareId) ?? []
    trail.push(entry)
    while (trail.length > AUDIT_LIMIT) trail.shift()
    audits.set(shareId, trail)
    return entry
  }

  /** The audit trail one share carries. */
  function auditFor(shareId) {
    return audits.get(shareId) ?? []
  }

  /** Write the state file atomically; a missing path keeps the store memory-only. */
  function save() {
    if (stateFile === '') return
    const payload = {
      version: 1,
      mockSecret: meta.mockSecret,
      shares: [...shares.values()],
    }
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      const temporary = `${stateFile}.tmp`
      writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(temporary, stateFile)
    } catch (error) {
      console.warn(`[liveshare-relay] state file write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Load rows and the mock secret; a missing or corrupt file is the ordinary first-run state. */
  function load() {
    if (stateFile === '') return
    let raw
    try {
      raw = readFileSync(stateFile, 'utf8')
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return
      if (typeof parsed.mockSecret === 'string' && parsed.mockSecret !== '') meta.mockSecret = parsed.mockSecret
      if (Array.isArray(parsed.shares)) {
        for (const candidate of parsed.shares) {
          const restored = normalizeRow(candidate)
          if (restored !== undefined) shares.set(restored.shareId, restored)
        }
      }
    } catch {
      console.warn('[liveshare-relay] state file is unreadable; starting empty')
    }
  }

  load()
  if (meta.mockSecret === '') {
    meta.mockSecret = base64Url(randomBytes(32))
    save()
  }

  return {
    get stateFile() { return stateFile },
    get mockSecret() { return meta.mockSecret },
    put,
    get,
    remove,
    list,
    accessStateOf,
    recordAudit,
    auditFor,
    save,
  }
}
