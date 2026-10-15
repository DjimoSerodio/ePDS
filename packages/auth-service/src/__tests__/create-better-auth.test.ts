/**
 * The better-auth instance exactly as index.ts builds it (createBetterAuth),
 * not one assembled in the test: the user-creation guard, the verification
 * hooks and the strict Google claim only protect anyone if they are wired
 * into it.
 *
 * Runs on in-memory SQLite with Google configured, Google's token endpoint
 * stubbed (see __helpers__/google-sign-in), PDS lookups mocked, and the
 * email codes captured from a stub EmailSender, so both kinds of sign-in
 * run through stock better-auth.
 *
 * The "earlier release" cases seed user, account and session rows straight
 * into the database, bypassing the hooks, as a release before them would
 * have left them.
 */
import type Database from 'better-sqlite3'
import { getMigrations } from 'better-auth/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EpdsDb } from '@certified-app/shared'
import {
  createBetterAuth,
  dropLinksMadeBeforeVerification,
  noteEmailVerification,
  refuseUnverifiedUser,
} from '../better-auth.js'
import type { EmailSender } from '../email/sender.js'
import { mapGoogleProfileToUser } from '../lib/google-email-verified.js'
import { hasVerifiedEmail } from '../lib/verified-email.js'
import { signInWithGoogleRedirect } from './__helpers__/google-sign-in.js'

vi.mock('../lib/get-did-by-email.js', () => ({
  getDidByEmail: vi.fn(() => Promise.resolve(null)),
}))

/** The last email code sent to each address. */
const codes = new Map<string, string>()

const emailSender = {
  sendOtpCode: vi.fn((opts: { to: string; code: string }) => {
    codes.set(opts.to, opts.code)
    return Promise.resolve()
  }),
} as unknown as EmailSender

const epdsDb = {
  getAuthFlow: vi.fn(() => undefined),
} as unknown as EpdsDb

beforeEach(() => {
  vi.stubEnv('DB_LOCATION', ':memory:')
  vi.stubEnv('AUTH_HOSTNAME', 'auth.example')
  vi.stubEnv('AUTH_SESSION_SECRET', 'test-secret-test-secret-test-secret')
  vi.stubEnv('GOOGLE_CLIENT_ID', 'google-client-id')
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'google-client-secret')
  vi.stubEnv('GITHUB_CLIENT_ID', '')
  vi.stubEnv('GITHUB_CLIENT_SECRET', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  codes.clear()
})

async function makeAuth() {
  const auth = createBetterAuth(emailSender, epdsDb, 6)
  const { runMigrations } = await getMigrations(auth.options)
  await runMigrations()
  return auth
}

type Auth = Awaited<ReturnType<typeof makeAuth>>

/** Sign in with an emailed code, as the login page's email form does. */
async function signInWithEmailCode(auth: Auth, email: string) {
  await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
  const otp = codes.get(email)
  if (!otp) throw new Error(`no code was sent to ${email}`)
  return auth.api.signInEmailOTP({ body: { email, otp } })
}

async function storedUser(auth: Auth, email: string) {
  const ctx = await auth.$context
  return ctx.internalAdapter.findUserByEmail(email, { includeAccounts: true })
}

/**
 * Rows an earlier release could have left: a user with `emailVerified`,
 * a social identity linked to it, and a session of it.
 */
async function seedEarlierRelease(
  auth: Auth,
  user: { email: string; emailVerified: unknown },
  link: { providerId: string; accountId: string },
) {
  const ctx = await auth.$context
  const now = new Date()
  const row = await ctx.adapter.create<{ id: string }>({
    model: 'user',
    data: { ...user, name: '', createdAt: now, updatedAt: now },
  })
  await ctx.adapter.create({
    model: 'account',
    data: { ...link, userId: row.id, createdAt: now, updatedAt: now },
  })
  const session = await ctx.internalAdapter.createSession(row.id)
  return { userId: row.id, sessionToken: session.token }
}

/**
 * Overwrite a user's `emailVerified` with text, as an earlier release could
 * store Google's claim. better-auth's adapter would turn a string into a
 * number on write, so this goes straight to SQLite.
 */
function storeEmailVerifiedAsText(
  auth: Auth,
  userId: string,
  text: 'true' | 'false',
) {
  const db = auth.options.database as unknown as Database.Database
  db.prepare('UPDATE user SET emailVerified = ? WHERE id = ?').run(text, userId)
}

describe('createBetterAuth wiring', () => {
  it('passes ePDS’s database hooks and Google claim mapper to better-auth', async () => {
    const auth = await makeAuth()
    const userHooks = auth.options.databaseHooks.user
    expect(userHooks.create.before).toBe(refuseUnverifiedUser)
    expect(userHooks.update.before).toBe(noteEmailVerification)
    expect(userHooks.update.after).toBe(dropLinksMadeBeforeVerification)
    expect(auth.options.socialProviders.google?.mapProfileToUser).toBe(
      mapGoogleProfileToUser,
    )
  })

  it('refuses a Google address Google is not authoritative for, leaving no user', async () => {
    const auth = await makeAuth()
    expect(
      await signInWithGoogleRedirect(auth, {
        email: 'alice@example.com',
        email_verified: true,
      }),
    ).toBe('/auth/complete?error=email_not_verified')
    expect(await storedUser(auth, 'alice@example.com')).toBeNull()
  })

  it('signs a verified Gmail address in', async () => {
    const auth = await makeAuth()
    expect(
      await signInWithGoogleRedirect(auth, {
        email: 'alice@gmail.com',
        email_verified: true,
      }),
    ).toBe('/auth/complete')
    const user = await storedUser(auth, 'alice@gmail.com')
    expect(user?.user.emailVerified).toBe(true)
    expect(user?.accounts.map((a) => a.providerId)).toEqual(['google'])
  })
})

