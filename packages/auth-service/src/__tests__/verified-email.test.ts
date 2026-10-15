import { describe, expect, it } from 'vitest'
import { hasVerifiedEmail } from '../lib/verified-email.js'

describe('hasVerifiedEmail', () => {
  it('is true for a boolean true', () => {
    expect(hasVerifiedEmail({ emailVerified: true })).toBe(true)
  })

  // 'true' is what an earlier release could store for a verified Google
  // claim; better-auth's SQLite adapter reads it back as a string.
  it('is true for the exact string "true"', () => {
    expect(hasVerifiedEmail({ emailVerified: 'true' })).toBe(true)
  })

  // 'false' is the other string an earlier release could store, and it is
  // truthy; no other string or number counts either.
  it.each([
    false,
    'false',
    'TRUE',
    'True',
    ' true',
    'true ',
    '1',
    'yes',
    '',
    1,
    0,
    null,
    undefined,
    {},
  ])('is false for %j', (emailVerified) => {
    expect(hasVerifiedEmail({ emailVerified })).toBe(false)
  })

  it('is false for no user', () => {
    expect(hasVerifiedEmail(null)).toBe(false)
    expect(hasVerifiedEmail(undefined)).toBe(false)
  })
})
