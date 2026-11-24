/**
 * Mock identity for the Relay, modeled on the protocol package's local-loopback MockIdentityProvider
 * (identity/mock.ts) and its IdentityProvider contract (identity/types.ts). It is deliberately not
 * an authentication boundary: every issuer here exists so the wire contract can run on a trusted
 * network. Swap this module for a real OAuth adapter later — its exports are the seam.
 *
 * Owner login follows host/owner-authorization.ts exactly:
 *   1. The owner host opens the Relay page GET /__liveshare/owner-authorize
 *      ?state&code_challenge(S256)&instance&origin and this module records that pending
 *      authorization.
 *   2. The served page (popup) confirms on the Relay's own origin; this module mints one single-use
 *      code bound to that pending authorization, and the page postMessage { type:
 *      'liveshare-auth-code', code, state } back to the opener origin (client/owner-login.ts).
 *   3. The owner host redeems POST /__liveshare/owner-credential { code, code_verifier,
 *      instanceKey }; this module checks S256(code_verifier) against the recorded challenge and the
 *      instance binding, then issues an HMAC-signed credential token whose payload decodes the way
 *      host/owner-credential-file.ts decodeOwnerCredential expects.
 *
 * Viewers are guests: carrying a share link is the identity. A cookie names one session so the
 * subject id stays stable across reads; the actor triple is provider/tenant/subject exactly as the
 * ShareRpcActor contract requires.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { base64Url, fromBase64Url } from './base64url.mjs'

/** Fixed mock provider id; mock.ts uses the adapter id as providerId. */
export const MOCK_PROVIDER_ID = 'local-mock'
/** Tenant placeholder mock.ts uses for personas without a tenant. */
export const MOCK_TENANT_ID = 'mock'

/** Fixed local personas a mock login page may select (mock.ts MockIdentityPersona). */
export const MOCK_PERSONAS = [
  { id: 'owner', displayName: '本地 Owner' },
  { id: 'reviewer', displayName: '本地 Reviewer' },
]

const AUTHORIZE_TTL_MS = 10 * 60 * 1000
const CODE_TTL_MS = 10 * 60 * 1000
const VIEWER_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Create the mock identity issuer.
 * @param options Signing secret (persisted by the store so credentials survive restarts), the
 *   owner-credential lifetime, and the viewer cookie name.
 */
