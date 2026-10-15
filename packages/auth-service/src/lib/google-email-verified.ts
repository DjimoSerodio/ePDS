/**
 * Decide whether a Google sign-in proves control of the email address it
 * reports.
 *
 * better-auth 1.4.18's Google provider copies the ID token's
 * `email_verified` claim into the user's `emailVerified` unchanged, and the
 * code that consumes it (user creation, implicit account linking) tests it
 * for truthiness. Taking the claim at face value is wrong in two ways:
 *
 * 1. Type. The claim should be a JSON boolean, but Google has been seen to
 *    send the string "true" — and the string "false" is truthy. Only a
 *    boolean `true` or the exact string "true" counts as verified here.
 * 2. Authority. Google vouches for an address only when it hosts it: a
 *    Gmail address, or an address in a Google Workspace organisation (the
 *    token then carries an `hd` claim). Any other address was verified once,
 *    when the Google account was created, and may have changed hands since.
 *    Google's guidance is to treat such an address as unverified:
 *    https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
 *
 * The result feeds `mapProfileToUser`, which better-auth spreads over the
 * provider's own user info, so it replaces the raw claim everywhere
 * better-auth reads `emailVerified` for a Google sign-in (the redirect flow
 * and the ID-token flow alike).
 */
import type { GoogleProfile } from 'better-auth/social-providers'

/** Domains whose addresses are Gmail accounts, hosted by Google. */
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

/** True only for a boolean `true` or the exact string "true". */
export function isTrueClaim(value: unknown): boolean {
  return value === true || value === 'true'
}

/**
 * Whether Google is authoritative for `email`: a Gmail address, or any
 * address when the token names a Workspace hosted domain (`hd`).
 */
export function isGoogleAuthoritativeFor(email: unknown, hd: unknown): boolean {
  if (typeof hd === 'string' && hd.trim() !== '') return true
  if (typeof email !== 'string') return false
  const at = email.lastIndexOf('@')
  if (at < 0) return false
  return GMAIL_DOMAINS.has(
    email
      .slice(at + 1)
      .trim()
      .toLowerCase(),
  )
}

/** Whether a Google ID token's claims prove control of its `email`. */
export function googleEmailVerified(
  profile: Pick<Partial<GoogleProfile>, 'email' | 'hd'> & {
    email_verified?: unknown
  },
): boolean {
  return (
    isTrueClaim(profile.email_verified) &&
    isGoogleAuthoritativeFor(profile.email, profile.hd)
  )
}

/**
 * better-auth `mapProfileToUser` for the Google provider: replaces the raw
 * `email_verified` claim with {@link googleEmailVerified}.
 */
export function mapGoogleProfileToUser(profile: GoogleProfile): {
  emailVerified: boolean
} {
  return { emailVerified: googleEmailVerified(profile) }
}
