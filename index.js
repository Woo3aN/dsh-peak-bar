/**
 * Host half of dsh-peak-bar.
 *
 * The capsule is browser-side (./client.js), but its "spent today" figure cannot
 * be: a drop in a balance is only meaningful against the previous reading, and
 * that previous reading has to outlive a page reload, a client restart, a second
 * window and a change of the port the page is served from. Browser storage
 * survives none of those reliably — the Desktop carrier drops `localStorage` when
 * its port moves — so the ledger lives here, in one JSON file under DSH_HOME, and
 * the page reads and folds it through two same-origin routes.
 *
 * The file holds both halves of that calculation:
 *
 *   {
 *     "version": 1,
 *     "days": { "2026-10-09": { "currency": "CNY", "spent": 0.2017 } },
 *     "last": { "day": "2026-10-09", "currency": "CNY", "amount": 20.79, "at": "..." },
 *     "updatedAt": "2026-10-09T05:33:12.000Z"
 *   }
 *
 * `last` is what the next observation is compared against; `days` is the answer
 * the page asks for. They are stored together because they are written together:
 * a fold reads both, moves one, and rewrites the file in one atomic step.
 *
 * Failure policy, stated once here because every function below depends on it:
 *   - a missing, unreadable, truncated or malformed file is an EMPTY ledger, never
 *     an exception, and the next successful write replaces it;
 *   - a write that fails (read-only home, a name claimed by a file, a locked file)
 *     answers 500 while the process keeps the folded ledger in memory, so an
 *     observation is lost only across a restart, never at the moment it is made;
 *   - the route is registered through an OPTIONAL injection, so a profile with no
 *     HTTP carrier still loads this plugin — the page then falls back to its own
 *     per-run tally.
 *
 * @module dsh-peak-bar
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The cordis plugin name; it matches this plugin's row id in cordis.patch.yml. */
export const name = 'peak-bar'

/** The single path both verbs are served from; the method selects the behaviour. */
const ROUTE = '/dsh-peak-bar/spend'

/**
 * The read-only balance path, served by GET alone.
 *
 * It is a second route rather than a third verb on the one above because the two
 * answer different questions from different sources: the ledger knows what this
 * machine has observed, while this one asks the platform what the key's account
 * holds. A walled-off key reader also means the official endpoint is reached from
 * exactly one place, with exactly one cache in front of it.
 */
const BALANCE_ROUTE = '/dsh-peak-bar/balance'

/** Where the official balance endpoint lives when nothing overrides it. */
const BALANCE_API = 'https://api.deepseek.com/user/balance'

/** The env override read on every request, so a test can point it at a stub. */
const BALANCE_URL_ENV = 'DSH_PEAK_BAR_BALANCE_URL'

/** The env key the credentials service is asked to resolve. */
const BALANCE_KEY_ENV = 'DEEPSEEK_API_KEY'

/** How long a successful reading is reused; the platform's own figure moves slowly. */
const BALANCE_CACHE_MS = 25000

/** Ceiling on one upstream call: a stalled request must not hold the page. */
const BALANCE_TIMEOUT_MS = 8000

/** Ledger file name under DSH_HOME. */
const LEDGER_FILE = '.dsh-peak-bar.json'

/** Ledger format version. A file declaring another one is treated as unusable. */
const LEDGER_VERSION = 1

/** Days kept in the file; older rows are dropped on write so it cannot grow forever. */
const LEDGER_DAYS = 14

/** The currency reported while the ledger holds no usable record. */
const FALLBACK_CURRENCY = 'CNY'

/** Body ceiling for the write route; one reading is a few dozen bytes. */
const MAX_BODY_BYTES = 64 * 1024

/** Decimal places kept when two readings are subtracted, as a float-noise guard. */
const MONEY_SCALE = 1e10

/** A ledger day key: the client's `YYYY-MM-DD`, which sorts chronologically. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** A ledger currency: the three uppercase letters the account API reports. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/

/** The authorities this service accepts. Anything else is another machine's page. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * The ledger file's absolute path, resolved on every call.
 *
 * Resolving per call — rather than once at module load — is what lets a test, or
 * a profile that moves its home, point `DSH_HOME` somewhere else and have the very
 * next request follow it.
 *
 * @returns the absolute path of `<DSH_HOME>/.dsh-peak-bar.json`.
 */
function ledgerPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, LEDGER_FILE)
}

