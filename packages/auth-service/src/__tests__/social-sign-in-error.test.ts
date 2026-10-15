import { describe, it, expect } from 'vitest'
import {
  loginPageUrlWithError,
  SOCIAL_ERROR_PARAM,
  socialSignInErrorCode,
  socialSignInErrorMessage,
} from '../lib/social-sign-in-error.js'

describe('socialSignInErrorCode', () => {
  it.each([
    ['access_denied', 'cancelled'],
    ['account_not_linked', 'email_unverified'],
    ['email_not_found', 'no_email'],
    ['invalid_code', 'failed'],
    ['unable_to_create_user', 'failed'],
    ['', 'failed'],
    [['access_denied', 'x'], 'failed'],
    [undefined, 'failed'],
  ])('%j -> %s', (error, code) => {
    expect(socialSignInErrorCode(error)).toBe(code)
  })
})

describe('socialSignInErrorMessage', () => {
  it.each(['cancelled', 'email_unverified', 'no_email', 'failed'])(
    'has a message for %s',
    (code) => {
      expect(socialSignInErrorMessage(code)).toEqual(expect.any(String))
    },
  )

  it.each([
    'access_denied',
    '<script>alert(1)</script>',
    'toString',
    '__proto__',
    '',
    undefined,
    ['cancelled'],
  ])('has no message for %j', (code) => {
    expect(socialSignInErrorMessage(code)).toBeNull()
  })
})

describe('loginPageUrlWithError', () => {
  it('returns to the login page for the flow with the code', () => {
    const url = new URL(
      loginPageUrlWithError(
        {
          requestUri: 'urn:ietf:params:oauth:request_uri:req-123',
          clientId: 'https://app.example/client.json',
        },
        'cancelled',
      ),
      'https://auth.example',
    )
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('request_uri')).toBe(
      'urn:ietf:params:oauth:request_uri:req-123',
    )
    expect(url.searchParams.get('client_id')).toBe(
      'https://app.example/client.json',
    )
    expect(url.searchParams.get(SOCIAL_ERROR_PARAM)).toBe('cancelled')
  })

  it('omits client_id when the flow has none', () => {
    const url = new URL(
      loginPageUrlWithError({ requestUri: 'urn:x', clientId: null }, 'failed'),
      'https://auth.example',
    )
    expect(url.searchParams.has('client_id')).toBe(false)
  })
})
