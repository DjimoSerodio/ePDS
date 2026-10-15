---
'ePDS': patch
---

Signing in with Google or GitHub now only works with an email address the provider can vouch for, and cancelling brings you back to the sign-in page.

**Affects:** End users, Operators

**End users:** If Google or GitHub cannot confirm that the address is yours (for Google, anything other than a Gmail or Google Workspace address), the sign-in page asks you to use a code sent to your email instead. Pressing Cancel at Google or GitHub returns you to the sign-in page instead of an error page.

**Operators:**

- A Google sign-in counts as email-verified only when the ID token's `email_verified` is `true` (boolean or the exact string `"true"`) and the address is `@gmail.com` / `@googlemail.com` or its domain equals the token's `hd` claim (ignoring case); an `hd` naming any other domain does not count. Unverified social sign-ins no longer create better-auth users, PDS accounts, or sessions that `/auth/complete`, `/auth/choose-handle` or `/account` accept.
- When a user's email becomes verified (an email-code sign-in, or a social sign-in the provider vouches for), the social identities linked to that user while it was unverified are removed and its other sessions signed out.
- **If `GOOGLE_*` or `GITHUB_*` was ever set on your instance, run the cleanup in `docs/configuration.md` ("If Google or GitHub was configured before this release") once after upgrading.** A social identity an earlier release linked to a verified user still signs in as that user without the email being checked again, and a user whose verified flag an earlier release stored as text cannot sign in by email code until it is removed.
- The redirect URIs to register are `https://<AUTH_HOSTNAME>/api/auth/callback/google` and `https://<AUTH_HOSTNAME>/api/auth/callback/github`; the Google consent screen needs only `openid`, `email` and `profile` and must be published "In production". See the social providers section of `docs/configuration.md`.