/** One short line from a thrown value, for a `reason` field. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a parsed JSON value is an object that can carry named fields. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Whether a value is a usable `YYYY-MM-DD` day key. */
function isDayKey(value) {
  return typeof value === 'string' && DAY_PATTERN.test(value)
}

/** Whether a value is a usable three-letter currency. */
function isCurrency(value) {
  return typeof value === 'string' && CURRENCY_PATTERN.test(value)
}

/** An empty ledger: the answer for every unreadable or malformed file. */
function emptyLedger() {
  return { version: LEDGER_VERSION, days: {}, last: null, updatedAt: null }
}

/**
 * Trim a computed amount to the precision the ledger stores.
 *
 * Subtracting two decimal balances in binary floating point can leave noise
 * (`20.79 - 20.5883` is `0.2017000000000006`), and that noise would accumulate
 * into the day's total. Ten decimal places is far below any real balance step and
 * far above the noise.
 *
 * @param value - the amount to trim.
 * @returns the trimmed amount.
 */
function tidy(value) {
  return Math.round(value * MONEY_SCALE) / MONEY_SCALE
}

/**
 * Keep the most recent {@link LEDGER_DAYS} day rows.
 *
 * Keys are `YYYY-MM-DD`, so a plain string sort is chronological and the tail of
 * the descending order is what falls off. Rebuilding the object also leaves the
 * file written newest-first, which is what a human reads it for.
 *
 * @param days - the day rows to trim.
 * @returns a new map holding at most {@link LEDGER_DAYS} rows.
 */
function pruneDays(days) {
  const keys = Object.keys(days).sort().reverse()
  if (keys.length <= LEDGER_DAYS) return days
  const kept = {}
  for (const key of keys.slice(0, LEDGER_DAYS)) kept[key] = days[key]
  return kept
}

/**
 * Validate one parsed file into a ledger, or reject it whole.
 *
 * Rejection is all-or-nothing on purpose. A ledger that is trusted field by field
 * could keep a `last` row whose day row was discarded, and the next fold would
 * then subtract against a reading it cannot place — inventing spend. Discarding
 * the file costs history and never correctness, which is the trade this plugin
 * makes everywhere.
 *
 * @param parsed - the value `JSON.parse` produced.
 * @returns a normalized ledger, or null when the value is not a usable ledger.
 */
function sanitizeLedger(parsed) {
  if (!isRecord(parsed)) return null
  if (parsed.version !== LEDGER_VERSION) return null
  if (!isRecord(parsed.days)) return null
  const days = {}
  for (const key of Object.keys(parsed.days)) {
    if (!isDayKey(key)) return null
    const row = parsed.days[key]
    if (!isRecord(row)) return null
    if (!isCurrency(row.currency)) return null
    if (typeof row.spent !== 'number' || !Number.isFinite(row.spent) || row.spent < 0) return null
    days[key] = { currency: row.currency, spent: row.spent }
  }
  let last = null
  if (parsed.last !== undefined && parsed.last !== null) {
    const row = parsed.last
    if (!isRecord(row)) return null
    if (!isDayKey(row.day) || !isCurrency(row.currency)) return null
    if (typeof row.amount !== 'number' || !Number.isFinite(row.amount) || row.amount < 0) return null
    if (typeof row.at !== 'string' || Number.isNaN(Date.parse(row.at))) return null
    last = { day: row.day, currency: row.currency, amount: row.amount, at: row.at }
  }
  const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null
  return { version: LEDGER_VERSION, days, last, updatedAt }
}

/**
 * Read the ledger file without ever failing.
 *
 * Every failure mode — no file, no permission, a directory that is not a
 * directory, a truncated write, a hand-edited file, another program's JSON — ends
 * as an empty ledger, because the caller is an HTTP handler that must answer, and
 * because the next successful write repairs the file in place.
 *
 * @param file - the ledger path to read.
 * @returns the stored ledger, or an empty one.
 */
function readLedgerFile(file) {
  try {
    return sanitizeLedger(JSON.parse(readFileSync(file, 'utf8'))) ?? emptyLedger()
  } catch {
    return emptyLedger()
  }
}

/**
 * A cheap identity for the file on disk: size and modification time, or null when
 * there is no file there.
 *
 * This is what tells the memory mirror whether the file it knows about was
 * replaced behind its back — by another window's host process, by a test, or by a
 * hand edit — so a stale mirror cannot outlive the truth on disk.
 *
 * @param file - the ledger path to inspect.
 * @returns a fingerprint string, or null.
 */
