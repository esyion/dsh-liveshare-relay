/**
 * End-to-end smoke test for the LiveShare Relay.
 *
 * Simulates both sides of the wire contract against a running relay:
 *   - the owner: PKCE login over the mock page, WS gateway registration, /requests read,
 *     DELETE stop — exactly the URLs, headers, and frames owner-gateway/worker.ts and
 *     host/tunnel-supervision.ts produce;
 *   - the viewer: page fetch (asset read + carrier injection), /__share/rpc passthrough.
 *
 * Usage: node smoke-test.mjs [baseUrl]   (default http://127.0.0.1:8787)
 */

import { WebSocket } from 'ws'
import { createHash, randomBytes } from 'node:crypto'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787'
const b64url = value => Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
let failures = 0

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

async function jsonFetch(path, init) {
  const response = await fetch(`${BASE}${path}`, init)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, headers: response.headers, body, text }
}

/* 1) Owner login over the mock page (PKCE S256, as host/owner-authorization.ts mints it). */
console.log('== owner login ==')
const verifier = b64url(randomBytes(32))
const challenge = b64url(createHash('sha256').update(verifier).digest())
const state = b64url(randomBytes(16))
const instanceKey = 'smoke-instance'
const ownerOrigin = 'http://127.0.0.1:51194'

const authorizeResponse = await fetch(`${BASE}/__liveshare/owner-authorize?state=${state}&code_challenge=${challenge}&instance=${instanceKey}&origin=${encodeURIComponent(ownerOrigin)}`)
check('authorize page answers 200', authorizeResponse.status === 200)
const confirmResponse = await fetch(`${BASE}/__liveshare/owner-authorize/confirm`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: `state=${encodeURIComponent(state)}&persona=owner`,
})
const confirmHtml = await confirmResponse.text()
const code = /"code":"([^"]+)"/u.exec(confirmHtml)?.[1]
check('confirm page mints a code', confirmResponse.status === 200 && typeof code === 'string' && code !== '')

const redeem = await jsonFetch('/__liveshare/owner-credential', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code, code_verifier: verifier, instanceKey }),
})
check('redeem answers 200 with a credential', redeem.status === 200 && typeof redeem.body.credential === 'string')
const credential = redeem.body.credential

const probe = await jsonFetch('/__liveshare/owner-credential', { headers: { 'x-liveshare-owner-credential': credential } })
check('credential probe reports supported + horizon', probe.status === 200 && probe.body.supported === true && typeof probe.body.ownerCredentialExpiresAt === 'string')

/* 2) Gateway registration refusals, then the accepted handshake. */
console.log('== gateway registration ==')
const shareId = `smoke-${b64url(randomBytes(6))}`
const gatewayToken = b64url(randomBytes(32))
const wsBase = BASE.replace(/^http/u, 'ws')

function registrationUrl(overrides = {}) {
  const params = new URLSearchParams({
    shareId,
    sessionId: 'smoke-session',
    sessionTitle: 'Smoke Share',
    accessMode: 'open',
    ownerDisplayName: 'Smoke Owner',
    protocolVersion: '1',
    capabilities: 'session-mode,fork,expiry,share-access-state,unsupported-frame-refusal,owner-credential',
    ownerInstanceId: instanceKey,
  })
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) params.delete(key)
    else params.set(key, value)
  }
  return `${wsBase}/__tunnel_gateway__?${params.toString()}`
}

function handshakeAttempt(url, headers) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers })
    const outcome = { status: undefined }
    socket.on('unexpected-response', (_request, response) => {
      outcome.status = response.statusCode
      resolve(outcome)
      socket.terminate()
    })
    socket.on('open', () => {
      outcome.open = true
      resolve(outcome)
    })
    socket.on('error', () => {
      if (outcome.status === undefined && outcome.open !== true) resolve(outcome)
    })
    setTimeout(() => resolve(outcome), 3000)
  })
}

const wrongVersion = await handshakeAttempt(registrationUrl({ protocolVersion: '999' }), {
  authorization: `Bearer ${gatewayToken}`,
  'x-liveshare-owner-credential': credential,
})
check('wrong protocolVersion refused with 426', wrongVersion.status === 426)

const noCredential = await handshakeAttempt(registrationUrl(), { authorization: `Bearer ${gatewayToken}` })
check('missing owner credential refused with 401', noCredential.status === 401)

const accessStates = []
const rpcRequests = []
const gateway = new WebSocket(registrationUrl(), {
  headers: {
    authorization: `Bearer ${gatewayToken}`,
    'x-liveshare-owner-credential': credential,
  },
})
await new Promise((resolve, reject) => {
  gateway.on('open', resolve)
  gateway.on('unexpected-response', (_request, response) => reject(new Error(`handshake refused ${String(response.statusCode)}`)))
  gateway.on('error', reject)
  setTimeout(() => reject(new Error('handshake timeout')), 3000)
})
check('valid handshake upgrades', gateway.readyState === WebSocket.OPEN)

