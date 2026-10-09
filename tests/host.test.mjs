/**
 * Offline check for the Host half in ../index.js.
 *
 * The plugin is mounted with a stand-in context, so the assertions drive the
 * route handler the plugin actually registers and the ledger file it actually
 * writes — under a temporary DSH_HOME, never the real one. node:test's own
 * runner is used directly rather than through `node --test`, whose per-file
 * child process this machine's sandbox refuses to fork:
 *
 *   node tests/host.test.mjs
 *
 * One thing to know about the route capture below: the ledger is served from a
 * single path for both verbs (the carrier's route table is keyed by path), so
 * `routes` holds that one dispatcher. The two per-verb fronts it delegates to are
 * exported through `testing` and are what the method-mismatch check addresses,
 * because that check is about "the GET route reached with POST" and "the POST
 * route reached with GET" — two different handlers, only one slot.
 *
 * The second route, the API-key balance read, is captured the same way. It is
 * handed the stand-in `credentials` service below, whose held key one case can
 * change, so the "no key configured" and "a key is configured" branches of one
 * plugin are both reachable without touching the real credential store.
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test, { after } from 'node:test'

/** The run's home; every test gets a fresh case directory underneath it. */
const homeRoot = mkdtempSync(join(tmpdir(), 'peak-bar-host-'))

// Set BEFORE ../index.js is loaded, so the module can never resolve the real
// ~/.dsh: the ledger path is resolved per request, not at import, but the order
// is kept because it is the contract this file asserts.
process.env.DSH_HOME = homeRoot

after(() => {
  rmSync(homeRoot, { recursive: true, force: true })
})

const host = await import('../index.js')

/** Ledger file name under DSH_HOME; the frozen storage contract. */
const LEDGER_NAME = '.dsh-peak-bar.json'
/** The day and instant used by most of the cases below. */
const DAY = '2026-10-09'
const AT = '2026-10-09T05:33:12.000Z'

/** Routes captured from the stand-in context, keyed by path. */
const routes = new Map()
/** The dependency list apply() asked its context to inject. */
let injected = null

/**
 * The key the stand-in `credentials` service holds, or undefined when this
 * profile has none. It starts empty — the "only an API key is configured" user
 * either has one or does not — and one case sets it for the length of the case.
 */
const heldKey = { value: undefined }

/** Every env name the plugin asked the credentials service to resolve. */
const credentialNames = []

host.apply({
  inject: (deps, callback) => {
    injected = deps
    callback({
      effect: (fn) => {
        fn()
        return () => {}
      },
      webServer: {
        register: (route) => {
          routes.set(route.path, route.handler)
          return () => {}
        },
      },
      // Resolved per request, as the real service is: a case can change what the
      // profile holds between two calls, and the next call must see the change.
      credentials: {
        resolve: async (name) => {
          credentialNames.push(name)
          return heldKey.value
        },
      },
    })
  },
})

/** The handler the plugin registered for the frozen route. */
const route = routes.get(host.testing.ROUTE)

/** One observation body, in the shape the page posts. */
function observation(day, amount, currency = 'CNY', at = AT) {
  return { day, currency, amount, at }
}

/**
 * A node-like request, defaulting to the loopback authority.
 *
 * `options.body` is encoded as JSON; `options.raw` is sent verbatim, for the
 * bodies that are not JSON at all.
 */
function request(method, options = {}) {
  const chunks = options.raw !== undefined
    ? [options.raw]
    : (options.body === undefined ? [] : [JSON.stringify(options.body)])
  const req = Readable.from(chunks)
  req.method = method
  req.headers = { host: '127.0.0.1:1234', ...(options.headers ?? {}) }
  return req
}

/** A node-like response that records what the handler wrote. */
function response() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    end(text) {
      if (text !== undefined) this.body = String(text)
    },
  }
}

/** Drive one handler with one request and return the recorded response. */
async function call(handler, method, options = {}) {
  const res = response()
  await handler(request(method, options), res)
  return res
}

