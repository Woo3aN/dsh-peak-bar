# dsh-peak-bar

**English** | [简体中文](README.md)

> ⚠️ **Pre-release** — the version is still `0.x`: CSS variable names and the file layout may change, and the interface is not frozen.

**A small capsule centred in the window title bar: the DeepSeek API peak/off-peak window, the countdown to the next switch, the account balance, and today's spend.**

A plugin for DSH (DeepSeek Harness). Click the capsule to open a details panel in the main area; when a read fails it does not go quiet — it writes the reason on the capsule. Colours **follow the active skin by default**, and every one of them can be overridden.

> **The stylesheet contains no colour literal of its own.** Every colour variable defaults to a host semantic token (`--dsw-alias-*`), so the capsule takes the active skin's palette, its light and dark pair and its accent colour on its own. Override only the few variables you care about; the rest keep following the skin. A regression check pins this, so no skin can leave the capsule painted in the wrong palette.

---

## Appearance and placement

![The capsule in the title bar (a real capture, default skin): the billing window, its countdown, the balance and today's spend, with the minimize / maximize / close buttons to its right](docs/capsule.png)

![A close-up of the capsule](docs/capsule-closeup.png)

The capsule shows whether the current window is peak or off-peak, the countdown to the next switch, and the account balance. The countdown **reads to the minute while more than an hour remains** (`59h 24m`) and **only gains seconds within the final hour** (`18m 57s`). Clicking the capsule opens a details panel in the main area with the peak/off-peak state, the countdown to the next switch, the balance, today's spend and an explanation of the billing rules; **the `✕` in its top-right corner returns to the conversation**.

![The details panel: the billing window, the countdown, the balance and today's spend, plus both sources and the billing rule](docs/panel.png)

> These captures were taken with the **Chinese UI** (the labels shown are the `zh` dictionary; the `en` dictionary renders "Off-peak / balance / spent today"). The amounts and the countdown in them are **illustrative values** — the real balance and spend have been replaced — and everything else is untouched.

The capsule sits at the centre of the window title bar, on the same line as the minimize / close buttons on Windows and to their left (no overlap, no occlusion). The image above is a real capture (150% display scaling, 2115px wide); the capsule centre measures at **49.9%**.

**Why the title bar**: DSH's window-chrome seat `shell.leading` only mounts on macOS with the sidebar collapsed — Windows has no title-bar slot. This plugin registers into `shell.overlay`, the root frame's overlay layer, whose `inset:0` covers the padding box including the title bar, so it lands on that line on Windows too. The seat centres with `left:50%` + `translateX(-50%)`; the exact position is decided by the overlay box the shell hands out — see [Position](#position) to pin it yourself.

The capsule is `position:absolute`, the seat is `pointer-events:none`, only the capsule itself is clickable, and it sets `-webkit-app-region:no-drag`, so the rest of the title bar still drags the window.

### When a read fails

- **Nothing has been read yet** — the capsule writes a short reason such as "balance read failed". A bare `--` must come with an explanation.
- **A value has been read before** — the last numbers stay, and only a failure lasting **more than 2 minutes** raises the two-word marker "not refreshed". The platform reports brief hiccups as `status=failed` too, and those recur through the day, so the grace period is measured in minutes.
- **No API key configured** — the capsule says "no API key configured": that is a configuration fact, not an error.

**The full reason always lives in the tooltip and the details panel** (for example "account not ready (status=failed)", "account Remote unavailable"). The capsule is narrow and a platform reason runs to dozens of characters, so writing it there pushed the capsule past the window edge where it was clipped — the capsule carries a short phrase instead.

Retries back off **15s → 30s → 60s** during a failure (the normal interval is 60s), so a brief hiccup heals quickly without hammering the platform. When the browser reports the network is back (`online`) or the window becomes visible again, it retries at once — so a dropped connection heals within seconds.

---

## Installation

Pick one of the five entry points, then follow [Restart](#restart-refreshing-the-page-is-not-enough).

### 1. Clone from GitHub

```bash
git clone https://github.com/Woo3aN/dsh-peak-bar.git
cd dsh-peak-bar
npm test          # optional: three offline suites, no DSH runtime needed
```

Then use "add a local directory" below and point it at the cloned folder.

### 2. Extract and use (Release asset)

Download `dsh-peak-bar-<version>.zip` from [Releases](https://github.com/Woo3aN/dsh-peak-bar/releases), unpack it to get a `dsh-peak-bar/` directory, then use "add a local directory". The same Release also carries `dsh-peak-bar-<version>.tgz`, which goes through "add a packed tgz".

### 3. Desktop: add a local directory

Plugins → Add plugin → enter the absolute path of this directory.

### 4. Desktop: add a packed tgz

Plugins → Add plugin → enter the absolute path of the packed tgz.
(Pack it yourself with `npm pack`; the artifact is `dsh-peak-bar-<version>.tgz`.)

### 5. Command line

```bash
dsh plugin --profile web add "<absolute path of this directory, or package name>"
```

### Restart: refreshing the page is not enough

- Changing the Host half (`index.js`) **requires a full DSH process restart**.
- Changing only `client.js` also requires a restart: the Host snapshots the client artifact into memory when the plugin activates.

---

## Peak and off-peak rules

| Window | Billing |
|--------|---------|
| Beijing time, Monday–Friday 09:00–12:00 and 14:00–18:00 | peak price |
| everything else | off-peak, roughly half the peak price |
| statutory holidays | off-peak all day |

The countdown **reads to the minute while more than an hour remains**, and to the second within the final hour. The holiday table's coverage is listed under [Known limitations](#known-limitations).

---

## Data source and privacy

The balance has **two paths**, tried in order:

| Order | Path | How it reads |
|-------|------|--------------|
| ① | **Signed-in account** | `ctx.remote.account.getBalance()` — the same path DSH's own "Account & balance" settings card uses |
| ② | **API key** | when the account path cannot answer, the page asks the Host half at `/dsh-peak-bar/balance` |

**About path ①'s return shape**: it is two-layered, `{ok, value}`, where `value` is `{status, value: topUpWallets[], bonusWallets[]}`. Balance = top-up + granted credit, multiple currencies shown separately and joined with ` + `.

**About path ②**: the Host resolves `DEEPSEEK_API_KEY` from the DSH credential service, calls the official `GET https://api.deepseek.com/user/balance`, and returns only `total_balance` and its currency. **The key never leaves the Host, and nothing is sent anywhere except the official endpoint.**

Both paths report the same quantity (top-up plus granted credit), so the "spent today" ledger keeps folding correctly whichever one answers. The panel states which path the balance came from (`balance source: DeepSeek account / API key`).

**No data goes to any third party.** The account balance goes through DSH's own account service; the API-key balance only ever goes to DeepSeek's official endpoint.

---

## Spent today

The account API returns a **balance**, not a bill, so "spent today" is accumulated by observing **balance drops**:

- the difference between two readings counts as spend when the balance falls
- a rising balance (top-up / granted credit) is **not** counted, and never erases spend already recorded
- days are split by **Beijing time**, matching the official billing day

The ledger is written by the **Host half** to `<DSH_HOME>/.dsh-peak-bar.json` (by default `~/.dsh/`). It lives on the Host rather than in the page because the desktop client picks a different port on each launch — and when the port changes the page origin does too, which wipes `localStorage`. The file keeps only the last **14 days** of daily totals, writes atomically (temp file + rename), and treats a corrupted file as an empty ledger rather than failing.

Without the Host route (a profile with no HTTP carrier, say), the capsule falls back to counting this run and keeps showing the billing window and balance — **what is lost is history, not function**.

**Display**: both numbers in the capsule carry labels and no sign — for example `Off-peak 18m 57s balance ¥20.79 spent today ¥0.20`. Today's spend is shown to two decimals (or `<0.01` when too small to show two); the "today's spend" segment is omitted entirely when there has been no spend yet.

---

## Following the theme and the skin

**Following is the default, and it needs no configuration.** Every colour variable defaults to a host semantic token (`--dsw-alias-*`), so the capsule takes the active skin's palette, its light and dark pair and its accent colour on its own. Motion uses the theme's `--ds-transition-duration` / `--ds-ease-in-out`, the focus ring is the host's `--dsw-focus-ring-*`, and `prefers-reduced-motion` turns the transition off.

Customising rides on top rather than replacing: override any few variables and the rest keep following the skin.

## Custom colours

The plugin **declares no** `--dsh-peak-bar-*` of its own; it only writes `var(--dsh-peak-bar-x, theme token)` where it is used. That is deliberate: the theme attaches `--dsw-alias-*` as inline variables on **`body`**, so declaring `--dsh-peak-bar-x` on `html` would make it resolve on elements where those tokens do not exist yet and collapse to an invalid value — and a property with no fallback such as `border` simply disappears (an early version lost its outline exactly this way). Written at the point of use, it resolves on that button, which can see the tokens on `body`.

And because we declare nothing, **any override just works**: the skin's `skin.css`, a custom stylesheet, `:root`, `body`, the capsule element itself — none of them has to out-specify this file.

| Variable | Purpose | Default |
|----------|---------|---------|
| `--dsh-peak-bar-bg` | capsule fill | `var(--dsw-alias-button-elevated-fill, transparent)` |
| `--dsh-peak-bar-bg-hover` | fill on hover | `var(--dsw-alias-button-floating-hover)` |
| `--dsh-peak-bar-border` | outline | `var(--dsw-alias-border-l2)` |
| `--dsh-peak-bar-text` | amounts and other primary text | `var(--dsw-alias-label-primary)` |
| `--dsh-peak-bar-offpeak` | the off-peak tag (the theme's success colour, i.e. green) | `var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))` |
| `--dsh-peak-bar-peak` | the peak tag | `var(--dsw-alias-brand-primary)` |
| `--dsh-peak-bar-countdown` | the countdown digits | `var(--dsw-alias-label-tertiary)` |
| `--dsh-peak-bar-label` | the balance / spent-today labels | `var(--dsw-alias-label-tertiary)` |
| `--dsh-peak-bar-spent` | the spent-today amount | `var(--dsw-alias-label-secondary)` |
| `--dsh-peak-bar-note` | failure-reason text | `var(--dsw-alias-label-tertiary)` |
| `--dsh-peak-bar-radius` | corner radius | `999px` |
| `--dsh-peak-bar-font-size` | font size | `12px` |

### For skin authors

A skin that wants to take over the capsule's look need only override the differences — this makes the capsule use the skin's own sidebar fill, a square-cornered style and its brand accent:

```css
/* your skin.css */
:root {
  /* the fill follows the title-bar strip rather than a generic elevated colour */
  --dsh-peak-bar-bg: var(--dsw-specific-sidebar-fill, transparent);
  --dsh-peak-bar-border: var(--dsw-alias-border-l3);
  /* a square-cornered skin: cut the capsule square too. Not every skin defines a
     radius step, so keep a literal fallback: a bare var(--dsw-radius-sm)
     collapses to an invalid value when the token is missing, and the whole
     declaration is dropped. */
  --dsh-peak-bar-radius: var(--dsw-radius-sm, 4px);
  /* the accent stays the skin's brand colour, just a different token */
  --dsh-peak-bar-peak: var(--dsw-alias-brand-primary);
}
```

You do not need the whole table when changing only a few variables: anything you leave out keeps following the skin. **Always give a skin token a literal fallback** (`var(--dsw-xxx, <fallback>)`): the Rhine Life skin, for one, leaves several tokens undefined — `--dsw-radius-*` among them.

### Examples

| Theme | Look |
|-------|------|
| Rhine Life default orange | dark brown fill, orange outline, bright orange peak tag |
| Plain grey, high contrast | pure black fill, white outline, no chroma |
| Cool cyan | deep teal fill, cyan accent |

```css
/* 1. Rhine Life default orange */
:root {
  --dsh-peak-bar-bg: #2a1a10cc;
  --dsh-peak-bar-border: #ff8a3d55;
  --dsh-peak-bar-peak: #ff9d4d;
  --dsh-peak-bar-text: #ffe9d2;
}

/* 2. plain grey, high contrast */
:root {
  --dsh-peak-bar-bg: #101010;
  --dsh-peak-bar-border: #ffffff;
  --dsh-peak-bar-text: #ffffff;
  --dsh-peak-bar-radius: 6px;
}

/* 3. cool cyan */
:root {
  --dsh-peak-bar-bg: #06222a;
  --dsh-peak-bar-border: #1de9b644;
  --dsh-peak-bar-peak: #35e0d0;
  --dsh-peak-bar-countdown: #7fd7d0;
}
```

## Position

The capsule's position is decided by the shell's `shell.overlay` layer (see the measurements under [Appearance and placement](#appearance-and-placement)). To pin it yourself, override the seat class — **note that the class name is not a public contract and may change; verify it yourself**:

```css
/* genuinely window-centred: a position:fixed containing block is the viewport,
   so the overlay box does not affect it */
.dshPeakBarSeat { position: fixed; left: 50%; right: auto; transform: translateX(-50%) }

/* or hard against the left of the window buttons: 132px ≈ the three buttons at
   100% scaling, and it changes with the scale factor */
.dshPeakBarSeat { position: absolute; left: auto; right: 132px; transform: none }
```

---

## Layout

```
dsh-peak-bar/
├── index.js              ★ Host half: local routes + atomic ledger + API-key balance path
├── client.js             ★ Client half: capsule, details panel, dictionaries, styles
├── cordis.patch.yml      bundle patch that registers the plugin into a profile
├── package.json          manifest (dsh.bundle / dsh.client declarations)
├── icon.svg              plugin icon
├── locale/
│   ├── zh.json           plugin-card metadata (Chinese)
│   └── en.json           plugin-card metadata (English)
├── docs/                 real captures referenced by the READMEs
├── tests/
│   ├── peak.test.mjs     peak/off-peak rules, 7 cases
│   ├── render.test.mjs   rendering / injection / theme defaults / clicks / ledger round trip (offline, stand-in React)
│   └── host.test.mjs     the Host ledger (accounting, validation, trust fence, corrupted file), 28 cases
├── .github/workflows/
│   ├── test.yml          runs the tests on three platforms × Node 20/22
│   └── release.yml       packs zip + tgz onto a Release when a tag is pushed
├── README.md / README.en.md
├── CHANGELOG.md
└── LICENSE               MIT
```

## Self-check

```bash
npm test
```

All three suites run **offline**: `render` uses a stand-in React and a stand-in module loader, and `host` uses a temporary `DSH_HOME` — neither touches your real `~/.dsh`.

`.github/workflows/test.yml` runs this suite on **ubuntu + windows + macos × Node 20/22**.

---

## Known limitations

- A failure reason appears only when **both** paths are unusable (not signed in *and* no `DEEPSEEK_API_KEY` in the credentials); the panel then lists each path's own reason.
- The account read happens on the Host side; the plugin polls every **60 seconds**, and refreshes immediately once the page becomes visible again.
- **The statutory holiday table covers 2026 only** (source: the General Office of the State Council notice on the 2026 public holiday arrangement). From 2027 onwards the table must be extended, otherwise holidays are counted as peak. Past the covered range the panel says the verdict may be off.
- Exercised only on the **official Windows desktop client with DSH 0.2.0-rc.2**; macOS/Linux and pure browser mode are untested. In pure browser mode there is no title bar, so the capsule floats centred at the top of the app.
- The client version sent in the request is `'unknown'`: the official DSH client inlines `DSH_CLIENT_VERSION` at build time, a third-party plugin cannot read it and falls back (works in practice).
- "Spent today" is an **estimate inferred from balance differences**, not a platform bill: it cannot see spending that does not move the balance, and it covers no other provider's channels; a balance increase is always read as a top-up and never as negative spend.
- That ledger writes a file on this machine only and makes no network request; without the Host route it degrades to counting this run.

---

## Design choices

- **Follow first, override optionally.** Every default points at a host semantic token; the plugin invents no palette of its own. Customisation rides on top rather than replacing.
- **A failure has to speak.** Better a two-word marker than a silent `--` — but the marker stays two words, and the full reason moves somewhere with room.
- **State lives on the Host; the page only displays.** The port changes, the origin changes, `localStorage` cannot be trusted.
- **Credentials do not leave the Host.** The API key is resolved in-process and sent only to the official endpoint.

## Contributing

Issues and PRs are welcome. Two kinds especially: **colour problems you hit under your own skin**, and **new holiday tables** (after the State Council publishes each year's arrangement).

## Acknowledgements

This plugin's approach owes directly to:

| Project | What was borrowed |
|---------|-------------------|
| [dsh-whale-widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) (MeteorNOX) | the split where the Host owns the credentials and the ledger while the client only displays; the accounting rule behind "spent today" (accumulating observed balance drops); the idea of a separate API-key balance path |
| [dsh-plugin-rhine-lab-theme](https://github.com/Galaxy-2001/Rhine-Lab-Codex-Theme) (Galaxy-2001) | the criteria for "follows the skin" (semantic tokens and light/dark pairs) are taken from what it defines; this plugin was developed and verified under that skin |
| DSH's own "Account & balance" settings card (`@deepseek-ai/dsh-client-ui-settings-account`) | the balance read path, the return shape (`{ok, value}` outside, `{status, value, bonusWallets}` inside), and the fact that `remote.account` is a service separate from `remote` |

The plugin bundles no third-party code or artwork: `icon.svg` is its own.

## License

MIT © Woo3aN — see [LICENSE](LICENSE).
