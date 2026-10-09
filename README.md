# dsh-peak-bar

窗口标题栏上的一枚小胶囊：显示 DeepSeek API 的峰谷计费时段、账户余额与今日已用，点击胶囊在主区域打开详情面板，读取失败时把失败原因直接写在胶囊上。颜色跟随当前皮肤，也可以自己覆盖。

- 版本：0.3.0
- 许可：MIT
- 运行时不需要任何 npm 依赖。`peerDependencies` 里只有可选的 `react`：浏览器里的 React 由宿主提供，插件不打包 React。

## 它长什么样，放在哪

![标题栏上的胶囊（默认皮肤）：峰谷状态、距下次切换的倒计时、余额与今日已用](docs/capsule.png)

胶囊显示当前是高峰还是空闲、距下次切换的倒计时，以及账户余额；倒计时精确到秒。点击胶囊会在主区域打开详情面板，面板里是峰谷状态、距下次切换的倒计时、余额和计费规则说明，**右上角的叉号可以退回对话**。

读取失败时不会静默：

- **还没读到过任何数值**时，胶囊写一句「余额读取失败」——一个光秃秃的 `--` 必须带解释。
- **已经有数值**时保留上次的数字，只有失败**持续超过 2 分钟**才挂一个短标记「余额未刷新」。平台把瞬时抖动也报成 `status=failed`，而这种抖动一天里会反复出现，所以宽限按分钟计。
- 未配置 API key 时只说「未配置 API key」——这是配置事实，不是错误。

**完整原因始终在悬停提示与详情面板里**（例如“账号未就绪（status=failed）”“账号 Remote 不可用”）。胶囊本来就窄，平台原因动辄几十个字，写上去会把胶囊撑出窗口边缘被截断，所以那里只放短句。

失败期间重试节奏是 **15 秒 → 30 秒 → 60 秒**递退（正常间隔 60 秒），既能在短暂抖动后迅速修好，也不会长时间高频敲平台；浏览器报告网络恢复（`online`）或窗口重新可见时**立刻重试**，所以断网恢复后几秒内就会自愈。

胶囊落在窗口顶部那一行，在 Windows 上和最小化/关闭按钮同一行、位于它们左侧（不重叠、不遮挡）。

为什么用标题栏：DSH 的窗口 chrome 座位 `shell.leading` 只在 macOS + 侧栏收起时才挂载，Windows 上没有标题栏槽位。本插件注册进 `shell.overlay`——根帧的覆盖层，`inset:0` 覆盖包含标题栏的 padding box——因此 Windows 上也能落在标题栏这一行。

座位用 `left:50%` + `translateX(-50%)` 表达“居中”。**实测说明**：在 1423px 宽的窗口里，胶囊中心落在约 73% 处而不是 50%（截图 `docs/capsule.png` 可量），也就是说这个覆盖层的实际包含块比整窗窄、且不左对齐。README 只如实描述落点（同一行、按钮左侧），不解释机制；想要严格的居中或紧贴按钮，可以覆盖 `--dsh-peak-bar-*` 之外的定位——见下面“自定义颜色”一节末尾的定位说明。

胶囊是 `position:absolute`，座位 `pointer-events:none`，只有胶囊本身可点，并设了 `-webkit-app-region:no-drag`，所以标题栏其余部分仍然可以拖动窗口。

## 安装

三种入口任选一种，装完之后按“重启”一节操作。

### 从 GitHub 克隆

```bash
git clone https://github.com/Woo3aN/dsh-peak-bar.git
cd dsh-peak-bar
npm test          # 可选：三套离线测试，不需要 DSH 运行时
```

然后按下面的“添加本地目录”，填入克隆下来的目录绝对路径。

### 桌面端：添加本地目录

插件 → 添加插件 → 填入本目录的绝对路径。

### 桌面端：添加打包后的 tgz

插件 → 添加插件 → 填入打包后 tgz 的绝对路径。
（自己打包：`npm pack`，产物为 `dsh-peak-bar-<版本>.tgz`。）