export function createMockIdentity({
  secret,
  credentialTtlMs = 24 * 60 * 60 * 1000,
  viewerCookieName = 'liveshare_viewer',
  now = Date.now,
} = {}) {
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('mock identity requires a non-empty signing secret')
  }
  const signingKey = Buffer.from(secret, 'utf8')
  /** state -> pending authorization from the authorize URL. */
  const authorizations = new Map()
  /** code -> minted one-time code bound to its authorization. */
  const codes = new Map()
  /** cookie session value -> { actor, expiresAt }. */
  const viewerSessions = new Map()

  const sweep = () => {
    const at = now()
    for (const [state, record] of authorizations) {
      if (at >= record.expiresAt) authorizations.delete(state)
    }
    for (const [code, record] of codes) {
      if (at >= record.expiresAt) codes.delete(code)
    }
    for (const [value, record] of viewerSessions) {
      if (at >= record.expiresAt) viewerSessions.delete(value)
    }
  }

  /**
   * Record the pending authorization one owner-host authorize URL states.
   * @param input Values from GET /__liveshare/owner-authorize.
   */
  function beginOwnerAuthorize(input) {
    sweep()
    const { state, codeChallenge, instance, origin } = input
    if (typeof state !== 'string' || state === ''
      || typeof codeChallenge !== 'string' || codeChallenge === ''
      || typeof instance !== 'string' || instance === '') {
      return { ok: false, error: 'invalid-authorization-request' }
    }
    if (typeof origin !== 'string' || origin === '') return { ok: false, error: 'invalid-authorization-request' }
    let parsedOrigin
    try {
      parsedOrigin = new URL(origin)
    } catch {
      return { ok: false, error: 'invalid-origin' }
    }
    if (parsedOrigin.protocol !== 'https:' && parsedOrigin.protocol !== 'http:') {
      return { ok: false, error: 'invalid-origin' }
    }
    authorizations.set(state, {
      challenge: codeChallenge,
      instance,
      origin: parsedOrigin.origin,
      expiresAt: now() + AUTHORIZE_TTL_MS,
    })
    return { ok: true }
  }

  /**
   * Read one pending authorization for page rendering (the origin the code may be posted to).
   * @param state The authorization transaction's state.
   */
  function ownerAuthorizeTarget(state) {
    sweep()
    return authorizations.get(state)
  }

  /**
   * Mint the single-use code one confirmed popup hands back to its opener.
   * @param input The transaction state and the persona the user selected.
   */
  function completeOwnerAuthorize(input) {
    sweep()
    const { state, personaId } = input
    const record = authorizations.get(state)
    if (record === undefined) return { ok: false, error: 'unknown-authorization' }
    const persona = MOCK_PERSONAS.find(candidate => candidate.id === personaId)
    if (persona === undefined) return { ok: false, error: 'unknown-persona' }
    const code = base64Url(randomBytes(24))
    codes.set(code, {
      state,
      challenge: record.challenge,
      instance: record.instance,
      origin: record.origin,
      personaId: persona.id,
      expiresAt: now() + CODE_TTL_MS,
      used: false,
    })
    // One code per transaction: a second confirm needs a fresh authorize URL.
    authorizations.delete(state)
    return { ok: true, code, origin: record.origin }
  }

  /**
   * Redeem one code with its PKCE verifier, exactly the shape host/owner-http-routes.ts posts.
   * @param input The code, the S256 verifier, and the instance key in force.
   */
  function redeemOwnerLoginCode(input) {
    sweep()
    const { code, codeVerifier, instanceKey } = input
    if (typeof code !== 'string' || code === ''
      || typeof codeVerifier !== 'string' || codeVerifier === ''
      || typeof instanceKey !== 'string' || instanceKey === '') {
      return { ok: false, status: 400, error: 'invalid-completion' }
    }
    const record = codes.get(code)
    if (record === undefined) return { ok: false, status: 400, error: 'unknown-code' }
    if (record.used) return { ok: false, status: 401, error: 'code-replayed' }
    if (now() >= record.expiresAt) {
      codes.delete(code)
      return { ok: false, status: 401, error: 'expired-code' }
    }
    const digest = createHash('sha256').update(codeVerifier).digest()
    const expected = fromBase64Url(record.challenge)
    if (expected.length !== digest.length || !timingSafeEqual(expected, digest)) {
      return { ok: false, status: 403, error: 'challenge-mismatch' }
    }
    if (record.instance !== instanceKey) return { ok: false, status: 403, error: 'instance-mismatch' }
    record.used = true
    const persona = MOCK_PERSONAS.find(candidate => candidate.id === record.personaId)
    if (persona === undefined) return { ok: false, status: 500, error: 'unknown-persona' }
    const expiresAtMs = now() + credentialTtlMs
    const payload = {
      providerId: MOCK_PROVIDER_ID,
      tenantId: MOCK_TENANT_ID,
      subjectId: persona.id,
      displayName: persona.displayName,
      instanceKey,
      expiresAt: expiresAtMs,
    }
    return {
      ok: true,
      credential: signCredential(payload),
      ownerCredentialExpiresAt: new Date(expiresAtMs).toISOString(),
      identity: identityOf(payload),
    }
  }

  /**
   * Sign one credential payload into the token shape decodeOwnerCredential reads.
   * @param payload Plain object payload; `expiresAt` stays an epoch-milliseconds number.
   */
  function signCredential(payload) {
    const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8')
    const signature = createHmac('sha256', signingKey).update(payloadBytes).digest()
    return `${base64Url(payloadBytes)}.${base64Url(signature)}`
  }

  /**
   * Verify one credential token's signature. The signed expiry is not enforced here: the Relay
   * renews the login behind a credential (owner-credential-file.ts), so a signature-valid token is
   * what the Relay accepts and what it answers a horizon for.
   * @param token Credential token exactly as presented.
   */
  function verifyOwnerCredential(token) {
    if (typeof token !== 'string' || token === '') return undefined
    const dot = token.lastIndexOf('.')
    if (dot <= 0) return undefined
    const payloadBytes = fromBase64Url(token.slice(0, dot))
    const signature = fromBase64Url(token.slice(dot + 1))
    const expected = createHmac('sha256', signingKey).update(payloadBytes).digest()
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return undefined
    let payload
    try {
      payload = JSON.parse(payloadBytes.toString('utf8'))
    } catch {
      return undefined
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
    return payload
  }

  /**
   * The actor triple one credential payload asserts.
   * @param payload Decoded credential payload.
   */
  function identityOf(payload) {
    return {
      providerId: typeof payload.providerId === 'string' && payload.providerId !== '' ? payload.providerId : MOCK_PROVIDER_ID,
      tenantId: typeof payload.tenantId === 'string' && payload.tenantId !== '' ? payload.tenantId : MOCK_TENANT_ID,
      subjectId: typeof payload.subjectId === 'string' ? payload.subjectId : '',
      displayName: typeof payload.displayName === 'string' ? payload.displayName : undefined,
    }
  }

  /**
   * Read the viewer actor one cookie session names.
   * @param cookieValue Raw cookie value (the session part, without the share prefix).
   */
  function viewerActorFor(cookieValue) {
    sweep()
    const record = viewerSessions.get(cookieValue)
    if (record === undefined) return undefined
    return record.actor
  }

  /**
   * Mint one viewer session bound to the share its page presents. Carrying the link is the mock
   * identity; the cookie only keeps one subject id stable across reads.
   * @param shareId The share this viewer came in through.
   */
  function createViewerSession(shareId) {
    sweep()
    const sessionValue = base64Url(randomBytes(12))
    const short = sessionValue.slice(0, 4)
    const actor = {
      providerId: MOCK_PROVIDER_ID,
      tenantId: MOCK_TENANT_ID,
      subjectId: `guest-${sessionValue.slice(0, 8)}`,
      displayName: `访客 ${short}`,
    }
    viewerSessions.set(sessionValue, { actor, shareId, expiresAt: now() + VIEWER_TTL_MS })
    return { cookieValue: sessionValue, actor }
  }

  return {
    providerId: MOCK_PROVIDER_ID,
    tenantId: MOCK_TENANT_ID,
    personas: MOCK_PERSONAS,
    viewerCookieName,
    beginOwnerAuthorize,
    ownerAuthorizeTarget,
    completeOwnerAuthorize,
    redeemOwnerLoginCode,
    verifyOwnerCredential,
    viewerActorFor,
    createViewerSession,
  }
}
