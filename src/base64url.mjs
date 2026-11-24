/** Unpadded base64url, mirroring the owner package's host/base64-url.ts exactly. */

/**
 * Encode bytes as RFC 4648 base64url without padding.
 * @param value Bytes to encode.
 */
export function base64Url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/**
 * Decode unpadded base64url text.
 * @param text RFC 4648 base64url text without padding.
 */
export function fromBase64Url(text) {
  return Buffer.from(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - text.length % 4) % 4), 'base64')
}
