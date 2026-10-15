/**
 * Shared test harness that runs the login page's real inline script in a
 * `node:vm` context against a minimal stand-in DOM. Lifted out of
 * login-page-social-buttons.test.ts so the route-level social error test
 * can run the script of the page the route actually served: there is no
 * DOM test environment in this repo, and asserting on the script's source
 * text alone would not show that it does anything on load.
 */
import * as vm from 'node:vm'
import { vi, type Mock } from 'vitest'

/** The page's main inline script (the one that owns the login flow). */
export function mainScript(html: string): string {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1],
  )
  const main = scripts.find((s) => s.includes('var authBasePath'))
  if (!main) throw new Error('login page main script not found')
  return main
}

/**
 * A value that absorbs any property read, call or construction by returning
 * itself, so page-script initialisation that does not concern the test
 * (OTP boxes, typo guard, heartbeat) runs without a real DOM.
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

export interface FakeButton {
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

type FetchImpl = (url: string, init: RequestInit) => unknown

/** What a test drives and observes on a page script run by runPageScript. */
export interface PageScriptHandles {
  buttons: { google: FakeButton; github: FakeButton }
  /** `window.location.assign`. */
  assign: Mock<(url: string) => void>
  /** The stubbed `fetch`. */
  fetchSpy: Mock<FetchImpl>
  windowListeners: Partial<Record<string, ((e: unknown) => void)[]>>
  /** `text` is the last message shown in the flash region (`#error-msg`). */
  flash: { text: string }
}

/**
 * Run the main script of `html` with fake Google/GitHub buttons and a
 * stubbed `fetch`, and return the handles a test needs to drive and
 * observe it.
 */
export function runPageScript(
  html: string,
  fetchImpl: FetchImpl,
): PageScriptHandles {
  const buttons = { google: fakeButton('google'), github: fakeButton('github') }
  const assign = vi.fn<(url: string) => void>()
  const fetchSpy = vi.fn(fetchImpl)
  const windowListeners: Partial<Record<string, ((e: unknown) => void)[]>> = {}
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
  vm.runInNewContext(mainScript(html), {
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

export function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  })
}
