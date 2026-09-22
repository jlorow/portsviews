import type { ConnectionStatus } from './wakeSocket'

// Small, separate from the canvas. Connected vs disconnected only -- the
// server deliberately sends no AIS-side health signal (see S3.5), and a
// data gap looks identical to a quiet period, so there is no third state
// to show here. Per S1.7's spec: a small dot in a corner, not a banner.
export default function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const color = status === 'connected' ? '#7EC8C8' : '#8A9DB5'

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 12,
        right: 12,
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: color,
        opacity: status === 'connected' ? 0.8 : 0.4,
      }}
    />
  )
}
