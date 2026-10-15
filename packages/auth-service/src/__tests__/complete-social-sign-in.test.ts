/**
 * Route-level tests for how /auth/complete treats a social (Google /
 * GitHub) sign-in that did not complete.
 *
 * The social buttons pass /auth/complete as better-auth's errorCallbackURL,
 * so a cancel at the provider or a refusal by better-auth arrives here as
 * ?error=<code>. The route must send the user back to the login page for
 * the same flow, with a fixed error code, and must not fall through to
 * whatever better-auth session the browser already holds.
 */
import type { AddressInfo } from 'node:net'
import express from 'express'
import cookieParser from 'cookie-parser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthServiceContext } from '../context.js'
import { createCompleteRouter } from '../routes/complete.js'

const mocks = vi.hoisted(() => ({
  getDidByEmail: vi.fn(),
  pingParRequest: vi.fn(),
  resolveRecoveryEmail: vi.fn(),
}))

vi.mock('../lib/get-did-by-email.js', () => ({
  getDidByEmail: mocks.getDidByEmail,
}))

vi.mock('../lib/ping-par-request.js', () => ({
  pingParRequest: mocks.pingParRequest,
}))

vi.mock('../lib/resolve-recovery-email.js', () => ({
  resolveRecoveryEmail: mocks.resolveRecoveryEmail,
}))

const AUTH_FLOW_COOKIE = 'epds_auth_flow'
const REQUEST_URI = 'urn:ietf:params:oauth:request_uri:req-123'
const CLIENT_ID = 'https://app.example/client.json'

function makeCtx(): AuthServiceContext {
  return {
    config: {
      pdsPublicUrl: 'https://pds.example',
      pdsHostname: 'pds.example',
      epdsCallbackSecret: 'test-callback-secret',
      trustedClients: [],
    },
    db: {
      getAuthFlow: vi.fn(() => ({
        flowId: 'flow-1',
        requestUri: REQUEST_URI,
        clientId: CLIENT_ID,
        handleMode: 'random',
      })),
      deleteAuthFlow: vi.fn(),
    },
  } as unknown as AuthServiceContext
}

function makeAuth(user: Record<string, unknown> | null) {
  return {
    api: {
      getSession: vi.fn(() => Promise.resolve(user ? { user } : null)),
    },
  }
}

type FakeAuth = ReturnType<typeof makeAuth>

async function startApp(auth: FakeAuth) {
  const app = express()
  app.disable('x-powered-by')
  app.use(cookieParser())
  app.use(createCompleteRouter(makeCtx(), auth))
  const server = app.listen(0)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => {
      resolve()
    })
  })
  server.unref()
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      }),
  }
}

/** GET `path` with the flow cookie; returns the 303 redirect target. */
async function redirectFrom(auth: FakeAuth, path: string): Promise<URL> {
  const app = await startApp(auth)
  try {
    const res = await fetch(`${app.baseUrl}${path}`, {
      redirect: 'manual',
      headers: { cookie: `${AUTH_FLOW_COOKIE}=flow-1` },
    })
    expect(res.status).toBe(303)
    const location = res.headers.get('location')
    if (!location) throw new Error('Missing redirect location')
    return new URL(location, app.baseUrl)
  } finally {
    await app.close()
  }
}

describe('/auth/complete after a social sign-in that did not complete', () => {
  let priorEnv: { pdsInternalUrl?: string; internalSecret?: string }

  beforeEach(() => {
    priorEnv = {
      pdsInternalUrl: process.env.PDS_INTERNAL_URL,
      internalSecret: process.env.EPDS_INTERNAL_SECRET,
    }
    process.env.PDS_INTERNAL_URL = 'http://pds.internal' // NOSONAR test-only internal mocked URL
    process.env.EPDS_INTERNAL_SECRET = 'test-internal-secret'
    mocks.getDidByEmail.mockReset()
    mocks.pingParRequest.mockReset()
    mocks.resolveRecoveryEmail.mockReset()
    mocks.pingParRequest.mockResolvedValue({ ok: true })
    mocks.resolveRecoveryEmail.mockResolvedValue(null)
  })

  afterEach(() => {
    if (priorEnv.pdsInternalUrl === undefined)
      delete process.env.PDS_INTERNAL_URL
    else process.env.PDS_INTERNAL_URL = priorEnv.pdsInternalUrl
    if (priorEnv.internalSecret === undefined)
      delete process.env.EPDS_INTERNAL_SECRET
    else process.env.EPDS_INTERNAL_SECRET = priorEnv.internalSecret
  })

  it.each([
    ['access_denied', 'cancelled'],
    ['account_not_linked', 'email_unverified'],
    ['email_not_found', 'no_email'],
    ['invalid_code', 'failed'],
  ])('?error=%s returns to the login page with %s', async (error, expected) => {
    const url = await redirectFrom(
      makeAuth(null),
      `/auth/complete?error=${error}`,
    )
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('request_uri')).toBe(REQUEST_URI)
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('epds_social_error')).toBe(expected)
  })

  it('does not use a session the browser already holds', async () => {
    // An earlier, valid sign-in in the same browser must not be resumed
    // when this one was cancelled.
    const auth = makeAuth({ email: 'alice@example.com', emailVerified: true })
    mocks.getDidByEmail.mockResolvedValue('did:plc:alice')

    const url = await redirectFrom(auth, '/auth/complete?error=access_denied')

    expect(url.pathname).toBe('/oauth/authorize')
    expect(auth.api.getSession).not.toHaveBeenCalled()
    expect(mocks.getDidByEmail).not.toHaveBeenCalled()
  })
})
