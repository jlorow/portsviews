import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { createPositionMap, createStaticMap } from './caches.ts'
import { createBroadcastServer, type BroadcastServerHandle } from './broadcast.ts'
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

/** A port that was free a moment ago: bind 0, read it, release it. */
async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const address = probe.address()
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  if (address === null || typeof address === 'string') throw new Error('test setup error: no TCP port')
  return address.port
}

function get(port: number, rawPath: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Connects, returns the first message (parsed), then closes the client. */
function firstMessage(url: string): Promise<{ kind?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error(`no message from ${url} within 5 s`))
    }, 5000)
    ws.once('message', (data) => {
      clearTimeout(timer)
      const parsed = JSON.parse(String(data)) as { kind?: string }
      ws.once('close', () => resolve(parsed))
      ws.close()
    })
    ws.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

const INDEX_HTML = '<!doctype html><title>Online test</title>'

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-online-test-'))
  fs.writeFileSync(path.join(dir, 'index.html'), INDEX_HTML)

  // With a static handler: page and live feed on one port.
  {
    const port = await freePort()
    let server: BroadcastServerHandle | undefined
    try {
      server = createBroadcastServer(port, createPositionMap(), createStaticMap(), undefined, {
        staticHandler: createStaticHandler(dir),
      })
      await withTimeout(server.ready, 5000, 'static server ready')

      const page = await get(port, '/')
      assert(page.status === 200 && page.body === INDEX_HTML, `static: GET / returns the index (got ${page.status})`)

      const atWs = await firstMessage(`ws://127.0.0.1:${port}/ws`)
      assert(atWs.kind === 'snapshot', `static: a client at /ws gets the snapshot first (got ${JSON.stringify(atWs.kind)})`)
      const atRoot = await firstMessage(`ws://127.0.0.1:${port}/`)
      assert(atRoot.kind === 'snapshot', `static: a client at / gets the snapshot first (got ${JSON.stringify(atRoot.kind)})`)
    } finally {
      if (server !== undefined) await withTimeout(server.close(), 5000, 'static server close')
    }
  }

  // Without a static handler: today's WebSocket-only behaviour.
  {
    const port = await freePort()
    let server: BroadcastServerHandle | undefined
    try {
      server = createBroadcastServer(port, createPositionMap(), createStaticMap())
      await withTimeout(server.ready, 5000, 'plain server ready')

      const plain = await get(port, '/')
      assert(plain.status === 426, `plain: GET / is 426, as ws answered before (got ${plain.status})`)
      assert(plain.body === 'Upgrade Required', `plain: body "Upgrade Required" (got ${JSON.stringify(plain.body)})`)
      assert(plain.headers['content-type'] === 'text/plain', `plain: Content-Type text/plain (got ${plain.headers['content-type']})`)
      assert(plain.headers['content-length'] === '16', `plain: Content-Length 16 (got ${plain.headers['content-length']})`)

      const atRoot = await firstMessage(`ws://127.0.0.1:${port}/`)
      assert(atRoot.kind === 'snapshot', `plain: a client at / still gets the snapshot (got ${JSON.stringify(atRoot.kind)})`)
    } finally {
      if (server !== undefined) await withTimeout(server.close(), 5000, 'plain server close')
    }
  }

  fs.rmSync(dir, { recursive: true, force: true })

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
