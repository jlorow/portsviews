import WebSocket from 'ws'
import { AISSTREAM_URL } from '@wake/shared'
import type { CaptureLogger } from './capture.ts'

// DEMO-1: the endpoint moved to @wake/shared so the server's client and
// resolveSourceConfig cannot drift apart; re-exported here for existing
// consumers. Default connection URL is unchanged.
export { AISSTREAM_URL }

// Dover Strait. Corner order matches the documented example: NW first, SE second.
// Exported so index.ts's per-box attribution stays in sync with what we
// actually subscribed to, instead of duplicating the coordinates. The
// per-box machinery itself supports more than one box (see S3.2).
//
// These are the Wake server's DEFAULTS, not a hardcoded subscription --
// see SubscriptionConfig below (RISK-1, S3.2 groundwork). index.ts passes
// them explicitly, so the Wake server's own subscription message is
// byte-identical to what it always sent.
export const BOUNDING_BOXES = [
  [
    [51.4, 0.9],
    [50.8, 2.0],
  ],
]

export const BOUNDING_BOX_LABELS = ['DOVER']

export const FILTER_MESSAGE_TYPES = [
  'PositionReport',
  'StandardClassBPositionReport',
  'ShipStaticData',
]

const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30000
const JITTER_MAX_MS = 1000
const HEALTHY_RESET_MS = 60000

export interface AisStreamMessage {
  MessageType: string
  MetaData?: {
    MMSI?: number
    [key: string]: unknown
  }
  Message?: unknown
}

export interface AisStreamHandlers {
  onMessage: (message: AisStreamMessage) => void
  onSubscribed?: () => void
  /** Fired when the connection drops and a reconnect is about to be scheduled — not fired on a user-initiated shutdown. */
  onDisconnected?: () => void
  /**
   * Observability hooks, added for RISK-1's capacityCapture tool (events
   * log needs open/subscription-sent/reconnect-attempt/error/close, none
   * of which the Wake server itself has ever needed). Purely additive and
   * optional — connect/backoff/close timing and behaviour are unchanged;
   * these only expose moments that already happen internally. index.ts
   * sets none of them.
   */
  onOpen?: () => void
  onSubscriptionSent?: () => void
  onReconnectAttempt?: (delayMs: number) => void
  onError?: (err: Error) => void
  onClose?: (code: number, reason: string) => void
}

/**
 * What a subscription's bounding boxes and message-type filter are. Kept
 * separate from AisStreamHandlers because handlers are behaviour and this
 * is data — a subscription can be re-sent (see resubscribe()) without
 * touching handlers at all.
 */
export interface SubscriptionConfig {
  boundingBoxes: number[][][]
  filterMessageTypes: string[]
}

/**
 * The minimal structural surface AisStreamClient needs from a socket.
 * A real `ws.WebSocket` satisfies this with no adapter (see broadcast.ts's
 * ClientSocket for the identical pattern) — this is what lets a test
 * inject a plain mock object with no real networking, in place of the one
 * place in this file that used to call `new WebSocket(...)` directly and
 * unconditionally.
 */
export interface AisSocket {
  readonly readyState: number
  on(event: 'open', listener: () => void): void
  on(event: 'message', listener: (data: WebSocket.RawData) => void): void
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void
  on(event: 'error', listener: (err: Error) => void): void
  once(event: 'close', listener: (code: number) => void): void
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type AisSocketFactory = (url: string, options: WebSocket.ClientOptions) => AisSocket

const defaultSocketFactory: AisSocketFactory = (url, options) => new WebSocket(url, options)

export class AisStreamClient {
  private ws: AisSocket | undefined
  private backoffMs = BASE_BACKOFF_MS
  private healthyTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false

  constructor(
    private readonly apiKey: string,
    private readonly subscription: SubscriptionConfig,
    private readonly handlers: AisStreamHandlers,
    private readonly captureLogger?: CaptureLogger,
    private readonly socketFactory: AisSocketFactory = defaultSocketFactory,
    // DEMO-1: endpoint override (aiscast). Defaults to today's URL.
    private readonly url: string = AISSTREAM_URL,
  ) {}

  getSocket(): AisSocket | undefined {
    return this.ws
  }

  private buildSubscriptionMessage(): string {
    return JSON.stringify({
      APIKey: this.apiKey,
      BoundingBoxes: this.subscription.boundingBoxes,
      FilterMessageTypes: this.subscription.filterMessageTypes,
    })
  }

