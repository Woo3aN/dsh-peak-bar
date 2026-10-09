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
/**
 * Timers the plugin scheduled, so the retry cadence can be asserted without a
 * fake clock: every entry keeps the delay it was asked for and the callback.
 */
const timers = []
let timerSeq = 0
/** One-second interval callbacks the plugin registered, so its clock can tick. */
const intervals = []
/** Milliseconds added to the wall clock, so time-based rules are observable. */
let clockOffset = 0
const realNow = Date.now
Date.now = () => realNow() + clockOffset
/** Let the microtask queue drain, the way a promise settling does. */
const flush = () => new Promise((resolve) => {
  setTimeout(resolve, 0)
})
/** Let a second pass: move the clock and run the plugin's one-second ticks. */
function tickClock(ms = 1000) {
  clockOffset += ms
  for (const fn of intervals) fn()
}
/** Listeners the plugin registered, by target and event name. */
const listeners = { window: {}, document: {} }
function listen(target, event, fn) {
  listeners[target][event] = [...(listeners[target][event] ?? []), fn]
}
function unlisten(target, event, fn) {
  listeners[target][event] = (listeners[target][event] ?? []).filter((row) => row !== fn)
}
/** Fire every listener registered for an event, the way the browser would. */
function fire(target, event) {
  for (const fn of listeners[target][event] ?? []) fn()
}

globalThis.window = {
  __ModuleLoader__: { load: (definition) => { captured = definition } },
  setTimeout: (fn, delay) => {
    timerSeq += 1
    timers.push({ id: timerSeq, fn, delay })
    return timerSeq
  },
  clearTimeout: (id) => {
    const at = timers.findIndex((row) => row.id === id)
    if (at >= 0) timers.splice(at, 1)
  },
  setInterval: (fn) => {
    intervals.push(fn)
    return intervals.length
  },
  clearInterval: () => {},
  addEventListener: (event, fn) => listen('window', event, fn),
  removeEventListener: (event, fn) => unlisten('window', event, fn),
}
globalThis.document = {
  visibilityState: 'visible',
  addEventListener: (event, fn) => listen('document', event, fn),
  removeEventListener: (event, fn) => unlisten('document', event, fn),
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

/** Resolve a cordis service name, dotted names included, inside a scope. */
function serviceIn(scope, name) {
  return name.split('.').reduce((value, part) => (value === null || value === undefined ? undefined : value[part]), scope)
}

/**
 * The scope handed back for a nested injection.
 *
 * It carries the services the plugin asks for by name, the way cordis hands a
 * scoped context back: reading anything the scope does not carry is what a real
 * plugin cannot do either — that is exactly how the click target broke, by
 * reading `layout` off the plugin's own context instead of injecting it.
 */
function scopeFor(ctx) {
  const scope = {
    effect: (fn) => {
      fn()
      return () => {}
    },
  }
  if (Object.hasOwn(ctx, 'remote')) scope.remote = ctx.remote
  if (Object.hasOwn(ctx, 'layout')) scope.layout = ctx.layout
  return scope
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
/** Panel ids the plugin asked the shell's layout service to select. */
const openedPanels = []

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
    // The shell provides `layout`; the plugin has to inject it to reach
    // `selectPanel`. Scenarios that need its absence delete the key.
    layout: {
      selectPanel: (id) => openedPanels.push(id),
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
  ctx.inject = (deps, callback) => {
    const scope = scopeFor(ctx)
    // Cordis runs the callback once the injected services are available, so a
    // missing one must leave the plugin's scope empty rather than hand it a
    // scope without that service.
    const ready = (deps ?? []).every((name) => serviceIn(scope, name) !== undefined)
    if (ready) callback(scope)
  }
  return Object.assign(ctx, overrides)
}

const fakeCtx = makeCtx()

module.apply(fakeCtx)

assert.deepEqual(registrations.map((row) => row.options.name), ['main', 'shell.overlay'])
assert.equal(registrations[0].options.key, 'peak-bar')
assert.equal(registrations[1].options.id, 'peak-bar')
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
const table = dictionaries.peakBar
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
 *
 * `root` is the hook-identity prefix, shared with `renderEntry`: passing the same
 * root as an earlier render of the same entry reads that mount's state instead of
 * starting a fresh one, which is what lets the tooltip be inspected after the
 * balance and the ledger have settled.
 */
function findButton(node, data, root = 'entry') {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, data, root)
      if (found !== null) return found
    }
    return null
  }
  if (typeof node.type === 'function') {
    const previous = currentIdentity
    currentIdentity = root
    hookSeq = 0
    const rendered = node.type({ ...node.props, ...data })
    currentIdentity = previous
    return findButton(rendered, data, root)
  }
  if (node.type === 'button') return node
  return findButton(node.children ?? [], data, root)
}

