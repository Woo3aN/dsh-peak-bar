# dsh-rhine-statusbar

窗口标题栏正中一枚小胶囊：显示 DeepSeek API 的峰谷计费时段和账户余额，点击胶囊在主区域打开详情面板，读取失败时把失败原因直接写在胶囊上。

- 版本：0.3.0
- 许可：MIT
- 运行时不需要任何 npm 依赖。`peerDependencies` 里只有可选的 `react`：浏览器里的 React 由宿主提供，插件不打包 React。

## 它长什么样，放在哪

<!-- 截图：标题栏胶囊（待补） -->

胶囊显示当前是高峰还是空闲、距下次切换的倒计时，以及账户余额；倒计时精确到秒。点击胶囊会在主区域打开详情面板，面板里是峰谷状态、距下次切换的倒计时、余额和计费规则说明。

读取失败时胶囊不会静默显示 `--`，而是把原因直接写在上面，例如“账号 Remote 不可用”“账号未就绪（status=…）”“账号没有余额钱包”。

胶囊在窗口标题栏正中，在 Windows 上也和最小化/关闭按钮同一行。

为什么用标题栏：DSH 的窗口 chrome 座位 `shell.leading` 只在 macOS + 侧栏收起时才挂载，Windows 上没有标题栏槽位。本插件注册进 `shell.overlay`——根帧的覆盖层，`inset:0` 覆盖包含标题栏的 padding box——因此 Windows 上也能落在标题栏这一行。居中则是刻意的：shell 只发布了 `--dsh-windows-titlebar-height` 和 `--dsh-windows-menu-start`，没有发布原生按钮簇宽度，贴右侧只能写死内距。

胶囊是 `position:absolute`，座位 `pointer-events:none`，只有胶囊本身可点，并设了 `-webkit-app-region:no-drag`，所以标题栏其余部分仍然可以拖动窗口。

## 安装

三种入口任选一种，装完之后按“重启”一节操作。

### 桌面端：添加本地目录

插件 → 添加插件 → 填入本目录的绝对路径。

### 桌面端：添加打包后的 tgz

插件 → 添加插件 → 填入打包后 tgz 的绝对路径。

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
2. **API key**：账号路拿不到时（没登录、登录态失效、账号接口未就绪），改问 Host 半的 `/dsh-rhine-statusbar/balance`。Host 从 DSH 凭据服务解析 `DEEPSEEK_API_KEY`，直连官方 `GET https://api.deepseek.com/user/balance` 并只回传 `total_balance` 与币种。**密钥不出 Host、也不会发给除官方端点以外的任何地方。**

两条路口径一致（都是充值 + 赠金），所以“今日已用”的差额记账在切路时仍然正确。面板里会写明这次余额来自哪条路（`余额来源：DeepSeek 账号登录 / API key`）。

不把任何数据发往第三方；账号余额走 DSH 自己的账号服务，API key 余额只发往 DeepSeek 官方端点。

## 今日已用

账号接口给的是**余额**，不是账单，所以“今日已用”是按**余额下降**观测累计出来的：两次读取之间余额下降的差额算消费，余额上升（充值 / 赠金）不计入、也不会把已记的消费抹掉。按**北京时间日**分账，和官方计费日一致。

账本由 **Host 半**写在 `<DSH_HOME>/.dsh-rhine-statusbar.json`（默认 `~/.dsh/`）。放 Host 而不是放页面里，是因为桌面端每次启动的端口可能不同——端口一变，页面 origin 就变，`localStorage` 会被清空。文件里只保留最近 14 天的日汇总，写入是原子的（临时文件 + rename），文件损坏时当作空账本继续，不会影响插件运行。

Host 路由不可用时（例如没有 HTTP 载体的 profile），胶囊退回"本次运行统计"，并继续正常显示峰谷与余额——丢的是历史，不是功能。

显示口径：胶囊里两个数字都带标签、都不带符号 —— 形如 `谷时 18分57秒 余额 ¥20.79 今日已用 ¥0.20`，今日已用是两位小数（过小不足以显示两位时是 `<0.01`）；当日还没有消费时不显示“今日已用”那一段。详情面板里同样有这两行，并注明各自的来源与计算规则。

## 跟随主题与皮肤

**跟随是默认行为，不需要任何配置。** 胶囊的每个颜色变量的默认值都指向宿主的语义 token（`--dsw-alias-*`），所以它自动取当前皮肤的配色、深浅两套值与强调色；动效时长用主题的 `--ds-transition-duration` / `--ds-ease-in-out`，焦点环用宿主的 `--dsw-focus-ring-*`，系统开启"减少动态效果"时过渡自动关闭。本插件的样式表里**不含任何颜色字面值**（这一点有回归测试钉住），因此不存在"某个皮肤下颜色跑偏"的情况。

