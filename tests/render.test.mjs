/**
 * Offline render check for ../client.js.
 *
 * The shipped browser bundle is loaded with a stand-in module loader and a
 * minimal React substitute, so both registered components are actually invoked
 * and their element trees inspected — the same failure a slot entry crash would
 * produce is caught here, before installation.
 *
 *   node tests/render.test.mjs
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/** Minimal hook runtime: state persists per component identity and hook slot. */
const stateCells = new Map()
let currentIdentity = 'root'
let hookSeq = 0
let effectCount = 0

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => {
    const key = `${currentIdentity}#${String(hookSeq)}`
    hookSeq += 1
    if (!stateCells.has(key)) stateCells.set(key, typeof initial === 'function' ? initial() : initial)
    const set = (value) => stateCells.set(key, typeof value === 'function' ? value(stateCells.get(key)) : value)
    return [stateCells.get(key), set]
  },
  useEffect: (fn) => {
    effectCount += 1
    fn()
  },
}

let captured = null
/** Stylesheet text pushed through the fake document's style tag. */
const styles = []
globalThis.window = {
  __ModuleLoader__: { load: (definition) => { captured = definition } },
  setInterval: () => 0,
  clearInterval: () => {},
}
globalThis.document = {
  visibilityState: 'visible',
  addEventListener: () => {},
  removeEventListener: () => {},
  head: { querySelector: () => null, appendChild: () => {} },
  createElement: () => ({
    setAttribute: () => {},
    remove: () => {},
    style: {},
    set textContent(value) { styles.push(value) },
    get textContent() { return styles[styles.length - 1] },
  }),
}

// eslint-disable-next-line no-eval
eval(source)

const module = captured.factory((id) => {
  if (id === 'react') return react
  throw new Error('unexpected require: ' + id)
})

/** The scope handed back for the nested `remote.account` injection. */
function scopeFor(remote) {
  return {
    remote,
    effect: (fn) => {
      fn()
      return () => {}
    },
  }
}

/**
 * Registrations collected from a fake Client context.
 *
 * `inject` mirrors cordis: the callback runs with a scope carrying the injected
 * services, so the plugin's nested `remote.account` scope is exercised rather
 * than stubbed away. It reads the context it is attached to, so each scenario's
 * own `remote` reaches the plugin.
 *
 * `locale.getSnapshot()` and `locale.register()` are recorded: the first proves
 * the account call carries the active UI language, the second lets the checks
 * compare the zh and en dictionaries key by key.
 */
const registrations = []
/** Dictionaries handed to `ctx.locale.register`, by namespace. */
const dictionaries = {}
/** Metadata of every balance call the plugin made. */
const balanceCalls = []
/** The active locale the fake locale service reports. */
const ACTIVE_LOCALE = 'en'

