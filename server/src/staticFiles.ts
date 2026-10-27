import fs from 'node:fs'
import path from 'node:path'
import type http from 'node:http'

// Serves the built display (apps/display's dist folder) from the server's
// own port, so one web address carries both the page and the live feed.
// Node built-ins only. Files are streamed, never read whole into memory:
// basemap .pmtiles files can be hundreds of megabytes.

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain',
  '.pmtiles': 'application/octet-stream',
}

export function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/** urlPath is the decoded request path, e.g. "/assets/index-abc.js". */
export function cacheControlFor(urlPath: string): string {
  if (path.posix.basename(urlPath) === 'index.html') return 'no-cache'
  // Vite puts a content hash in every file name under /assets/.
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
  if (urlPath.toLowerCase().endsWith('.pmtiles')) return 'public, max-age=86400'
  return 'no-cache'
}

export type RangeResult =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' }

/**
 * One byte range: "bytes=a-b", "bytes=a-" or "bytes=-n". A list of ranges
 * is answered with the whole file (allowed by the HTTP spec). Anything
 * malformed or outside the file is unsatisfiable.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined) return { kind: 'full' }
  if (header.includes(',')) return { kind: 'full' }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return { kind: 'unsatisfiable' }
  const [, startText, endText] = match
  if (startText === '' && endText === '') return { kind: 'unsatisfiable' }
  if (size === 0) return { kind: 'unsatisfiable' }

  if (startText === '') {
    const suffix = Number(endText)
    if (!Number.isSafeInteger(suffix) || suffix === 0) return { kind: 'unsatisfiable' }
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(startText)
  if (!Number.isSafeInteger(start) || start >= size) return { kind: 'unsatisfiable' }
  if (endText === '') return { kind: 'partial', start, end: size - 1 }
  const end = Number(endText)
  if (!Number.isSafeInteger(end) || end < start) return { kind: 'unsatisfiable' }
  return { kind: 'partial', start, end: Math.min(end, size - 1) }
}

function sendText(res: http.ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extra,
  })
  res.end(body)
}

/**
 * Maps a raw request path to a file under rootDir, or says why not.
 * Decoded once; a NUL byte, any segment starting with "." (which covers
 * "..", ".env" and every dotfile), or a result outside rootDir is refused.
 */
export function resolveRequestPath(
  rootDir: string,
  rawPath: string,
): { ok: true; filePath: string; urlPath: string } | { ok: false; status: 400 | 404 } {
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return { ok: false, status: 400 }
  }
  if (decoded.includes('\0')) return { ok: false, status: 400 }
  if (!decoded.startsWith('/')) return { ok: false, status: 404 }

  // Split on both slashes: Windows treats a backslash as a separator too.
  const segments = decoded.split(/[\\/]/).filter((segment) => segment !== '')
  if (segments.some((segment) => segment.startsWith('.'))) return { ok: false, status: 404 }

  const urlPath = decoded === '/' ? '/index.html' : decoded
  const root = path.resolve(rootDir)
  const filePath = path.resolve(root, ...(decoded === '/' ? ['index.html'] : segments))
  if (!filePath.startsWith(root + path.sep)) return { ok: false, status: 404 }
  return { ok: true, filePath, urlPath }
}

export function createStaticHandler(rootDir: string): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' })
      return
    }

    const rawUrl = req.url ?? '/'
    const rawPath = rawUrl.split(/[?#]/, 1)[0] || '/'

    // Answered from memory, never from disk, so a host's health check works
    // even if the folder is replaced underneath the server.
    if (rawPath === '/healthz') {
      sendText(res, 200, 'ok')
      return
    }

    const resolved = resolveRequestPath(rootDir, rawPath)
    if (!resolved.ok) {
      sendText(res, resolved.status, resolved.status === 400 ? 'Bad Request' : 'Not Found')
      return
    }

    fs.stat(resolved.filePath, (err, stats) => {
      if (err !== null || !stats.isFile()) {
        sendText(res, 404, 'Not Found')
        return
      }
      serveFile(req, res, resolved.filePath, resolved.urlPath, stats.size, method === 'HEAD')
    })
  }
}

function serveFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  urlPath: string,
  size: number,
  headOnly: boolean,
): void {
  const headers: Record<string, string | number> = {
    'Content-Type': mimeTypeFor(filePath),
    'Cache-Control': cacheControlFor(urlPath),
    'Accept-Ranges': 'bytes',
  }

  const range = parseRange(req.headers.range, size)
  if (range.kind === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 })
    res.end()
    return
  }

  let status = 200
  let start = 0
  let end = size - 1
  if (range.kind === 'partial') {
    status = 206
    start = range.start
    end = range.end
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  }
  headers['Content-Length'] = size === 0 ? 0 : end - start + 1

  res.writeHead(status, headers)
  if (headOnly || size === 0) {
    res.end()
    return
  }

  const stream = fs.createReadStream(filePath, { start, end })
  stream.on('error', () => {
    res.destroy()
  })
  stream.pipe(res)
}
