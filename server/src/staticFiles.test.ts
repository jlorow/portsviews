import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createStaticHandler } from './staticFiles.ts'

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

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

function request(
  port: number,
  rawPath: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: rawPath, method: options.method ?? 'GET', headers: options.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const SENTINEL = 'OUTSIDE-THE-SERVED-FOLDER'
const INDEX_HTML = '<!doctype html><title>Test index</title>'
const PMTILES = Buffer.alloc(1000)
for (let i = 0; i < PMTILES.length; i++) PMTILES[i] = i % 256

async function main(): Promise<void> {
  // base/ holds files that must never be served; base/site/ is the root.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-static-test-'))
  const root = path.join(base, 'site')
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(root, 'tiles'), { recursive: true })
  fs.writeFileSync(path.join(root, 'index.html'), INDEX_HTML)
  fs.writeFileSync(path.join(root, 'assets', 'app-abc123.js'), 'console.log(1)')
  fs.writeFileSync(path.join(root, 'assets', 'app-abc123.css'), 'body{}')
  fs.writeFileSync(path.join(root, 'assets', 'data.bin1'), 'x')
  fs.writeFileSync(path.join(root, 'tiles', 'test.pmtiles'), PMTILES)
  fs.writeFileSync(path.join(root, '.secret'), SENTINEL)
  fs.writeFileSync(path.join(base, 'package.json'), SENTINEL)
  fs.writeFileSync(path.join(base, 'x'), SENTINEL)

  const server = http.createServer(createStaticHandler(root))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port

  try {
    // Index at both addresses, never cached.
    for (const p of ['/', '/index.html']) {
      const r = await request(port, p)
      assert(r.status === 200 && r.body.toString() === INDEX_HTML, `${p}: 200 with the index (got ${r.status})`)
      assert(r.headers['content-type'] === 'text/html; charset=utf-8', `${p}: html content type`)
      assert(r.headers['cache-control'] === 'no-cache', `${p}: Cache-Control no-cache (got ${r.headers['cache-control']})`)
      assert(r.headers['accept-ranges'] === 'bytes', `${p}: Accept-Ranges bytes`)
    }

    // MIME types and cache rules.
    {
      const js = await request(port, '/assets/app-abc123.js')
      assert(js.status === 200 && js.headers['content-type'] === 'text/javascript', `js: text/javascript (got ${js.headers['content-type']})`)
      assert(
        js.headers['cache-control'] === 'public, max-age=31536000, immutable',
        `js under /assets/: immutable (got ${js.headers['cache-control']})`,
      )
      const css = await request(port, '/assets/app-abc123.css')
      assert(css.headers['content-type'] === 'text/css', `css: text/css (got ${css.headers['content-type']})`)
      const tiles = await request(port, '/tiles/test.pmtiles')
      assert(
        tiles.status === 200 && tiles.headers['content-type'] === 'application/octet-stream',
        `pmtiles: application/octet-stream (got ${tiles.headers['content-type']})`,
      )
      assert(tiles.headers['cache-control'] === 'public, max-age=86400', `pmtiles: one-day cache (got ${tiles.headers['cache-control']})`)
      assert(tiles.body.equals(PMTILES), 'pmtiles: the full 1000 bytes, unchanged')
      const unknown = await request(port, '/assets/data.bin1')
      assert(unknown.headers['content-type'] === 'application/octet-stream', `unknown extension: application/octet-stream (got ${unknown.headers['content-type']})`)
    }

    // Byte ranges.
    {
      const r = await request(port, '/tiles/test.pmtiles', { headers: { Range: 'bytes=0-99' } })
      assert(r.status === 206, `bytes=0-99: 206 (got ${r.status})`)
      assert(r.body.length === 100 && r.body.equals(PMTILES.subarray(0, 100)), `bytes=0-99: exactly the first 100 bytes (got ${r.body.length})`)
      assert(r.headers['content-range'] === 'bytes 0-99/1000', `bytes=0-99: Content-Range (got ${r.headers['content-range']})`)
      assert(r.headers['content-length'] === '100', `bytes=0-99: Content-Length 100 (got ${r.headers['content-length']})`)
    }
    {
      const r = await request(port, '/tiles/test.pmtiles', { headers: { Range: 'bytes=900-' } })
      assert(r.status === 206 && r.body.equals(PMTILES.subarray(900)), `bytes=900-: the last 100 bytes (got ${r.status}, ${r.body.length})`)
      assert(r.headers['content-range'] === 'bytes 900-999/1000', `bytes=900-: Content-Range (got ${r.headers['content-range']})`)
    }
    {
      const r = await request(port, '/tiles/test.pmtiles', { headers: { Range: 'bytes=-10' } })
      assert(r.status === 206 && r.body.equals(PMTILES.subarray(990)), `bytes=-10: the last 10 bytes (got ${r.status}, ${r.body.length})`)
    }
    {
      const r = await request(port, '/tiles/test.pmtiles', { headers: { Range: 'bytes=2000-3000' } })
      assert(r.status === 416, `bytes=2000-3000: 416 (got ${r.status})`)
      assert(r.headers['content-range'] === 'bytes */1000', `bytes=2000-3000: Content-Range bytes */1000 (got ${r.headers['content-range']})`)
    }
    {
      const r = await request(port, '/tiles/test.pmtiles', { headers: { Range: 'bytes=abc' } })
      assert(r.status === 416, `malformed range: 416 (got ${r.status})`)
    }
    {
      const r = await request(port, '/tiles/test.pmtiles', { headers: { Range: 'bytes=0-9,20-29' } })
      assert(r.status === 200 && r.body.equals(PMTILES), `multi-range: plain 200 with the whole file (got ${r.status}, ${r.body.length})`)
    }

    // HEAD, other methods, health check.
    {
      const r = await request(port, '/tiles/test.pmtiles', { method: 'HEAD' })
      assert(r.status === 200 && r.headers['content-length'] === '1000', `HEAD: 200 with Content-Length 1000 (got ${r.status}, ${r.headers['content-length']})`)
      assert(r.body.length === 0, `HEAD: empty body (got ${r.body.length} bytes)`)
    }
    {
      const r = await request(port, '/', { method: 'POST' })
      assert(r.status === 405 && r.headers.allow === 'GET, HEAD', `POST: 405 with Allow: GET, HEAD (got ${r.status}, ${r.headers.allow})`)
    }
    {
      const r = await request(port, '/healthz')
      assert(r.status === 200 && r.body.toString() === 'ok', `/healthz: 200 ok (got ${r.status} ${JSON.stringify(r.body.toString())})`)
      assert(String(r.headers['content-type']).startsWith('text/plain'), '/healthz: text/plain')
    }

    // Paths that must never reach a file outside the folder.
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/assets/%2e%2e%2f%2e%2e/x', '/..%5c..%5cx', '/%E0%A4%A']) {
      const r = await request(port, p)
      assert(r.status === 404 || r.status === 400, `${p}: 404 or 400 (got ${r.status})`)
      assert(!r.body.toString().includes(SENTINEL), `${p}: no outside content in the reply`)
    }
    {
      const r = await request(port, '/%00index.html')
      assert(r.status === 400 || r.status === 404, `NUL byte: refused (got ${r.status})`)
    }
    {
      const r = await request(port, '/.secret')
      assert(r.status === 404 && !r.body.toString().includes(SENTINEL), `/.secret: 404, content not served (got ${r.status})`)
    }
    for (const p of ['/assets', '/assets/']) {
      const r = await request(port, p)
      assert(r.status === 404, `directory ${p}: 404, no listing (got ${r.status})`)
    }
    {
      const r = await request(port, '/missing.js')
      assert(r.status === 404, `missing file: 404 (got ${r.status})`)
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(base, { recursive: true, force: true })
  }

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