function makeCtx(overrides = {}) {
  const ctx = {
    locale: {
      bind: () => (key) => `zh:${key}`,
      register: (namespace, table) => {
        dictionaries[namespace] = table
        return () => {}
      },
      getSnapshot: () => ({ active: ACTIVE_LOCALE }),
    },
    effect: (fn) => {
      fn()
      return () => {}
    },
    slots: {
      inject: (_name, factory) => {
        factory()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    remote: {
      account: {
        getBalance: async (meta) => {
          balanceCalls.push(meta)
          return {
            ok: true,
            value: [{ currency: 'CNY', balance: '12.3456' }],
            bonusWallets: [{ currency: 'CNY', balance: '1.00' }],
          }
        },
      },
    },
  }
  ctx.inject = (_deps, callback) => {
    callback(scopeFor(ctx.remote))
  }
  return Object.assign(ctx, overrides)
}

const fakeCtx = makeCtx()

module.apply(fakeCtx)

assert.deepEqual(registrations.map((row) => row.options.name), ['main', 'shell.overlay'])
assert.equal(registrations[0].options.key, 'rhine-statusbar')
assert.equal(registrations[1].options.id, 'rhine-statusbar')
assert.equal(registrations[1].options.order, 10)

/**
 * Render one element tree to a flat text string, invoking function components.
 * Each element's position in the tree is its identity, so a second render of
 * the same element reuses the same hook cells — what React does across renders.
 */
function text(node, data, path = 'root') {
  if (node === null || node === undefined || node === false) return ''
  if (Array.isArray(node)) return node.map((child, index) => text(child, data, `${path}/${String(index)}`)).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node.type === 'function') {
    const previousIdentity = currentIdentity
    currentIdentity = path
    hookSeq = 0
    const rendered = text(node.type({ ...node.props, ...data }), data, `${path}>`)
    currentIdentity = previousIdentity
    return rendered
  }
  return (node.children ?? []).map((child, index) => text(child, data, `${path}/${String(index)}`)).join('')
}

/**
 * Render one registered entry the way the slot renderer mounts it. `root` is the
 * hook-identity prefix, so each scenario gets fresh hook cells instead of
 * inheriting the previous scenario's resolved balance.
 */
function renderEntry(registration, data, root = 'entry') {
  return text({ type: registration.component, props: {}, children: [] }, data, root)
}

const injected = registrations[0].options.inject()
const rowText = renderEntry(registrations[1], injected)

// The billing window is a pure function of the clock, so this check only
// requires the capsule to render both halves with the injected labels.
assert.match(rowText, /zh:peakOn|zh:peakOff/)

// The balance read is asynchronous: the first pass shows the placeholder, and
// the resolved amount appears on the next render — exactly what a user sees.
assert.match(rowText, /—/)
await new Promise((resolve) => {
  setTimeout(resolve, 0)
})
const settledText = renderEntry(registrations[1], injected)
assert.match(settledText, /¥13\.35/)

const panelText = renderEntry(registrations[0], injected)
assert.match(panelText, /zh:balance/)
assert.match(panelText, /zh:rule/)
assert.match(panelText, /¥13\.35/)

assert.ok(effectCount >= 2, 'expected the clock and balance effects to run')

/**
 * Payload shape: the account Remote wraps the platform answer once, so the call
 * resolves to `{ ok, value }` where `value` is `{ status, value, bonusWallets }`
 * — the shape the shipped account card reads as `details.balance.status`,
 * `.value` and `.bonusWallets`. Reading the wallets off the envelope instead is
 * what made the balance show `--` forever, so the nested shape is pinned here.
 */
const nestedShape = {
  ok: true,
  value: {
    status: 'ready',
    value: [{ currency: 'CNY', balance: '12.3456' }],
    bonusWallets: [{ currency: 'CNY', balance: '1.00' }],
  },
}
module.apply(makeCtx({ remote: { account: { getBalance: async () => nestedShape } } }))
const nestedPanel = registrations[registrations.length - 2]
const nestedCapsule = registrations[registrations.length - 1]
const nestedInjected = nestedPanel.options.inject()
const nestedBefore = renderEntry(nestedCapsule, nestedInjected, 'nested')
assert.equal(/¥/.test(nestedBefore), false, 'the nested payload starts without an amount')
assert.match(nestedBefore, /—/, 'the nested payload starts as a placeholder, like every other read')
await new Promise((resolve) => {
  setTimeout(resolve, 0)
})
assert.match(
  renderEntry(nestedCapsule, nestedInjected, 'nested'),
  /¥13\.35/,
  'the nested account payload renders the balance',
)

/**
 * A failed read reports why: an empty-wallet answer must reach the panel instead
 * of leaving a bare `—` that cannot be told apart from "not logged in".
 */
module.apply(makeCtx({
  remote: { account: { getBalance: async () => ({ ok: true, value: { status: 'ready', value: [], bonusWallets: [] } }) } },
}))
const emptyPanel = registrations[registrations.length - 2]
const emptyInjected = emptyPanel.options.inject()
renderEntry(emptyPanel, emptyInjected, 'empty')
await new Promise((resolve) => {
  setTimeout(resolve, 0)
})
assert.match(renderEntry(emptyPanel, emptyInjected, 'empty'), /zh:reasonNoWallet/)

/**
 * The reason must be readable without hovering: the capsule renders it inline,
 * because a lone `—` cannot be told apart from "still loading".
 */
const emptyCapsule = registrations[registrations.length - 1]
const emptyCapsuleInjected = emptyCapsule.options.inject()
renderEntry(emptyCapsule, emptyCapsuleInjected, 'empty-capsule')
await new Promise((resolve) => {
  setTimeout(resolve, 0)
})
assert.match(
  renderEntry(emptyCapsule, emptyCapsuleInjected, 'empty-capsule'),
  /zh:reasonNoWallet/,
  'the capsule states the failure reason inline',
)

/**
 * Without the account provider the capsule must survive: `remote.account` is a
 * separate cordis service, so a profile that never provides it must still draw
 * the peak / valley countdown and state the missing Remote rather than hold the
 * whole plugin inactive.
 */
module.apply(makeCtx({ inject: () => {}, remote: undefined }))
const bareCapsule = registrations[registrations.length - 1]
const bareInjected = bareCapsule.options.inject()
renderEntry(bareCapsule, bareInjected, 'no-remote')
await new Promise((resolve) => {
  setTimeout(resolve, 0)
})
const bareText = renderEntry(bareCapsule, bareInjected, 'no-remote')
assert.match(bareText, /zh:reasonNoRemote/, 'a missing account Remote is reported')
assert.match(bareText, /zh:peakOn|zh:peakOff/, 'the countdown still renders without the account side')

/**
 * Localisation: both dictionaries must carry the same keys, so a new string
 * cannot ship translated in one language only.
 */
const table = dictionaries.statusbarRhine
assert.ok(table !== undefined, 'the dictionaries were registered')
assert.deepEqual(
  Object.keys(table.zh).sort(),
  Object.keys(table.en).sort(),
  'zh and en define the same keys',
)

/**
 * The account call reports the active UI language instead of a hard-coded one:
 * the platform turns it into the `x-client-locale` client header.
 */
assert.ok(balanceCalls.length > 0, 'the plugin called the account service')
for (const meta of balanceCalls) {
  assert.equal(meta.locale, ACTIVE_LOCALE, 'the active locale is forwarded')
  assert.equal(typeof meta.timezoneOffsetSeconds, 'number', 'the UTC offset is forwarded')
}

/**
 * The capsule is the only entry point left: activating it must select this
 * plugin's `main` key through the shell's layout service, so a click is
 * exercised the way React would fire it.
 */
function findButton(node, data) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, data)
      if (found !== null) return found
    }
    return null
  }
  if (typeof node.type === 'function') return findButton(node.type({ ...node.props, ...data }), data)
  if (node.type === 'button') return node
  return findButton(node.children ?? [], data)
}