  connect(): void {
    if (this.stopped) return

    const ws = this.socketFactory(this.url, { perMessageDeflate: true })
    this.ws = ws

    ws.on('open', () => {
      this.handlers.onOpen?.()

      // Must be sent immediately — AISstream closes the connection if no
      // valid subscription arrives within 3 seconds of opening.
      ws.send(this.buildSubscriptionMessage())
      console.log('[Wake] Connected to AISstream — subscription sent')
      this.handlers.onSubscriptionSent?.()

      this.healthyTimer = setTimeout(() => {
        this.backoffMs = BASE_BACKOFF_MS
        console.log('[Wake] Connection healthy for 60s — backoff reset')
      }, HEALTHY_RESET_MS)
    })

    ws.on('message', (data) => {
      let parsed: AisStreamMessage
      try {
        parsed = JSON.parse(data.toString())
      } catch {
        console.error('[Wake] Received a message that was not valid JSON, ignoring')
        return
      }

      // Earliest possible point, before any existing branching — so a raw
      // capture (when enabled) sees every message type, including
      // SubscriptionConfirmation, not just what onMessage below is filtered
      // down to.
      this.captureLogger?.write(parsed)

      if (parsed.MessageType === 'SubscriptionConfirmation') {
        const confirmation = parsed.Message as { CompressionEnabled?: unknown } | undefined
        const compressionEnabled = confirmation?.CompressionEnabled
        const compressionLabel =
          compressionEnabled === true ? 'true' : compressionEnabled === false ? 'false' : 'missing'
        console.log(`[Wake] Subscription confirmed — compression: ${compressionLabel}`)
        this.handlers.onSubscribed?.()
        return
      }

      this.handlers.onMessage(parsed)
    })

    ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf.toString() || '(no reason given)'
      console.log(`[Wake] Connection closed: code=${code} reason="${reason}"`)
      this.handlers.onClose?.(code, reason)

      if (this.healthyTimer) {
        clearTimeout(this.healthyTimer)
        this.healthyTimer = undefined
      }

      if (this.stopped) return

      this.handlers.onDisconnected?.()
      this.scheduleReconnect()
    })

    ws.on('error', (err) => {
      console.error('[Wake] WebSocket error:', err.message)
      this.handlers.onError?.(err)
    })
  }

  /**
   * Re-sends the current subscription on the open socket. AISstream
   * REPLACES the whole subscription on each update (max 1/sec) rather than
   * merging, so this always sends the complete boundingBoxes/
   * filterMessageTypes set, identical to what connect() sent. The Wake
   * server never calls this today — it exists for tools (e.g. RISK-1's
   * capacityCapture) that need to refresh a long-lived subscription.
   * A no-op on a socket that isn't open.
   */
  resubscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(this.buildSubscriptionMessage())
    console.log('[Wake] Subscription re-sent')
  }

  private scheduleReconnect(): void {
    const jitter = Math.random() * JITTER_MAX_MS
    const delay = Math.min(this.backoffMs, MAX_BACKOFF_MS) + jitter

    console.log(`[Wake] Reconnecting in ${Math.round(delay)}ms`)
    this.handlers.onReconnectAttempt?.(delay)

    setTimeout(() => {
      if (this.stopped) return
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
      this.connect()
    }, delay)
  }

  /** Stops future reconnect attempts. Does not itself close the socket. */
  stopReconnecting(): void {
    this.stopped = true
    if (this.healthyTimer) {
      clearTimeout(this.healthyTimer)
      this.healthyTimer = undefined
    }
  }
}

/**
 * DEMO-1: optional connection override from resolveSourceConfig. When
 * given, the env key read is skipped (aiscast's credential lives in
 * AISCAST_TOKEN, not AISSTREAM_API_KEY). Omitted -- as every existing
 * caller and test does -- the behaviour is unchanged: key from
 * AISSTREAM_API_KEY, URL = AISSTREAM_URL.
 */
export interface ConnectionOverride {
  url: string
  apiKey: string
}

export function createAisStreamClient(
  subscription: SubscriptionConfig,
  handlers: AisStreamHandlers,
  captureLogger?: CaptureLogger,
  socketFactory?: AisSocketFactory,
  connection?: ConnectionOverride,
): AisStreamClient {
  const apiKey = connection?.apiKey ?? process.env.AISSTREAM_API_KEY

  if (!apiKey || apiKey.trim() === '') {
    console.error(
      '[Wake] AISSTREAM_API_KEY is missing or empty. Set it in .env before starting the server.',
    )
    process.exit(1)
  }

  const url = connection?.url ?? AISSTREAM_URL

  return socketFactory
    ? new AisStreamClient(apiKey, subscription, handlers, captureLogger, socketFactory, url)
    : new AisStreamClient(apiKey, subscription, handlers, captureLogger, defaultSocketFactory, url)
}