const clickable = injected
const button = findButton({ type: registrations[1].component, props: {}, children: [] }, clickable)
assert.ok(button !== null, 'the capsule renders a button')
assert.equal(typeof button.props.onClick, 'function')
button.props.onClick()
assert.deepEqual(
  openedPanels,
  ['peak-bar'],
  'the capsule opens the status panel through the injected layout service, with the main key',
)

/**
 * Without the shell's `layout` service the capsule must not promise a click it
 * cannot deliver. Reading `ctx.layout` without injecting it threw inside the
 * click handler, which is precisely how every click turned into a silent no-op.
 */
const noLayoutCtx = makeCtx()
delete noLayoutCtx.layout
module.apply(noLayoutCtx)
const noLayoutPanel = registrations[registrations.length - 2]
const noLayoutCapsule = registrations[registrations.length - 1]
const noLayoutInjected = noLayoutCapsule.options.inject()
const noLayoutButton = findButton(
  { type: noLayoutCapsule.component, props: {}, children: [] },
  noLayoutInjected,
  'no-layout',
)
assert.match(
  noLayoutButton.props.title,
  /zh:panelUnavailable$/,
  'the tooltip admits the panel is unavailable instead of promising a click',
)
noLayoutButton.props.onClick() // must not throw
assert.deepEqual(openedPanels, ['peak-bar'], 'no panel is selected when layout is absent')

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

/**
 * The hover text names each figure once and never repeats the panel's heading:
 * prefixing it with "峰谷 · 余额" produced `峰谷 · 余额: … 余额 ¥20.79`, the same
 * word twice behind a half-width colon. A ledger that fell back to this run is
 * called out in one short word instead of the whole reason, which the panel
 * carries.
 */