/** A response body, parsed. */
function payload(res) {
  return JSON.parse(res.body)
}

/** The handler the plugin registered for the frozen balance route. */
const balanceRoute = routes.get(host.testing.BALANCE_ROUTE)

/** Every balance call the stand-in `fetch` saw, in order. */
const balanceCalls = []

/**
 * Stand in for the global `fetch` and record the calls it receives.
 *
 * The balance route is the only part of the Host that reaches the network, so
 * replacing the global for the length of one case is enough to keep every case
 * offline. `state` is read at call time, which lets a case change the answer
 * between two calls without swapping the stub.
 *
 * @param t - the running test, for the restoration hook.
 * @param options - `{ ok, status, json }`, where `json` is a value or a function
 *   of the call index; `{ reject }` makes the call throw instead of answering.
 * @returns the mutable state, so a case can retarget the answer mid-test.
 */
function useBalanceFetch(t, options = {}) {
  const state = { ok: options.ok ?? true, status: options.status ?? 200, json: options.json, reject: options.reject }
  const original = globalThis.fetch
  let calls = 0
  // The log is shared by the file's cases, so this case counts from here.
  balanceCalls.length = 0
  globalThis.fetch = async (url, init) => {
    balanceCalls.push({
      url: String(url),
      headers: (init && init.headers) || {},
      method: init && init.method,
      signal: init && init.signal,
    })
    const index = calls
    calls += 1
    if (state.reject === true) throw new Error('network down')
    const body = typeof state.json === 'function' ? state.json(index) : state.json
    return {
      ok: state.ok,
      status: state.status,
      json: async () => body,
    }
  }
  t.after(() => {
    if (original === undefined) delete globalThis.fetch
    else globalThis.fetch = original
  })
  return state
}

/**
 * Hold a key in the stand-in credentials service for the length of one case, and
 * give it back afterwards. Undefined is the "no API key configured" profile.
 */
function useCredentials(t, value) {
  heldKey.value = value
  t.after(() => {
    heldKey.value = undefined
  })
  return heldKey
}

/** One upstream answer in the platform's own shape. */
function balancePayload(total = '20.79', currency = 'CNY', available) {
  const wallet = { currency, total_balance: total, granted_balance: '0.00', topped_up_balance: total }
  if (available !== undefined) wallet.is_available = available
  return { is_available: available === undefined ? true : available, balance_infos: [wallet] }
}

/** Open one balance reading against a fresh stub and a fresh cache. */
function openBalance(t, options = {}) {
  useCredentials(t, options.key ?? 'test-key')
  useBalanceFetch(t, options)
  process.env.DSH_PEAK_BAR_BALANCE_URL = options.url ?? 'https://balance.test/user/balance'
  host.testing.resetBalanceCache()
  t.after(() => {
    delete process.env.DSH_PEAK_BAR_BALANCE_URL
    host.testing.resetBalanceCache()
  })
}