function fileFingerprint(file) {
  try {
    const stats = statSync(file)
    return `${String(stats.size)}:${String(stats.mtimeMs)}`
  } catch {
    return null
  }
}

/**
 * The in-memory mirror of the file: `{ file, fingerprint, ledger }`, where the
 * fingerprint is the disk state the ledger was read from or written to.
 *
 * It exists for exactly one reason — a write that fails must not take the
 * observation with it. After a failed write the mirror holds the folded ledger
 * under the *old* fingerprint, so reads keep answering from it while the file on
 * disk is untouched; and because any outside change to the file moves the
 * fingerprint, the mirror is dropped the moment it would be wrong.
 */
let mirror = null

/**
 * The current ledger: the file when the mirror is stale or absent, else the
 * mirror.
 *
 * @returns a ledger that callers must treat as read-only; folds build new objects
 *   rather than mutating one.
 */
function readLedger() {
  const file = ledgerPath()
  const fingerprint = fileFingerprint(file)
  if (mirror !== null && mirror.file === file && mirror.fingerprint === fingerprint) return mirror.ledger
  const ledger = readLedgerFile(file)
  mirror = { file, fingerprint, ledger }
  return ledger
}

/**
 * The exact bytes written to the file: two-space JSON with a trailing LF. UTF-8
 * without a BOM, because the string is written as `utf8` and never with a BOM
 * character, and LF-only, because `JSON.stringify` indents with `\n`.
 *
 * @param ledger - the ledger to serialize.
 * @returns the file's full text.
 */
function serialize(ledger) {
  return `${JSON.stringify(ledger, null, 2)}\n`
}

/**
 * Write the ledger atomically, and throw when it cannot be written.
 *
 * The text goes to a randomly named sibling first and is then renamed over the
 * target, so a reader — this process, another window, the next boot — sees either
 * the previous file or the new one and never a half-written one. The home
 * directory is created when missing; the temporary file is removed if anything
 * after its creation fails, so a failure leaves no litter.
 *
 * @param ledger - the ledger to persist.
 * @throws whatever node:fs threw, so the caller can answer 500 and keep the fold.
 */
function writeLedger(ledger) {
  const file = ledgerPath()
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid.toString(36)}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temp, serialize(ledger), { encoding: 'utf8', flag: 'wx' })
    renameSync(temp, file)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // The temporary file is either gone or unreachable; the write error is the
      // one worth reporting.
    }
    throw error
  }
}

/**
 * Fold one balance observation into a ledger.
 *
 * The rules, which the page's display depends on:
 *   - a lower balance for the same day and currency than the previous reading is
 *     consumption, and the difference is added to that day's total;
 *   - a higher balance is a top-up or granted credit and changes nothing: the
 *     increment is only ever positive, so a day's total cannot go down;
 *   - a different day, or a different currency, starts that day's total from zero
 *     rather than subtracting amounts in unlike units;
 *   - the day's total is kept per currency, so a currency switch cannot corrupt it.
 *
 * The returned ledger is new in every field it touches, which is what makes it
 * safe to hand the mirror's current ledger in here.
 *
 * One consequence worth naming: because a day's total restarts when the
 * observation's day moves, a very old day posted after newer ones is dropped by
 * pruning and reports 0 rather than resurrecting its old total.
 *
 * @param ledger - the current ledger.
 * @param observation - a validated `{ day, currency, amount, at }` reading.
 * @returns the ledger with this reading folded in.
 */
function foldObservation(ledger, observation) {
  const { day, currency, amount, at } = observation
  const previous = ledger.last
  const carries = previous !== null && previous.day === day && previous.currency === currency
  const known = ledger.days[day]
  const stored = known !== undefined && known.currency === currency ? known.spent : 0
  let spent = carries ? stored : 0
  if (carries && amount < previous.amount) spent = tidy(spent + (previous.amount - amount))
  return {
    version: LEDGER_VERSION,
    days: pruneDays({ ...ledger.days, [day]: { currency, spent } }),
    last: { day, currency, amount, at },
    updatedAt: at,
  }
}

/**
 * Validate one decoded request body into an observation.
 *
 * Every field is checked here rather than at use, because the fold's arithmetic
 * silently produces nonsense from a usable-looking wrong type: `amount` must be a
 * real finite number, `day` and `currency` must match the shapes the ledger keys
 * use, and `at` must be a date the ledger can store.
 *
 * @param body - the value `JSON.parse` produced, or undefined when it failed.
 * @returns `{ observation }` when usable, else `{ reason }` for the 400 answer.
 */