const opened = []
const clickable = {
  ...injected,
  ctx: { layout: { selectPanel: (id) => opened.push(id) } },
}
const button = findButton({ type: registrations[1].component, props: {}, children: [] }, clickable)
assert.ok(button !== null, 'the capsule renders a button')
assert.equal(typeof button.props.onClick, 'function')
button.props.onClick()
assert.deepEqual(opened, ['rhine-statusbar'], 'the capsule opens the status panel')

/**
 * The tooltip must not blink. A native `title` tooltip is torn down whenever its
 * attribute changes, so it may hold only values that change at billing-window or
 * balance cadence — never the per-second countdown, which used to rewrite it
 * every second.
 */
assert.equal(
  button.props.title.includes('zh:countdownShort') || button.props.title.includes('zh:countdownLong'),
  false,
  'the tooltip holds no per-second countdown',
)
assert.match(button.props.title, /zh:clickHint/, 'the tooltip says what a click does')
assert.match(button.props.title, /zh:balance/, 'the tooltip carries the balance label')

/**
 * Today's observed spend: a drop between two readings is consumption. The fake
 * service reports 15.00 and then 13.00, so the capsule must show `-¥2.00`.
 */
let spendCall = 0
module.apply(makeCtx({
  remote: {
    account: {
      getBalance: async () => {
        spendCall += 1
        const balance = spendCall === 1 ? '15.00' : '13.00'
        return { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance }], bonusWallets: [] } }
      },
    },
  },
}))
const spendCapsule = registrations[registrations.length - 1]
const spendInjected = spendCapsule.options.inject()
// One identity across renders, like a mounted component: the fake hook runtime
// keys its cells by the tree path, so a new path would be a new mount.
renderEntry(spendCapsule, spendInjected, 'spend')
await new Promise((resolve) => {
  setTimeout(resolve, 0)
})
renderEntry(spendCapsule, spendInjected, 'spend')
await new Promise((resolve) => {
  setTimeout(resolve, 0)
})
const spendText = renderEntry(spendCapsule, spendInjected, 'spend')
assert.match(spendText, /¥2\.00/, 'a balance drop shows as spend, unsigned and at two decimals')
assert.match(spendText, /¥13\.00/, 'the balance itself follows the latest reading')
assert.equal(spendText.includes('-¥'), false, 'the spend readout carries no minus sign')
// Both numbers are labelled, so neither reads as an unlabelled figure.
assert.match(spendText, /zh:balance.*¥13\.00/, 'the balance is labelled')
assert.match(spendText, /zh:spent.*¥2\.00/, 'the spend is labelled')

// A degraded ledger must be visible, not silently smaller: with `fetch` absent
// the panel says the number came from this run.
const spendPanel = registrations[registrations.length - 2]
const spendPanelInjected = spendPanel.options.inject()
renderEntry(spendPanel, spendPanelInjected, 'spend-panel')
await new Promise((resolve) => {
  setTimeout(resolve, 0)
})
assert.match(
  renderEntry(spendPanel, spendPanelInjected, 'spend-panel'),
  /zh:spendSourceRun/,
  'the panel names the fallback ledger',
)

