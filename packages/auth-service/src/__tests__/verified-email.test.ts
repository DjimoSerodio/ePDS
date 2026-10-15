import { describe, expect, it } from 'vitest'
import { hasVerifiedEmail } from '../lib/verified-email.js'

describe('hasVerifiedEmail', () => {
  it('is true only for a boolean true', () => {
    expect(hasVerifiedEmail({ emailVerified: true })).toBe(true)
  })

  // 'true' / 'false' are what an earlier release could store for Google's
  // claim; better-auth's SQLite adapter reads them back as strings.
  it.each([false, 'true', 'false', 1, 0, null, undefined])(
    'is false for %j',
    (emailVerified) => {
      expect(hasVerifiedEmail({ emailVerified })).toBe(false)
    },
  )

  it('is false for no user', () => {
    expect(hasVerifiedEmail(null)).toBe(false)
    expect(hasVerifiedEmail(undefined)).toBe(false)
  })
})