### 命令行

```bash
dsh plugin --profile web add "<本目录绝对路径或包名>"
```

然后重载。

### 重启：刷新页面不够

- 改 Host 半（`index.js`）必须整进程重启 DSH。
- 只改 `client.js` 也要重启才能换：Host 在插件激活时把客户端产物快照进内存。

## 峰谷规则

- 高峰：北京时间周一至周五 09:00–12:00、14:00–18:00，不含法定节假日。
- 其余时段为空闲价，约为高峰价的一半。
- 倒计时精确到秒。
- 节假日表的覆盖范围见“已知限制”。

## 数据来源与隐私

余额有**两条路**，按顺序尝试：

1. **账号登录态**：`ctx.remote.account.getBalance()`，和 DSH 自带“账号与余额”设置卡片同一条路。返回值是两层的：`{ok, value}`，其中 `value` 是 `{status, value: 充值钱包[], bonusWallets: 赠金钱包[]}`。余额 = 充值 + 赠金，多币种分别显示，并用 ` + ` 连接。
2. **API key**：账号路拿不到时（没登录、登录态失效、账号接口未就绪），改问 Host 半的 `/dsh-peak-bar/balance`。Host 从 DSH 凭据服务解析 `DEEPSEEK_API_KEY`，直连官方 `GET https://api.deepseek.com/user/balance` 并只回传 `total_balance` 与币种。**密钥不出 Host、也不会发给除官方端点以外的任何地方。**

两条路口径一致（都是充值 + 赠金），所以“今日已用”的差额记账在切路时仍然正确。面板里会写明这次余额来自哪条路（`余额来源：DeepSeek 账号登录 / API key`）。

不把任何数据发往第三方；账号余额走 DSH 自己的账号服务，API key 余额只发往 DeepSeek 官方端点。

## 今日已用

账号接口给的是**余额**，不是账单，所以“今日已用”是按**余额下降**观测累计出来的：两次读取之间余额下降的差额算消费，余额上升（充值 / 赠金）不计入、也不会把已记的消费抹掉。按**北京时间日**分账，和官方计费日一致。

账本由 **Host 半**写在 `<DSH_HOME>/.dsh-peak-bar.json`（默认 `~/.dsh/`）。放 Host 而不是放页面里，是因为桌面端每次启动的端口可能不同——端口一变，页面 origin 就变，`localStorage` 会被清空。文件里只保留最近 14 天的日汇总，写入是原子的（临时文件 + rename），文件损坏时当作空账本继续，不会影响插件运行。

Host 路由不可用时（例如没有 HTTP 载体的 profile），胶囊退回"本次运行统计"，并继续正常显示峰谷与余额——丢的是历史，不是功能。

显示口径：胶囊里两个数字都带标签、都不带符号 —— 形如 `谷时 18分57秒 余额 ¥20.79 今日已用 ¥0.20`，今日已用是两位小数（过小不足以显示两位时是 `<0.01`）；当日还没有消费时不显示“今日已用”那一段。详情面板里同样有这两行，并注明各自的来源与计算规则。

## 跟随主题与皮肤

**跟随是默认行为，不需要任何配置。** 胶囊的每个颜色变量的默认值都指向宿主的语义 token（`--dsw-alias-*`），所以它自动取当前皮肤的配色、深浅两套值与强调色；动效时长用主题的 `--ds-transition-duration` / `--ds-ease-in-out`，焦点环用宿主的 `--dsw-focus-ring-*`，系统开启"减少动态效果"时过渡自动关闭。本插件的样式表里**不含任何颜色字面值**（这一点有回归测试钉住），因此不存在"某个皮肤下颜色跑偏"的情况。

自定义是叠在其上的一层，不是替代：覆盖任意几个变量即可，其余继续跟皮肤走。

## 自定义颜色

