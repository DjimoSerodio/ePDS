---
'ePDS': patch
---

The "Sign in with Google" and "Sign in with GitHub" buttons now work, and each client app chooses whether to show them.

**Affects:** End users, Client app developers, Operators

**End users:** Clicking either button used to end on a "not found" page. If a sign-in cannot be started, the page now says so and the button can be pressed again.

**Operators:** The buttons now POST `{ provider, callbackURL: '/auth/complete' }` to `/api/auth/sign-in/social` instead of linking to it with a GET, which better-auth answers with 404. Configuring a provider no longer adds its button to every client's login page; only clients that list it in `epds_social_providers` get it. Because the buttons never worked before this change (every click returned 404), no client loses a working sign-in. Branding CSS that targeted `a.btn-google` / `a.btn-github` should target `.btn-google` / `.btn-github` instead.

**Client app developers:** Social buttons are now opt-in per client, like the ATProto/Bluesky button. Add `"epds_social_providers": ["google"]` (and/or `"github"`) to your client metadata to show them. Clients that do not list a provider see no social buttons, even when the operator has configured it.