function validateObservation(body) {
  if (!isRecord(body)) return { reason: 'body must be a JSON object' }
  if (!isDayKey(body.day)) return { reason: 'day must be a YYYY-MM-DD string' }
  if (!isCurrency(body.currency)) return { reason: 'currency must be three uppercase letters' }
  if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount < 0) {
    return { reason: 'amount must be a finite number greater than or equal to 0' }
  }
  if (typeof body.at !== 'string' || Number.isNaN(Date.parse(body.at))) {
    return { reason: 'at must be a date string' }
  }
  return { observation: { day: body.day, currency: body.currency, amount: body.amount, at: body.at } }
}

/**
 * The `YYYY-MM-DD` date of this host's civil calendar.
 *
 * Used only as the placeholder day on an empty ledger: the day a reading belongs
 * to is decided by the page, which knows the billing calendar, and the next
 * observation replaces this value.
 *
 * @returns the local date as `YYYY-MM-DD`.
 */
function todayKey() {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

/**
 * The host name inside one authority, with the port and IPv6 brackets removed.
 * @param authority - a `Host` header value, e.g. `[::1]:19387`.
 * @returns the host name, or `''` when the value holds no usable one.
 */
function hostnameOf(authority) {
  const value = String(authority ?? '').trim().toLowerCase()
  if (value === '') return ''
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? '' : value.slice(1, end)
  }
  // A bare IPv6 literal (`::1`): its port cannot be told apart from its last
  // group, so the whole value is the host name.
  if (value.indexOf(':') !== value.lastIndexOf(':')) return value
  const colon = value.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(value.slice(colon + 1))) return value.slice(0, colon)
  return value
}

/**
 * Why this request must not reach the ledger, or null when it may.
 *
 * Both routes are called by the page the carrier itself served, so both are
 * checked the same way and before anything else: the authority the browser sent
 * must be loopback, and an `Origin` header, when present, must name that same
 * authority. A page on another site cannot forge either header, so this is what
 * stands between an arbitrary web page and a writable file — which is why every
 * unreadable value (a missing or malformed `Host`, an unparseable `Origin`,
 * `Origin: null`) is refused rather than waved through.
 *
 * @param req - the node request.
 * @returns a reason string for the 403 answer, or null when the request passes.
 */
function fenceReason(req) {
  const headers = (req && req.headers) || {}
  const host = String(headers.host ?? '').trim().toLowerCase()
  if (!LOOPBACK_HOSTNAMES.has(hostnameOf(host))) return 'request host must be a loopback address'
  const origin = headers.origin
  if (origin === undefined || origin === null || origin === '') return null
  try {
    if (new URL(String(origin)).host.toLowerCase() !== host) return 'origin must match the request host'
  } catch {
    return 'origin is not a usable URL'
  }
  return null
}

/** Answer one request with JSON. */
function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/**
 * The upstream balance endpoint, resolved on every call.
 *
 * The override is read here rather than at module load so a test can move the
 * endpoint between cases, in the same spirit as {@link ledgerPath}.
 *
 * @returns the URL to call.
 */
function balanceUrl() {
  return process.env[BALANCE_URL_ENV] || BALANCE_API
}

/**
 * The wallet a balance answer should be reported from: the CNY one when the
 * platform sends it, otherwise the first one.
 *
 * @param infos - the `balance_infos` array, whatever shape it arrived in.
 * @returns the chosen wallet, or null when nothing usable is there.
 */
function pickWallet(infos) {
  if (!Array.isArray(infos)) return null
  const wallets = infos.filter(isRecord)
  if (wallets.length === 0) return null
  return wallets.find((wallet) => wallet.currency === FALLBACK_CURRENCY) ?? wallets[0]
}

/**
 * The successful reading reused for {@link BALANCE_CACHE_MS}, or null.
 *
 * One module-level slot is enough: the answer is a single account's balance, and
 * the whole point of the cache is that many windows polling the page, and the page
 * polling a few times a minute, still reach the platform about once per 25
 * seconds. The timestamp is taken when the reading arrived, so a slow call cannot
 * extend its own life.
 */
let balanceCache = null

/**
 * Drop the cached reading. Only the offline check calls this, between cases, so
 * that one case's reading cannot answer another case's request.
 */
function resetBalanceCache() {
  balanceCache = null
}