本插件**不声明** `--dsh-peak-bar-*` 自身，只在用到的地方写成 `var(--dsh-peak-bar-x, 主题 token)`。这一点是刻意的：主题把 `--dsw-alias-*` 以内联变量挂在 **`body`** 上，若把 `--dsh-peak-bar-x` 声明在 `html` 上，它就会在"那些 token 还不存在"的元素上求值而变成非法值——边框这种没有 fallback 的属性会直接消失（早期版本正是这样丢掉描边的）。写在使用处则由那枚按钮求值，能看见 body 上的 token。也正因我们不声明任何变量，**任何覆盖都直接生效**：皮肤的 `skin.css`、自定义样式表、`:root`、`body`、胶囊元素本身，都不必和本文件比优先级。

| 变量 | 作用 | 默认值 |
|---|---|---|
| `--dsh-peak-bar-bg` | 胶囊底色 | `var(--dsw-alias-button-elevated-fill, transparent)` |
| `--dsh-peak-bar-bg-hover` | 悬停底色 | `var(--dsw-alias-button-floating-hover)` |
| `--dsh-peak-bar-border` | 描边 | `var(--dsw-alias-border-l2)` |
| `--dsh-peak-bar-text` | 金额等主文字 | `var(--dsw-alias-label-primary)` |
| `--dsh-peak-bar-offpeak` | "谷时"标签（取主题的成功色，即绿色） | `var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))` |
| `--dsh-peak-bar-peak` | "高峰"标签 | `var(--dsw-alias-brand-primary)` |
| `--dsh-peak-bar-countdown` | 倒计时数字 | `var(--dsw-alias-label-tertiary)` |
| `--dsh-peak-bar-label` | “余额 / 今日已用”标签 | `var(--dsw-alias-label-tertiary)` |
| `--dsh-peak-bar-spent` | 今日已用金额 | `var(--dsw-alias-label-secondary)` |
| `--dsh-peak-bar-note` | 失败原因文字 | `var(--dsw-alias-label-tertiary)` |
| `--dsh-peak-bar-radius` | 圆角 | `999px` |
| `--dsh-peak-bar-font-size` | 字号 | `12px` |

### 皮肤作者接入

皮肤想接管胶囊外观时，只覆盖差异部分即可 —— 下面这段让胶囊改用皮肤自己的侧栏底色、直角风格与品牌强调色：

```css
/* 你的 skin.css */
:root {
  /* 底色跟着标题栏那条带子走，而不是用一个泛化的浮起色 */
  --dsh-peak-bar-bg: var(--dsw-specific-sidebar-fill, transparent);
  --dsh-peak-bar-border: var(--dsw-alias-border-l3);
  /* 直角皮肤：胶囊也切成直角。圆角档位不是每个皮肤都定义，
     所以给一个字面量兜底 —— 只写 var(--dsw-radius-sm) 的话，
     皮肤没定义这个 token 时整条声明会变成非法值而失效。 */
  --dsh-peak-bar-radius: var(--dsw-radius-sm, 4px);
  /* 强调色仍是皮肤的品牌色，只是换个 token */
  --dsh-peak-bar-peak: var(--dsw-alias-brand-primary);
}
```

只改几个变量时不必写全表：没提到的继续跟随皮肤。**引用皮肤 token 时一律带字面量兜底**（`var(--dsw-xxx, 兜底值)`）——莱茵生命皮肤里就有若干 token（例如 `--dsw-radius-*`）并未定义。

### 示例一：莱茵生命默认橙

```css
:root {
  --dsh-peak-bar-bg: #2a1a10cc;
  --dsh-peak-bar-border: #ff8a3d55;
  --dsh-peak-bar-peak: #ff9d4d;
  --dsh-peak-bar-text: #ffe9d2;
}
```

### 示例二：纯灰高对比

```css
:root {
  --dsh-peak-bar-bg: #101010;
  --dsh-peak-bar-border: #ffffff;
  --dsh-peak-bar-text: #ffffff;
  --dsh-peak-bar-radius: 6px;
}
```

### 示例三：冷色青

