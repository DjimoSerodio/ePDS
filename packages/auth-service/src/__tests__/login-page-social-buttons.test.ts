/**
 * The social sign-in buttons must POST to better-auth's /sign-in/social.
 *
 * better-auth registers that endpoint as POST-only, so the plain
 * `<a href=".../sign-in/social?provider=google...">` link the page used to
 * render sent a GET and got a 404: the Google and GitHub buttons could never
 * start a sign-in.
 *
 * The behavioural tests run the page's real inline script in a `node:vm`
 * context against a minimal stand-in DOM, then click a button: there is no
 * DOM test environment in this repo, and asserting on the script's source
 * text alone would not show that the handler is wired up.
 */
import * as vm from 'node:vm'
import { describe, it, expect, vi } from 'vitest'

vi.mock('../better-auth.js', () => ({
  socialProviders: {
    google: { clientId: 'google-id', clientSecret: 'google-secret' },
    github: { clientId: 'github-id', clientSecret: 'github-secret' },
  },
}))

const { renderLoginPage } = await import('../routes/login-page.js')

function render(
  branding: Record<string, unknown> = {
    epds_social_providers: ['google', 'github'],
  },
): string {
  return renderLoginPage({
    flowId: 'flow-1',
    clientId: 'https://example.com/client-metadata.json',
    clientName: 'Example',
    branding,
    customCss: null,
    customFaviconUrl: null,
    customFaviconUrlDark: null,
    loginHint: '',
    initialStep: 'email',
    otpAlreadySent: false,
    csrfToken: 'csrf',
    authBasePath: '/api/auth',
    pdsPublicUrl: 'https://pds.example.com',
    otpLength: 6,
    otpCharset: 'numeric',
    heartbeatEnabled: false,
  })
}

/** The page's main inline script (the one that owns the login flow). */
function mainScript(html: string): string {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1],
  )
  const main = scripts.find((s) => s.includes('var authBasePath'))
  if (!main) throw new Error('login page main script not found')
  return main
}

/**
 * A value that absorbs any property read, call or construction by returning
 * itself, so page-script initialisation that does not concern the social
 * buttons (OTP boxes, typo guard, heartbeat) runs without a real DOM.
 */
function absorbing(): unknown {
  const target = function () {}
  const proxy: unknown = new Proxy(target, {
    get: (_t, key) => {
      if (key === Symbol.toPrimitive) return () => ''
      if (key === 'length') return 0
      return proxy
    },
    set: () => true,
    apply: () => proxy,
    construct: () => proxy as object,
  })
  return proxy
}

interface FakeButton {
  disabled: boolean
  getAttribute: (name: string) => string | null
  addEventListener: (type: string, fn: () => unknown) => void
  click: () => unknown
}

function fakeButton(provider: string): FakeButton {
  let onClick: (() => unknown) | undefined
  return {
    disabled: false,
    getAttribute: (name) => (name === 'data-social-provider' ? provider : null),
    addEventListener: (type, fn) => {
      if (type === 'click') onClick = fn
    },
    click: () => onClick?.(),
  }
}

/**
 * Run the page script with fake Google/GitHub buttons and a stubbed
 * `fetch`, and return the handles a test needs to drive and observe it.
 */
function runPage(fetchImpl: (url: string, init: RequestInit) => unknown) {
  const buttons = { google: fakeButton('google'), github: fakeButton('github') }
  const assign = vi.fn()
  const fetchSpy = vi.fn(fetchImpl)
  const windowListeners: Partial<Record<string, ((e: unknown) => void)[]>> = {}
  // The shared flash region: records the text of the last message shown.
  const flash = { text: '' }
  const errorEl = {
    classList: { add: () => undefined, remove: () => undefined },
    replaceChildren: (frag?: { children: { textContent: string }[] }) => {
      flash.text = frag ? frag.children.map((c) => c.textContent).join('') : ''
    },
  }
  const fakeDocument: Record<string, unknown> = {
    querySelectorAll: (selector: string) =>
      selector === '[data-social-provider]'
        ? [buttons.google, buttons.github]
        : [],
    getElementById: (id: string) =>
      id === 'error-msg' ? errorEl : absorbing(),
    createDocumentFragment: () => {
      const children: unknown[] = []
      return { children, appendChild: (n: unknown) => children.push(n) }
    },
    createElement: () => ({ textContent: '' }),
  }
  const document = new Proxy(absorbing() as object, {
    get: (target, key) =>
      typeof key === 'string' && key in fakeDocument
        ? fakeDocument[key]
        : (target as Record<PropertyKey, unknown>)[key],
  })
  const window = {
    location: { assign, href: '', search: '' },
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      ;(windowListeners[type] ??= []).push(fn)
    },
  }
  vm.runInNewContext(mainScript(render()), {
    document,
    window,
    fetch: fetchSpy,
    setInterval: () => 0,
    clearInterval: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    navigator: absorbing(),
    URL,
    console,
  })
  return { buttons, assign, fetchSpy, windowListeners, flash }
}

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  })
}