自定义是叠在其上的一层，不是替代：覆盖任意几个变量即可，其余继续跟皮肤走。

## 自定义颜色

本插件**不声明** `--dsh-rhine-*` 自身，只在用到的地方写成 `var(--dsh-rhine-x, 主题 token)`。这一点是刻意的：主题把 `--dsw-alias-*` 以内联变量挂在 **`body`** 上，若把 `--dsh-rhine-x` 声明在 `html` 上，它就会在"那些 token 还不存在"的元素上求值而变成非法值——边框这种没有 fallback 的属性会直接消失（早期版本正是这样丢掉描边的）。写在使用处则由那枚按钮求值，能看见 body 上的 token。也正因我们不声明任何变量，**任何覆盖都直接生效**：皮肤的 `skin.css`、自定义样式表、`:root`、`body`、胶囊元素本身，都不必和本文件比优先级。

| 变量 | 作用 | 默认值 |
|---|---|---|
| `--dsh-rhine-bg` | 胶囊底色 | `var(--dsw-alias-button-elevated-fill, transparent)` |
| `--dsh-rhine-bg-hover` | 悬停底色 | `var(--dsw-alias-button-floating-hover)` |
| `--dsh-rhine-border` | 描边 | `var(--dsw-alias-border-l2)` |
| `--dsh-rhine-text` | 金额等主文字 | `var(--dsw-alias-label-primary)` |
| `--dsh-rhine-offpeak` | "谷时"标签（取主题的成功色，即绿色） | `var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))` |
| `--dsh-rhine-peak` | "高峰"标签 | `var(--dsw-alias-brand-primary)` |
| `--dsh-rhine-countdown` | 倒计时数字 | `var(--dsw-alias-label-tertiary)` |
| `--dsh-rhine-label` | “余额 / 今日已用”标签 | `var(--dsw-alias-label-tertiary)` |
| `--dsh-rhine-spent` | 今日已用金额 | `var(--dsw-alias-label-secondary)` |
| `--dsh-rhine-note` | 失败原因文字 | `var(--dsw-alias-label-tertiary)` |
| `--dsh-rhine-radius` | 圆角 | `999px` |
| `--dsh-rhine-font-size` | 字号 | `12px` |

### 皮肤作者接入

皮肤想接管胶囊外观时，只覆盖差异部分即可 —— 下面这段让胶囊改用皮肤自己的侧栏底色、直角风格与品牌强调色：

```css
/* 你的 skin.css */
:root {
  /* 底色跟着标题栏那条带子走，而不是用一个泛化的浮起色 */
  --dsh-rhine-bg: var(--dsw-specific-sidebar-fill, transparent);
  --dsh-rhine-border: var(--dsw-alias-border-l3);
  /* 直角皮肤：胶囊也切成直角。圆角档位不是每个皮肤都定义，
     所以给一个字面量兜底 —— 只写 var(--dsw-radius-sm) 的话，
     皮肤没定义这个 token 时整条声明会变成非法值而失效。 */
  --dsh-rhine-radius: var(--dsw-radius-sm, 4px);
  /* 强调色仍是皮肤的品牌色，只是换个 token */
  --dsh-rhine-peak: var(--dsw-alias-brand-primary);
}
```

只改几个变量时不必写全表：没提到的继续跟随皮肤。**引用皮肤 token 时一律带字面量兜底**（`var(--dsw-xxx, 兜底值)`）——莱茵生命皮肤里就有若干 token（例如 `--dsw-radius-*`）并未定义。

### 示例一：莱茵生命默认橙

```css
:root {
  --dsh-rhine-bg: #2a1a10cc;
  --dsh-rhine-border: #ff8a3d55;
  --dsh-rhine-peak: #ff9d4d;
  --dsh-rhine-text: #ffe9d2;
}
```

### 示例二：纯灰高对比

```css
:root {
  --dsh-rhine-bg: #101010;
  --dsh-rhine-border: #ffffff;
  --dsh-rhine-text: #ffffff;
  --dsh-rhine-radius: 6px;
}
```

### 示例三：冷色青

```css
:root {
  --dsh-rhine-bg: #06222a;
  --dsh-rhine-border: #1de9b644;
  --dsh-rhine-peak: #35e0d0;
  --dsh-rhine-countdown: #7fd7d0;
}
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

## 许可

MIT。版权署名见 [LICENSE](LICENSE)：`Copyright (c) 2026 Woo3aN`。
