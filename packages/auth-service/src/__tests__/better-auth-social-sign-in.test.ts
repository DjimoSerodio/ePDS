/**
 * Google sign-in through a real better-auth instance: which ID tokens
 * produce a verified user, and when a Google identity may join an existing
 * user.
 *
 * Uses better-auth's ID-token sign-in (POST /sign-in/social with
 * `idToken`), which runs the same provider `getUserInfo` →
 * `mapProfileToUser` → `handleOAuthUserInfo` chain as the redirect flow's
 * callback, without a round trip to Google. The provider's signature check
 * is stubbed so the tests can mint unsigned tokens; everything after it is
 * stock better-auth with ePDS's provider config.
 */
import Database from 'better-sqlite3'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db'
import { describe, it, expect } from 'vitest'
import { buildSocialProviders } from '../better-auth.js'

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
  ])('treats %s as unverified', async (_label, email, claim) => {
    const auth = await makeAuth()
    const user = await signInWithGoogle(auth, { email, email_verified: claim })
    expect(user.emailVerified).toBe(false)
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