/**
 * The Host ledger is authoritative. `fetch` is absent in this harness, which is
 * exactly the fallback path above; here it is stubbed to prove the Host answer is
 * what reaches the capsule, and that the observation the Host receives carries
 * the day, currency, amount and timestamp it needs.
 */
const observed = []
globalThis.fetch = async (url, init = {}) => {
  const body = init.body === undefined ? null : JSON.parse(init.body)
  if (init.method === 'POST') observed.push({ url, body })
  const payload = init.method === 'POST'
    ? { ok: true, day: body.day, currency: body.currency, spent: 7.5 }
    : { ok: true, day: '2026-10-09', currency: 'CNY', spent: 7.5 }
  return { ok: true, status: 200, json: async () => payload }
}
try {
  module.apply(makeCtx({}))
  const hostCapsule = registrations[registrations.length - 1]
  const hostInjected = hostCapsule.options.inject()
  renderEntry(hostCapsule, hostInjected, 'host-spend')
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
  const hostText = renderEntry(hostCapsule, hostInjected, 'host-spend')
  assert.match(hostText, /¥7\.50/, 'the Host ledger total is what the capsule shows')
  assert.ok(observed.length > 0, 'the plugin posted an observation to the Host ledger')
  assert.match(observed[0].url, /\/dsh-rhine-statusbar\/spend$/, 'the observation goes to the ledger route')
  assert.match(observed[0].body.day, /^\d{4}-\d{2}-\d{2}$/, 'the observation names the Beijing day')
  assert.match(observed[0].body.currency, /^[A-Z]{3}$/, 'the observation names the currency')
  assert.equal(typeof observed[0].body.amount, 'number', 'the observation carries the balance amount')
  assert.equal(typeof observed[0].body.at, 'string', 'the observation carries a timestamp')
  const hostPanel = registrations[registrations.length - 2]
  const hostPanelInjected = hostPanel.options.inject()
  renderEntry(hostPanel, hostPanelInjected, 'host-panel')
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
  assert.match(
    renderEntry(hostPanel, hostPanelInjected, 'host-panel'),
    /zh:spendSourceHost/,
    'the panel names the Host ledger when the Host answered',
  )
} finally {
  delete globalThis.fetch
}

/**
 * The API-key path: a user who configured `DEEPSEEK_API_KEY` without signing in
 * is served by the Host's balance route, and the panel must say so.
 */
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('/dsh-rhine-statusbar/balance')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, balance: '20.79', currency: 'CNY', source: 'apikey' }) }
  }
  if (init.method === 'POST') {
    return { ok: true, status: 200, json: async () => ({ ok: true, day: '2026-10-09', currency: 'CNY', spent: 0 }) }
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, day: '2026-10-09', currency: 'CNY', spent: 0 }) }
}
try {
  module.apply(makeCtx({ inject: () => {}, remote: undefined }))
  const keyCapsule = registrations[registrations.length - 1]
  const keyPanel = registrations[registrations.length - 2]
  const keyInjected = keyCapsule.options.inject()
  const keyPanelInjected = keyPanel.options.inject()
  renderEntry(keyCapsule, keyInjected, 'key')
  renderEntry(keyPanel, keyPanelInjected, 'key-panel')
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
  const keyText = renderEntry(keyCapsule, keyInjected, 'key')
  assert.match(keyText, /zh:balance/, 'the capsule labels the balance')
  assert.match(keyText, /¥20\.79/, 'the API-key balance is rendered')
  assert.match(
    renderEntry(keyPanel, keyPanelInjected, 'key-panel'),
    /zh:balanceSourceKey/,
    'the panel names the API-key path',
  )
} finally {
  delete globalThis.fetch
}

/**
 * A throw inside `apply` must not take the capsule away silently: the guard
 * registers a minimal entry that states the failure.
 */
module.apply(makeCtx({
  locale: {
    bind: () => () => {
      throw new Error('boom')
    },
  },
}))
const failure = registrations[registrations.length - 1]
assert.equal(failure.options.id, 'rhine-statusbar-failure', 'the failure entry is registered')
assert.match(
  renderEntry(failure, {}, 'failure'),
  /峰谷·余额加载失败/,
  'the failure is visible in the caption strip',
)

/**
 * The failure line follows the UI language without depending on the locale
 * service — binding it is one of the things that may have thrown.
 */
