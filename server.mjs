/**
 * LiveShare Relay entry point.
 *
 * Node 20+ ESM; the only external dependency is `ws`. Configuration is environment only:
 *   LIVESHARE_RELAY_PORT       listen port (default 8787; PORT also honoured)
 *   LIVESHARE_RELAY_HOST       bind host (default 0.0.0.0)
 *   LIVESHARE_BASE_PATH        mount the Relay under a path prefix (default '')
 *   LIVESHARE_RELAY_STATE_FILE optional JSON file persisting share rows across restarts
 *   LIVESHARE_OWNER_CREDENTIAL_TTL_HOURS owner credential lifetime (default 24)
 */

import http from 'node:http'
import { createGatewayRegistry } from './src/gateway.mjs'
import { createRequestHandler } from './src/http-routes.mjs'
import { createMockIdentity } from './src/identity.mjs'
import { createRelayStore } from './src/store.mjs'

function normalizeBasePath(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return ''
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`
  return withSlash.replace(/\/+$/u, '')
}

const port = Number.parseInt(process.env.LIVESHARE_RELAY_PORT ?? process.env.PORT ?? '8787', 10)
const host = process.env.LIVESHARE_RELAY_HOST ?? '0.0.0.0'
const basePath = normalizeBasePath(process.env.LIVESHARE_BASE_PATH ?? '')
const stateFile = (process.env.LIVESHARE_RELAY_STATE_FILE ?? '').trim()
const credentialTtlMs = Number.parseInt(process.env.LIVESHARE_OWNER_CREDENTIAL_TTL_HOURS ?? '24', 10) * 60 * 60 * 1000

if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
  console.error('[liveshare-relay] invalid listen port')
  process.exit(1)
}

const store = createRelayStore({ stateFile })
const identity = createMockIdentity({
  secret: store.mockSecret,
  credentialTtlMs: Number.isSafeInteger(credentialTtlMs) && credentialTtlMs > 0 ? credentialTtlMs : 24 * 60 * 60 * 1000,
})
const gateway = createGatewayRegistry({ store, identity, basePath })
const handle = createRequestHandler({ store, identity, gateway, basePath })

const server = http.createServer(handle)
server.on('upgrade', (req, socket, head) => { gateway.handleUpgrade(req, socket, head) })

server.listen(port, host, () => {
  console.log(`[liveshare-relay] listening on http://${host}:${String(port)}${basePath === '' ? '' : basePath}`)
  console.log(`[liveshare-relay] owner 探测地址:  http://<host>:${String(port)}${basePath}/`)
  console.log(`[liveshare-relay] 健康检查:      http://<host>:${String(port)}${basePath}/__liveshare/health`)
  console.log(`[liveshare-relay] 已恢复分享数:  ${String(store.list().length)}(stateFile=${stateFile === '' ? '内存' : stateFile})`)
})

let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[liveshare-relay] received ${signal}; closing gateway sockets`)
  gateway.closeAll()
  store.save()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
