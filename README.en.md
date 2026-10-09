# dsh-peak-bar

**English** | [简体中文](README.md)

> ⚠️ **Pre-release** — the version is still `0.x`: CSS variable names and the file layout may change.

**One small capsule centred in the window title bar: the peak/off-peak window, the countdown to the next switch, the balance, and today's spend.**

A DSH plugin. Click the capsule to open a details panel in the main area. Colours follow the active skin by default — the stylesheet holds **no colour literal**, every variable falls back to a host semantic token (`--dsw-alias-*`), and overriding means touching only the few you care about.

---

## Appearance and placement

![The capsule in the title bar: the billing window, its countdown, the balance and today's spend, with the minimize / maximize / close buttons to its right](docs/capsule.png)

![A close-up of the capsule](docs/capsule-closeup.png)

![The details panel](docs/panel.png)

> The captures show the Chinese UI; the amounts and the countdown in them are **illustrative values** — the real data has been replaced.

- The capsule shows the billing window, the countdown and the balance. The countdown **reads to the minute while more than an hour remains** (`59h 24m`) and to the second within the final hour (`18m 57s`).
- Clicking it opens the details panel in the main area; the `✕` in its top-right corner returns to the conversation.
- It sits at the centre of the title bar, on the same line as the minimize / close buttons on Windows and to their left (the centre measures at 49.9%).
- The seat is `pointer-events:none`: only the capsule is clickable, and the rest of the title bar still drags the window.
- It registers into `shell.overlay`, not `shell.leading` — the latter only mounts on macOS with the sidebar collapsed, and Windows has no title-bar slot.

### When a read fails

- **Nothing read yet**: the capsule writes a short reason instead of a silent `--`.
- **A value already read**: the last numbers stay, and only a failure lasting **more than 2 minutes** raises the two-word marker "not refreshed".
- **No API key configured**: it says just "no API key configured" — a configuration fact, not an error.
- The full reason always lives in the tooltip and the details panel (the capsule is narrow; a long reason would push it past the window edge).
- Retries back off **15s → 30s → 60s** (the normal poll is 60s); a restored network or a visible window retries at once.

## Installation

| Route | How |
|-------|-----|
| Release asset | Download `dsh-peak-bar-<version>.zip`, unpack, then point at that folder |
| Clone | `git clone https://github.com/Woo3aN/dsh-peak-bar.git` |
| Local directory | Plugins → Add plugin → enter the absolute path |
| tgz | `npm pack`, then "add plugin → tgz" |
| Command line | `dsh plugin --profile web add "<path or package name>"` |

**A full DSH process restart is required** after any change — refreshing the page is not enough: the Host snapshots the client artifact into memory when the plugin activates.

## Peak and off-peak rules

| Window (Beijing time) | Billing |
|------|------|
| Monday–Friday 09:00–12:00 and 14:00–18:00 | peak price |
| everything else | off-peak, roughly half the peak price |
| statutory holidays | off-peak all day |

## Balance and privacy

Two paths, tried in order, reporting the same quantity (top-up + granted credit):

| Order | Path | Detail |
|-------|------|--------|
| ① | **Signed-in account** | `ctx.remote.account.getBalance()` — the same path DSH's own "Account & balance" card uses. The return is two-layered, `{ok, value}`, where `value` is `{status, value: topUpWallets[], bonusWallets[]}` |
| ② | **API key** | When the account path cannot answer, the Host's `/dsh-peak-bar/balance` is asked. The Host resolves `DEEPSEEK_API_KEY` from the DSH credential service and calls the official endpoint directly — **only the total and its currency come back; the key never leaves the Host** |

Nothing goes to any third party. The panel states which path the balance came from.

## Spent today

The account API returns a balance, not a bill, so today's spend is accumulated by observing **balance drops**: the difference between two readings counts as spend when the balance falls, a rising balance (top-up / granted credit) is neither counted nor allowed to erase what was already recorded, and days are split by Beijing time.

The Host half writes the ledger to `<DSH_HOME>/.dsh-peak-bar.json` (by default `~/.dsh/`), keeping the last 14 days, writing atomically, and treating a corrupted file as an empty ledger. It lives on the Host because the desktop client picks a different port each launch, and a changed origin wipes `localStorage`. Without the Host route it falls back to counting this run — **what is lost is history, not function**.

## Language

The plugin has **no language switch of its own** — it follows DSH's UI language:

> DSH **Settings → General → Language** → `中文` / `English`

The dictionaries are registered under the plugin's own namespace; both `zh` and `en` carry the full key set and `zh` falls back to `en`. Switching needs no reinstall and no restart. The plugin card's title and description come from `locale/zh.json` / `locale/en.json`.

## Custom colours

The plugin **declares no** `--dsh-peak-bar-*` of its own — it writes `var(--dsh-peak-bar-x, theme token)` at the point of use. That is deliberate: the theme attaches `--dsw-alias-*` to `body`, so a declaration on `html` would resolve on elements where those tokens do not exist yet and collapse to an invalid value (an early version lost its outline exactly this way). As a result **any override just works**, with no specificity contest.

| Variable | Purpose | Default |
|----------|---------|---------|
| `--dsh-peak-bar-bg` | capsule fill | `var(--dsw-alias-button-elevated-fill, transparent)` |
| `--dsh-peak-bar-bg-hover` | fill on hover | `var(--dsw-alias-button-floating-hover)` |
| `--dsh-peak-bar-border` | outline | `var(--dsw-alias-border-l2)` |
| `--dsh-peak-bar-text` | amounts and other primary text | `var(--dsw-alias-label-primary)` |
| `--dsh-peak-bar-offpeak` | the off-peak tag | `var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))` |
| `--dsh-peak-bar-peak` | the peak tag | `var(--dsw-alias-brand-primary)` |
| `--dsh-peak-bar-countdown` | the countdown digits | `var(--dsw-alias-label-tertiary)` |
| `--dsh-peak-bar-label` | the balance / spent-today labels | `var(--dsw-alias-label-tertiary)` |
| `--dsh-peak-bar-spent` | the spent-today amount | `var(--dsw-alias-label-secondary)` |
| `--dsh-peak-bar-note` | failure-reason text | `var(--dsw-alias-label-tertiary)` |
| `--dsh-peak-bar-radius` | corner radius | `999px` |
| `--dsh-peak-bar-font-size` | font size | `12px` |

You do not need the whole table when changing a few variables: anything left out keeps following the skin. **Always give a skin token a literal fallback** (`var(--dsw-xxx, <fallback>)`) — the Rhine Life skin, for one, leaves several tokens undefined, `--dsw-radius-*` among them.

```css
/* for skin authors: take over only the differences */
:root {
  --dsh-peak-bar-bg: var(--dsw-specific-sidebar-fill, transparent);
  --dsh-peak-bar-border: var(--dsw-alias-border-l3);
  --dsh-peak-bar-radius: var(--dsw-radius-sm, 4px);
  --dsh-peak-bar-peak: var(--dsw-alias-brand-primary);
}

/* three ready-made palettes, pick one */
:root { --dsh-peak-bar-bg:#2a1a10cc; --dsh-peak-bar-border:#ff8a3d55; --dsh-peak-bar-peak:#ff9d4d; --dsh-peak-bar-text:#ffe9d2 }  /* Rhine Life orange */
:root { --dsh-peak-bar-bg:#101010;   --dsh-peak-bar-border:#ffffff;   --dsh-peak-bar-text:#ffffff; --dsh-peak-bar-radius:6px }  /* plain grey, high contrast */
:root { --dsh-peak-bar-bg:#06222a;   --dsh-peak-bar-border:#1de9b644; --dsh-peak-bar-peak:#35e0d0; --dsh-peak-bar-countdown:#7fd7d0 }  /* cool cyan */
```

## Position

To pin the position yourself, override the seat class — **the class name is not a public contract and may change, so verify it yourself**:

```css
.dshPeakBarSeat { position: fixed; left: 50%; right: auto; transform: translateX(-50%) }  /* genuinely window-centred */
.dshPeakBarSeat { position: absolute; left: auto; right: 132px; transform: none }         /* hard against the buttons */
```

---

## Layout

```
dsh-peak-bar/
├── index.js            ★ Host half: local routes + atomic ledger + API-key balance path
├── client.js           ★ Client half: capsule, details panel, dictionaries, styles
├── cordis.patch.yml    bundle patch registering the plugin into a profile
├── package.json        manifest (dsh.bundle / dsh.client)
├── icon.svg            icon
├── locale/             plugin-card metadata (zh / en)
├── docs/               real captures used by the READMEs
├── tests/              three offline suites (peak / render / host)
├── .github/workflows/  test.yml (three platforms × Node 20/22), release.yml (packing on a tag)
└── README / CHANGELOG / LICENSE
```

Self-check: `npm test` — all three suites run offline, and `host` uses a temporary `DSH_HOME`, never your real `~/.dsh`.

## Known limitations

- A failure reason appears only when **both** paths are unusable; the panel then lists each path's own reason.
- The account read happens on the Host side and polls every **60 seconds**; a visible window refreshes it at once.
- **The statutory holiday table covers 2026 only** — from 2027 it must be extended, otherwise holidays count as peak (the panel says so).
- Exercised only on the **official Windows client with DSH 0.2.0-rc.2**; macOS / Linux and pure browser mode are untested.
- "Spent today" is an **estimate** inferred from balance differences, not a platform bill, and covers no other provider's channels.
- The client version in requests is `'unknown'`: the official client inlines it at build time and a third-party plugin cannot read it.

---

## Design choices

- **Follow first, override optionally**: every default points at a host semantic token; the plugin invents no palette of its own.
- **A failure has to speak**: two words beat a silent `--`, and the full reason moves somewhere with room.
- **State lives on the Host; the page only displays**: the port changes, the origin changes, `localStorage` cannot be trusted.

## Contributing

Issues and PRs are welcome — especially **colour problems you hit under your own skin** and **new holiday tables**.

## Acknowledgements

- [dsh-whale-widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) — the split where the Host owns credentials and the ledger, the balance-drop accounting rule, and the idea of a separate API-key path.
- [dsh-plugin-rhine-lab-theme](https://github.com/Galaxy-2001/Rhine-Lab-Codex-Theme) — the criteria for "follows the skin" are taken from the semantic tokens and light/dark pairs it defines.
- DSH's own "Account & balance" card — the balance read path and return shape.

`icon.svg` is this project's own; no third-party code or artwork is bundled.

## License

MIT © Woo3aN — see [LICENSE](LICENSE).
