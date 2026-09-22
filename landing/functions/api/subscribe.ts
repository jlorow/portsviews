/**
 * LANDING-5 — the serverless adapter for the signup endpoint.
 *
 * PLATFORM: Cloudflare Pages Functions, proposed rather than assumed —
 * A0 found NO hosting configuration anywhere in this repository, and
 * CLAUDE.md still lists "hosting choice" among the risk checks deferred
 * until the waitlist shows demand. Pages Functions was chosen as the
 * smallest possible addition: a file at functions/api/subscribe.ts inside
 * the static folder becomes POST /api/subscribe with NO config file, no
 * build step and no change to how landing/ is served. Nothing else in the
 * folder knows it exists.
 *
 * THIS FILE IS DELIBERATELY TRIVIAL. Every decision lives in
 * ../../src/subscribe.ts, which is pure and tested. Moving to Vercel,
 * Netlify or a plain Node server means writing a different twelve-line
 * adapter beside this one; it does not mean revisiting any of the logic.
 *
 * The environment is read here and nowhere else. RESEND_API_KEY never
 * leaves this process: it goes into an Authorization header inside
 * buildContactRequest and is not logged, echoed, or returned.
 */
import { handleSubscribe, type SubscribeEnv } from '../../src/subscribe'

interface PagesContext {
  request: Request
  env: SubscribeEnv
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Nothing here is cacheable and a cached signup response would be
      // actively confusing.
      'Cache-Control': 'no-store',
    },
  })
}

async function readEmail(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    try {
      const body = (await request.json()) as { email?: unknown }
      return body?.email
    } catch {
      return undefined
    }
  }
  // A plain <form> POST, so the endpoint still works if the page's
  // JavaScript fails to load.
  try {
    const form = await request.formData()
    return form.get('email')
  } catch {
    return undefined
  }
}

/**
 * ONE export, branching on the method internally, rather than an
 * `onRequestPost` beside an `onRequest`. Cloudflare documents both forms,
 * but which wins when both are exported is a precedence detail this code
 * does not need to depend on -- and getting it wrong silently would mean a
 * GET returning something that looks like a successful signup.
 */
export async function onRequest(context: PagesContext): Promise<Response> {
  if (context.request.method !== 'POST') {
    return json({ code: 'method_not_allowed', message: 'Send a POST request.' }, 405)
  }

  const email = await readEmail(context.request)

  const outcome = await handleSubscribe(email, context.env, {
    fetchImpl: async (url, init) => {
      const response = await fetch(url, init)
      // LANDING-6 A0: text(), not json() -- handleSubscribe logs Resend's
      // raw body verbatim on any non-2xx, and json() would discard exactly
      // the response that is hardest to diagnose.
      return { status: response.status, text: () => response.text() }
    },
  })

  return json({ code: outcome.code, message: outcome.message }, outcome.status)
}
