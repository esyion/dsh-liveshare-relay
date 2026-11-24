/**
 * The Relay's HTTP surface.
 *
 * Owner-side endpoints come verbatim from the owner sources (paths and shapes are the contract):
 *   - GET  {base}/                                  anonymous connectivity probe (relay-authority /
 *                                                   share-operations testRelay: any answer = reachable)
 *   - GET  {base}/__liveshare/requests?shareId=     Bearer gatewayToken -> access-state snapshot
 *   - DELETE {base}/__liveshare/share?shareId=      Bearer gatewayToken -> remove the row
 *   - GET  {base}/__liveshare/owner-credential      optional x-liveshare-owner-credential -> support probe
 *   - POST {base}/__liveshare/owner-credential      { code, code_verifier, instanceKey } -> credential
 *   - GET  {base}/__liveshare/owner-authorize?...   mock login page (owner-authorization.ts authorizeUrl)
 *   - POST {base}/__liveshare/share/claim?shareId=  Bearer gatewayToken + owner credential -> bind
 *   - GET  {base}/__liveshare/audit?shareId=        Bearer gatewayToken -> { events }
 * Viewer-side surfaces:
 *   - GET  {base}/?shareId=...                      viewer page: asset read of '' + carrier injected
 *   - GET  {base}/s/<code>                          convenience alias -> /?shareId=<code>
 *   - GET  {base}/assets/... | /plugins/... | ...   asset reads proxied to the owner
 *   - POST {base}/__share/rpc?shareId=...           opaque viewer reads forwarded as share-rpc frames
 * Relay's own:
 *   - GET  {base}/__liveshare/health                health probe for Docker HEALTHCHECK
 *
 * Viewer refusals answer the conditions viewer-states.ts names, each with the one status and error
 * code VIEWER_REFUSALS maps it to.
 */

import { viewerCarrierScript } from './carrier.mjs'
import { isExpired, viewerAdmitted, viewerRefusal } from './protocol.mjs'

/** Longest request body accepted; a viewer read stays far below this. */
const MAX_BODY_BYTES = 10 * 1024 * 1024
/** The page's own read budget, handed to the carrier (ViewerCarrierOptions.readTimeoutMs). */
const VIEWER_READ_TIMEOUT_MS = 30_000

/**
 * Build the request handler.
 * @param options Store, identity, gateway modules, URL base path, and a logger.
 */