const spendButton = findButton({ type: spendCapsule.component, props: {}, children: [] }, spendInjected, 'spend')
assert.equal(/zh:label/.test(spendButton.props.title), false, 'the tooltip does not repeat the panel heading')
assert.equal(
  (spendButton.props.title.match(/zh:balance /g) ?? []).length,
  1,
  'the tooltip names the balance once',
)
assert.equal(
  (spendButton.props.title.match(/zh:spent /g) ?? []).length,
  1,
  'the tooltip names the spend once',
)
assert.match(
  spendButton.props.title,
  /zh:spent ¥2\.00zh:spentUnpersisted/,
  'a run-only ledger is marked unpersisted in the tooltip',
)
assert.match(spendButton.props.title, /zh:clickHint$/, 'the tooltip ends with what a click does')
assert.equal(
  spendButton.props.title.includes('zh:countdownShort') || spendButton.props.title.includes('zh:countdownLong'),
  false,
  'the tooltip holds no per-second value',
)
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
  assert.match(observed[0].url, /\/dsh-peak-bar\/spend$/, 'the observation goes to the ledger route')
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
  if (String(url).includes('/dsh-peak-bar/balance')) {
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
 * A failing read is not shouted about. The platform reports a blip as
 * `status: "failed"`, and writing the reason for one made it flash on and off, so
 * a failure is only reported once it has lasted the grace period: the last known
 * amount stays on screen and is marked in two words, while the full reason lives
 * in the panel. Recovery clears the mark at once.
 */
let flakyMode = 'ok'
const flakyCtx = makeCtx({
  remote: {
    account: {
      getBalance: async (meta) => {
        balanceCalls.push(meta)
        if (flakyMode === 'fail') throw new Error('offline')
        return {
          ok: true,
          value: { status: 'ready', value: [{ currency: 'CNY', balance: '30.00' }], bonusWallets: [] },
        }
      },
    },
  },
})
module.apply(flakyCtx)
const flakyCapsule = registrations[registrations.length - 1]
const flakyInjected = flakyCapsule.options.inject()
renderEntry(flakyCapsule, flakyInjected, 'flaky')
await flush()
const firstOk = renderEntry(flakyCapsule, flakyInjected, 'flaky')
assert.match(firstOk, /¥30\.00/, 'a successful read puts the balance on the capsule')
assert.equal(/zh:stale/.test(firstOk), false, 'a healthy read is not marked stale')

flakyMode = 'fail'
const timersBeforeFailure = timerSeq
renderEntry(flakyCapsule, flakyInjected, 'flaky')
await flush()
const duringGrace = renderEntry(flakyCapsule, flakyInjected, 'flaky')
assert.match(duringGrace, /¥30\.00/, 'the last known amount stays on screen while the read fails')
assert.equal(/zh:stale/.test(duringGrace), false, 'one failed read is not reported yet')
assert.equal(/zh:reasonCallFailed/.test(duringGrace), false, 'and no reason is written on the capsule')
// Timers are selected by id, not by array index: `clearTimeout` splices entries
// out, so any index recorded earlier points at the wrong row afterwards.
assert.ok(
  timers.some((row) => row.id > timersBeforeFailure && row.delay === 15000),
  'a failed read retries sooner than the normal interval',
)

tickClock(31000)
const afterGrace = renderEntry(flakyCapsule, flakyInjected, 'flaky')
assert.match(afterGrace, /zh:stale/, 'a failure that lasts is marked stale, in two words')
assert.equal(/zh:reasonCallFailed/.test(afterGrace), false, 'the capsule still does not carry the reason')
const flakyPanel = registrations[registrations.length - 2]
const flakyPanelInjected = flakyPanel.options.inject()
renderEntry(flakyPanel, flakyPanelInjected, 'flaky-panel')
await flush()
assert.match(
  renderEntry(flakyPanel, flakyPanelInjected, 'flaky-panel'),
  /zh:reasonCallFailed/,
  'the panel carries the reason the capsule only marks',
)

flakyMode = 'ok'
const callsBeforeOnline = balanceCalls.length
const timersBeforeOnline = timerSeq
fire('window', 'online')
await flush()
// The harness shares one listener table across every scenario and re-runs effects
// on each render (React would have cleaned the previous one up), so one event
// reaches several listener instances. What matters is that the event reads
// immediately — not on the timer — and that a read that succeeds goes back to the
// normal cadence.
assert.ok(
  balanceCalls.length > callsBeforeOnline,
  `coming online triggers a read at once (${String(callsBeforeOnline)} -> ${String(balanceCalls.length)})`,
)
const afterOnline = renderEntry(flakyCapsule, flakyInjected, 'flaky')
assert.match(afterOnline, /¥30\.00/, 'the balance appears once the connection is back')
assert.equal(/zh:stale/.test(afterOnline), false, 'the stale mark clears with the first successful read')
assert.ok(
  timers.some((row) => row.id > timersBeforeOnline && row.delay === 60000),
  'a successful read returns to the normal interval',
)

/**
 * The panel's close control returns the shell to the conversation, and it only
 * exists when the layout service does — a button that cannot close anything is
 * worse than no button.
 */
const closePanelEntry = registrations[registrations.length - 2]
const closePanelInjected = closePanelEntry.options.inject()
const closePanelText = renderEntry(closePanelEntry, closePanelInjected, 'close-panel')
assert.match(closePanelText, /✕/, 'the panel carries a close control')
const closeButton = findButton(
  { type: closePanelEntry.component, props: {}, children: [] },
  closePanelInjected,
  'close-panel',
)
assert.equal(closeButton.props['aria-label'], 'zh:close', 'the close control is labelled for the active locale')
closeButton.props.onClick()
assert.deepEqual(openedPanels, ['peak-bar', null], 'closing asks the shell for the conversation')

// Without the layout service there is nothing to close, so no control is drawn.
assert.equal(
  renderEntry(noLayoutPanel, noLayoutPanel.options.inject(), 'no-layout-panel').includes('✕'),
  false,
  'no close control without the layout service',
)

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
assert.equal(failure.options.id, 'peak-bar-failure', 'the failure entry is registered')
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
assert.match(css, /\.dshPeakBarSeat\{/)
assert.match(css, /var\(--dsh-windows-titlebar-height/)
assert.equal(/dshPeakBarRow/.test(css), false, 'the sidebar row styles are gone')

/**
 * Following the skin is the default, so every colour `var()` must fall back to a
 * theme token — a literal here would silently stop tracking the active skin.
 *
 * The fallbacks must sit **at the use site** and no rule of ours may declare the
 * variables themselves: the theme projects `--dsw-alias-*` inline on `body`, so a
 * `--dsh-peak-bar-*` declared on `html` would be resolved where those tokens do not
 * exist yet and would come out invalid — which is exactly how the capsule once
 * lost its border. Declaring nothing also leaves every override (a skin, a custom
 * stylesheet, `:root`, `body`) winning with no specificity fight.
 */
const COLOUR_VARS = [
  'bg', 'bg-hover', 'border', 'text', 'offpeak', 'peak', 'countdown', 'label', 'spent', 'note',
]
for (const name of COLOUR_VARS) {
  const marker = `var(--dsh-peak-bar-${name},`
  const at = css.indexOf(marker)
  assert.ok(at >= 0, `--dsh-peak-bar-${name} is read with a fallback`)
  // Nested fallbacks are allowed (a success token with a neutral backstop), so
  // this checks the shape of the fallback head rather than matching one level of
  // parentheses.
  assert.match(
    css.slice(at, at + marker.length + 60),
    new RegExp(`^var\\(--dsh-peak-bar-${name},var\\(--dsw-`),
    `--dsh-peak-bar-${name} falls back to a theme token, so the capsule follows the skin`,
  )
}
assert.equal(
  /--dsh-peak-bar-[a-z-]+\s*:/.test(css),
  false,
  'the plugin declares none of its own variables, so any override wins',
)
assert.match(css, /var\(--dsh-peak-bar-radius,999px\)/, 'the corner radius is themeable')
assert.match(
  css,
  /var\(--dsh-peak-bar-offpeak,var\(--dsw-alias-state-success-primary/,
  'off-peak reads as the theme success colour, with a neutral backstop',
)
assert.match(css, /var\(--dsh-peak-bar-font-size,12px\)/, 'the font size is themeable')
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
