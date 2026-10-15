/**
 * Google sign-in through a real better-auth instance: which ID tokens
 * produce a verified user, that an unverified email never becomes a user,
 * and when a Google identity may join an existing user.
 *
 * Most cases use better-auth's ID-token sign-in (POST /sign-in/social with
 * `idToken`), which runs the same provider `getUserInfo` →
 * `mapProfileToUser` → `handleOAuthUserInfo` chain as the redirect flow's
 * callback, without a round trip to Google. The provider's signature check
 * is stubbed so the tests can mint unsigned tokens; everything after it is
 * stock better-auth with ePDS's provider config and database hooks.
 *
 * The last block drives the redirect flow the login page uses (POST
 * /sign-in/social, then GET /callback/google) with Google's token endpoint
 * stubbed, to pin where cancels and refusals land.
 */
import Database from 'better-sqlite3'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db'
import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  buildSocialProviders,
  databaseHooks,
  EMAIL_NOT_VERIFIED,
} from '../better-auth.js'

/** An unsigned JWT carrying `claims`; better-auth's decodeJwt only parses. */
function idToken(claims: Record<string, unknown>): string {
  const part = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${part({ alg: 'RS256', kid: 'test' })}.${part({
    iss: 'https://accounts.google.com',
    aud: 'google-client-id',
    sub: 'google-sub-1',
    name: 'Alice',
    picture: 'https://example.com/a.png',
    iat: 0,
    exp: 9999999999,
    ...claims,
  })}.sig`
}

async function makeAuth() {
  const google = buildSocialProviders({
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-client-secret',
  }).google
  if (!google) throw new Error('Google provider not configured')
  const auth = betterAuth({
    secret: 'test-secret-test-secret-test-secret',
    baseURL: 'https://auth.example',
    basePath: '/api/auth',
    database: new Database(':memory:'),
    databaseHooks,
    socialProviders: {
      google: { ...google, verifyIdToken: () => Promise.resolve(true) },
    },
  })
  const { runMigrations } = await getMigrations(auth.options)
  await runMigrations()
  return auth
}

type Auth = Awaited<ReturnType<typeof makeAuth>>

/** Sign in with an ID token carrying `claims`; resolves to the user. */
async function signInWithGoogle(auth: Auth, claims: Record<string, unknown>) {
  const res = await auth.api.signInSocial({
    body: { provider: 'google', idToken: { token: idToken(claims) } },
  })
  if (!('user' in res)) throw new Error('expected an ID-token sign-in result')
  return res.user
}

async function storedUser(auth: Auth, email: string) {
  const ctx = await auth.$context
  return ctx.internalAdapter.findUserByEmail(email, { includeAccounts: true })
}

describe('Google sign-in emailVerified (real better-auth)', () => {
  it.each([
    ['a boolean true on a Gmail address', 'alice@gmail.com', true, undefined],
    [
      'the string "true" on a Gmail address',
      'alice@gmail.com',
      'true',
      undefined,
    ],
    [
      'a Workspace address (hd present)',
      'alice@example.com',
      true,
      'example.com',
    ],
  ])('treats %s as verified', async (_label, email, claim, hd) => {
    const auth = await makeAuth()
    const user = await signInWithGoogle(auth, {
      email,
      email_verified: claim,
      ...(hd ? { hd } : {}),
    })
    expect(user.emailVerified).toBe(true)
  })

  it.each([
    ['the string "false" on a Gmail address', 'alice@gmail.com', 'false'],
    ['a boolean false on a Gmail address', 'alice@gmail.com', false],
    [
      'a non-Gmail address without hd, even with email_verified true',
      'alice@example.com',
      true,
    ],
  ])('creates no user for %s', async (_label, email, claim) => {
    const auth = await makeAuth()
    await expect(
      signInWithGoogle(auth, { email, email_verified: claim }),
    ).rejects.toThrow(EMAIL_NOT_VERIFIED)
    expect(await storedUser(auth, email)).toBeNull()
  })

  it('leaves nothing behind for a later email sign-in to adopt', async () => {
    const auth = await makeAuth()
    const ctx = await auth.$context
    // Google calls the address verified but is not authoritative for it.
    const claims = { email: 'alice@example.com', email_verified: true }
    await expect(signInWithGoogle(auth, claims)).rejects.toThrow(
      EMAIL_NOT_VERIFIED,
    )

    // The address's owner then signs in with an email code, which creates
    // a verified user for it.
    await ctx.internalAdapter.createUser({
      email: 'alice@example.com',
      name: 'alice@example.com',
      emailVerified: true,
    })

    // The Google identity still cannot sign in as that user.
    await expect(signInWithGoogle(auth, claims)).rejects.toThrow(
      'account not linked',
    )
    const user = await storedUser(auth, 'alice@example.com')
    expect(user?.accounts.filter((a) => a.providerId === 'google')).toEqual([])
  })

  it('does not link a non-authoritative Google identity to an existing user', async () => {
    const auth = await makeAuth()
    const ctx = await auth.$context
    // As created by a successful email-OTP sign-in.
    await ctx.internalAdapter.createUser({
      email: 'alice@example.com',
      name: 'alice@example.com',
      emailVerified: true,
    })

    await expect(
      signInWithGoogle(auth, {
        email: 'alice@example.com',
        email_verified: true,
      }),
    ).rejects.toThrow('account not linked')

    const user = await storedUser(auth, 'alice@example.com')
    expect(user?.accounts.filter((a) => a.providerId === 'google')).toEqual([])
  })

  it('links a verified Gmail identity to an existing user', async () => {
    const auth = await makeAuth()
    const ctx = await auth.$context
    await ctx.internalAdapter.createUser({
      email: 'alice@gmail.com',
      name: 'alice@gmail.com',
      emailVerified: true,
    })

    const user = await signInWithGoogle(auth, {
      email: 'alice@gmail.com',
      email_verified: true,
    })

    expect(user.email).toBe('alice@gmail.com')
    const stored = await storedUser(auth, 'alice@gmail.com')
    expect(stored?.accounts.map((a) => a.providerId)).toContain('google')
  })
})

describe('Google redirect flow outcomes (real better-auth)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * Start a sign-in exactly as the login page's Google button does and
   * return the state and cookies the callback needs.
   */
  async function startSignIn(auth: Auth) {
    const res = await auth.handler(
      new Request('https://auth.example/api/auth/sign-in/social', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://auth.example',
        },
        body: JSON.stringify({
          provider: 'google',
          callbackURL: '/auth/complete',
          errorCallbackURL: '/auth/complete',
        }),
      }),
    )
    expect(res.status).toBe(200)
    const { url } = (await res.json()) as { url: string }
    const state = new URL(url).searchParams.get('state') ?? ''
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')
    return { state, cookie }
  }

  /** Answer Google's token endpoint with an ID token carrying `claims`. */
  function stubGoogleToken(claims: Record<string, unknown>) {
    const realFetch = globalThis.fetch.bind(globalThis)
    vi.stubGlobal(
      'fetch',
      vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url =
          input instanceof URL
            ? input.href
            : typeof input === 'string'
              ? input
              : input.url
        if (url.startsWith('https://oauth2.googleapis.com/token')) {
          return Promise.resolve(
            Response.json({
              access_token: 'access-token',
              id_token: idToken(claims),
              token_type: 'Bearer',
              expires_in: 3600,
            }),
          )
        }
        return realFetch(input, init)
      }),
    )
  }

  async function callback(auth: Auth, query: string, cookie: string) {
    const res = await auth.handler(
      new Request(`https://auth.example/api/auth/callback/google?${query}`, {
        headers: { cookie },
      }),
    )
    expect(res.status).toBe(302)
    return res.headers.get('location')
  }

  it('sends a cancel at Google to /auth/complete with ?error=', async () => {
    const auth = await makeAuth()
    const { state, cookie } = await startSignIn(auth)
    expect(
      await callback(auth, `error=access_denied&state=${state}`, cookie),
    ).toBe('/auth/complete?error=access_denied')
  })

  it('sends an unverified email to /auth/complete with ?error=', async () => {
    const auth = await makeAuth()
    const { state, cookie } = await startSignIn(auth)
    stubGoogleToken({ email: 'alice@example.com', email_verified: true })

    expect(await callback(auth, `code=c&state=${state}`, cookie)).toBe(
      '/auth/complete?error=email_not_verified',
    )
    expect(await storedUser(auth, 'alice@example.com')).toBeNull()
  })

  it('signs a verified Gmail address in and goes to /auth/complete', async () => {
    const auth = await makeAuth()
    const { state, cookie } = await startSignIn(auth)
    stubGoogleToken({ email: 'alice@gmail.com', email_verified: true })

    expect(await callback(auth, `code=c&state=${state}`, cookie)).toBe(
      '/auth/complete',
    )
    const user = await storedUser(auth, 'alice@gmail.com')
    expect(user?.user.emailVerified).toBe(true)
  })
})
