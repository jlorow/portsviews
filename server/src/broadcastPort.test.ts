import net from 'node:net'
import { createPositionMap, createStaticMap } from './caches.ts'
import { createBroadcastServer, formatPortInUseMessage, type PortInUseReport } from './broadcast.ts'

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

// The formatter, asserted on its own first: it is pure, and the story fixes
// its wording. The live case below then proves the formatter is what a real
// failed bind actually reports.
{
  const message = formatPortInUseMessage(8080)
  assert(
    message.startsWith('[Wake] Port 8080 is already in use. Another Portsviews server may already be running'),
    `formatter: opens with the port and the likeliest cause (got ${JSON.stringify(message.slice(0, 60))})`,
  )
  assert(
    message.includes('(look at your other terminal windows), or another program uses that port.'),
    'formatter: keeps the other-program clause',
  )
  assert(
    message.includes('set WAKE_BROADCAST_PORT and VITE_WAKE_BROADCAST_PORT to the same number in .env'),
    'formatter: names both port settings, so a changed port is changed in both places',
  )
  assert(
    message.endsWith('and restart both the server and the display.'),
    'formatter: ends by saying both processes must restart',
  )
  assert(
    formatPortInUseMessage(1234).includes('Port 1234 is already in use.'),
    'formatter: the number it is given is the number it prints (no hardcoded port)',
  )
}

// A real taken port. The blocker listens on every interface (net's default
// host), so the broadcast server's own bind -- which also asks for every
// interface -- is refused on any platform rather than only where an
// overlapping bind happens to be rejected.
{
  const blocker = net.createServer()
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject)
    blocker.listen(0, () => resolve())
  })
  const address = blocker.address()
  if (address === null || typeof address === 'string') {
    throw new Error('test setup error: expected a TCP address with a port')
  }
  const takenPort = address.port

  // The report is a console line, so capture console.error for the duration.
  const printed: string[] = []
  const originalConsoleError = console.error
  console.error = (...args: unknown[]) => {
    printed.push(args.map((arg) => String(arg)).join(' '))
  }

  // The whole point of the handler: an occupied port must not surface as an
  // uncaught exception the way it did before (a raw stack trace).
  const uncaught: unknown[] = []
  const onUncaught = (err: unknown) => {
    uncaught.push(err)
  }
  process.on('uncaughtException', onUncaught)

  const reports: PortInUseReport[] = []
  const server = createBroadcastServer(takenPort, createPositionMap(), createStaticMap(), undefined, {
    onPortInUse: (report) => {
      reports.push(report)
    },
  })

  // The bind failure arrives asynchronously; poll for it instead of guessing
  // a sleep long enough on this machine.
  const deadline = Date.now() + 5000
  while (reports.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  console.error = originalConsoleError
  process.off('uncaughtException', onUncaught)

  assert(reports.length === 1, `port-in-use: the handler reported exactly once (got ${reports.length})`)
  assert(reports[0]?.code === 'EADDRINUSE', `port-in-use: the reported code is EADDRINUSE (got ${String(reports[0]?.code)})`)
  assert(
    reports[0]?.port === takenPort,
    `port-in-use: the report carries the port that was tried (wanted ${takenPort}, got ${String(reports[0]?.port)})`,
  )
  assert(
    reports[0]?.message === formatPortInUseMessage(takenPort),
    'port-in-use: the reported message is exactly the formatter output for that port',
  )
  assert(
    reports[0]?.message.includes(`Port ${takenPort} is already in use.`) === true,
    `port-in-use: the message contains the port number (got ${JSON.stringify(reports[0]?.message)})`,
  )
  assert(
    printed.some((line) => line.includes(`Port ${takenPort} is already in use.`)),
    `port-in-use: the message was printed to the operator (printed ${printed.length} line(s))`,
  )
  assert(uncaught.length === 0, `port-in-use: nothing escaped as an uncaught exception (got ${uncaught.length})`)

  // Release both sockets. A bind that never succeeded leaves no listening
  // handle, but close anyway so the process cannot be kept alive by this
  // scenario; the race is a guard, not an expected wait.
  await Promise.race([server.close(), new Promise<void>((resolve) => setTimeout(resolve, 1000))])
  await new Promise<void>((resolve) => blocker.close(() => resolve()))
}

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
