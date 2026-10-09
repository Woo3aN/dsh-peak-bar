/**
 * Client half of dsh-peak-bar — one compact capsule centred in the
 * window's caption strip, showing the DeepSeek API billing window (peak /
 * valley) with a countdown to the next switch, and the account balance.
 *
 * Placement: the root frame declares `shell.overlay`, a root-scoped list seat
 * rendered into its absolutely positioned overlay layer. That layer spans the
 * frame's padding box, caption strip included, so an entry can be pinned to
 * the strip that carries the window controls (the Windows caption row, the
 * macOS title strip) and stays visible on every page.
 *
 * Why centred, not beside the Windows controls: the shell publishes
 * `--dsh-windows-titlebar-height` and `--dsh-windows-menu-start` but no width
 * for the native minimize / maximize / close cluster, so a right-aligned
 * capsule would need a hard-coded inset that drifts with DPI, OS build and
 * locale. The centre of the strip is the one position the native controls
 * cannot claim.
 *
 * Why not `shell.leading`: that is the seat inside this very strip, but the
 * frame mounts it only on macOS desktop with the sidebar collapsed
 * (`leadingMounted = darwin && sidebarCollapsed`), so it renders nothing on
 * Windows. `shell.overlay` is the documented seat for a known overlay
 * position (see the ui-plugin reference), which is exactly this case.
 *
 * Clicking the capsule opens the `main` panel registered below through the
 * Client `layout` service; it is a real button, so it also answers to Tab and
 * Enter, and it opts itself out of the caption's drag region.
 *
 * Balance: read through the Web client's `remote.account` service — the same
 * path the shipped "account and balance" settings card uses — and the answer is
 * unwrapped through the envelope that card reads (`{ok, value}` whose `value` is
 * `{status, value, bonusWallets}`).
 *
 * `remote` and `remote.account` are separate cordis services: the member must be
 * injected under its dotted name, and touching it while only `remote` is
 * injected throws `cannot get property "remote.account"`. The dependency is
 * scoped with `ctx.inject(['remote.account'], ...)` rather than declared in the
 * plugin's top-level `inject`, so a profile without the account provider keeps
 * the capsule — countdown included — and states that the Remote is missing
 * instead of holding the whole plugin inactive.
 *
 * Styling: theme tokens only (`--dsw-alias-*`), so the capsule follows the
 * active skin — with the Rhine Lab skin that is the warm grey / orange palette
 * — and follows light and dark mode without any own colour literals.
 *
 * @module dsh-peak-bar/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-peak-bar',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Panel id, shared by the capsule and the layout's keyed `main` seat. */
    const PANEL_ID = 'peak-bar'
    /** Locale namespace for the capsule: visible text goes through ctx.locale. */
    const LOCALE_NS = 'peakBar'
    /** Balance re-read interval; the account read itself is cached for 25s. */
    const BALANCE_REFRESH_MS = 60000
    /** One-second clock is enough: the capsule shows mm:ss. */
    const CLOCK_MS = 1000

    /**
     * Chinese public holidays, which bill as valley all day. DeepSeek's footnote
     * reads "Monday to Friday (excluding Chinese statutory holidays)"; the
     * published 2026 arrangement only lists days off — swapped-in working
     * weekends are already valley under the weekend rule, so they need no row.
     * Source: 国务院办公厅关于 2026 年部分节假日安排的通知. Extend this each
     * November when the next year's arrangement is published.
     */
    const HOLIDAY_VALLEY = {
      '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1,
      '2026-02-15': 1, '2026-02-16': 1, '2026-02-17': 1, '2026-02-18': 1,
      '2026-02-19': 1, '2026-02-20': 1, '2026-02-21': 1, '2026-02-22': 1, '2026-02-23': 1,
      '2026-04-04': 1, '2026-04-05': 1, '2026-04-06': 1,
      '2026-05-01': 1, '2026-05-02': 1, '2026-05-03': 1, '2026-05-04': 1, '2026-05-05': 1,
      '2026-06-19': 1, '2026-06-20': 1, '2026-06-21': 1,
      '2026-09-25': 1, '2026-09-26': 1, '2026-09-27': 1,
      '2026-10-01': 1, '2026-10-02': 1, '2026-10-03': 1, '2026-10-04': 1,
      '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1,
    }

    /** Peak billing is Beijing 09:00-12:00 and 14:00-18:00 on working days. */
    const PEAK_WINDOWS = [[9, 12], [14, 18]]
    /** Beijing hour boundaries at which the billing window can switch. */
    const EDGES = [0, 9, 12, 14, 18]
    /** Coverage of the forward scan used to find the next switch. */
    const SCAN_DAYS = 14
    /**
     * The last day the holiday table below covers. Past it the table no longer
     * knows anything, so a statutory holiday would be counted as a working day and
     * the window would be wrong for a few days a year — the panel says so instead
     * of answering confidently.
     */
    const HOLIDAY_TABLE_LAST = '2026-12-31'

    const BJ_OFFSET_MS = 8 * 3600 * 1000
    const DAY_MS = 86400000

    /**
     * Project a moment onto the Beijing civil calendar.
     * @param date - any instant.
     * @returns Beijing weekday, hour and `YYYY-MM-DD` key.
     */
    function beijing(date) {
      const shifted = new Date(date.getTime() + BJ_OFFSET_MS)
      return {
        day: shifted.getUTCDay(),
        hour: shifted.getUTCHours(),
        key: shifted.toISOString().slice(0, 10),
      }
    }

    /**
     * Whether the holiday table no longer covers the day being displayed.
     * @param key - a Beijing `YYYY-MM-DD` key; today's by default.
     * @returns true when the table has run out.
     */
    function isHolidayTableStale(key = beijing(new Date()).key) {
      return key > HOLIDAY_TABLE_LAST
    }

    /**
     * Whether an instant bills at the off-peak (valley) price: weekends,
     * Chinese statutory holidays, and every hour outside the peak windows.
     * @param date - the instant to classify.
     * @returns true when valley.
     */
    function isValley(date) {
      const { day, hour, key } = beijing(date)
      if (day === 0 || day === 6) return true
      if (Object.hasOwn(HOLIDAY_VALLEY, key)) return true
      for (const [start, end] of PEAK_WINDOWS) {
        if (hour >= start && hour < end) return false
      }
      return true
    }

    /**
     * The next instant at which the billing window changes, found by walking
     * Beijing hour boundaries under the same rules as {@link isValley}.
     * @param from - search origin.
     * @returns the next switch instant, or null when the scan finds none.
     */
    function nextSwitch(from) {
      const current = isValley(from)
      const startOfDay = Math.floor((from.getTime() + BJ_OFFSET_MS) / DAY_MS) * DAY_MS
      for (let day = 0; day <= SCAN_DAYS; day += 1) {
        for (const edge of EDGES) {
          const candidate = new Date(startOfDay + day * DAY_MS + edge * 3600000 - BJ_OFFSET_MS)
          if (candidate.getTime() <= from.getTime()) continue
          if (isValley(candidate) !== current) return candidate
        }
      }
      return null
    }

    /** Fallback countdown templates, used only by the exported test surface. */
    const DEFAULT_COUNTDOWN = { long: '{h}小时{m}分', short: '{m}分{s}秒' }

    /** Fill `{name}` placeholders in one locale template. */
    function fill(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) => (
        Object.hasOwn(params, key) ? String(params[key]) : whole
      ))
    }

    /**
     * Countdown text from the locale's two templates: the long one while more
     * than an hour remains, the short one otherwise.
     *
     * The templates are locale strings, not hard-coded units: an English UI must
     * not read `Peak 3小时5分`.
     *
     * @param ms - milliseconds remaining.
     * @param formats - `{ long, short }` templates carrying `{h}` `{m}` `{s}`.
     * @returns the localized countdown, or an empty string when not applicable.
     */
    function countdown(ms, formats) {
      const text = formats ?? DEFAULT_COUNTDOWN
      if (!Number.isFinite(ms) || ms < 0) return ''
      const total = Math.floor(ms / 1000)
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      if (hours > 0) return fill(text.long, { h: hours, m: minutes })
      return fill(text.short, { m: minutes, s: total % 60 })
    }

    /**
     * Money text for one wallet amount. Sub-cent balances stay meaningful, so
     * they keep four decimals instead of collapsing to a rounded zero.
     * @param value - the amount as the platform sent it.
     * @param currency - `CNY` or `USD`.
     * @returns the display string, or null when the value is not a number.
     */
    function formatMoney(value, currency) {
      const amount = Number(value)
      if (!Number.isFinite(amount)) return null
      const symbol = currency === 'USD' ? '$' : '¥'
      const digits = amount !== 0 && Math.abs(amount) < 1 ? 4 : 2
      return `${symbol}${amount.toFixed(digits)}`
    }

    /**
     * Sum one wallet list per currency, so a mixed-currency account keeps each
     * amount separate instead of adding unlike units together.
     * @param wallets - wallet rows as projected by the account service.
     * @returns the display text, plus the primary currency's numeric total for
     *   the spend tracker (CNY when present, else the first currency seen).
     */
    function sumWallets(wallets) {
      const totals = new Map()
      for (const wallet of wallets) {
        const currency = String((wallet && wallet.currency) || 'CNY').toUpperCase()
        const amount = Number(wallet && wallet.balance)
        if (!Number.isFinite(amount)) continue
        totals.set(currency, (totals.get(currency) ?? 0) + amount)
      }
      const entries = [...totals.entries()]
      const parts = entries
        .map(([currency, amount]) => formatMoney(amount, currency))
        .filter((text) => text !== null)
      const primary = entries.find(([currency]) => currency === 'CNY') ?? entries[0] ?? null
      return {
        text: parts.join(' + '),
        total: primary === null ? null : { currency: primary[0], amount: primary[1] },
      }
    }

    /**
     * Money text for the spend readout: always two decimals, never a sign, the
     * way the balance widgets read. Amounts too small to survive rounding stay
     * visible as `<0.01` instead of collapsing to a zero that would look like a
     * bug.
     * @param amount - the amount to render.
     * @param currency - `CNY` or `USD`.
     * @returns the display string.
     */
    function formatSpend(amount, currency) {
      const value = Number(amount)
      const symbol = currency === 'USD' ? '$' : '¥'
      if (!Number.isFinite(value) || value <= 0) return ''
      const rounded = Number(value.toFixed(2))
      if (rounded === 0) return `${symbol}<0.01`
      return `${symbol}${rounded.toFixed(2)}`
    }

    /**
     * The spend ledger route, served by this plugin's Host half.
     *
     * The Host owns the ledger on purpose: the account service reports a balance,
     * not a bill, so spend is inferred from balance drops, and a ledger kept in
     * the page would restart with every window, every reload and every Desktop
     * launch (its port — and with it the page origin, and `localStorage` — can
     * change per launch). The Host writes `<DSH_HOME>/.dsh-peak-bar.json`
     * instead, so the number survives all three.
     */
    const SPEND_ROUTE = '/dsh-peak-bar/spend'
    /**
     * The Host's API-key balance route. The credential can only be resolved on
     * the Host, so a user who configured `DEEPSEEK_API_KEY` without signing in is
     * served from here rather than from the account Remote.
     */
    const BALANCE_ROUTE = '/dsh-peak-bar/balance'
    /** A local request that outlives this is not coming back; fall back to local. */
    const SPEND_TIMEOUT_MS = 4000

    /** An abort signal with a deadline, when the runtime offers one. */
    function spendSignal() {
      try {
        return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(SPEND_TIMEOUT_MS)
          : undefined
      } catch (error) {
        return undefined
      }
    }

    /** Read the Host's ledger for today. */
    async function fetchSpend() {
      const response = await fetch(SPEND_ROUTE, {
        headers: { accept: 'application/json' },
        signal: spendSignal(),
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const payload = await response.json()
      if (!payload || payload.ok !== true) throw new Error('malformed ledger answer')
      return payload
    }

    /** Hand one balance reading to the Host ledger; it answers with the day's total. */
    async function postSpend(observation) {
      const response = await fetch(SPEND_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(observation),
        signal: spendSignal(),
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const payload = await response.json()
      if (!payload || payload.ok !== true) throw new Error('malformed ledger answer')
      return payload
    }

    /**
     * The fallback ledger, used only while the Host route is unreachable — a
     * profile whose HTTP carrier is missing, or a failed request. It keeps the
     * run's own tally in `localStorage`, so the number still moves; losing that
     * store costs history, never correctness.
     */
    const SPEND_STORE_KEY = 'dsh-peak-bar.spend'
    let spendRecord = null

    /** The run's spend record, read from storage once per run. */
    function readSpendRecord() {
      if (spendRecord !== null) return spendRecord
      let stored = null
      try {
        stored = JSON.parse(window.localStorage.getItem(SPEND_STORE_KEY) || 'null')
      } catch (error) {
        stored = null
      }
      const usable = stored !== null && typeof stored === 'object'
        && Number.isFinite(Number(stored.spent)) && typeof stored.currency === 'string'
      spendRecord = usable
        ? {
          day: String(stored.day || ''),
          currency: stored.currency,
          spent: Number(stored.spent),
          last: Number.isFinite(Number(stored.last)) ? Number(stored.last) : null,
        }
        : { day: '', currency: '', spent: 0, last: null }
      return spendRecord
    }

    /** Mirror the fallback record into storage; a refusal only costs history. */
    function writeSpendRecord(record) {
      try {
        window.localStorage.setItem(SPEND_STORE_KEY, JSON.stringify(record))
      } catch (error) {
        // Private mode, a cleared store, or storage disabled: keep the run's total.
      }
    }

    /**
     * Fold one balance reading into the fallback record, under the same rule the
     * Host applies: a drop is consumption, a rise is a top-up.
     * @param observation - `{ day, currency, amount }`.
     * @returns the day's spent amount.
     */
    function observeSpendLocally(observation) {
      const record = readSpendRecord()
      if (record.day !== observation.day || record.currency !== observation.currency) {
        record.day = observation.day
        record.currency = observation.currency
        record.spent = 0
      } else if (record.last !== null && observation.amount < record.last) {
        record.spent += record.last - observation.amount
      }
      record.last = observation.amount
      writeSpendRecord(record)
      return record.spent
    }

    /**
     * Record one balance reading and return today's spend text.
     *
     * The Host ledger is authoritative; the fallback only runs when that request
     * fails, so a missing route degrades the history, not the feature — and the
     * caller is told which of the two answered, so a degraded ledger is visible
     * rather than silently smaller.
     *
     * @param total - the primary currency's amount, or null when unreadable.
     * @returns the display text ('' when nothing has been spent yet) and the source.
     */
    async function recordSpend(total) {
      if (total === null) return { text: '', source: 'host' }
      const observation = {
        day: beijing(new Date()).key,
        currency: total.currency,
        amount: total.amount,
        at: new Date().toISOString(),
      }
      let state = null
      try {
        state = await postSpend(observation)
      } catch (error) {
        return {
          text: formatSpend(observeSpendLocally(observation), total.currency),
          source: 'run',
        }
      }
      return {
        text: formatSpend(state.spent, typeof state.currency === 'string' ? state.currency : total.currency),
        source: 'host',
      }
    }

    /**
     * Unwrap one `remote.account.getBalance` answer into its wallet lists.
     *
     * The account Remote wraps the platform answer exactly once: the call
     * resolves to `{ ok, value }` — the envelope the shipped account card checks
     * with `if (!result.ok)` — and `value` is the platform snapshot
     * `{ status, value, bonusWallets }` that the same card then reads as
     * `details.balance.status`, `.value` and `.bonusWallets`.
     *
     * Reading wallets straight off the envelope is why the balance used to show
     * `--` forever: `Array.isArray(result.value)` was false and
     * `result.bonusWallets` was undefined, so the sum was always empty. Both
     * shapes are accepted here so a build that returns the snapshot directly
     * keeps working.
     *
     * @param result - the Remote answer.
     * @param reasons - the active locale's reason templates.
     * @returns the two wallet lists, or a reason string when unusable.
     */
    function readWallets(result, reasons) {
      if (!result || result.ok !== true) return { reason: reasons.callFailed }
      const payload = result.value
      const wrapped = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        && ('status' in payload || 'bonusWallets' in payload)
      const snapshot = wrapped ? payload : result
      if (typeof snapshot.status === 'string' && snapshot.status !== 'ready') {
        return { reason: fill(reasons.notReady, { status: snapshot.status }) }
      }
      const recharge = Array.isArray(snapshot.value) ? snapshot.value : []
      const bonus = Array.isArray(snapshot.bonusWallets) ? snapshot.bonusWallets : []
      if (recharge.length === 0 && bonus.length === 0) return { reason: reasons.noWallet }
      return { recharge, bonus }
    }

    /** One short line of an error, for a caption that cannot wrap. */
    function errText(error) {
      return String((error && error.message) || error).slice(0, 160)
    }

    /**
     * The UI language the account call reports, read at call time so it follows
     * a language switch — the same thing the shipped account card does with
     * `accountClientMetadata(ctx.locale.getSnapshot().active, <build version>)`.
     * @param ctx - the Client plugin context.
     * @returns the active locale tag, falling back to `zh_CN`.
     */
    function activeLocale(ctx) {
      try {
        const active = ctx.locale.getSnapshot().active
        if (typeof active === 'string' && active !== '') return active
      } catch (error) {
        // A locale service without that reader keeps the fallback.
      }
      return 'zh_CN'
    }

    /**
     * The `remote.account` member as a usable service, plus why it was not
     * usable when it was not.
     *
     * `remote` and `remote.account` are two separate cordis services: the member
     * is injected by its own dotted name — the shipped account card declares
     * `"remote.account"` right next to `"remote"` in its service list — and
     * touching the member while only `remote` is injected throws
     * `cannot get property "remote.account"`. That throw is what the capsule used
     * to report as an unknown failure.
     *
     * The injected scope is preferred. The plugin's own context is tried second
     * only so a runtime without `ctx.inject` reports the real message instead of
     * a guess, and every access is wrapped because the accessor itself throws.
     *
     * @param scope - the context from the nested `remote.account` injection.
     * @param ctx - the plugin's own context.
     * @returns the service, or the attempts that failed.
     */
    function accountService(scope, ctx) {
      const tried = []
      const attempt = (label, read) => {
        try {
          const member = read()
          if (member && typeof member.getBalance === 'function') return member
          tried.push(`${label} 上没有 getBalance`)
        } catch (error) {
          tried.push(`${label} 抛错：${errText(error)}`)
        }
        return null
      }
      if (scope) {
        const scoped = attempt('remote.account', () => scope.remote && scope.remote.account)
        if (scoped !== null) return { service: scoped, tried }
      }
      const fallback = attempt('ctx.remote.account', () => ctx.remote && ctx.remote.account)
      if (fallback !== null) return { service: fallback, tried }
      return { service: null, tried }
    }

    /**
     * Read the account balance through the Web client's account Remote.
     *
     * The service is optional, so it is not declared in the plugin's top-level
     * `inject`: that would hold the whole capsule inactive in a profile without
     * the account provider. The dependency lives in a nested `ctx.inject`
     * instead, and this read reports its absence rather than throwing.
     *
     * The failure reason travels back with the text instead of being swallowed:
     * a bare `—` cannot be told apart from "still loading", "not logged in" or a
     * changed payload shape, which is exactly the state this plugin sat in.
     *
     * @param ctx - the Client plugin context.
     * @param scope - the context injected for `remote.account`, or null.
     * @param reasons - the active locale's reason templates.
     * @returns the balance text, the numeric total, and a reason note.
     */
    async function readAccountBalance(ctx, scope, reasons) {
      const { service, tried } = accountService(scope, ctx)
      if (service === null) {
        return { text: null, note: fill(reasons.noRemote, { detail: tried.join('；') }), total: null }
      }
      let result
      try {
        result = await service.getBalance({
          // The shipped account card inlines its own build version; a third-party
          // plugin has none to inline, so it reports `unknown`. The platform
          // accepts it — only an empty string is rejected.
          version: 'unknown',
          // The active UI language, the way the shipped card passes it. The
          // platform reduces it to `zh_CN` / `en_US` for `x-client-locale`.
          locale: activeLocale(ctx),
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        })
      } catch (error) {
        return { text: null, note: fill(reasons.callFailed, { detail: errText(error) }), total: null }
      }
      const wallets = readWallets(result, reasons)
      if (!wallets.recharge) return { text: null, note: wallets.reason, total: null }
      const sums = sumWallets(wallets.recharge.concat(wallets.bonus))
      if (sums.text === '') return { text: null, note: reasons.noAmount, total: null }
      // The numeric total travels back so the ledger round trip can happen after
      // the readout is already on screen; see the caller.
      return { text: sums.text, note: '', total: sums.total }
    }

    /**
     * Read the balance through the Host half, which holds the API key.
     *
     * This is the path for a user who configured `DEEPSEEK_API_KEY` but never
     * signed in to a DeepSeek account: the credential can only be resolved on the
     * Host, so the page asks its own Host route instead of the account Remote.
     * The route answers `ok:false` with a reason when it cannot help — a page
     * without that route at all is reported as no answer, and the caller then
     * keeps the account path's note.
     *
     * @param labels - the active locale's balance-path labels.
     * @returns the balance text, total and note, or null when no route answered.
     */
    async function readKeyedBalance(labels) {
      let payload = null
      try {
        const response = await fetch(BALANCE_ROUTE, {
          headers: { accept: 'application/json' },
          signal: spendSignal(),
        })
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        payload = await response.json()
      } catch (error) {
        return null
      }
      if (!payload || payload.ok !== true) {
        const reason = payload && typeof payload.reason === 'string' ? payload.reason : 'unknown'
        return { text: null, note: fill(labels.keyFailed, { reason }), total: null }
      }
      const amount = Number(payload.balance)
      const currency = typeof payload.currency === 'string' && payload.currency !== ''
        ? payload.currency
        : 'CNY'
      if (!Number.isFinite(amount)) {
        return { text: null, note: fill(labels.keyFailed, { reason: 'unreadable amount' }), total: null }
      }
      return {
        text: formatMoney(amount, currency),
        // An account the platform flags as unavailable still has a number worth
        // showing; the note is what keeps that number from reading as spendable.
        note: payload.available === false ? labels.keyUnavailable : '',
        total: { currency, amount },
        source: 'apikey',
      }
    }

    /**
     * Read the balance, preferring the signed-in account and falling back to the
     * Host's API-key route.
     *
     * Both paths report the same quantity — top-up plus granted credit — so the
     * ledger keeps folding correctly whichever one answers. When neither can, the
     * note carries both reasons, which is what tells "not signed in" apart from
     * "no key configured".
     *
     * @param ctx - the Client plugin context.
     * @param scope - the context injected for `remote.account`, or null.
     * @param reasons - the active locale's account reason templates.
     * @param labels - the active locale's balance-path labels.
     * @returns the balance text, total, source and note.
     */
    async function readBalance(ctx, scope, reasons, labels) {
      const account = await readAccountBalance(ctx, scope, reasons)
      if (account.text !== null) return { ...account, source: 'account' }
      const keyed = await readKeyedBalance(labels)
      if (keyed !== null && keyed.text !== null) return keyed
      const extra = keyed !== null && keyed.note !== '' ? keyed.note : ''
      return {
        text: null,
        total: null,
        source: '',
        note: extra === '' ? account.note : `${account.note} · ${extra}`,
      }
    }

    /**
     * The status body shown in the layout's `main` seat when the capsule is
     * opened. It reuses the capsule's data and adds the rule the capsule cannot
     * state.
     * @param props - this plugin's injected data.
     * @returns the status panel.
     */
    /** Which ledger answered the spend readout, in the active locale. */
    function spendSourceText(props, source) {
      if (source === 'host') return props.spendSourceHost
      if (source === 'run') return props.spendSourceRun
      return ''
    }

    function StatusPanel(props) {
      const status = useStatus(props)
      const source = spendSourceText(props, status.spentSource)
      const balanceSource = balanceSourceText(props, status.balanceSource)
      const tableStale = isHolidayTableStale()
      return h('div', { className: 'dshPeakBarPanel' },
        h('div', { className: 'dshPeakBarPanel__head' },
          h('span', { className: status.valley ? 'dshPeakBarPanel__tag' : 'dshPeakBarPanel__tag dshPeakBarPanel__tag--peak' }, status.label),
          h('span', { className: 'dshPeakBarPanel__title' }, props.titleLabel)),
        h('dl', { className: 'dshPeakBarPanel__rows' },
          h('dt', null, props.nextLabel),
          h('dd', null, status.remaining === '' ? '—' : status.remaining),
          h('dt', null, props.balanceLabel),
          h('dd', null, status.balanceText),
          h('dt', null, props.spentLabel),
          h('dd', null, status.spentText === '' ? '—' : status.spentText)),
        balanceSource === '' ? null : h('p', { className: 'dshPeakBarPanel__note' }, `${props.balanceSourceLabel}：${balanceSource}`),
        source === '' ? null : h('p', { className: 'dshPeakBarPanel__note' }, `${props.spendSourceLabel}：${source}`),
        tableStale ? h('p', { className: 'dshPeakBarPanel__warn' }, props.holidayStaleHint) : null,
        status.balanceNote === '' ? null : h('p', { className: 'dshPeakBarPanel__warn' }, status.balanceNote),
        h('p', { className: 'dshPeakBarPanel__note' }, props.spentHint),
        h('p', { className: 'dshPeakBarPanel__note' }, props.ruleLabel))
    }

    /**
     * Shared clock, balance and spend state for the capsule and the panel, so
     * both agree.
     * @param props - this plugin's injected data.
     * @returns the derived display state.
     */
    function useStatus(props) {
      const [now, setNow] = React.useState(() => Date.now())
      const [balance, setBalance] = React.useState(undefined)
      const [balanceSource, setBalanceSource] = React.useState('')
      const [balanceNote, setBalanceNote] = React.useState('')
      const [spent, setSpent] = React.useState('')
      const [spentSource, setSpentSource] = React.useState('')

      React.useEffect(() => {
        const timer = window.setInterval(() => {
          setNow(Date.now())
        }, CLOCK_MS)
        return () => {
          window.clearInterval(timer)
        }
      }, [])

      React.useEffect(() => {
        let disposed = false
        // The `remote.account` scope is resolved when the shell provides that
        // service, which can land after this effect starts; the read therefore
        // asks for it on every tick instead of capturing it once.
        const accountScope = () => (typeof props.accountScope === 'function' ? props.accountScope() : null)
        // Show the ledger's current value before the first balance read lands —
        // and keep showing it when the balance itself is unreadable.
        const prime = () => {
          Promise.resolve()
            .then(() => fetchSpend())
            .then((state) => {
              if (disposed) return
              const text = formatSpend(state.spent, typeof state.currency === 'string' ? state.currency : 'CNY')
              if (text !== '') setSpent(text)
            })
            .catch(() => {})
        }
        prime()
        const tick = () => {
          if (disposed) return
          Promise.resolve()
            .then(() => readBalance(props.ctx, accountScope(), props.reasons, {
              keyFailed: props.keyFailed,
              keyUnavailable: props.keyUnavailable,
            }))
            .then((answer) => {
              if (disposed) return
              // A failed read keeps the last known amount on screen, like the
              // other balance surfaces do; only the note changes.
              if (answer.text !== null) setBalance(answer.text)
              setBalanceSource(typeof answer.source === 'string' ? answer.source : '')
              setBalanceNote(answer.note)
              // The ledger round trip runs after the readout is on screen: a slow
              // or unreachable Host must not hold back the balance.
              if (answer.total) {
                Promise.resolve()
                  .then(() => recordSpend(answer.total))
                  .then((result) => {
                    if (disposed || result === null) return
                    if (typeof result.text === 'string') setSpent(result.text)
                    setSpentSource(typeof result.source === 'string' ? result.source : '')
                  })
                  .catch(() => {})
              }
            })
            .catch((error) => {
              if (disposed) return
              setBalanceNote(fill(props.reasons.readError, { detail: errText(error) }))
            })
        }
        tick()
        const timer = window.setInterval(tick, BALANCE_REFRESH_MS)
        const onVisible = () => {
          if (document.visibilityState === 'visible') tick()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          disposed = true
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [props.ctx])

      const at = new Date(now)
      const valley = isValley(at)
      const until = nextSwitch(at)
      return {
        valley,
        label: valley ? props.peakOffLabel : props.peakOnLabel,
        remaining: until === null ? '' : countdown(until.getTime() - now, props.countdownFormats),
        balanceText: balance === undefined ? '—' : (balance ?? '--'),
        balanceNote,
        balanceSource,
        spentText: spent,
        spentSource,
      }
    }

    /** Which path answered the balance read, in the active locale. */
    function balanceSourceText(props, source) {
      if (source === 'account') return props.balanceSourceAccount
      if (source === 'apikey') return props.balanceSourceKey
      return ''
    }

    /**
     * The hover text.
     *
     * Built from the parts, never from the panel's own heading: the heading is
     * "峰谷 · 余额", which already names the balance, so prefixing the tooltip with
     * it read as `峰谷 · 余额: … 余额 ¥20.79` — the same word twice, behind a
     * half-width colon. The numbers keep their labels and nothing else repeats.
     *
     * It holds no per-second value on purpose: a native `title` tooltip is torn
     * down whenever the attribute is rewritten, so a countdown in here made the
     * tooltip blink every second. The countdown lives in the visible text.
     *
     * @param props - this plugin's injected data.
     * @param status - the derived display state.
     * @returns the tooltip and accessible label.
     */
    function capsuleTooltip(props, status) {
      const parts = [status.label, `${props.balanceLabel} ${status.balanceText}`]
      if (status.spentText !== '') {
        // A ledger that fell back to this run is called out in one short word
        // rather than the whole reason, which belongs in the panel.
        const suffix = status.spentSource === 'run' ? props.spentUnpersisted : ''
        parts.push(`${props.spentLabel} ${status.spentText}${suffix}`)
      }
      // The failure note is the one thing the capsule can only show truncated.
      if (status.balanceNote !== '') parts.push(status.balanceNote)
      // Only promise a click when the shell can deliver one.
      parts.push(props.layoutScope() === null ? props.panelUnavailable : props.clickHint)
      return parts.join(' · ')
    }

    /**
     * The caption-strip capsule: the billing window with its countdown, the
     * balance, and today's observed spend. It is a button because it opens the
     * panel below; the seat around it stays transparent to the pointer so the
     * rest of the strip keeps dragging the window.
     *
     * @param props - the entry's own props plus this plugin's injected data.
     * @returns the seat and its capsule.
     */
    function StatusCapsule(props) {
      const status = useStatus(props)
      const title = capsuleTooltip(props, status)

      /**
       * Open this plugin's `main` panel.
       *
       * The shell's `layout` service is reached through the scope injected for it
       * (see the layout scope in the real mount), never off this ctx: cordis
       * refuses to read a service the plugin did not inject — the read throws —
       * so the earlier version's `ctx.layout` lookup made every click a silent
       * no-op. `layout.selectPanel` also throws when the id is not a live `main`
       * key, so the call is guarded: a click must never throw into React's event
       * handler.
       */
      const openPanel = () => {
        const scope = props.layoutScope()
        if (scope === null) return
        try {
          const layout = scope.layout
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID)
        } catch (error) {
          if (typeof console !== 'undefined' && typeof console.error === 'function') {
            console.error('[dsh-peak-bar] opening the details panel failed', error)
          }
        }
      }

      return h('div', { className: 'dshPeakBarSeat' },
        h('button', {
          type: 'button',
          className: 'dshPeakBarCapsule',
          title,
          'aria-label': title,
          onClick: openPanel,
        },
          h('span', { className: status.valley ? 'dshPeakBarCapsule__tag' : 'dshPeakBarCapsule__tag dshPeakBarCapsule__tag--peak' }, status.label),
          status.remaining === '' ? null : h('span', { className: 'dshPeakBarCapsule__time' }, status.remaining),
          // The numbers are labelled, the way the balance widgets read: a bare
          // amount next to a countdown is ambiguous.
          h('span', { className: 'dshPeakBarCapsule__label' }, props.balanceLabel),
          h('span', { className: 'dshPeakBarCapsule__money' }, status.balanceText),
          // Today's observed spend, hidden until a first drop is seen.
          status.spentText === '' ? null : h('span', { className: 'dshPeakBarCapsule__label' }, props.spentLabel),
          status.spentText === '' ? null : h('span', { className: 'dshPeakBarCapsule__spent' }, status.spentText),
          // The reason is rendered inline, not only in the tooltip: a lone `—`
          // cannot be told apart from "still loading", and the caption strip is
          // the only place the user is already looking.
          status.balanceNote === '' ? null : h('span', { className: 'dshPeakBarCapsule__note' }, status.balanceNote)))
    }

    /**
     * Capsule styles.
     *
     * Following the theme is the default, not an option: every colour variable
     * below resolves to a host theme token, so the capsule takes whatever the
     * active skin defines — its palette, its light / dark pair, its accent — and
     * needs no configuration to do it. The transition duration and easing come
     * from the theme's motion tokens for the same reason, and the focus ring is
     * the host's.
     *
     * The fallbacks are written **at the use site**, not as declarations of the
     * variables themselves. That is deliberate and load-bearing: the theme
     * projects `--dsw-alias-*` inline on `body`, so a custom property declared on
     * `html` would be resolved where those tokens do not exist yet and would come
     * out invalid — a `border` with no fallback then collapses to nothing, and the
     * capsule loses its outline. Resolved on the element itself, the fallback sees
     * the body-scoped tokens.
     *
     * Customising rides on top: no rule of ours declares `--dsh-peak-bar-*`, so any
     * rule that does — in a skin's `skin.css`, in a custom stylesheet, on `:root`,
     * on `body`, or on the capsule — wins outright, with no specificity fight.
     *
     * The seat is the full caption strip: `top:0` on an absolutely positioned
     * box resolves against the frame's padding box, which includes the strip
     * the frame reserves for the caption, so the capsule lands on the same row
     * as the native window controls. Its height follows the strip the shell
     * actually reserved — the Windows caption height when that marker is on the
     * document, the macOS top clearance otherwise — and in fullscreen, where no
     * strip is reserved, the capsule floats a few pixels below the top edge.
     */
    const CAPSULE_CSS = [
      '.dshPeakBarSeat{position:absolute;top:0;left:50%;transform:translateX(-50%);',
      'height:var(--dsh-windows-titlebar-height,var(--dsh-frame-top-clearance,48px));',
      'display:flex;align-items:center;justify-content:center;max-width:60%;',
      'pointer-events:none;-webkit-app-region:no-drag;z-index:1}',
      'html[data-fullscreen] .dshPeakBarSeat{top:6px;height:auto}',
      '.dshPeakBarCapsule{pointer-events:auto;-webkit-app-region:no-drag;',
      'display:inline-flex;align-items:center;gap:.4em;height:24px;padding:0 10px;',
      'box-sizing:border-box;',
      'border:.5px solid var(--dsh-peak-bar-border,var(--dsw-alias-border-l2));',
      'border-radius:var(--dsh-peak-bar-radius,999px);',
      'background:var(--dsh-peak-bar-bg,var(--dsw-alias-button-elevated-fill,transparent));',
      'color:var(--dsh-peak-bar-text,var(--dsw-alias-label-primary));',
      'font:inherit;font-size:var(--dsh-peak-bar-font-size,12px);line-height:1;',
      'cursor:pointer;white-space:nowrap;overflow:hidden;',
      'transition:background-color var(--ds-transition-duration,.12s) var(--ds-ease-in-out,ease)}',
      '.dshPeakBarCapsule:hover{background:var(--dsh-peak-bar-bg-hover,var(--dsw-alias-button-floating-hover))}',
      '.dshPeakBarCapsule:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px}',
      // Off-peak reads as the good state, so it takes the theme's success colour
      // (a skin that defines none keeps the neutral secondary label).
      '.dshPeakBarCapsule__tag{flex:none;font-weight:600;color:var(--dsh-peak-bar-offpeak,var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary)))}',
      '.dshPeakBarCapsule__tag--peak{color:var(--dsh-peak-bar-peak,var(--dsw-alias-brand-primary))}',
      '.dshPeakBarCapsule__time{flex:none;color:var(--dsh-peak-bar-countdown,var(--dsw-alias-label-tertiary));font-variant-numeric:tabular-nums}',
      '.dshPeakBarCapsule__label{flex:none;color:var(--dsh-peak-bar-label,var(--dsw-alias-label-tertiary))}',
      '.dshPeakBarCapsule__money{flex:none;color:var(--dsh-peak-bar-text,var(--dsw-alias-label-primary));font-variant-numeric:tabular-nums}',
      '.dshPeakBarCapsule__spent{flex:none;color:var(--dsh-peak-bar-spent,var(--dsw-alias-label-secondary));font-variant-numeric:tabular-nums}',
      '.dshPeakBarCapsule__note{flex:none;min-width:0;max-width:20em;overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;color:var(--dsh-peak-bar-note,var(--dsw-alias-label-tertiary));font-size:.92em}',
      '@media (prefers-reduced-motion:reduce){.dshPeakBarCapsule{transition:none}}',
    ].join('')

    /**
     * Panel styles. Same rule as the capsule: tokens only, no literal colours,
     * and no own typography — the panel inherits the host's body text.
     */
    const PANEL_CSS = [
      '.dshPeakBarPanel{padding:18px 20px;max-width:520px;color:var(--dsw-alias-label-primary)}',
      '.dshPeakBarPanel__head{display:flex;align-items:baseline;gap:8px;margin-bottom:12px}',
      '.dshPeakBarPanel__tag{font-weight:600;color:var(--dsh-peak-bar-offpeak,var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary)))}',
      '.dshPeakBarPanel__tag--peak{color:var(--dsh-peak-bar-peak,var(--dsw-alias-brand-primary))}',
      '.dshPeakBarPanel__title{color:var(--dsw-alias-label-tertiary)}',
      '.dshPeakBarPanel__rows{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0}',
      '.dshPeakBarPanel__rows dt{color:var(--dsw-alias-label-secondary)}',
      '.dshPeakBarPanel__rows dd{margin:0;font-variant-numeric:tabular-nums}',
      '.dshPeakBarPanel__note{margin:14px 0 0;color:var(--dsw-alias-label-tertiary);line-height:1.6}',
      '.dshPeakBarPanel__warn{margin:14px 0 0;color:var(--dsw-alias-label-secondary);line-height:1.6}',
    ].join('')

    const locale = {
      zh: {
        label: '峰谷 · 余额',
        peakOn: '高峰',
        peakOff: '谷时',
        next: '距切换',
        balance: '余额',
        rule: '高峰时段为北京时间周一至周五 9:00–12:00、14:00–18:00（不含法定节假日）；其余时段按空闲价计费，空闲价约为高峰价的一半。余额为充值余额与赠送余额之和。',
        countdownLong: '{h}小时{m}分',
        countdownShort: '{m}分{s}秒',
        spent: '今日已用',
        balanceSourceLabel: '余额来源',
        balanceSourceAccount: 'DeepSeek 账号登录',
        balanceSourceKey: 'API key',
        keyFailed: 'API key 余额不可用（{reason}）',
        keyUnavailable: '平台标记该账户余额不可用（is_available=false）',
        holidayStaleHint: '节假日表只覆盖到 2026-12-31：此后法定节假日会被当作工作日，峰谷判定可能不准，请更新表后重装。',
        spendSourceLabel: '今日已用来源',
        spendSourceHost: 'Host 账本（跨重启保留）',
        spendSourceRun: '本次运行（Host 账本不可用）',
        spentUnpersisted: '（未持久化）',
        spentHint: '“今日已用”按余额减少观测累计（充值/赠金不计入）。账本由 Host 写入 $DSH_HOME，跨重启保留；Host 不可用时退回本次运行统计。',
        clickHint: '点击查看详情',
        panelUnavailable: '详情面板暂不可用',
        reasonNoRemote: '账号 Remote 不可用（{detail}）',
        reasonCallFailed: '账号接口调用失败：{detail}',
        reasonNotReady: '账号未就绪（status={status}）',
        reasonNoWallet: '账号没有余额钱包',
        reasonNoAmount: '余额字段不可用（钱包里没有可读的金额）',
        reasonReadError: '余额读取异常：{detail}',
      },
      en: {
        label: 'Rate · balance',
        peakOn: 'Peak',
        peakOff: 'Off-peak',
        next: 'next in',
        balance: 'balance',
        rule: 'Peak billing is Beijing time Monday to Friday, 09:00-12:00 and 14:00-18:00, excluding Chinese public holidays. All other hours bill at the off-peak rate, about half of peak. The balance shown is topped-up plus granted credit.',
        countdownLong: '{h}h {m}m',
        countdownShort: '{m}m {s}s',
        spent: 'spent today',
        balanceSourceLabel: 'balance source',
        balanceSourceAccount: 'DeepSeek account sign-in',
        balanceSourceKey: 'API key',
        keyFailed: 'API key balance unavailable ({reason})',
        keyUnavailable: 'the platform marks this account balance as unavailable (is_available=false)',
        holidayStaleHint: 'The holiday table only covers up to 2026-12-31: after that a statutory holiday is treated as a working day, so the peak window can be wrong. Update the table and reinstall.',
        spendSourceLabel: 'spent today, source',
        spendSourceHost: 'host ledger (survives restarts)',
        spendSourceRun: 'this run (host ledger unavailable)',
        spentUnpersisted: ' (not persisted)',
        spentHint: '"Spent today" accumulates the drops between balance readings (top-ups and granted credit are not counted). The ledger lives in $DSH_HOME, written by the Host half, so it survives restarts; when the Host is unavailable the capsule falls back to counting this run only.',
        clickHint: 'click for details',
        panelUnavailable: 'the details panel is unavailable',
        reasonNoRemote: 'account Remote unavailable ({detail})',
        reasonCallFailed: 'account call failed: {detail}',
        reasonNotReady: 'account not ready (status={status})',
        reasonNoWallet: 'the account reports no balance wallet',
        reasonNoAmount: 'balance fields unreadable (no amount in the wallets)',
        reasonReadError: 'balance read failed: {detail}',
      },
    }

    /**
     * Insert this plugin's stylesheet once per document and return its remover.
     * The rules are presentation only, so one shared tag serves every entry and
     * the plugin's own context owns its lifetime.
     * @param doc - the document to style.
     * @returns a disposer that removes the tag it created.
     */
    function installStyles(doc) {
      const marker = 'data-dsh-peak-bar'
      if (doc.head.querySelector(`style[${marker}]`) !== null) return () => {}
      const tag = doc.createElement('style')
      tag.setAttribute(marker, '')
      tag.textContent = CAPSULE_CSS + PANEL_CSS
      doc.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    /**
     * The two lines the failure path can draw, per locale.
     *
     * They are carried here rather than read from the registered dictionaries:
     * the locale service is one of the things that may have thrown (binding it is
     * the first statement of the real mount), so the failure path cannot depend on
     * a dictionary having been registered. The language is still picked from the
     * active locale when that is readable.
     */
    const FAILURE_LINES = {
      zh: '峰谷·余额加载失败：{detail}',
      en: 'rate capsule failed to load: {detail}',
    }

    /**
     * A last-resort entry: anything that throws inside `apply` would otherwise
     * remove the plugin's only surface with no on-screen trace, leaving the user
     * to guess. This registers one plain overlay entry that states the failure.
     * @param ctx - the Client plugin context.
     * @param error - what went wrong.
     */
    function registerFailureCapsule(ctx, error) {
      const english = activeLocale(ctx).toLowerCase().startsWith('en')
      const message = fill(FAILURE_LINES[english ? 'en' : 'zh'], { detail: errText(error) })
      const Failure = () => h('div', { className: 'dshPeakBarSeat' },
        h('span', { className: 'dshPeakBarCapsule', title: message }, message))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: `${PANEL_ID}-failure`,
        order: 10,
        inject: () => ({}),
      }, Failure))
    }

    /**
     * Mount the plugin, and never mount nothing: a throw here is reported in the
     * caption strip instead of silently taking the capsule away.
     * @param ctx - the Client plugin context.
     */
    function apply(ctx) {
      try {
        applyWorking(ctx)
      } catch (error) {
        try {
          ctx.effect(() => installStyles(document), 'peak-bar: stylesheet (failure path)')
          registerFailureCapsule(ctx, error)
        } catch (secondary) {
          // Nothing left to draw with; the Host console carries the original.
          if (typeof console !== 'undefined' && typeof console.error === 'function') {
            console.error('[dsh-peak-bar]', error, secondary)
          }
        }
      }
    }

    /** The real mount; see {@link apply} for the failure contract. */
    function applyWorking(ctx) {
      const t = ctx.locale.bind(LOCALE_NS)

      /**
       * The context the account Remote is read through, once the shell provides
       * that service.
       *
       * `remote.account` is its own cordis service, not a member of `remote`, so
       * it has to be injected under that dotted name. Declaring it in the
       * plugin's top-level `inject` would instead hold the whole capsule
       * inactive in a profile without the account provider — losing the peak /
       * valley countdown, which needs nothing from the account — so the
       * dependency is scoped to the balance read and its absence becomes a note.
       */
      let accountScope = null
      if (typeof ctx.inject === 'function') {
        // Both names, mirroring the shipped account card's service list: the
        // member is reached through the container, so the container has to be in
        // the same scope as `remote.account` itself.
        ctx.inject(['remote', 'remote.account'], (scoped) => {
          scoped.effect(() => {
            accountScope = scoped
            return () => {
              accountScope = null
            }
          }, 'peak-bar: account scope')
        })
      }

      /**
       * The context the shell's `layout` service is reached through.
       *
       * The capsule opens this plugin's `main` panel with
       * `layout.selectPanel(key)`, where the key is the one the `main` slot
       * registration below uses. `layout` belongs to the shell, so it is injected
       * optionally rather than declared at the top level: a profile without the
       * layout package keeps the peak / valley capsule and only loses the click
       * target, which the tooltip then admits instead of promising a panel.
       */
      let layoutScope = null
      if (typeof ctx.inject === 'function') {
        ctx.inject(['layout'], (scoped) => {
          scoped.effect(() => {
            layoutScope = scoped
            return () => {
              layoutScope = null
            }
          }, 'peak-bar: layout scope')
        })
      }

      const injected = () => ({
        ctx,
        accountScope: () => accountScope,
        layoutScope: () => layoutScope,
        titleLabel: t('label'),
        peakOnLabel: t('peakOn'),
        peakOffLabel: t('peakOff'),
        nextLabel: t('next'),
        balanceLabel: t('balance'),
        ruleLabel: t('rule'),
        spentLabel: t('spent'),
        keyFailed: t('keyFailed'),
        keyUnavailable: t('keyUnavailable'),
        holidayStaleHint: t('holidayStaleHint'),
        balanceSourceLabel: t('balanceSourceLabel'),
        balanceSourceAccount: t('balanceSourceAccount'),
        balanceSourceKey: t('balanceSourceKey'),
        spendSourceLabel: t('spendSourceLabel'),
        spendSourceHost: t('spendSourceHost'),
        spendSourceRun: t('spendSourceRun'),
        spentUnpersisted: t('spentUnpersisted'),
        spentHint: t('spentHint'),
        clickHint: t('clickHint'),
        panelUnavailable: t('panelUnavailable'),
        countdownFormats: { long: t('countdownLong'), short: t('countdownShort') },
        reasons: {
          noRemote: t('reasonNoRemote'),
          callFailed: t('reasonCallFailed'),
          notReady: t('reasonNotReady'),
          noWallet: t('reasonNoWallet'),
          noAmount: t('reasonNoAmount'),
          readError: t('reasonReadError'),
        },
      })

      ctx.effect(() => ctx.locale.register(LOCALE_NS, locale), 'peak-bar: dictionaries')
      ctx.effect(() => installStyles(document), 'peak-bar: stylesheet')

      // The panel body registers first: opening the capsule selects its `main`
      // key, and the layout refuses a key with no registration.
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: LOCALE_NS,
        inject: injected,
      }, StatusPanel))

      // The capsule itself: the root frame's overlay list, whose layer covers
      // the caption strip, so the capsule shares the row with the window
      // controls. `order` keeps it ahead of any other overlay entry.
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: PANEL_ID,
        order: 10,
        locale: LOCALE_NS,
        inject: injected,
      }, StatusCapsule))
    }

    return {
      inject: ['slots', 'locale'],
      apply,
      // Exposed for the offline checks that pin the billing-window rules and the
      // spend readout format.
      testing: {
        isValley,
        nextSwitch,
        countdown,
        formatMoney,
        formatSpend,
        beijing,
        isHolidayTableStale,
        holidayTableLast: HOLIDAY_TABLE_LAST,
      },
    }
  },
})