export function createRequestHandler({ store, identity, gateway, basePath = '', log = console } = {}) {

  return function handle(req, res) {
    route(req, res).catch((error) => {
      log.error?.(`[liveshare-relay] handler failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      if (!res.headersSent) answerJson(res, 500, { error: 'relay-internal-error' })
      else res.destroy()
    })
  }

  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://relay.internal')
    let pathname = url.pathname
    if (basePath !== '') {
      if (pathname === basePath) pathname = '/'
      else if (pathname.startsWith(`${basePath}/`)) pathname = pathname.slice(basePath.length)
      else return answerNotFound(res)
    }
    const method = (req.method ?? 'GET').toUpperCase()

    if (method === 'GET' && pathname === '/') {
      const shareId = url.searchParams.get('shareId') ?? ''
      return shareId === '' ? serveLanding(res) : serveViewerPage(res, req, shareId)
    }
    if (method === 'GET' && pathname.startsWith('/s/')) {
      const code = pathname.slice(3)
      if (code === '') return answerNotFound(res)
      res.writeHead(302, { location: `${basePath}/?shareId=${encodeURIComponent(code)}` })
      res.end()
      return
    }
    if (method === 'POST' && pathname === '/__share/rpc') return shareRpc(req, res, url)
    if (method === 'GET' && pathname === '/__liveshare/health') {
      return answerJson(res, 200, {
        ok: true,
        protocolVersion: 1,
        shares: store.list().length,
        gatewayConnections: gateway.connectionCount(),
        uptimeSeconds: Math.round(process.uptime()),
      })
    }
    if (method === 'GET' && pathname === '/__liveshare/requests') return requestsRead(res, req, url)
    if (method === 'DELETE' && pathname === '/__liveshare/share') return shareRemove(res, req, url)
    if (pathname === '/__liveshare/owner-credential' && (method === 'GET' || method === 'POST')) {
      return method === 'GET' ? ownerCredentialProbe(res, req) : ownerCredentialRedeem(res, req)
    }
    if (method === 'GET' && pathname === '/__liveshare/owner-authorize') return ownerAuthorizePage(res, url)
    if (method === 'POST' && pathname === '/__liveshare/owner-authorize/confirm') return ownerAuthorizeConfirm(res, req)
    if (method === 'POST' && pathname === '/__liveshare/share/claim') return shareClaim(res, req, url)
    if (method === 'GET' && pathname === '/__liveshare/audit') return auditRead(res, req, url)
    if (method === 'GET' && pathname === '/__liveshare/context') return viewerContext(res, req, url)
    if (method === 'GET') return proxyAsset(res, req, pathname, url)

    res.setHeader('allow', 'GET, POST, DELETE')
    return answerJson(res, 405, { error: 'method-not-allowed' })
  }

  /* ------------------------------------------------------------------ viewer identity */

  /** Cookie value for one viewer session: `<shareId>.<session>` so an asset read names its share. */
  function viewerCookieValue(shareId, sessionValue) {
    return `${shareId}.${sessionValue}`
  }

  function parseViewerCookie(raw) {
    if (raw === undefined) return undefined
    const dotAt = raw.indexOf('.')
    if (dotAt <= 0) return undefined
    return { shareId: raw.slice(0, dotAt), sessionValue: raw.slice(dotAt + 1) }
  }

  function setViewerCookie(res, value) {
    res.setHeader('Set-Cookie',
      `${identity.viewerCookieName}=${value}; Path=${basePath === '' ? '/' : basePath}; HttpOnly; SameSite=Lax; Max-Age=604800`)
  }

  /**
   * Resolve the viewer identity one request asserts.
   * @param pageShareId The share this request is for when the request itself names it (the page and
   *   /__share/rpc); undefined for asset reads, which take the share their cookie names.
   * @returns The actor with its share, or undefined when an asset read carries no usable session.
   */
  function resolveViewer(req, res, pageShareId) {
    const parsed = parseViewerCookie(readCookie(req, identity.viewerCookieName))
    if (parsed !== undefined) {
      const actor = identity.viewerActorFor(parsed.sessionValue)
      if (actor !== undefined) {
        if (pageShareId === undefined) return { actor, shareId: parsed.shareId }
        if (parsed.shareId === pageShareId) return { actor, shareId: pageShareId }
      }
    }
    if (pageShareId === undefined) return undefined
    const session = identity.createViewerSession(pageShareId)
    setViewerCookie(res, viewerCookieValue(pageShareId, session.cookieValue))
    return { actor: session.actor, shareId: pageShareId }
  }

  /**
   * The viewer refusal one share row answers with, or undefined when it may be served.
   * A removed row reads as share-not-found (the owner DELETEs it on stop); a passed deadline reads
   * as share-expired; a viewer outside the share's admission reads as access-denied.
   */
  function refusalFor(row, actor) {
    if (row === undefined) return viewerRefusal('share-not-found')
    if (isExpired(row.expiresAt)) return viewerRefusal('share-expired')
    if (!viewerAdmitted(row, actor)) return viewerRefusal('access-denied')
    return undefined
  }

  /* ------------------------------------------------------------------ viewer page & assets */

  async function serveViewerPage(res, req, shareId) {
    const viewer = resolveViewer(req, res, shareId)
    if (viewer === undefined) return answerJson(res, 404, viewerRefusal('share-not-found').body)
    const row = store.get(viewer.shareId)
    const refusal = refusalFor(row, viewer.actor)
    if (refusal !== undefined) return answerJson(res, refusal.status, refusal.body)

    const call = gateway.beginCall(row, { op: 'asset', path: '' }, viewer.actor)
    req.on('close', () => call.cancel())
    const answer = await call.promise
    const body = answer.body
    if (answer.status === 200 && typeof body === 'object' && body !== null
      && typeof body.base64 === 'string' && typeof body.contentType === 'string') {
      const html = Buffer.from(body.base64, 'base64').toString('utf8')
      const script = viewerCarrierScript({
        basePath,
        shareId: viewer.shareId,
        sessionId: row.sessionId,
        readTimeoutMs: VIEWER_READ_TIMEOUT_MS,
      })
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(withCarrier(withoutManifestLink(html), script))
      return
    }
    answerJson(res, answer.status, body === undefined ? { error: 'viewer-page-unavailable' } : body)
  }

  /**
   * Map one page-resource path onto its owner asset path (page-relative, no leading slash, query
   * included). The manifest file stays reachable; the served document drops its link, so the browser
   * never fetches it without credentials (owner README, Understand the implementation).
   */
  function assetPathFor(pathname, search) {
    if (pathname === '/') return ''
    if (pathname === '/index.html') return 'index.html'
    if (pathname === '/manifest.webmanifest') return 'manifest.webmanifest'
    if (pathname === '/favicon.svg') return 'favicon.svg'
    if (pathname === '/favicon-dark.svg') return 'favicon-dark.svg'
    if (pathname.startsWith('/assets/') || pathname.startsWith('/plugins/')) {
      return pathname.slice(1) + (search === '' ? '' : search)
    }
    return undefined
  }

  async function proxyAsset(res, req, pathname, url) {
    // Source maps are refused on every asset path; the owner refuses them at the asset read too.
    if (pathname.endsWith('.map')) {
      return answerJson(res, 404, { error: { code: 'sourcemap-refused', message: 'source maps are refused', details: {} } })
    }
    const assetPath = assetPathFor(pathname, url.search)
    if (assetPath === undefined) return answerNotFound(res)
    const viewer = resolveViewer(req, res, undefined)
    if (viewer === undefined) return answerJson(res, 404, viewerRefusal('share-not-found').body)
    const row = store.get(viewer.shareId)
    const refusal = refusalFor(row, viewer.actor)
    if (refusal !== undefined) return answerJson(res, refusal.status, refusal.body)

    const call = gateway.beginCall(row, { op: 'asset', path: assetPath }, viewer.actor)
    req.on('close', () => call.cancel())
    const answer = await call.promise
    const body = answer.body
    if (answer.status === 200 && typeof body === 'object' && body !== null
      && typeof body.base64 === 'string' && typeof body.contentType === 'string') {
      const bytes = Buffer.from(body.base64, 'base64')
      res.writeHead(200, { 'content-type': body.contentType, 'cache-control': 'no-store' })
      res.end(bytes)
      return
    }
    answerJson(res, answer.status, body === undefined ? { error: 'asset-not-found' } : body)
  }

  /* ------------------------------------------------------------------ /__share/rpc */

  async function shareRpc(req, res, url) {
    const request = await readJson(req)
    if (request === undefined || typeof request !== 'object' || Array.isArray(request)) {
      return answerJson(res, 400, { error: { code: 'invalid-request', message: 'the body is not a JSON object', details: {} } })
    }
    const shareId = url.searchParams.get('shareId') ?? ''
    if (shareId === '') return answerJson(res, 404, viewerRefusal('share-not-found').body)
    const viewer = resolveViewer(req, res, shareId)
    const row = store.get(shareId)
    const refusal = refusalFor(row, viewer?.actor)
    if (refusal !== undefined) return answerJson(res, refusal.status, refusal.body)

    const call = gateway.beginCall(row, request, viewer.actor)
    // A viewer that went away cancels its read; a completed read makes this a no-op.
    req.on('close', () => call.cancel())
    const answer = await call.promise
    answerJson(res, answer.status, answer.body)
  }

  /* ------------------------------------------------------------------ viewer context */

  /**
   * GET /__liveshare/context?shareId= — the viewer page's own share confirmation read
   * (client/viewer-context.ts). The answer MUST carry a `capabilities` object: without one the page
   * states `notFound`/`unconfirmed` and renders "链接无效" even while every other endpoint works.
   */
  function viewerContext(res, req, url) {
    const shareId = url.searchParams.get('shareId') ?? ''
    if (shareId === '') return answerJson(res, 404, viewerRefusal('share-not-found').body)
    const viewer = resolveViewer(req, res, shareId)
    const row = store.get(shareId)
    const refusal = refusalFor(row, viewer?.actor)
    if (refusal !== undefined) return answerJson(res, refusal.status, refusal.body)
    answerJson(res, 200, {
      ...(row.ownerDisplayName === undefined || row.ownerDisplayName === ''
        ? {} : { ownerDisplayName: row.ownerDisplayName }),
      ...(row.owner?.subjectId === undefined ? {} : { ownerSubjectId: row.owner.subjectId }),
      ...(row.dshVersion === undefined ? {} : { dshVersion: row.dshVersion }),
      viewer: {
        subjectId: viewer.actor.subjectId,
        ...(viewer.actor.displayName === undefined ? {} : { displayName: viewer.actor.displayName }),
      },
      capabilities: {
        sessionMode: row.sessionMode ?? 'view',
        online: gateway.shareOnline(shareId),
        ...(row.allowsFork ? { fork: { allowed: true } } : {}),
      },
    })
  }

  /* ------------------------------------------------------------------ owner endpoints */

  /** GET /__liveshare/requests — the owner's authoritative access-state read. */
  function requestsRead(res, req, url) {
    const auth = authorizeByToken(res, req, url)
    if (auth === undefined) return
    const state = store.accessStateOf(auth.row)
    if (state === undefined) return answerJson(res, 500, { error: 'invalid-access-state' })
    answerJson(res, 200, state)
  }

  /** DELETE /__liveshare/share — the owner's stop: the row goes, the socket closes. */
  function shareRemove(res, req, url) {
    const auth = authorizeByToken(res, req, url)
    if (auth === undefined) return
    store.remove(auth.row.shareId)
    gateway.closeShare(auth.row.shareId)
    store.recordAudit(auth.row.shareId, 'share.stopped', { actor: auth.row.owner?.subjectId })
    answerJson(res, 200, { ok: true })
  }

  /** GET /__liveshare/audit — the audit trail one share carries (in-memory ring). */
  function auditRead(res, req, url) {
    const auth = authorizeByToken(res, req, url)
    if (auth === undefined) return
    answerJson(res, 200, { events: store.auditFor(auth.row.shareId) })
  }

  /**
   * Token-gated access for one owner endpoint: resolves ?shareId=, answers 404 for an unknown row
   * and 401 for a mismatched gateway token.
   */
  function authorizeByToken(res, req, url) {
    const shareId = url.searchParams.get('shareId') ?? ''
    const row = store.get(shareId)
    if (row === undefined) {
      answerJson(res, 404, { error: 'share-not-found' })
      return undefined
    }
    const token = bearerToken(req.headers.authorization)
    if (token === undefined || token !== row.gatewayToken) {
      answerJson(res, 401, { error: 'invalid-token' })
      return undefined
    }
    return { row }
  }

  /** GET /__liveshare/owner-credential — does this Relay bind owner identity, and for how long. */
  function ownerCredentialProbe(res, req) {
    const header = req.headers['x-liveshare-owner-credential']
    const presented = Array.isArray(header) ? header[0] : header
    if (typeof presented !== 'string' || presented === '') return answerJson(res, 200, { supported: true })
    const payload = identity.verifyOwnerCredential(presented)
    if (payload === undefined) return answerJson(res, 401, { error: 'owner-credential-invalid', supported: false })
    answerJson(res, 200, {
      supported: true,
      ...(typeof payload.expiresAt === 'number' && Number.isFinite(payload.expiresAt)
        ? { ownerCredentialExpiresAt: new Date(payload.expiresAt).toISOString() }
        : {}),
    })
  }

  /** POST /__liveshare/owner-credential — redeem one login code for a signed credential. */
  async function ownerCredentialRedeem(res, req) {
    const input = await readJson(req)
    if (input === undefined || typeof input !== 'object' || Array.isArray(input)) {
      return answerJson(res, 400, { error: 'invalid-completion' })
    }
    const outcome = identity.redeemOwnerLoginCode({
      code: input.code,
      codeVerifier: input.code_verifier,
      instanceKey: input.instanceKey,
    })
    if (!outcome.ok) return answerJson(res, outcome.status, { error: outcome.error })
    answerJson(res, 200, {
      credential: outcome.credential,
      ownerCredentialExpiresAt: outcome.ownerCredentialExpiresAt,
    })
  }

  /** POST /__liveshare/share/claim — bind one existing share to the credential presented. */
  async function shareClaim(res, req, url) {
    const auth = authorizeByToken(res, req, url)
    if (auth === undefined) return
    const header = req.headers['x-liveshare-owner-credential']
    const presented = Array.isArray(header) ? header[0] : header
    const payload = identity.verifyOwnerCredential(typeof presented === 'string' ? presented : undefined)
    if (payload === undefined) return answerJson(res, 401, { error: 'owner-credential-invalid' })
    const expiresAt = typeof payload.expiresAt === 'number' && Number.isFinite(payload.expiresAt)
      ? new Date(payload.expiresAt).toISOString()
      : undefined
    const row = auth.row
    const subjectId = typeof payload.subjectId === 'string' ? payload.subjectId : ''
    if (subjectId === '') return answerJson(res, 401, { error: 'owner-credential-invalid' })
    if (row.owner?.subjectId === subjectId) {
      return answerJson(res, 200, { claimed: false, ...(expiresAt === undefined ? {} : { ownerCredentialExpiresAt: expiresAt }) })
    }
    row.owner = {
      providerId: typeof payload.providerId === 'string' && payload.providerId !== '' ? payload.providerId : identity.providerId,
      tenantId: typeof payload.tenantId === 'string' && payload.tenantId !== '' ? payload.tenantId : identity.tenantId,
      subjectId,
      ...(typeof payload.displayName === 'string' ? { displayName: payload.displayName } : {}),
    }
    store.put(row)
    store.recordAudit(row.shareId, 'share.claimed', { actor: subjectId })
    answerJson(res, 200, { claimed: true, ...(expiresAt === undefined ? {} : { ownerCredentialExpiresAt: expiresAt }) })
  }

  /* ------------------------------------------------------------------ mock owner login */

  function ownerAuthorizePage(res, url) {
    const outcome = identity.beginOwnerAuthorize({
      state: url.searchParams.get('state') ?? '',
      codeChallenge: url.searchParams.get('code_challenge') ?? '',
      instance: url.searchParams.get('instance') ?? '',
      origin: url.searchParams.get('origin') ?? '',
    })
    if (!outcome.ok) return htmlAnswer(res, 400, loginErrorPage(outcome.error))
    const record = identity.ownerAuthorizeTarget(url.searchParams.get('state') ?? '')
    const personaButtons = identity.personas.map(persona =>
      `        <button type="submit" name="persona" value="${escapeHtml(persona.id)}">以 “${escapeHtml(persona.displayName)}” 登录</button>`).join('\n')
    const state = escapeHtml(url.searchParams.get('state') ?? '')
    const instance = escapeHtml(url.searchParams.get('instance') ?? '')
    htmlAnswer(res, 200, `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LiveShare Owner 登录(mock)</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f6f7f9; display: grid; place-items: center; min-height: 90vh; margin: 0; }
  main { background: #fff; border: 1px solid #e2e5ea; border-radius: 10px; padding: 28px 32px; max-width: 420px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { color: #5a6072; font-size: 13px; line-height: 1.6; }
  button { display: block; width: 100%; margin-top: 10px; padding: 10px 14px; border: 1px solid #d6d9e0; background: #f0f2f6; border-radius: 8px; font-size: 14px; cursor: pointer; }
  button:hover { background: #e4e8ef; }
  code { background: #eef0f4; border-radius: 4px; padding: 1px 5px; font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>LiveShare Owner 登录(mock 身份)</h1>
  <p>授权实例:<code>${instance}</code><br>这是内网/信任场景的 mock 登录,不是真实认证边界。</p>
  <form method="post" action="${escapeHtml(`${basePath}/__liveshare/owner-authorize/confirm`)}">
    <input type="hidden" name="state" value="${state}">
${personaButtons}
  </form>
</main>
</body>
</html>`)
  }

  async function ownerAuthorizeConfirm(res, req) {
    const form = await readForm(req)
    if (form === undefined) return htmlAnswer(res, 400, loginErrorPage('invalid-form'))
    const state = form.get('state') ?? ''
    const personaId = form.get('persona') ?? ''
    const outcome = identity.completeOwnerAuthorize({ state, personaId })
    if (!outcome.ok) return htmlAnswer(res, 400, loginErrorPage(outcome.error))
    // The popup hands the code to its exact opener origin (client/owner-login.ts contract), waits
    // for the acknowledgement, then closes.
    const payloadJson = JSON.stringify({ type: 'liveshare-auth-code', code: outcome.code, state })
    const targetJson = JSON.stringify(outcome.origin)
    htmlAnswer(res, 200, `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>授权完成</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f7f9;display:grid;place-items:center;min-height:90vh;margin:0}main{background:#fff;border:1px solid #e2e5ea;border-radius:10px;padding:28px 32px;max-width:420px}p{color:#5a6072;font-size:13px;line-height:1.6}code{background:#eef0f4;border-radius:4px;padding:1px 5px;font-size:12px;word-break:break-all}</style>
</head>
<body>
<main>
  <h1 style="font-size:18px">授权完成</h1>
  <p id="fallback">正在把一次性码回传给发起页面…</p>
  <p>若页面未自动关闭,请回到 DSH 分享面板查看结果;一次性码只能使用一次。</p>
</main>
<script>
(function () {
  var payload = ${payloadJson};
  var target = ${targetJson};
  try { if (window.opener !== null) window.opener.postMessage(payload, target); } catch (e) {}
  window.addEventListener('message', function (event) {
    if (event.origin !== target) return;
    var data = event.data;
    if (data !== null && typeof data === 'object' && data.type === 'liveshare-auth-ack' && data.state === payload.state) window.close();
  });
  var fallback = document.getElementById('fallback');
  if (fallback !== null) fallback.textContent = '已向发起页面回传一次性码,本页可以关闭。';
})();
</script>
</body>
</html>`)
  }

  function loginErrorPage(error) {
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>登录失败</title></head>
<body style="font-family:system-ui,sans-serif;background:#f6f7f9;display:grid;place-items:center;min-height:90vh;margin:0">
<main style="background:#fff;border:1px solid #e2e5ea;border-radius:10px;padding:28px 32px;max-width:420px">
<h1 style="font-size:18px">登录失败</h1><p>原因:<code>${escapeHtml(error)}</code>。请回到 DSH 分享面板重新发起登录。</p>
</main></body></html>`
  }

  /* ------------------------------------------------------------------ landing */

  function serveLanding(res) {
    htmlAnswer(res, 200, `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LiveShare Relay</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;line-height:1.7">
<h1>LiveShare Relay(最小可用)</h1>
<p>这是 DSH LiveShare 的自建中继服务。观看者打开 owner 分享的链接(形如 <code>${escapeHtml(`${basePath}/?shareId=...`)}</code>)即可进入观看页。</p>
<p>owner 端请在 DSH 分享面板填入本服务地址,例如 <code>http://127.0.0.1:8787</code>。</p>
<p><a href="${escapeHtml(`${basePath}/__liveshare/health`)}">健康检查</a></p>
</body></html>`)
  }

  /* ------------------------------------------------------------------ io helpers */

  function readCookie(req, name) {
    const header = req.headers.cookie
    if (typeof header !== 'string') return undefined
    for (const part of header.split(';')) {
      const at = part.indexOf('=')
      if (at === -1) continue
      if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
    }
    return undefined
  }

  function bearerToken(header) {
    if (typeof header !== 'string') return undefined
    const match = /^Bearer\s+(.+)$/u.exec(header.trim())
    const token = match?.[1]?.trim()
    return token === undefined || token === '' ? undefined : token
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(new Error('body-too-large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  async function readJson(req) {
    let bytes
    try {
      bytes = await readBody(req)
    } catch {
      return undefined
    }
    if (bytes.length === 0) return undefined
    try {
      return JSON.parse(bytes.toString('utf8'))
    } catch {
      return undefined
    }
  }

  async function readForm(req) {
    let bytes
    try {
      bytes = await readBody(req)
    } catch {
      return undefined
    }
    return new URLSearchParams(bytes.toString('utf8'))
  }

  function answerJson(res, status, value) {
    const body = value === undefined ? '' : JSON.stringify(value)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }

  function answerNotFound(res) {
    answerJson(res, 404, { error: 'not-found' })
  }

  function htmlAnswer(res, status, html) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
  }

  function escapeHtml(value) {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }
}

/**
 * Place the carrier script first in the served document, exactly the duty the owner README states
 * for the Relay ("places the carrier script … first in it").
 * @param html The owner's rendered index document.
 * @param script The classic inline carrier script.
 */
function withCarrier(html, script) {
  const element = `<script>${script}</script>`
  const head = /<head[^>]*>/iu.exec(html)
  if (head !== null) {
    return html.slice(0, head.index + head[0].length) + element + html.slice(head.index + head[0].length)
  }
  return element + html
}

/** Drop the manifest link, which a browser would otherwise fetch without credentials. */
function withoutManifestLink(html) {
  return html.replace(/<link\b[^>]*\brel=["']?manifest["']?[^>]*>\s*/giu, '')
}
