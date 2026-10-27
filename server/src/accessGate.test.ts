import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { createPositionMap, createStaticMap } from './caches.ts'
import { createBroadcastServer, type BroadcastServerHandle } from './broadcast.ts'
import { createStaticHandler } from './staticFiles.ts'
import { createAccessGate, type AccessGateOptions } from './accessGate.ts'

// Everything printed during the test, so the last check can prove the
// password never reached the console. Still forwarded, so output reads
// as usual.
const captured: string[] = []
for (const name of ['log', 'warn', 'error'] as const) {
  const original = console[name].bind(console)
  console[name] = (...args: unknown[]) => {
    captured.push(args.map((arg) => String(arg)).join(' '))
    original(...args)
  }
}

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++
    console.log(`[Pass] ${label}`)
  } else {
    failed++
    console.log(`[FAIL] ${label}`)
  }
}

const PASSWORD = 'correct-horse-battery'
const INDEX_HTML = '<!doctype html><title>Gate test</title>'
const PMTILES = Buffer.alloc(1000)
for (let i = 0; i < PMTILES.length; i++) PMTILES[i] = i % 256

async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const address = probe.address()
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  if (address === null || typeof address === 'string') throw new Error('test setup error: no TCP port')
  return address.port
}

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

function send(
  port: number,
  rawPath: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { ...options.headers }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      headers['Content-Length'] = Buffer.byteLength(options.body)
    }
    const req = http.request(
      { host: '127.0.0.1', port, path: rawPath, method: options.method ?? 'GET', headers, agent: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      },
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

function login(port: number, password: string, headers: Record<string, string> = {}): Promise<Reply> {
  return send(port, '/login', { method: 'POST', body: new URLSearchParams({ password }).toString(), headers })
}

/** 'snapshot' when the first message is one, or the refusal status. */
function tryWebSocket(url: string, cookie?: string): Promise<{ kind?: string; refusedStatus?: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, cookie === undefined ? {} : { headers: { Cookie: cookie } })
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error(`no answer from ${url} within 5 s`))
    }, 5000)
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer)
      res.resume()
      ws.terminate()
      resolve({ refusedStatus: res.statusCode })
    })
    ws.once('message', (data) => {
      clearTimeout(timer)
      const parsed = JSON.parse(String(data)) as { kind?: string }
      ws.once('close', () => resolve({ kind: parsed.kind }))
      ws.close()
    })
    ws.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function startServer(dir: string, gateOptions?: AccessGateOptions): Promise<{ port: number; server: BroadcastServerHandle }> {
  const port = await freePort()
  const server = createBroadcastServer(port, createPositionMap(), createStaticMap(), undefined, {
    staticHandler: createStaticHandler(dir),
    accessGate: createAccessGate(PASSWORD, gateOptions),
  })
  await server.ready
  return { port, server }
}

