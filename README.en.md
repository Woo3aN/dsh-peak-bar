# dsh-peak-bar

One small capsule centred in the window title bar: it shows the DeepSeek API peak/off-peak billing windows and the account balance. Click the capsule to open a details panel in the main area; when the read fails, the capsule writes the reason on itself.

- Version: 0.3.0
- License: MIT
- No npm dependency at runtime. `peerDependencies` holds only the optional `react`: the browser gets React from the host, the plugin does not bundle React.

## What it looks like, and where it sits

![The capsule in the title bar (a real capture, default skin): the billing window, its countdown, the balance and today's spend, with the minimize / maximize / close buttons to its right](docs/capsule.png)

The capsule shows whether the current window is peak or off-peak, the countdown to the next switch, and the account balance; the countdown is accurate to the second. Clicking the capsule opens a details panel in the main area with the peak/off-peak state, the countdown to the next switch, the balance, and an explanation of the billing rules; **the ✕ in its top-right corner returns to the conversation**.

![The details panel: the billing window, the countdown, the balance and today's spend, plus both sources and the billing rule](docs/panel.png)

> Both images are real captures; **the amounts and the countdown in them are illustrative** (the real balance and spend were replaced), everything else is untouched.

A failed read is never silent:

- **Before any value has ever been read**, the capsule says “balance read failed” — a bare `--` needs its explanation.
- **Once a value is on screen**, the last number stays and only a failure that **lasts past two minutes** is marked, in two words (“余额未刷新” / “balance not refreshed”). The platform reports a transient blip as `status=failed` too, and those blips come back all day, which is why the grace is measured in minutes.
- A missing API key reads as “no API key configured”: a configuration fact, not an error.

**The full reason always lives in the tooltip and the details panel** (“账号未就绪（status=failed）”, “账号 Remote 不可用”). A platform reason runs to dozens of characters, and writing it across the caption strip pushed the capsule past the window edge where it was clipped — so the strip carries a short phrase instead.

While reads are failing the retry backs off — **15s, then 30s, then 60s** — so a short blip is repaired at once without knocking on the platform all day; when the browser reports the network back (`online`) or the window becomes visible again the plugin retries at once, so a real outage still repairs itself within seconds.

The capsule lands in the centre of the window's title bar — on Windows that is the same row as the minimize / close buttons, to their left (no overlap, nothing covered). The image above is a real capture (a 150%-scaled 2115px screen), in which the capsule's centre measures at **49.9%**.

Why the title bar: DSH's window chrome seat `shell.leading` is mounted only on macOS with the sidebar collapsed, and Windows has no title-bar slot. This plugin registers into `shell.overlay` — the root frame's overlay layer, `inset:0` over the padding box that contains the title bar — so it lands on the title-bar row on Windows too. The seat asks for the centre with `left:50%` + `translateX(-50%)`; the exact seat comes from the overlay box the shell provides, and the "Position" section below shows how to pin it down.

The capsule is `position:absolute` and the seat is `pointer-events:none`; only the capsule itself is clickable and it sets `-webkit-app-region:no-drag`, so the rest of the title bar still drags the window.

## Installation

Pick one of the three entry points, then follow “Restart” below.

### Clone from GitHub

```bash
git clone https://github.com/Woo3aN/dsh-peak-bar.git
cd dsh-peak-bar
npm test          # optional: three offline suites, no DSH runtime needed
```

Then use “add a local directory” below and point it at the cloned folder.

### Desktop: add a local directory

Plugins → Add plugin → enter the absolute path of this directory.

### Desktop: add a packed tgz

Plugins → Add plugin → enter the absolute path of the packed tgz.
(Pack it yourself with `npm pack`; the artifact is `dsh-peak-bar-<version>.tgz`.)

### Command line

```bash
dsh plugin --profile web add "<absolute path of this directory, or package name>"
```

Then reload.

### Restart: refreshing the page is not enough

- Changing the Host half (`index.js`) requires a full DSH process restart.
- Changing only `client.js` also requires a restart: the Host snapshots the client artifact into memory when the plugin activates.

## Peak and off-peak rules

- Peak: Beijing time, Monday to Friday 09:00–12:00 and 14:00–18:00, statutory holidays excluded.
- Every other window is off-peak, at roughly half the peak price.
- The countdown is accurate to the second.
- For how far the holiday table reaches, see “Known limitations”.

## Data source and privacy

The balance has **two paths**, tried in order:

1. **Account sign-in**: `ctx.remote.account.getBalance()` — the same path as the account and balance settings card DSH ships with. The answer has two layers: `{ok, value}`, where `value` is `{status, value: top-up wallets[], bonusWallets: bonus wallets[]}`. Balance = top-up + bonus; multiple currencies are shown separately and joined with ` + `.
2. **API key**: when the account path cannot answer (not signed in, expired sign-in, account service not ready), the page asks the Host half at `/dsh-peak-bar/balance`. The Host resolves `DEEPSEEK_API_KEY` from the DSH credential service, calls the official `GET https://api.deepseek.com/user/balance`, and returns only `total_balance` and its currency. **The key never leaves the Host, and nothing is sent anywhere except the official endpoint.**

Both paths report the same quantity (top-up plus granted credit), so the spend ledger keeps folding correctly when the source switches. The panel names which path answered (`balance source: DeepSeek account sign-in / API key`).

Nothing is sent to a third party; the account balance goes through DSH's own account service, and the API-key balance only to DeepSeek's official endpoint.

## Spent today

The account API reports a **balance**, not a bill, so "spent today" is inferred from **balance drops**: the difference between two readings that went down counts as consumption, while a rise (a top-up or granted credit) is not counted and never cancels spend already recorded. Days are split on the Beijing calendar, matching the official billing day.

The ledger is written by the **Host half** to `<DSH_HOME>/.dsh-peak-bar.json` (default `~/.dsh/`). It lives in the Host rather than the page because a Desktop launch can pick a different port — a different port means a different page origin, and `localStorage` would be wiped with it. The file keeps the last 14 days of daily totals, is written atomically (temp file plus rename), and a corrupted file is treated as an empty ledger instead of breaking the plugin.

When the Host route is unavailable — a profile with no HTTP carrier, for instance — the capsule falls back to counting this run only, and keeps showing the peak window and balance as usual: what is lost is history, not the feature.

Readout: both numbers in the capsule carry a label and no sign — `谷时 18分57秒 余额 ¥20.79 今日已用 ¥0.20` (the labels follow the UI language) — with today's spend at two decimals (`<0.01` when it is too small to round to a cent); before anything is spent that segment is hidden. The detail panel carries the same two rows plus each one's source and rule.

## Following the theme and the skin

**Following is the default, and it needs no configuration.** Every colour variable defaults to a host semantic token (`--dsw-alias-*`), so the capsule takes the active skin's palette, its light and dark pair and its accent colour on its own. Motion uses the theme's `--ds-transition-duration` / `--ds-ease-in-out`, the focus ring is the host's `--dsw-focus-ring-*`, and `prefers-reduced-motion` turns the transition off. The plugin's stylesheet contains **no colour literal of its own** — a regression check pins that — so no skin can leave the capsule painted in the wrong palette.

Customising is a layer on top, not a replacement: override a few variables and the rest keeps following the skin.

## Custom colours

The plugin declares none of the `--dsh-peak-bar-*` variables itself; it only reads them at the point of use, as `var(--dsh-peak-bar-x, <theme token>)`. That is deliberate: the theme projects `--dsw-alias-*` inline on **`body`**, so a `--dsh-peak-bar-x` declared on `html` would be resolved on an element where those tokens do not exist yet and would come out invalid — a property without a fallback, such as `border`, then disappears outright, which is exactly how an earlier build lost its outline. Read on the element itself, the fallback sees the body-scoped tokens. Declaring nothing also means **any override applies as-is**: your skin's `skin.css`, a custom stylesheet, `:root`, `body`, or the capsule element itself — no specificity contest with this file.

| Variable | Purpose | Default |
|---|---|---|
| `--dsh-peak-bar-bg` | capsule background | `var(--dsw-alias-button-elevated-fill, transparent)` |
| `--dsh-peak-bar-bg-hover` | hover background | `var(--dsw-alias-button-floating-hover)` |
| `--dsh-peak-bar-border` | border | `var(--dsw-alias-border-l2)` |
| `--dsh-peak-bar-text` | primary text (amounts) | `var(--dsw-alias-label-primary)` |
| `--dsh-peak-bar-offpeak` | the "谷时" tag (the theme's success colour, i.e. green) | `var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))` |
| `--dsh-peak-bar-peak` | "高峰" tag | `var(--dsw-alias-brand-primary)` |
| `--dsh-peak-bar-countdown` | countdown digits | `var(--dsw-alias-label-tertiary)` |
| `--dsh-peak-bar-label` | the "余额 / 今日已用" labels | `var(--dsw-alias-label-tertiary)` |
| `--dsh-peak-bar-spent` | today's spend amount | `var(--dsw-alias-label-secondary)` |
| `--dsh-peak-bar-note` | failure reason text | `var(--dsw-alias-label-tertiary)` |
| `--dsh-peak-bar-radius` | corner radius | `999px` |
| `--dsh-peak-bar-font-size` | font size | `12px` |

### For skin authors

A skin that wants to own the capsule only overrides the differences — this one paints it from the skin's own sidebar fill, squares it off, and keeps the brand accent:

```css
/* your skin.css */
:root {
  /* take the caption strip's own fill instead of a generic elevated surface */
  --dsh-peak-bar-bg: var(--dsw-specific-sidebar-fill, transparent);
  --dsh-peak-bar-border: var(--dsw-alias-border-l3);
  /* a square-cornered skin squares the capsule too. Not every skin defines a
     radius step, so keep a literal fallback: a bare var(--dsw-radius-sm)
     resolves to nothing there and the whole declaration is dropped. */
  --dsh-peak-bar-radius: var(--dsw-radius-sm, 4px);
  /* the accent is still the skin's brand colour, just re-pointed */
  --dsh-peak-bar-peak: var(--dsw-alias-brand-primary);
}
```

Anything you leave out keeps following the skin. **Always give a skin token a literal fallback** (`var(--dsw-xxx, <fallback>)`): the Rhine Life skin, for one, leaves several tokens undefined — `--dsw-radius-*` among them.

### Example 1: Rhine Life default orange

```css
:root {
  --dsh-peak-bar-bg: #2a1a10cc;
  --dsh-peak-bar-border: #ff8a3d55;
  --dsh-peak-bar-peak: #ff9d4d;
  --dsh-peak-bar-text: #ffe9d2;
}
```

### Example 2: plain grey, high contrast

```css
:root {
  --dsh-peak-bar-bg: #101010;
  --dsh-peak-bar-border: #ffffff;
  --dsh-peak-bar-text: #ffffff;
  --dsh-peak-bar-radius: 6px;
}
```

### Example 3: cool cyan

```css
:root {
  --dsh-peak-bar-bg: #06222a;
  --dsh-peak-bar-border: #1de9b644;
  --dsh-peak-bar-peak: #35e0d0;
  --dsh-peak-bar-countdown: #7fd7d0;
}
```

## Position

Where the capsule lands is decided by the shell's `shell.overlay` layer (see the measurement under "What it looks like, and where it sits"). To pin it yourself, override the seat's positioning — **the class names are not a public contract and may change, so verify after an update**:

```css
/* a true window centre: a fixed box is positioned against the viewport, not the overlay's box */
.dshPeakBarSeat { position: fixed; left: 50%; right: auto; transform: translateX(-50%) }

/* or flush against the window buttons: 132px is their width at 100% scaling, and it changes with it */
.dshPeakBarSeat { position: absolute; left: auto; right: 132px; transform: none }
```

## Known limitations

- A failure reason appears only when **both** paths are unusable (not signed in *and* no `DEEPSEEK_API_KEY` in the credentials); the panel then lists each path's own reason.
- The account read happens on the Host side; the plugin polls every 60 seconds, and refreshes immediately once the page becomes visible again.
- The statutory holiday table covers 2026 only (source: the General Office of the State Council notice on the 2026 public holiday arrangement). From 2027 onwards the table must be extended, otherwise holidays are counted as peak.
- Exercised only on the official Windows desktop client with DSH 0.2.0-rc.2; macOS/Linux and pure browser mode are untested. In pure browser mode there is no title bar, so the capsule floats centred at the top of the app.
- The client version sent in the request is `'unknown'`: the official DSH client inlines `DSH_CLIENT_VERSION` at build time, a third-party plugin cannot read it and falls back (works in practice).
- "Spent today" is an **estimate inferred from balance differences**, not a platform bill: it cannot see spending that does not move the balance, and it covers no other provider's channels; a balance increase is always read as a top-up and never as negative spend.
- That ledger writes a file on this machine only and makes no network request; without the Host route it degrades to counting this run (see the previous section).

## Development and tests

```bash
node tests/peak.test.mjs
node tests/render.test.mjs
node tests/host.test.mjs
```

- `tests/peak.test.mjs`: peak/off-peak rules, 7 cases.
- `tests/render.test.mjs`: rendering, injection, theme defaults, clicks, and the Host ledger round trip; runs offline with a stand-in React and a stand-in module loader, and never touches the real vault.
- `tests/host.test.mjs`: the Host ledger (accounting rule, validation, trust fence, corrupted file); uses a temporary `DSH_HOME` and never touches the real `~/.dsh`.

## Acknowledgements

This plugin's approach owes a direct debt to the following projects and implementations:

- **[dsh-whale-widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)** (MeteorNOX) — the split where the Host owns the credentials and the ledger while the client only displays, and the accounting rule behind "spent today" (accumulating observed balance drops), both follow its approach; so does the idea of a separate API-key balance path.
- **[dsh-plugin-rhine-lab-theme](https://github.com/Galaxy-2001/Rhine-Lab-Codex-Theme)** (Galaxy-2001) — this plugin was developed and verified under that skin, and "follows the skin" is measured against the semantic tokens and light/dark pairs it defines.
- **DSH's own account and balance settings card** (`@deepseek-ai/dsh-client-ui-settings-account`) — the balance read path, its two-layer answer (`{ok, value}` wrapping `{status, value, bonusWallets}`), and the fact that `remote.account` is a service of its own next to `remote`, were all confirmed against that client artifact.

The plugin bundles no third-party code or artwork: `icon.svg` belongs to this project.

## License

MIT. The attribution lives in [LICENSE](LICENSE): `Copyright (c) 2026 Woo3aN`.