/** Authorization URLs of the shape better-auth returns for each provider. */
const PROVIDER_URLS = {
  google:
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=google-id&state=s',
  github:
    'https://github.com/login/oauth/authorize?client_id=github-id&state=s',
} as const

describe('renderLoginPage social sign-in buttons', () => {
  it('never links to /sign-in/social with a GET', () => {
    expect(render()).not.toContain('/sign-in/social?provider=')
  })

  it.each(['google', 'github'])('renders %s as a button, not a link', (p) => {
    expect(render()).toContain(
      `<button type="button" class="btn-social btn-${p}" data-social-provider="${p}">`,
    )
  })

  it.each(['google', 'github'] as const)(
    'clicking %s POSTs the provider and follows the returned URL',
    async (provider) => {
      const providerUrl = PROVIDER_URLS[provider]
      const { buttons, assign, fetchSpy } = runPage(() =>
        jsonResponse(200, { url: providerUrl, redirect: true }),
      )

      await buttons[provider].click()

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url, init] = fetchSpy.mock.calls[0]
      expect(url).toBe('/api/auth/sign-in/social')
      expect(init.method).toBe('POST')
      expect(JSON.parse(init.body as string)).toEqual({
        provider,
        callbackURL: '/auth/complete',
      })
      expect(assign).toHaveBeenCalledWith(providerUrl)
    },
  )

  it('ignores a second click while the first POST is in flight', async () => {
    let resolveFetch: (v: unknown) => void = () => undefined
    const { buttons, fetchSpy } = runPage(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        }),
    )

    const first = buttons.google.click()
    await buttons.google.click()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    resolveFetch(await jsonResponse(200, { url: PROVIDER_URLS.google }))
    await first
  })

  it.each([
    ['an error status', () => jsonResponse(404, {})],
    ['a response without a URL', () => jsonResponse(200, {})],
    ['a network failure', () => Promise.reject(new Error('offline'))],
  ])(
    'shows an error and re-enables the button after %s',
    async (_label, impl) => {
      const { buttons, assign, fetchSpy, flash } = runPage(impl)

      await buttons.github.click()

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(assign).not.toHaveBeenCalled()
      expect(flash.text).toBe('Could not start sign-in. Please try again.')
      expect(buttons.github.disabled).toBe(false)
    },
  )

  it.each([
    ['an http URL', 'google', 'http://accounts.google.com/o/oauth2/v2/auth'],
    ['another host', 'google', 'https://evil.example/o/oauth2/v2/auth'],
    [
      'a look-alike host',
      'google',
      'https://accounts.google.com.evil.example/o/oauth2/v2/auth',
    ],
    ['a Google URL for GitHub', 'github', PROVIDER_URLS.google],
    ['a GitHub URL for Google', 'google', PROVIDER_URLS.github],
    ['an explicit port', 'github', 'https://github.com:8443/login/oauth'],
    ['a javascript: URL', 'google', 'javascript:alert(1)'],
    ['a relative URL', 'github', '/login/oauth/authorize'],
    ['a protocol-relative URL', 'github', '//github.com/login/oauth/authorize'],
    ['a non-string URL', 'google', { href: PROVIDER_URLS.google }],
  ] as const)(
    'refuses to follow %s and shows the error',
    async (_label, provider, url) => {
      const { buttons, assign, flash } = runPage(() =>
        jsonResponse(200, { url, redirect: true }),
      )

      await buttons[provider].click()

      expect(assign).not.toHaveBeenCalled()
      expect(flash.text).toBe('Could not start sign-in. Please try again.')
      expect(buttons[provider].disabled).toBe(false)
    },
  )

  it('shows the error for a JSON null body', async () => {
    const { buttons, assign, flash } = runPage(() => jsonResponse(200, null))

    await buttons.google.click()

    expect(assign).not.toHaveBeenCalled()
    expect(flash.text).toBe('Could not start sign-in. Please try again.')
  })

  it('re-enables the buttons when the page is restored from the back/forward cache', async () => {
    const { buttons, windowListeners } = runPage(() =>
      jsonResponse(200, { url: PROVIDER_URLS.google }),
    )
    await buttons.google.click()
    expect(buttons.google.disabled).toBe(true)

    for (const fn of windowListeners.pageshow ?? []) fn({ persisted: true })

    expect(buttons.google.disabled).toBe(false)
  })
})

describe('renderLoginPage social sign-in opt-in', () => {
  it('renders no social buttons when the client does not ask for any', () => {
    const html = render({})
    expect(html).not.toContain('data-social-provider="')
    expect(html).not.toContain('or continue with')
  })

  it('renders only the providers the client lists', () => {
    const html = render({ epds_social_providers: ['google'] })
    expect(html).toContain('data-social-provider="google"')
    expect(html).not.toContain('data-social-provider="github"')
  })

  it('ignores unknown providers and a non-array value', () => {
    expect(render({ epds_social_providers: ['facebook'] })).not.toContain(
      'data-social-provider="',
    )
    expect(render({ epds_social_providers: 'google' })).not.toContain(
      'data-social-provider="',
    )
  })
})