function cookieFrom(reply: Reply): string {
  const header = reply.headers['set-cookie']?.[0] ?? ''
  return header.split(';')[0]
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-gate-test-'))
  fs.mkdirSync(path.join(dir, 'assets'))
  fs.mkdirSync(path.join(dir, 'tiles'))
  fs.writeFileSync(path.join(dir, 'index.html'), INDEX_HTML)
  fs.writeFileSync(path.join(dir, 'assets', 'x.js'), 'console.log(1)')
  fs.writeFileSync(path.join(dir, 'tiles', 'test.pmtiles'), PMTILES)

  const servers: BroadcastServerHandle[] = []
  try {
    const { port, server } = await startServer(dir)
    servers.push(server)

    // No cookie: nothing but the login page and the health check.
    for (const p of ['/', '/assets/x.js', '/tiles/test.pmtiles']) {
      const r = await send(port, p)
      assert(r.status === 303 && r.headers.location === '/login', `no cookie: GET ${p} -> 303 to /login (got ${r.status} ${r.headers.location})`)
      assert(r.body.length === 0, `no cookie: GET ${p} leaks no content (got ${r.body.length} bytes)`)
    }
    {
      const r = await send(port, '/login')
      const html = r.body.toString()
      assert(r.status === 200 && String(r.headers['content-type']).startsWith('text/html'), `GET /login -> 200 HTML (got ${r.status})`)
      assert(html.includes('type="password"') && html.includes('name="password"'), 'GET /login: has a password field named "password"')
      assert(!html.toLowerCase().includes('<script'), 'GET /login: no <script at all')
      assert(html.includes('#05070A') && html.includes('>Open<') && html.includes('Portsviews'), 'GET /login: dark page, "Portsviews" heading, "Open" button')
      assert(html.includes('method="post"') && html.includes('action="/login"'), 'GET /login: posts to /login')
    }
    {
      const r = await send(port, '/healthz')
      assert(r.status === 200 && r.body.toString() === 'ok', `no cookie: GET /healthz -> 200 ok (got ${r.status})`)
    }

    // Wrong password: slowed down, then 401 with the login page.
    {
      const started = Date.now()
      const r = await login(port, 'not-the-password-at-all')
      const elapsed = Date.now() - started
      assert(r.status === 401, `wrong password -> 401 (got ${r.status})`)
      assert(elapsed >= 900, `wrong password: answered after >= 900 ms (took ${elapsed} ms)`)
      assert(r.body.toString().includes('Wrong password.'), 'wrong password: the page says "Wrong password."')
      assert(r.headers['set-cookie'] === undefined, 'wrong password: no cookie set')
    }

    // Right password: a session cookie, Secure only behind https.
    const right = await login(port, PASSWORD)
    {
      const setCookie = right.headers['set-cookie']?.[0] ?? ''
      assert(right.status === 303 && right.headers.location === '/', `right password -> 303 to / (got ${right.status} ${right.headers.location})`)
      assert(setCookie.startsWith('pv_session='), 'right password: sets pv_session')
      for (const part of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']) {
        assert(setCookie.includes(part), `right password: cookie has ${part}`)
      }
      assert(!setCookie.includes('Secure'), 'right password over plain http: no Secure')
      const proxied = await login(port, PASSWORD, { 'X-Forwarded-Proto': 'https' })
      assert((proxied.headers['set-cookie']?.[0] ?? '').includes('; Secure'), 'right password with X-Forwarded-Proto https: Secure')
    }
    const cookie = cookieFrom(right)

    // With the cookie: the display and its tiles.
    {
      const r = await send(port, '/', { headers: { Cookie: cookie } })
      assert(r.status === 200 && r.body.toString() === INDEX_HTML, `with cookie: GET / -> 200 index (got ${r.status})`)
      const ranged = await send(port, '/tiles/test.pmtiles', { headers: { Cookie: cookie, Range: 'bytes=0-99' } })
      assert(ranged.status === 206 && ranged.body.length === 100, `with cookie: Range on the pmtiles -> 206, 100 bytes (got ${ranged.status}, ${ranged.body.length})`)
    }

    // Cookies that must not work.
    {
      const otherPasswordValue = crypto.createHmac('sha256', 'a-different-password').update('portsviews-session-v1').digest('base64url')
      const bad: Array<[string, string]> = [
        ['forged', 'pv_session=' + 'A'.repeat(43)],
        ['empty', 'pv_session='],
        ['different password', `pv_session=${otherPasswordValue}`],
      ]
      for (const [label, value] of bad) {
        const r = await send(port, '/', { headers: { Cookie: value } })
        assert(r.status === 303 && r.headers.location === '/login', `${label} cookie -> 303 to /login (got ${r.status})`)
      }
    }

    // The live feed.
    {
      const refused = await tryWebSocket(`ws://127.0.0.1:${port}/ws`)
      assert(refused.refusedStatus === 401, `ws at /ws without cookie -> refused with 401 (got ${JSON.stringify(refused)})`)
      const allowed = await tryWebSocket(`ws://127.0.0.1:${port}/ws`, cookie)
      assert(allowed.kind === 'snapshot', `ws at /ws with cookie -> the snapshot first (got ${JSON.stringify(allowed)})`)
    }

    // An oversized form body.
    {
      const r = await send(port, '/login', { method: 'POST', body: 'password=' + 'x'.repeat(2048) })
      assert(r.status === 413, `2 KB body -> 413 (got ${r.status})`)
    }

    // The throttle, on its own server with a fixed clock and no wait.
    {
      let clock = 1_000_000
      const throttled = await startServer(dir, { now: () => clock, wrongPasswordDelay: async () => {} })
      servers.push(throttled.server)
      const statuses: number[] = []
      for (let i = 0; i < 6; i++) statuses.push((await login(throttled.port, 'wrong-password-' + i)).status)
      assert(
        JSON.stringify(statuses) === JSON.stringify([401, 401, 401, 401, 401, 429]),
        `6 wrong attempts: the 6th gets 429 (got ${JSON.stringify(statuses)})`,
      )
      const stillPaused = await login(throttled.port, PASSWORD)
      assert(stillPaused.status === 429, `during the pause even the right password gets 429 (got ${stillPaused.status})`)
      clock += 61_000
      const after = await login(throttled.port, PASSWORD)
      assert(after.status === 303, `after the 60-second window the right password works again (got ${after.status})`)
    }
  } finally {
    for (const server of servers) await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }

  assert(!captured.some((line) => line.includes(PASSWORD)), 'the password never appears in console output')

  const total = passed + failed
  if (failed === 0) {
    console.log(`\nAll ${total} tests passed`)
  } else {
    console.log(`\n${failed} of ${total} tests failed`)
    throw new Error(`${failed} tests failed`)
  }
}

main().catch((err) => {
  console.log(err)
  process.exitCode = 1
})