describe('an email becoming verified (createBetterAuth)', () => {
  it('cuts a Google identity an earlier release linked to an unverified user loose when the owner signs in by email code', async () => {
    const auth = await makeAuth()
    const ctx = await auth.$context
    const { userId, sessionToken } = await seedEarlierRelease(
      auth,
      { email: 'alice@example.com', emailVerified: false },
      { providerId: 'google', accountId: 'google-sub-1' },
    )

    const res = await signInWithEmailCode(auth, 'alice@example.com')

    const user = await storedUser(auth, 'alice@example.com')
    expect(user?.user.id).toBe(userId)
    expect(user?.user.emailVerified).toBe(true)
    expect(user?.accounts).toEqual([])
    // The old session of the Google identity is gone; the owner's is not.
    expect(await ctx.internalAdapter.findSession(sessionToken)).toBeNull()
    expect(await ctx.internalAdapter.findSession(res.token)).not.toBeNull()

    // The Google identity (sub google-sub-1, a non-Gmail address) can no
    // longer sign in as the owner.
    expect(
      await signInWithGoogleRedirect(auth, {
        email: 'alice@example.com',
        email_verified: true,
      }),
    ).toBe('/auth/complete?error=account_not_linked')
  })

  it('drops other links when an authoritative Google sign-in verifies the user, then links again', async () => {
    const auth = await makeAuth()
    const ctx = await auth.$context
    const { sessionToken } = await seedEarlierRelease(
      auth,
      { email: 'alice@gmail.com', emailVerified: false },
      { providerId: 'github', accountId: 'github-someone-else' },
    )

    // The owner signs in with Google: better-auth links the identity and
    // marks the user verified, and the hook then drops every link (this
    // one included) and the old sessions. The sign-in itself completes.
    expect(
      await signInWithGoogleRedirect(auth, {
        email: 'alice@gmail.com',
        email_verified: true,
      }),
    ).toBe('/auth/complete')
    let user = await storedUser(auth, 'alice@gmail.com')
    expect(user?.user.emailVerified).toBe(true)
    expect(user?.accounts).toEqual([])
    expect(await ctx.internalAdapter.findSession(sessionToken)).toBeNull()
    expect(
      await ctx.internalAdapter.listSessions(user?.user.id ?? ''),
    ).toHaveLength(1)

    // Next time the Google identity links again by itself.
    expect(
      await signInWithGoogleRedirect(auth, {
        email: 'alice@gmail.com',
        email_verified: true,
      }),
    ).toBe('/auth/complete')
    user = await storedUser(auth, 'alice@gmail.com')
    expect(user?.accounts.map((a) => a.providerId)).toEqual(['google'])
  })

  it('signs in a user an earlier release stored as the text "true" by email code', async () => {
    const auth = await makeAuth()
    const { userId } = await seedEarlierRelease(
      auth,
      { email: 'alice@gmail.com', emailVerified: true },
      { providerId: 'google', accountId: 'google-sub-1' },
    )
    storeEmailVerifiedAsText(auth, userId, 'true')
    // better-auth reads the text back unchanged.
    expect(
      (await storedUser(auth, 'alice@gmail.com'))?.user.emailVerified,
    ).toBe('true')

    const res = await signInWithEmailCode(auth, 'alice@gmail.com')

    expect(hasVerifiedEmail(res.user)).toBe(true)
    const session = await (
      await auth.$context
    ).internalAdapter.findSession(res.token)
    expect(hasVerifiedEmail(session?.user)).toBe(true)
  })

  it('still treats a user an earlier release stored as the text "false" as unverified', async () => {
    const auth = await makeAuth()
    const { userId } = await seedEarlierRelease(
      auth,
      { email: 'alice@example.com', emailVerified: false },
      { providerId: 'google', accountId: 'google-sub-1' },
    )
    storeEmailVerifiedAsText(auth, userId, 'false')

    // better-auth only marks a user verified when the stored value is
    // falsy, and the text 'false' is not, so an email code leaves it as is:
    // this is the row docs/configuration.md says to remove by hand.
    const res = await signInWithEmailCode(auth, 'alice@example.com')

    expect(hasVerifiedEmail(res.user)).toBe(false)
    expect(
      (await storedUser(auth, 'alice@example.com'))?.user.emailVerified,
    ).toBe('false')
  })

  it('leaves a verified user’s links and sessions alone on an email-code sign-in', async () => {
    const auth = await makeAuth()
    const ctx = await auth.$context
    const { sessionToken } = await seedEarlierRelease(
      auth,
      { email: 'alice@gmail.com', emailVerified: true },
      { providerId: 'google', accountId: 'google-sub-1' },
    )

    await signInWithEmailCode(auth, 'alice@gmail.com')

    const user = await storedUser(auth, 'alice@gmail.com')
    expect(user?.accounts.map((a) => a.providerId)).toEqual(['google'])
    expect(await ctx.internalAdapter.findSession(sessionToken)).not.toBeNull()
  })
})
