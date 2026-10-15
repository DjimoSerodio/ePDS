/**
 * The one check for "this better-auth user's email is verified".
 *
 * ePDS keys a sign-in to a PDS account by email alone, so every route that
 * decides whether a session may act for that address (/auth/complete,
 * /auth/choose-handle, account settings, GET /account/login) and the
 * user-creation guard in better-auth.ts must agree on it. A looser check in
 * one route and a strict one in another made /account and /account/login
 * redirect to each other forever for some rows.
 *
 * Only a boolean `true` or the exact text 'true' counts. An earlier release
 * could store Google's `email_verified` claim as the text 'true' or
 * 'false', and better-auth's SQLite adapter turns stored numbers back into
 * booleans but leaves strings alone. The text 'true' is what that release
 * stored for a verified claim, so it is honoured, as a boolean `true` from
 * the same release is; the text 'false' is truthy and must never count.
 */
export function hasVerifiedEmail(
  user: { emailVerified?: unknown } | null | undefined,
): boolean {
  const value = user?.emailVerified
  return value === true || value === 'true'
}
