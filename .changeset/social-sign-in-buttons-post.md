---
'ePDS': patch
---

The "Sign in with Google" and "Sign in with GitHub" buttons now work.

**Affects:** End users, Operators

**End users:** Clicking either button used to end on a "not found" page. If a sign-in cannot be started, the page now says so and the button can be pressed again.

**Operators:** The buttons now POST `{ provider, callbackURL: '/auth/complete' }` to `/api/auth/sign-in/social` instead of linking to it with a GET, which better-auth answers with 404. Instances with `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` or `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` set need no change. Branding CSS that targeted `a.btn-google` / `a.btn-github` should target `.btn-google` / `.btn-github` instead.