gateway.on('message', (data) => {
  const frame = JSON.parse(data.toString('utf8'))
  if (frame.type === 'share-access-state') accessStates.push(frame)
  if (frame.type === 'share-rpc') {
    rpcRequests.push(frame)
    if (frame.body?.op === 'asset') {
      const html = frame.body.path === ''
        ? '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"><title>Smoke</title></head><body>hello</body></html>'
        : ''
      gateway.send(JSON.stringify({
        type: 'share-rpc-res',
        id: frame.id,
        status: html === '' ? 404 : 200,
        ...(html === ''
          ? { body: { error: 'asset-not-found' } }
          : { body: { contentType: 'text/html; charset=utf-8', base64: Buffer.from(html, 'utf8').toString('base64') } }),
      }))
      return
    }
    gateway.send(JSON.stringify({
      type: 'share-rpc-res',
      id: frame.id,
      status: 200,
      body: { ok: true, actor: frame.actor, echo: frame.body },
    }))
  }
})

await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (accessStates.length > 0) {
      clearInterval(timer)
      resolve()
    }
  }, 100)
  setTimeout(() => {
    clearInterval(timer)
    resolve()
  }, 3000)
})
check('share-access-state frame v1 arrives', accessStates.length === 1
  && accessStates[0].version === 1
  && accessStates[0].accessMode === 'open'
  && accessStates[0].sessionMode === 'view'
  && accessStates[0].type === 'share-access-state')

/* 3) /__liveshare/requests — the owner's authoritative read. */
console.log('== requests read ==')
const requestsWrong = await jsonFetch(`/__liveshare/requests?shareId=${encodeURIComponent(shareId)}`, {
  headers: { authorization: 'Bearer wrong-token' },
})
check('requests with wrong token answers 401', requestsWrong.status === 401)
const requests = await jsonFetch(`/__liveshare/requests?shareId=${encodeURIComponent(shareId)}`, {
  headers: { authorization: `Bearer ${gatewayToken}` },
})
check('requests returns the access state', requests.status === 200
  && requests.body.version === 1
  && requests.body.accessMode === 'open'
  && requests.body.sessionMode === 'view'
  && requests.body.allowsFork === false)

/* 4) Viewer page + rpc passthrough. */
console.log('== viewer ==')
const pageResponse = await fetch(`${BASE}/?shareId=${encodeURIComponent(shareId)}`)
const pageHtml = await pageResponse.text()
const setCookie = pageResponse.headers.get('set-cookie') ?? ''
const cookieValue = /liveshare_viewer=([^;]+)/u.exec(setCookie)?.[1]
check('viewer page answers 200 text/html', pageResponse.status === 200 && (pageResponse.headers.get('content-type') ?? '').includes('text/html'))
check('carrier script injected first', pageHtml.split('<script>')[0] === '<!doctype html><html><head>'
  && pageHtml.includes('__DSH_LIVESHARE_VIEWER__')
  && pageHtml.includes('__DSH_TRANSPORT__'))
check('manifest link dropped', !pageHtml.includes('rel="manifest"'))
check('viewer cookie issued', typeof cookieValue === 'string' && cookieValue.startsWith(`${shareId}.`))

const rpc = await jsonFetch(`/__share/rpc?shareId=${encodeURIComponent(shareId)}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `liveshare_viewer=${cookieValue}` },
  body: JSON.stringify({ op: 'call', path: '/api/session/page', body: { rpcId: 'r1' } }),
})
check('rpc passthrough answers owner status/body', rpc.status === 200 && rpc.body.ok === true && rpc.body.echo?.op === 'call')
const rpcActor = rpcRequests.at(-1)?.actor
check('actor asserted outside the body', typeof rpcActor?.providerId === 'string' && rpcActor.providerId !== ''
  && typeof rpcActor.tenantId === 'string' && rpcActor.tenantId !== ''
  && typeof rpcActor.subjectId === 'string' && rpcActor.subjectId.startsWith('guest-'))

const rpcNoCookie = await jsonFetch(`/__share/rpc?shareId=${encodeURIComponent(shareId)}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ op: 'stream-cancel', id: 5 }),
})
check('rpc without a cookie mints a guest identity', rpcNoCookie.status === 200 && rpcNoCookie.body.ok === true)

const rpcUnknownShare = await jsonFetch('/__share/rpc?shareId=nope', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ op: 'call', path: '/api/session/page', body: {} }),
})
check('rpc for an unknown share answers 404 share-not-found', rpcUnknownShare.status === 404
  && rpcUnknownShare.body.error?.code === 'share-not-found')

const sourceMap = await fetch(`${BASE}/assets/smoke.js.map`)
check('source maps refused', sourceMap.status === 404)

/* 5) Stop: DELETE then 404. */
console.log('== stop ==')
const removal = await jsonFetch(`/__liveshare/share?shareId=${encodeURIComponent(shareId)}`, {
  method: 'DELETE',
  headers: { authorization: `Bearer ${gatewayToken}` },
})
check('delete answers 200', removal.status === 200)
const afterRemoval = await jsonFetch(`/__liveshare/requests?shareId=${encodeURIComponent(shareId)}`, {
  headers: { authorization: `Bearer ${gatewayToken}` },
})
check('requests after stop answers 404', afterRemoval.status === 404)
const auditOfRemoved = await jsonFetch(`/__liveshare/audit?shareId=${encodeURIComponent(shareId)}`, {
  headers: { authorization: `Bearer ${gatewayToken}` },
})
check('audit after stop answers 404 (row is gone)', auditOfRemoved.status === 404)

gateway.close()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${String(failures)} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
