import crypto from 'node:crypto'
import type http from 'node:http'

// An optional password page in front of the hosted display. One password,
// no user accounts. The session cookie is an HMAC of a fixed message keyed
// by the password, so nothing is stored on the server and changing the
// password logs everyone out. Node built-ins only.
//
// Nothing here logs the password, the cookie value or a form body.

export const SESSION_COOKIE = 'pv_session'
const SESSION_MESSAGE = 'portsviews-session-v1'
const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60
const MAX_BODY_BYTES = 1024
const WRONG_PASSWORD_DELAY_MS = 1000
const THROTTLE_WINDOW_MS = 60 * 1000
const THROTTLE_MAX_FAILURES = 5

export interface AccessGate {
  /** Answers the request itself, or calls next() to let it through. */
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse, next: () => void): void
  /** True if a WebSocket upgrade carries a valid session cookie. */
  allowsUpgrade(req: http.IncomingMessage): boolean
}

export interface AccessGateOptions {
  /** Clock for the throttle window. Tests inject a fake one. */
  now?: () => number
  /** The pause before a wrong-password reply. Tests inject a quick one. */
  wrongPasswordDelay?: () => Promise<void>
}

export function sessionValueFor(password: string): string {
  return crypto.createHmac('sha256', password).update(SESSION_MESSAGE).digest('base64url')
}

function equalStrings(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function readCookie(req: http.IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return undefined
}

function isHttps(req: http.IncomingMessage): boolean {
  const header = req.headers['x-forwarded-proto']
  const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]
  return first?.trim().toLowerCase() === 'https'
}

export function loginPage(message?: string): string {
  const notice = message === undefined ? '' : `\n    <p class="notice">${message}</p>`
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Portsviews</title>
  <style>
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #05070A; color: #E6EDF3; font-family: system-ui, sans-serif; }
    form { display: flex; flex-direction: column; gap: 12px; width: min(320px, calc(100vw - 32px)); }
    h1 { margin: 0 0 8px; font-weight: 500; letter-spacing: 0.04em; }
    input, button { font: inherit; padding: 10px 12px; border-radius: 6px; border: 1px solid #2A3441; }
    input { background: #0D1117; color: #E6EDF3; }
    button { background: #1F6FEB; color: #FFFFFF; border-color: #1F6FEB; cursor: pointer; }
    .notice { margin: 0; color: #FF7B72; }
  </style>
</head>
<body>
  <form method="post" action="/login">
    <h1>Portsviews</h1>${notice}
    <input type="password" name="password" aria-label="Password" autocomplete="current-password" required autofocus>
    <button type="submit">Open</button>
  </form>
</body>
</html>
`
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  })
  res.end(html)
}

function sendStatus(res: http.ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Length': 0, 'Cache-Control': 'no-store', ...headers })
  res.end()
}

export function createAccessGate(password: string, options: AccessGateOptions = {}): AccessGate {
  const sessionValue = sessionValueFor(password)
  // Compared as HMACs so both sides always have the same length.
  const passwordDigest = sessionValueFor(password + '\0login')
  const now = options.now ?? Date.now
  const wrongPasswordDelay =
    options.wrongPasswordDelay ?? (() => new Promise<void>((resolve) => setTimeout(resolve, WRONG_PASSWORD_DELAY_MS)))

  // Wrong attempts across all clients, and when the pause ends.
  let failures: number[] = []
  let pausedUntil = 0

  function hasValidSession(req: http.IncomingMessage): boolean {
    const value = readCookie(req, SESSION_COOKIE)
    return value !== undefined && value !== '' && equalStrings(value, sessionValue)
  }

  function recordFailure(): void {
    const at = now()
    failures = failures.filter((time) => time > at - THROTTLE_WINDOW_MS)
    failures.push(at)
    if (failures.length >= THROTTLE_MAX_FAILURES) {
      pausedUntil = failures[0] + THROTTLE_WINDOW_MS
      console.warn('[Wake] Too many wrong passwords; the login page is paused for up to 60 seconds.')
    }
  }

  function handleLoginPost(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (now() < pausedUntil) {
      req.resume()
      sendStatus(res, 429, { 'Retry-After': String(Math.ceil((pausedUntil - now()) / 1000)) })
      return
    }

    const declared = Number(req.headers['content-length'] ?? '0')
    if (declared > MAX_BODY_BYTES) {
      req.resume()
      sendStatus(res, 413, { Connection: 'close' })
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        sendStatus(res, 413, { Connection: 'close' })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      const given = form.get('password') ?? ''
      if (equalStrings(sessionValueFor(given + '\0login'), passwordDigest)) {
        const secure = isHttps(req) ? '; Secure' : ''
        sendStatus(res, 303, {
          Location: '/',
          'Set-Cookie': `${SESSION_COOKIE}=${sessionValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SEC}${secure}`,
        })
        return
      }
      recordFailure()
      void wrongPasswordDelay().then(() => sendHtml(res, 401, loginPage('Wrong password.')))
    })
  }

  return {
    handleRequest(req, res, next) {
      const pathname = (req.url ?? '/').split(/[?#]/, 1)[0]
      const method = req.method ?? 'GET'

      if (pathname === '/login') {
        if (method === 'POST') {
          handleLoginPost(req, res)
          return
        }
        if (method === 'GET' || method === 'HEAD') {
          sendHtml(res, 200, loginPage())
          return
        }
      }
      if (pathname === '/healthz' && method === 'GET') {
        next()
        return
      }
      if (hasValidSession(req)) {
        next()
        return
      }
      sendStatus(res, 303, { Location: '/login' })
    },

    allowsUpgrade(req) {
      return hasValidSession(req)
    },
  }
}
