/**
 * Route-level coverage for GET /oauth/authorize?epds_social_error=<code>:
 * the login page that /auth/complete returns to after a social sign-in was
 * cancelled or refused shows the fixed message for a known code, and
 * nothing for anything else. The served page's own script is run (see
 * __helpers__/login-page-script) to show that the message reaches the
 * flash region on load, not just that it is in the HTML.
 *
 * The return renders this page's email step even when the browser holds a
 * device session and the PAR has a login_hint: handing it to pds-core's
 * account chooser would lose the message, and could auto-select the hinted
 * account for someone who had chosen "Another account".
 */
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import cookieParser from 'cookie-parser'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _seedClientMetadataCacheForTest } from '@certified-app/shared'
import { AuthServiceContext, type AuthServiceConfig } from '../context.js'
import {
  socialSignInErrorMessage,
  type SocialSignInErrorCode,
} from '../lib/social-sign-in-error.js'
import { csrfProtection } from '../middleware/csrf.js'
import { createLoginPageRouter } from '../routes/login-page.js'
import { jsonResponse, runPageScript } from './__helpers__/login-page-script.js'

const mocks = vi.hoisted(() => ({
  fetchParLoginHint: vi.fn<() => Promise<string | null>>(),
  resolveLoginHint: vi.fn<() => Promise<string | null>>(),
  fetchDeviceAccountEmails: vi.fn<() => Promise<string[] | null>>(),
}))

vi.mock('../lib/resolve-login-hint.js', () => ({
  fetchParLoginHint: mocks.fetchParLoginHint,
  resolveLoginHint: mocks.resolveLoginHint,
}))

vi.mock('../lib/fetch-device-accounts.js', () => ({
  fetchDeviceAccountEmails: mocks.fetchDeviceAccountEmails,
}))

function makeConfig(dbPath: string): AuthServiceConfig {
  return {
    hostname: 'auth.test.local',
    port: 0,
    sessionSecret: 'test-session-secret',
    epdsCallbackSecret: 'test-callback-secret',
    pdsHostname: 'test.local',
    pdsPublicUrl: 'https://test.local',
    email: {
      provider: 'smtp',
      smtpHost: 'localhost',
      smtpPort: 1025,
      from: 'noreply@test.local',
      fromName: 'ePDS Test',
    },
    dbLocation: dbPath,
    otpLength: 6,
    otpCharset: 'numeric',
    trustedClients: [],
  }
}

describe('GET /oauth/authorize with epds_social_error', () => {
  let dbPath: string
  let ctx: AuthServiceContext
  let baseUrl: string
  let close: () => Promise<void>

  beforeEach(async () => {
    mocks.fetchParLoginHint.mockResolvedValue(null)
    mocks.resolveLoginHint.mockResolvedValue(null)
    mocks.fetchDeviceAccountEmails.mockResolvedValue(null)
    dbPath = path.join(
      os.tmpdir(),
      `social-error-${Date.now()}-${randomBytes(4).toString('hex')}.db`,
    )
    _seedClientMetadataCacheForTest('https://app.example.com', {
      client_name: 'Test App',
    })
    ctx = new AuthServiceContext(makeConfig(dbPath))
    const app = express()
    app.disable('x-powered-by')
    app.use(cookieParser())
    app.use(csrfProtection())
    app.use(createLoginPageRouter(ctx))
    const server = app.listen(0)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.once('listening', () => {
        resolve()
      })
    })
    server.unref()
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    close = () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
  })

  afterEach(async () => {
    vi.clearAllMocks()
    await close()
    ctx.destroy()
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(dbPath + suffix, { force: true })
    }
  })

  /** GET /oauth/authorize for the test flow, without following redirects. */
  function authorize(
    socialError: string | null,
    headers: Record<string, string> = {},
  ): Promise<globalThis.Response> {
    return fetch(
      `${baseUrl}/oauth/authorize?request_uri=urn:ietf:params:oauth:request_uri:social` +
        `&client_id=${encodeURIComponent('https://app.example.com')}` +
        (socialError === null
          ? ''
          : `&epds_social_error=${encodeURIComponent(socialError)}`),
      { headers, redirect: 'manual' },
    )
  }

  async function loginPage(
    socialError: string,
    headers: Record<string, string> = {},
  ): Promise<string> {
    const res = await authorize(socialError, headers)
    expect(res.status).toBe(200)
    return res.text()
  }

  /** A full upstream device-session cookie pair, as after a sign-in. */
  const deviceSession = { cookie: 'dev-id=dev-1; ses-id=ses-1' }

  /** The text the page script puts in the flash region on load. */
  function flashOnLoad(html: string): string {
    return runPageScript(html, () => jsonResponse(200, {})).flash.text
  }

  it.each<SocialSignInErrorCode>([
    'cancelled',
    'email_unverified',
    'no_email',
    'failed',
  ])('shows the fixed message for %s on load', async (code) => {
    const message = socialSignInErrorMessage(code)
    expect(message).toBeTruthy()
    const html = await loginPage(code)
    expect(html).toContain(`var initialError = ${JSON.stringify(message)};`)
    expect(flashOnLoad(html)).toBe(message)
  })

  it('shows nothing for an unknown code, and never reflects it', async () => {
    const html = await loginPage('<b>owned</b>')
    expect(html).toContain('var initialError = "";')
    expect(html).not.toContain('owned')
    expect(flashOnLoad(html)).toBe('')
  })

  describe('with a device session in the browser', () => {
    it('is handed to pds-core without an error (control)', async () => {
      const res = await authorize(null, deviceSession)
      expect(res.status).toBe(302)
    })

    it('renders the login page with the message instead', async () => {
      const html = await loginPage('cancelled', deviceSession)
      expect(flashOnLoad(html)).toBe(socialSignInErrorMessage('cancelled'))
    })

    it('ignores the PAR login_hint and shows the email step', async () => {
      // The RP's hint is bound to this device: without the error, this
      // is the auto-select case (flow 1).
      mocks.fetchParLoginHint.mockResolvedValue('alice@example.com')
      mocks.resolveLoginHint.mockResolvedValue('alice@example.com')
      mocks.fetchDeviceAccountEmails.mockResolvedValue(['alice@example.com'])
      expect((await authorize(null, deviceSession)).status).toBe(302)
      mocks.fetchParLoginHint.mockClear()

      const html = await loginPage('cancelled', deviceSession)
      expect(mocks.fetchParLoginHint).not.toHaveBeenCalled()
      expect(html).toContain('var initialStep = "email";')
      expect(html).not.toContain('alice@example.com')
    })
  })
})
