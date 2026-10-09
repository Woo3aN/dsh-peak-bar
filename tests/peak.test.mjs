/**
 * Offline check for the billing-window rules in ../client.js.
 *
 * It loads the shipped browser bundle with a stand-in module loader, so the
 * assertions run against the code that actually renders — not a copy.
 *
 *   node --test tests/peak.test.mjs
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}

// eslint-disable-next-line no-eval
eval(source)

const react = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
}
const module = captured.factory((id) => {
  if (id === 'react') return react
  throw new Error('unexpected require: ' + id)
})
const { isValley, nextSwitch, countdown, formatMoney, beijing } = module.testing

/** Beijing wall-clock instant as a Date (the runtime shifts by +8h internally). */
const bj = (text) => new Date(text + '+08:00')

test('Beijing projection reads the civil calendar, not the host zone', () => {
  assert.deepEqual(beijing(bj('2026-09-29T09:30:00')), { day: 2, hour: 9, key: '2026-09-29' })
  assert.deepEqual(beijing(bj('2026-09-29T00:15:00')), { day: 2, hour: 0, key: '2026-09-29' })
  assert.deepEqual(beijing(bj('2026-09-28T23:59:00')), { day: 1, hour: 23, key: '2026-09-28' })
})

test('weekday peak windows are peak, their edges are not', () => {
  // 2026-09-29 is a Tuesday.
  assert.equal(isValley(bj('2026-09-29T08:59:00')), true)
  assert.equal(isValley(bj('2026-09-29T09:00:00')), false)
  assert.equal(isValley(bj('2026-09-29T11:59:00')), false)
  assert.equal(isValley(bj('2026-09-29T12:00:00')), true)
  assert.equal(isValley(bj('2026-09-29T13:59:00')), true)
  assert.equal(isValley(bj('2026-09-29T14:00:00')), false)
  assert.equal(isValley(bj('2026-09-29T17:59:00')), false)
  assert.equal(isValley(bj('2026-09-29T18:00:00')), true)
})

test('weekends bill as valley all day', () => {
  // 2026-09-26 is a Saturday, 2026-09-27 a Sunday.
  assert.equal(isValley(bj('2026-09-26T10:00:00')), true)
  assert.equal(isValley(bj('2026-09-27T15:00:00')), true)
})

test('Chinese statutory holidays bill as valley even on a workday', () => {
  // 2026-10-05 is a Monday inside the National Day holiday.
  assert.equal(beijing(bj('2026-10-05T10:00:00')).day, 1)
  assert.equal(isValley(bj('2026-10-05T10:00:00')), true)
})

test('next switch lands on the following Beijing boundary', () => {
  const beforeNoon = nextSwitch(bj('2026-09-29T11:30:00'))
  assert.equal(beforeNoon.toISOString(), bj('2026-09-29T12:00:00').toISOString())

  const inValleyAfternoon = nextSwitch(bj('2026-09-29T12:30:00'))
  assert.equal(inValleyAfternoon.toISOString(), bj('2026-09-29T14:00:00').toISOString())

  const fridayEvening = nextSwitch(bj('2026-09-25T19:00:00'))
  assert.equal(fridayEvening.toISOString(), bj('2026-09-28T09:00:00').toISOString())

  // Inside the National Day holiday the next switch is the holiday's last day.
  const duringHoliday = nextSwitch(bj('2026-10-02T10:00:00'))
  assert.equal(duringHoliday.toISOString(), bj('2026-10-08T09:00:00').toISOString())
})

test('countdown text stays in two units, in the locale it is given', () => {
  const zh = { long: '{h}小时{m}分', short: '{m}分{s}秒' }
  const en = { long: '{h}h {m}m', short: '{m}m {s}s' }
  const long = 3 * 3600 * 1000 + 5 * 60 * 1000

  assert.equal(countdown(long, zh), '3小时5分')
  assert.equal(countdown(65 * 1000, zh), '1分5秒')
  // An English UI must not read `3小时5分`: the units arrive as locale templates.
  assert.equal(countdown(long, en), '3h 5m')
  assert.equal(countdown(65 * 1000, en), '1m 5s')
  assert.equal(countdown(-1, zh), '')
})

test('money keeps sub-cent balances visible', () => {
  assert.equal(formatMoney('12.3456', 'CNY'), '¥12.35')
  assert.equal(formatMoney('0.0034', 'CNY'), '¥0.0034')
  assert.equal(formatMoney('7', 'USD'), '$7.00')
  assert.equal(formatMoney('abc', 'CNY'), null)
})