```css
:root {
  --dsh-peak-bar-bg: #06222a;
  --dsh-peak-bar-border: #1de9b644;
  --dsh-peak-bar-peak: #35e0d0;
  --dsh-peak-bar-countdown: #7fd7d0;
}
```

## 位置

胶囊的落点由 shell 的 `shell.overlay` 覆盖层决定（见上面“它长什么样，放在哪”里的实测说明）。想自己钉住位置，就覆盖座位类的定位——**注意类名不是公开契约，改版可能变，请自行验证**：

```css
/* 真·整窗居中：position:fixed 的包含块是视口，不受覆盖层盒子影响 */
.dshPeakBarSeat { position: fixed; left: 50%; right: auto; transform: translateX(-50%) }

/* 或者紧贴窗口按钮左侧：132px ≈ 100% 缩放下的三枚按钮宽度，缩放后会变 */
.dshPeakBarSeat { position: absolute; left: auto; right: 132px; transform: none }
```

## 已知限制

- 账号路与 API key 路**都不可用**时才会显示失败原因（例如既没登录账号、凭据里也没有 `DEEPSEEK_API_KEY`）；面板会同时列出两条路各自的原因。
- 账户读取由 Host 侧完成，插件按 60 秒轮询；页面重新可见时会立即刷新一次。
- 法定节假日表只覆盖 2026 年（来源：国务院办公厅关于 2026 年部分节假日安排的通知）；2027 年起需要补表，否则节假日会被算成高峰。
- 只在 Windows 官方桌面客户端 + DSH 0.2.0-rc.2 实测过；macOS/Linux 与纯浏览器模式未测。纯浏览器模式下没有标题栏，胶囊会浮在应用顶部居中。
- 请求里带的客户端版本是 `'unknown'`：DSH 官方客户端在构建时内联 `DSH_CLIENT_VERSION`，第三方插件拿不到，只能兜底（实测可用）。
- “今日已用”是按余额差观测的**推算值**，不是平台账单：它看不到余额之外的花费（例如赠金消耗与充值在观测口径下会互相抵消的部分），也不含其他厂商渠道的消费；“余额上升”一律视为充值、不计为负消费。
- 该账本只在本机写文件，不联网；Host 路由不可用时退化为“本次运行统计”（见上一节）。

## 开发与测试

```bash
node tests/peak.test.mjs
node tests/render.test.mjs
node tests/host.test.mjs
```

- `tests/peak.test.mjs`：峰谷规则，7 项。
- `tests/render.test.mjs`：渲染、注入、主题默认值、点击、Host 账本往返；离线跑，用替身 React 与替身模块加载器，不碰真实 vault。
- `tests/host.test.mjs`：Host 账本（记法、校验、信任栅栏、损坏文件）；用临时 `DSH_HOME`，不碰真实 `~/.dsh`。

## 致谢

这个插件的做法直接受益于以下项目与实现：

- **[dsh-whale-widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)**（MeteorNOX）——“Host 持有凭据与账本、客户端只负责显示”这套分工，以及“今日已用 = 余额下降观测累计”的记账口径，都参照了它的做法；API key 余额这条路的思路也来自它。
- **[dsh-plugin-rhine-lab-theme](https://github.com/Galaxy-2001/Rhine-Lab-Codex-Theme)**（Galaxy-2001）——本插件就是在该皮肤下开发与验证的，“跟随皮肤”的判据（语义 token 与深浅两套值）以它定义的为准。
- **DSH 自带的“账号与余额”设置卡片**（`@deepseek-ai/dsh-client-ui-settings-account`）——余额的读取路径、返回结构（外层 `{ok, value}`、内层 `{status, value, bonusWallets}`），以及“`remote.account` 是独立于 `remote` 的服务名”这一点，都是从它的客户端产物里核对出来的。

本插件不打包任何第三方代码或美术素材：`icon.svg` 为本项目自有。

## 许可

MIT。版权署名见 [LICENSE](LICENSE)：`Copyright (c) 2026 Woo3aN`。