/** A fresh DSH_HOME for one test, so no test can see another test's ledger. */
function useHome(t) {
  const home = mkdtempSync(join(homeRoot, 'case-'))
  process.env.DSH_HOME = home
  t.after(() => {
    process.env.DSH_HOME = homeRoot
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

/** The ledger file inside one test's home. */
function ledgerFile(home) {
  return join(home, LEDGER_NAME)
}

/** The ledger file, parsed. */
function storedLedger(home) {
  return JSON.parse(readFileSync(ledgerFile(home), 'utf8'))
}

test('apply registers the spend route through the optional webServer injection', () => {
  assert.equal(host.name, 'peak-bar')
  // Both services are optional and scoped to the one callback: the ledger route
  // needs only the carrier, and the balance route degrades to `no-key` without a
  // credentials service rather than keeping the plugin from loading.
  assert.deepEqual(injected, ['webServer', 'credentials'])
  // The dependency must not be object-level: a profile with no HTTP carrier still
  // has to load this plugin, and only lose the shared ledger.
  assert.equal(host.inject, undefined)
  assert.equal(typeof route, 'function')
  assert.equal(typeof balanceRoute, 'function')
  assert.deepEqual([...routes.keys()], [host.testing.ROUTE, host.testing.BALANCE_ROUTE])
})

test('an empty ledger answers GET with spent 0', async (t) => {
  useHome(t)
  const res = await call(route, 'GET')
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  const body = payload(res)
  assert.equal(body.ok, true)
  assert.equal(body.spent, 0)
  assert.equal(body.currency, 'CNY')
  assert.equal(body.updatedAt, null)
})

test('the first observation records the reading and creates the file', async (t) => {
  const home = useHome(t)
  const res = await call(route, 'POST', { body: observation(DAY, 20.79) })
  assert.equal(res.status, 200)
  const body = payload(res)
  assert.equal(body.ok, true)
  assert.equal(body.day, DAY)
  assert.equal(body.currency, 'CNY')
  // Nothing to subtract from yet: the first reading spends nothing.
  assert.equal(body.spent, 0)
  assert.equal(existsSync(ledgerFile(home)), true)
  const stored = storedLedger(home)
  assert.equal(stored.version, 1)
  assert.equal(stored.last.amount, 20.79)
  assert.equal(stored.last.day, DAY)
  assert.equal(stored.last.currency, 'CNY')
  assert.equal(stored.days[DAY].spent, 0)
  assert.equal(stored.updatedAt, AT)
})

test('the file is UTF-8 without a BOM and uses LF only', async (t) => {
  const home = useHome(t)
  await call(route, 'POST', { body: observation(DAY, 20.79) })
  const bytes = readFileSync(ledgerFile(home))
  assert.equal(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, false)
  const text = bytes.toString('utf8')
  assert.equal(text.startsWith('\ufeff'), false)
  assert.equal(text.startsWith('{'), true)
  assert.equal(text.includes('\r'), false)
  assert.equal(text.includes('\t'), false)
  assert.equal(text.endsWith('\n'), true)
})

test('a lower balance than the previous reading is consumption', async (t) => {
  const home = useHome(t)
  await call(route, 'POST', { body: observation(DAY, 15) })
  const res = await call(route, 'POST', { body: observation(DAY, 13) })
  assert.equal(res.status, 200)
  assert.equal(payload(res).spent, 2)
  // The reading is good for more than one window: a later GET sees the same total.
  const get = await call(route, 'GET')
  assert.equal(get.status, 200)
  assert.equal(payload(get).day, DAY)
  assert.equal(payload(get).spent, 2)
  assert.equal(storedLedger(home).days[DAY].spent, 2)
})

test('a top-up never reduces the day total', async (t) => {
  const home = useHome(t)
  await call(route, 'POST', { body: observation(DAY, 15) })
  await call(route, 'POST', { body: observation(DAY, 13) })
  const res = await call(route, 'POST', { body: observation(DAY, 25) })
  assert.equal(res.status, 200)
  assert.equal(payload(res).spent, 2)
  const get = await call(route, 'GET')
  assert.equal(payload(get).spent, 2)
  assert.equal(payload(get).currency, 'CNY')
  assert.equal(storedLedger(home).last.amount, 25)
})

test('a new day starts at 0 and keeps the earlier day', async (t) => {
  const home = useHome(t)
  await call(route, 'POST', { body: observation('2026-10-09', 15) })
  await call(route, 'POST', { body: observation('2026-10-09', 13) })
  const res = await call(route, 'POST', {
    body: observation('2026-10-10', 20, 'CNY', '2026-10-10T01:00:00.000Z'),
  })
  assert.equal(res.status, 200)
  assert.equal(payload(res).day, '2026-10-10')
  assert.equal(payload(res).spent, 0)
  const stored = storedLedger(home)
  assert.equal(stored.days['2026-10-10'].spent, 0)
  assert.equal(stored.days['2026-10-09'].spent, 2)
  assert.equal(stored.last.day, '2026-10-10')
})

test('a currency switch starts the day over instead of mixing units', async (t) => {
  const home = useHome(t)
  await call(route, 'POST', { body: observation(DAY, 15, 'CNY') })
  await call(route, 'POST', { body: observation(DAY, 13, 'CNY') })
  const res = await call(route, 'POST', { body: observation(DAY, 9, 'USD') })
  assert.equal(res.status, 200)
  assert.equal(payload(res).currency, 'USD')
  assert.equal(payload(res).spent, 0)
  const stored = storedLedger(home)
  assert.equal(stored.days[DAY].currency, 'USD')
  assert.equal(stored.days[DAY].spent, 0)
})

test('an unusable reading is refused with 400 and never reaches the file', async (t) => {
  const home = useHome(t)
  const cases = [
    observation(DAY, 'abc'),
    observation('x', 10),
    observation(DAY, 10, 'cny'),
    observation(DAY, -1),
    observation(DAY, 10, 'CNY', 'not a date'),
    { day: DAY, currency: 'CNY', amount: 10 },
    'not an object',
  ]
  for (const body of cases) {
    const res = await call(route, 'POST', { body })
    assert.equal(res.status, 400)
    assert.equal(payload(res).ok, false)
    assert.equal(typeof payload(res).reason, 'string')
  }
  // A body that is not JSON at all is the same answer.
  const unparsable = await call(route, 'POST', { raw: '{ not json' })
  assert.equal(unparsable.status, 400)
  assert.equal(existsSync(ledgerFile(home)), false)
})

test('a request that is not from this machine is refused with 403', async (t) => {
  const home = useHome(t)
  const foreign = await call(route, 'GET', { headers: { host: 'evil.example' } })
  assert.equal(foreign.status, 403)
  assert.equal(payload(foreign).ok, false)
  assert.equal(typeof payload(foreign).reason, 'string')
  const foreignPost = await call(route, 'POST', {
    headers: { host: 'evil.example', origin: 'http://evil.example' },
    body: observation(DAY, 10),
  })
  assert.equal(foreignPost.status, 403)
  // The authority is loopback but the origin names another host: still cross-site.
  const crossed = await call(route, 'POST', {
    headers: { host: '127.0.0.1:1234', origin: 'http://evil.example' },
    body: observation(DAY, 10),
  })
  assert.equal(crossed.status, 403)
  // A different port is a different origin.
  const crossedPort = await call(route, 'POST', {
    headers: { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:9999' },
    body: observation(DAY, 10),
  })
  assert.equal(crossedPort.status, 403)
  // A missing authority is refused rather than assumed.
  const noHost = await call(route, 'GET', { headers: { host: '' } })
  assert.equal(noHost.status, 403)
  // Nothing above wrote anything; the page's own call does, and does match.
  const same = await call(route, 'POST', {
    headers: { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234' },
    body: observation(DAY, 10),
  })
  assert.equal(same.status, 200)
  // Every loopback spelling the frozen contract names is accepted.
  for (const host of ['localhost:1234', '[::1]:1234', '::1']) {
    const res = await call(route, 'GET', { headers: { host } })
    assert.equal(res.status, 200)
    assert.equal(payload(res).spent, 0)
  }
  assert.deepEqual(Object.keys(storedLedger(home).days), [DAY])
})

test('a corrupt file reads as an empty ledger and the next write repairs it', async (t) => {
  const home = useHome(t)
  writeFileSync(ledgerFile(home), '{ not json')
  const res = await call(route, 'GET')
  assert.equal(res.status, 200)
  const body = payload(res)
  assert.equal(body.ok, true)
  assert.equal(body.spent, 0)
  assert.equal(body.currency, 'CNY')
  const post = await call(route, 'POST', { body: observation(DAY, 30) })
  assert.equal(post.status, 200)
  assert.equal(payload(post).spent, 0)
  const stored = storedLedger(home)
  assert.equal(stored.version, 1)
  assert.equal(stored.last.amount, 30)
  assert.equal(stored.days[DAY].spent, 0)
})

test('the wrong method on either verb is refused with 405', async (t) => {
  useHome(t)
  // The GET route, reached with POST.
  const readGotPost = await call(host.testing.readHandler, 'POST', { body: observation(DAY, 10) })
  assert.equal(readGotPost.status, 405)
  assert.equal(readGotPost.headers.allow, 'GET, HEAD')
  // The POST route, reached with GET.
  const recordGotGet = await call(host.testing.recordHandler, 'GET')
  assert.equal(recordGotGet.status, 405)
  assert.equal(recordGotGet.headers.allow, 'POST')
  // And the path itself refuses a verb neither serves.
  const other = await call(route, 'DELETE')
  assert.equal(other.status, 405)
  assert.equal(other.headers.allow, 'GET, HEAD, POST')
})

test('a write that cannot land answers 500 and keeps the fold in memory', async (t) => {
  const home = useHome(t)
  // A file where the home directory should be: the ledger can be neither created
  // nor replaced, which is the unwritable-home case without needing one.
  writeFileSync(join(home, 'blocked'), '')
  const blocked = join(home, 'blocked')
  process.env.DSH_HOME = blocked
  const first = await call(route, 'POST', { body: observation(DAY, 15) })
  assert.equal(first.status, 500)
  assert.equal(payload(first).ok, false)
  assert.equal(typeof payload(first).reason, 'string')
  const second = await call(route, 'POST', { body: observation(DAY, 10) })
  assert.equal(second.status, 500)
  // The fold itself succeeded, and the ledger it produced is the one GET answers
  // with: only durability is lost, not the observation.
  const get = await call(route, 'GET')
  assert.equal(get.status, 200)
  assert.equal(payload(get).day, DAY)
  assert.equal(payload(get).spent, 5)
  assert.equal(payload(get).updatedAt, AT)
  assert.equal(existsSync(join(blocked, LEDGER_NAME)), false)
})

test('only the fourteen most recent days are kept', async (t) => {
  const home = useHome(t)
  for (let index = 0; index < 16; index += 1) {
    const day = `2026-10-${String(index + 1).padStart(2, '0')}`
    await call(route, 'POST', { body: observation(day, 20, 'CNY', `${day}T00:00:00.000Z`) })
  }
  const days = Object.keys(storedLedger(home).days)
  assert.equal(days.length, 14)
  assert.equal(days.includes('2026-10-01'), false)
  assert.equal(days.includes('2026-10-02'), false)
  assert.equal(days.includes('2026-10-16'), true)
  // Newest first, because pruning rebuilds the map in descending day order.
  assert.deepEqual(days, [...days].sort().reverse())
})

test('the balance route answers 200 no-key when no API key is configured', async (t) => {
  useCredentials(t, undefined)
  const before = credentialNames.length
  const res = await call(balanceRoute, 'GET')
  assert.equal(res.status, 200)
  const body = payload(res)
  assert.equal(body.ok, false)
  assert.equal(body.reason, 'no-key')
  assert.equal(body.balance, undefined)
  // The service was asked, under the frozen name, and nothing left this machine.
  assert.deepEqual(credentialNames.slice(before), ['DEEPSEEK_API_KEY'])
  assert.equal(balanceCalls.length, 0)
})

test('a reading with a key comes back verbatim, with Bearer authorization', async (t) => {
  openBalance(t, { json: balancePayload('20.79') })
  const res = await call(balanceRoute, 'GET')
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  const body = payload(res)
  assert.equal(body.ok, true)
  // The platform's own string, not a number: the page formats it.
  assert.equal(body.balance, '20.79')
  assert.equal(body.currency, 'CNY')
  assert.equal(body.available, true)
  assert.equal(body.source, 'apikey')
  assert.equal(new Date(body.updatedAt).toISOString(), body.updatedAt)
  assert.equal(balanceCalls.length, 1)
  assert.equal(balanceCalls[0].url, 'https://balance.test/user/balance')
  assert.equal(balanceCalls[0].method, 'GET')
  assert.equal(balanceCalls[0].headers.authorization, 'Bearer test-key')
  assert.equal(balanceCalls[0].headers.accept, 'application/json')
  // The request carries a deadline, so a stalled call cannot hold the page.
  assert.equal(balanceCalls[0].signal instanceof AbortSignal, true)
})

test('a sub-cent reading keeps every digit the platform sent', async (t) => {
  openBalance(t, { json: balancePayload('0.0081') })
  const body = payload(await call(balanceRoute, 'GET'))
  assert.equal(body.ok, true)
  assert.equal(body.balance, '0.0081')
})

test('a wallet that is not available is reported as such', async (t) => {
  openBalance(t, {
    json: { is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '3.20', is_available: false }] },
  })
  const body = payload(await call(balanceRoute, 'GET'))
  assert.equal(body.ok, true)
  assert.equal(body.available, false)
})

test('USD is reported when the account holds no CNY wallet', async (t) => {
  openBalance(t, { json: balancePayload('5.00', 'USD') })
  const body = payload(await call(balanceRoute, 'GET'))
  assert.equal(body.ok, true)
  assert.equal(body.balance, '5.00')
  assert.equal(body.currency, 'USD')
})

test('CNY wins when the account holds several wallets', async (t) => {
  openBalance(t, {
    json: {
      is_available: true,
      balance_infos: [
        { currency: 'USD', total_balance: '1.00', granted_balance: '0.00', topped_up_balance: '1.00' },
        { currency: 'CNY', total_balance: '8.88', granted_balance: '0.00', topped_up_balance: '8.88' },
      ],
    },
  })
  const body = payload(await call(balanceRoute, 'GET'))
  assert.equal(body.ok, true)
  assert.equal(body.balance, '8.88')
  assert.equal(body.currency, 'CNY')
})

test('a failed upstream call is an ok:false answer, never a rejection', async (t) => {
  openBalance(t, { ok: false, status: 500 })
  const res = await call(balanceRoute, 'GET')
  assert.equal(res.status, 200)
  const body = payload(res)
  assert.equal(body.ok, false)
  assert.equal(typeof body.reason, 'string')
  assert.ok(body.reason.length > 0)
})

test('a call that throws is the same ok:false answer', async (t) => {
  openBalance(t, { reject: true })
  const res = await call(balanceRoute, 'GET')
  assert.equal(res.status, 200)
  assert.equal(payload(res).ok, false)
  assert.ok(payload(res).reason.length > 0)
})

test('an unreadable balance answer is refused rather than guessed at', async (t) => {
  const unusable = [
    { is_available: true, balance_infos: [] },
    { is_available: true },
    { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 'not a number' }] },
    { is_available: true, balance_infos: [{ currency: 'CNY' }] },
    { is_available: true, balance_infos: ['nope'] },
    'not an object',
  ]
  const credentials = useCredentials(t, 'test-key')
  t.after(() => {
    delete process.env.DSH_PEAK_BAR_BALANCE_URL
    host.testing.resetBalanceCache()
  })
  process.env.DSH_PEAK_BAR_BALANCE_URL = 'https://balance.test/user/balance'
  balanceCalls.length = 0
  // The answer changes every iteration, so the stub is rebuilt around the current
  // one instead of the single fixed answer `openBalance` installs.
  for (const answer of unusable) {
    host.testing.resetBalanceCache()
    globalThis.fetch = async (url, init) => {
      balanceCalls.push({
        url: String(url),
        headers: (init && init.headers) || {},
        method: init && init.method,
        signal: init && init.signal,
      })
      return { ok: true, status: 200, json: async () => answer }
    }
    assert.equal(credentials.value, 'test-key')
    const res = await call(balanceRoute, 'GET')
    assert.equal(res.status, 200, `expected 200 for ${JSON.stringify(answer)}`)
    const body = payload(res)
    assert.equal(body.ok, false, `expected ok:false for ${JSON.stringify(answer)}`)
    assert.equal(typeof body.reason, 'string')
    assert.ok(body.reason.length > 0)
  }
  assert.equal(balanceCalls.length, unusable.length)
  if (globalThis.fetch !== undefined) delete globalThis.fetch
})

test('a successful reading is cached for every window and poll', async (t) => {
  openBalance(t, { json: balancePayload('20.79') })
  const first = await call(balanceRoute, 'GET')
  const second = await call(balanceRoute, 'GET')
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(payload(first).ok, true)
  assert.equal(payload(second).ok, true)
  assert.deepEqual(payload(second), payload(first))
  // One upstream call for two requests: the platform is not polled per window.
  assert.equal(balanceCalls.length, 1)
  assert.equal(host.testing.BALANCE_CACHE_MS, 25000)
})

test('a failure is not cached, so the next request retries at once', async (t) => {
  const credentials = useCredentials(t, 'test-key')
  const state = useBalanceFetch(t, { ok: false, status: 503 })
  t.after(() => {
    delete process.env.DSH_PEAK_BAR_BALANCE_URL
    host.testing.resetBalanceCache()
  })
  process.env.DSH_PEAK_BAR_BALANCE_URL = 'https://balance.test/user/balance'
  host.testing.resetBalanceCache()
  assert.equal(payload(await call(balanceRoute, 'GET')).ok, false)
  state.ok = true
  state.status = 200
  state.json = balancePayload('1.23')
  const recovered = await call(balanceRoute, 'GET')
  assert.equal(payload(recovered).ok, true)
  assert.equal(payload(recovered).balance, '1.23')
  assert.equal(balanceCalls.length, 2)
  assert.equal(credentials.value, 'test-key')
})

test('the balance route is fenced off from every other machine', async (t) => {
  openBalance(t, { json: balancePayload('20.79') })
  const foreign = await call(balanceRoute, 'GET', { headers: { host: 'evil.example' } })
  assert.equal(foreign.status, 403)
  assert.equal(payload(foreign).ok, false)
  assert.equal(typeof payload(foreign).reason, 'string')
  // The authority is loopback but the origin names another host: still cross-site.
  const crossed = await call(balanceRoute, 'GET', {
    headers: { host: '127.0.0.1:1234', origin: 'http://evil.example' },
  })
  assert.equal(crossed.status, 403)
  // A missing authority is refused rather than assumed.
  const noHost = await call(balanceRoute, 'GET', { headers: { host: '' } })
  assert.equal(noHost.status, 403)
  // The fence runs before the key is even resolved: no request left this machine.
  assert.equal(balanceCalls.length, 0)
  // Every loopback spelling the ledger route accepts is accepted here too.
  for (const host of ['127.0.0.1:1234', 'localhost:1234', '[::1]:1234', '::1']) {
    const res = await call(balanceRoute, 'GET', { headers: { host } })
    assert.equal(res.status, 200)
    assert.equal(payload(res).ok, true)
  }
})

test('the wrong method on the balance route is refused with 405', async (t) => {
  openBalance(t, { json: balancePayload('20.79') })
  const res = await call(balanceRoute, 'POST', { body: { hello: 'world' } })
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET, HEAD')
  assert.equal(balanceCalls.length, 0)
})

test('the balance route is registered on its own path, and the ledger route ignores it', async (t) => {
  useHome(t)
  openBalance(t, { json: balancePayload('20.79') })
  // The spend route still answers its own question with the balance route closed
  // over in the same callback.
  const spend = await call(route, 'GET')
  assert.equal(spend.status, 200)
  assert.equal(payload(spend).spent, 0)
  // And the balance route never touches the ledger: nothing was written.
  const balance = await call(balanceRoute, 'GET')
  assert.equal(balance.status, 200)
  assert.equal(payload(balance).balance, '20.79')
  assert.equal(balanceCalls.length, 1)
})