module.apply({
  locale: {
    bind: () => (key) => key,
    register: () => {
      throw new Error('boom')
    },
    getSnapshot: () => ({ active: 'en' }),
  },
  effect: (fn) => {
    fn()
    return () => {}
  },
  inject: () => {},
  slots: {
    inject: (_name, factory) => {
      factory()
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
})
assert.match(
  renderEntry(registrations[registrations.length - 1], {}, 'failure-en'),
  /rate capsule failed to load/,
  'the failure line is English when the UI is English',
)

/**
 * The holiday table has an expiry, and the plugin must say so rather than keep
 * answering confidently with a table that no longer knows anything.
 */
const { isHolidayTableStale, holidayTableLast } = module.testing
assert.equal(holidayTableLast, '2026-12-31', 'the covered range is stated in one place')
assert.equal(isHolidayTableStale(holidayTableLast), false, 'the last covered day is still covered')
assert.equal(isHolidayTableStale('2027-01-01'), true, 'the day after it is not')

/**
 * Style invariants: the sheet must be well formed, must carry the caption-strip
 * seat with the shell's own height variable, and must not keep the retired
 * sidebar-row rules.
 */
const css = styles.join('')
assert.ok(css.length > 0, 'the stylesheet was installed')
assert.equal(
  (css.match(/\{/g) ?? []).length,
  (css.match(/\}/g) ?? []).length,
  'stylesheet braces balance',
)
assert.match(css, /\.dshRhineStatusSeat\{/)
assert.match(css, /var\(--dsh-windows-titlebar-height/)
assert.equal(/dshRhineStatusRow/.test(css), false, 'the sidebar row styles are gone')

/**
 * Following the skin is the default, so every colour `var()` must fall back to a
 * theme token — a literal here would silently stop tracking the active skin.
 *
 * The fallbacks must sit **at the use site** and no rule of ours may declare the
 * variables themselves: the theme projects `--dsw-alias-*` inline on `body`, so a
 * `--dsh-rhine-*` declared on `html` would be resolved where those tokens do not
 * exist yet and would come out invalid — which is exactly how the capsule once
 * lost its border. Declaring nothing also leaves every override (a skin, a custom
 * stylesheet, `:root`, `body`) winning with no specificity fight.
 */
const COLOUR_VARS = [
  'bg', 'bg-hover', 'border', 'text', 'offpeak', 'peak', 'countdown', 'label', 'spent', 'note',
]
for (const name of COLOUR_VARS) {
  const marker = `var(--dsh-rhine-${name},`
  const at = css.indexOf(marker)
  assert.ok(at >= 0, `--dsh-rhine-${name} is read with a fallback`)
  // Nested fallbacks are allowed (a success token with a neutral backstop), so
  // this checks the shape of the fallback head rather than matching one level of
  // parentheses.
  assert.match(
    css.slice(at, at + marker.length + 60),
    new RegExp(`^var\\(--dsh-rhine-${name},var\\(--dsw-`),
    `--dsh-rhine-${name} falls back to a theme token, so the capsule follows the skin`,
  )
}
assert.equal(
  /--dsh-rhine-[a-z-]+\s*:/.test(css),
  false,
  'the plugin declares none of its own variables, so any override wins',
)
assert.match(css, /var\(--dsh-rhine-radius,999px\)/, 'the corner radius is themeable')
assert.match(
  css,
  /var\(--dsh-rhine-offpeak,var\(--dsw-alias-state-success-primary/,
  'off-peak reads as the theme success colour, with a neutral backstop',
)
assert.match(css, /var\(--dsh-rhine-font-size,12px\)/, 'the font size is themeable')
assert.match(css, /var\(--ds-transition-duration/, 'motion follows the theme duration token')
assert.match(css, /prefers-reduced-motion/, 'reduced motion is honoured')
assert.equal(
  /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(css),
  false,
  'the plugin carries no colour literal of its own — bar the theme-token indirection',
)

/**
 * The spend readout format: unsigned, two decimals, and small amounts stay
 * visible instead of rounding away to a zero that would look like a bug.
 */
const { formatSpend } = module.testing
assert.equal(formatSpend(2, 'CNY'), '¥2.00', 'two decimals, no sign')
assert.equal(formatSpend(7.5, 'CNY'), '¥7.50', 'one trailing zero is kept')
assert.equal(formatSpend(0.0004, 'CNY'), '¥<0.01', 'sub-cent spend stays visible')
assert.equal(formatSpend(0, 'CNY'), '', 'nothing spent renders nothing')
assert.equal(formatSpend(-1, 'CNY'), '', 'a negative never renders')
assert.equal(formatSpend('2.5', 'USD'), '$2.50', 'a string amount is accepted')

console.log('render checks passed:', settledText)