/**
 * Ask the platform for the key's balance, without ever throwing.
 *
 * Every failure — no credentials, a rejected call, a non-2xx status, a body that
 * is not JSON, a missing wallet or an unreadable amount — comes back as
 * `{ ok: false, reason }`, because the caller is an HTTP handler that always has to
 * answer. Only a reading with a parseable `total_balance` is cached: a failure must
 * be retried on the very next request, so a momentary outage cannot be frozen in
 * place for 25 seconds.
 *
 * @param credentials - the credentials service, or null when none is available.
 * @returns `{ ok: true, balance, currency, available, updatedAt }`, or
 *   `{ ok: false, reason }`.
 */
async function fetchBalance(credentials) {
  const cached = balanceCache
  if (cached !== null && Date.now() - cached.at < BALANCE_CACHE_MS) {
    return { ...cached.reading }
  }
  if (credentials === null || typeof credentials.resolve !== 'function') {
    return { ok: false, reason: 'no-key' }
  }
  let key = null
  try {
    key = await credentials.resolve(BALANCE_KEY_ENV)
  } catch {
    return { ok: false, reason: 'api key could not be resolved' }
  }
  if (typeof key !== 'string' || key.trim() === '') return { ok: false, reason: 'no-key' }
  let response = null
  try {
    response = await fetch(balanceUrl(), {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, reason: 'balance request failed' }
  }
  if (!response.ok) return { ok: false, reason: `balance upstream HTTP ${String(response.status)}` }
  let json = null
  try {
    json = await response.json()
  } catch {
    return { ok: false, reason: 'balance answer was not JSON' }
  }
  const wallet = pickWallet(isRecord(json) ? json.balance_infos : null)
  if (wallet === null) return { ok: false, reason: 'balance answer carried no wallet' }
  // The amount stays exactly as the platform sent it: the page formats money, and
  // a number here would round a sub-cent balance into a wrong one.
  const balance = wallet.total_balance
  if (typeof balance !== 'string' || balance.trim() === '' || !Number.isFinite(Number(balance))) {
    return { ok: false, reason: 'balance amount was unreadable' }
  }
  const reading = {
    ok: true,
    balance,
    currency: isCurrency(wallet.currency) ? wallet.currency : FALLBACK_CURRENCY,
    available: wallet.is_available !== false,
    source: 'apikey',
    updatedAt: new Date().toISOString(),
  }
  balanceCache = { at: Date.now(), reading }
  return { ...reading }
}

/**
 * `GET /dsh-peak-bar/balance` -> the account balance behind the API key.
 *
 * The fence and the method check answer 403 and 405 as they do on the ledger
 * route; everything past them answers 200, with `ok` carrying the verdict, because
 * "there is no key here" is an ordinary state for a profile that signs in instead,
 * not a failed request.
 *
 * @param req - the node request.
 * @param res - the node response.
 * @param credentials - the credentials service, or null when none is available.
 */
async function balanceHandler(req, res, credentials) {
  const denied = fenceReason(req)
  if (denied !== null) {
    sendJson(res, 403, { ok: false, reason: denied })
    return
  }
  const method = String((req && req.method) || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  sendJson(res, 200, await fetchBalance(credentials))
}

/**
 * Read a request body as UTF-8 text.
 *
 * Chunks are coerced rather than assumed to be buffers, because a body reaches
 * this handler as whatever the carrier and the tests hand over (a string
 * `Readable`, a buffer, a mixture). The ceiling exists so a request cannot grow
 * the process; it is orders of magnitude above a reading.
 *
 * @param req - the node request.
 * @returns the body text.
 * @throws when the body cannot be read or exceeds {@link MAX_BODY_BYTES}.
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * `GET /dsh-peak-bar/spend` -> the ledger's most recent day.
 *
 * The day answered is the one the last observation named, not a calendar this
 * process derives: the page owns the billing day, so the host reports the newest
 * record it was given and lets the page compare it with its own. An empty ledger
 * answers with today's local date, `CNY` and `0`.
 *
 * @param req - the node request.
 * @param res - the node response.
 */
async function readHandler(req, res) {
  const denied = fenceReason(req)
  if (denied !== null) {
    sendJson(res, 403, { ok: false, reason: denied })
    return
  }
  const method = String((req && req.method) || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  const ledger = readLedger()
  const last = ledger.last
  const row = last === null ? undefined : ledger.days[last.day]
  sendJson(res, 200, {
    ok: true,
    day: last === null ? todayKey() : last.day,
    currency: last === null ? FALLBACK_CURRENCY : last.currency,
    spent: last !== null && row !== undefined && row.currency === last.currency ? row.spent : 0,
    updatedAt: ledger.updatedAt,
  })
}

/**
 * `POST /dsh-peak-bar/spend` -> fold one reading into the ledger.
 *
 * Answers 400 for a body that is not a usable reading, 403 for a request the
 * fence refuses, 500 when the fold could not be persisted, and 200 with the day's
 * total otherwise. The 500 is the one case where the answer and the file
 * disagree: the ledger in memory keeps the fold, so the page's number stays
 * right and only its durability is lost.
 *
 * @param req - the node request.
 * @param res - the node response.
 */
async function recordHandler(req, res) {
  const denied = fenceReason(req)
  if (denied !== null) {
    sendJson(res, 403, { ok: false, reason: denied })
    return
  }
  const method = String((req && req.method) || 'GET').toUpperCase()
  if (method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  let body = null
  try {
    body = JSON.parse(await readBody(req))
  } catch (error) {
    sendJson(res, 400, { ok: false, reason: `body is not usable JSON: ${messageOf(error)}` })
    return
  }
  const checked = validateObservation(body)
  if (checked.observation === undefined) {
    sendJson(res, 400, { ok: false, reason: checked.reason })
    return
  }
  const { observation } = checked
  const file = ledgerPath()
  const ledger = foldObservation(readLedger(), observation)
  // Published before the write, under the fingerprint of the file this attempt
  // may fail to replace: a failure then leaves the fold answerable from memory,
  // and a success re-publishes it under the new file's fingerprint.
  mirror = { file, fingerprint: fileFingerprint(file), ledger }
  try {
    writeLedger(ledger)
  } catch (error) {
    sendJson(res, 500, { ok: false, reason: `ledger was not persisted: ${messageOf(error)}` })
    return
  }
  mirror = { file, fingerprint: fileFingerprint(file), ledger }
  const row = ledger.days[observation.day]
  sendJson(res, 200, {
    ok: true,
    day: observation.day,
    currency: observation.currency,
    spent: row === undefined ? 0 : row.spent,
  })
}

/**
 * The registered route handler.
 *
 * One path serves both verbs, so the method is the router here instead of in the
 * carrier: the route table is keyed by path, and two registrations of the same
 * path would collide, leaving one verb unreachable. The per-verb handlers above
 * keep their own 405 answers — including their own `allow` header — for a caller
 * that addresses one of them with the wrong method.
 *
 * @param req - the node request.
 * @param res - the node response.
 */
async function spendHandler(req, res) {
  const method = String((req && req.method) || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return readHandler(req, res)
  if (method === 'POST') return recordHandler(req, res)
  res.writeHead(405, { allow: 'GET, HEAD, POST' })
  res.end()
}

/** Register one route through the carrier, tied to the plugin's lifetime. */
function mountRoute(webCtx, path, handler) {
  webCtx.effect(
    () => webCtx.webServer.register({ kind: 'exact', path, handler }),
    `peak-bar: ${path}`,
  )
}

/**
 * Mount the plugin.
 *
 * Both dependencies are injected optionally, through one scoped callback, and
 * never declared as an object-level `inject`: a profile with no HTTP carrier must
 * still load the plugin, because everything except the shared ledger — the
 * countdown, the balance the page reads for itself, the per-run tally — works
 * without a route; and a profile with no credentials service must still load it
 * too, because the ledger route answers from local state alone.
 *
 * The balance route captures the `credentials` service this way, so the key is
 * resolved per request rather than held here: nothing in this module ever stores
 * the secret, and a key that a profile rotates under us is picked up by the next
 * request that is not served from the cache.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.inject(['webServer', 'credentials'], (scoped) => {
    mountRoute(scoped, ROUTE, spendHandler)
    mountRoute(scoped, BALANCE_ROUTE, (req, res) => balanceHandler(req, res, scoped.credentials ?? null))
  })
}

/**
 * Internals exposed for the offline check in tests/host.test.mjs. Not part of the
 * plugin's contract: the page talks to the route, never to these.
 */
export const testing = {
  ROUTE,
  BALANCE_ROUTE,
  BALANCE_CACHE_MS,
  balanceHandler,
  fetchBalance,
  balanceUrl,
  pickWallet,
  resetBalanceCache,
  LEDGER_DAYS,
  ledgerPath,
  emptyLedger,
  sanitizeLedger,
  readLedger,
  writeLedger,
  foldObservation,
  pruneDays,
  validateObservation,
  fenceReason,
  readHandler,
  recordHandler,
  spendHandler,
  todayKey,
}
