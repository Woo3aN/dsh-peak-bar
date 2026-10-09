# dsh-peak-bar

**简体中文** | [English](README.en.md)

> ⚠️ **测试版（pre-release）** —— 版本号仍是 `0.x`，CSS 变量名与文件结构可能变动。

**窗口标题栏正中一枚小胶囊：峰谷时段、距下次切换的倒计时、账户余额、今日已用。**

DSH 插件。点胶囊在主区域打开详情面板。颜色默认跟随当前皮肤 —— 样式表里**没有任何颜色字面值**，
每个变量都回退到宿主的语义 token（`--dsw-alias-*`），自定义只需覆盖要改的那几个。

---

## 外观与位置

![标题栏上的胶囊：峰谷状态、倒计时、余额与今日已用，右侧是最小化/最大化/关闭按钮](docs/capsule.png)

![胶囊特写](docs/capsule-closeup.png)

![详情面板](docs/panel.png)

> 截图为中文界面；图中金额与倒计时是**示意值**，真实数据已替换。

- 胶囊显示峰谷状态、倒计时、余额；**倒计时剩余超过一小时时只到分钟**（`59小时24分`），
  最后一小时内到秒（`18分57秒`）。
- 点击胶囊在主区域打开详情面板，右上角 `✕` 退回对话。
- 落在标题栏正中，Windows 上与最小化/关闭按钮同一行、位于其左侧（实测中心在 49.9%）。
- 座位 `pointer-events:none`，只有胶囊可点，标题栏其余部分仍可拖动窗口。
- 用 `shell.overlay` 而非 `shell.leading`：后者只在 macOS + 侧栏收起时挂载，Windows 上没有槽位。

### 读取失败时

- **还没读到过数值**：胶囊写一句短原因，不静默显示 `--`。
- **已经有数值**：保留旧值，失败**持续超过 2 分钟**才挂两字标记「余额未刷新」。
- **未配置 API key**：只说「未配置 API key」——这是配置事实，不是错误。
- 完整原因始终在悬停提示与详情面板里（胶囊窄，长原因会把它撑出窗口）。
- 重试按 **15s → 30s → 60s** 递退（正常 60s 轮询）；网络恢复或窗口重新可见时立刻重试。

## 安装

| 方式 | 做法 |
|------|------|
| Release 附件 | 下载 `dsh-peak-bar-<版本>.zip` 解压，再指向该目录 |
| 克隆 | `git clone https://github.com/Woo3aN/dsh-peak-bar.git` |
| 本地目录 | 插件 → 添加插件 → 填目录绝对路径 |
| tgz | `npm pack` 后走「添加插件 → tgz」 |
| 命令行 | `dsh plugin --profile web add "<路径或包名>"` |

**改完必须整进程重启 DSH**，刷新页面不够：Host 在插件激活时把客户端产物快照进内存。

## 峰谷规则

| 时段（北京时间） | 计费 |
|------|------|
| 周一至周五 09:00–12:00、14:00–18:00 | 高峰价 |
| 其余时段 | 空闲价，约为高峰价的一半 |
| 法定节假日 | 全天按空闲价 |

## 余额与隐私

两条路按顺序尝试，口径一致（充值 + 赠金）：

| 顺序 | 路径 | 说明 |
|------|------|------|
| ① | **账号登录态** | `ctx.remote.account.getBalance()`，与 DSH 自带「账号与余额」同一条路。返回是两层 `{ok, value}`，`value` 形如 `{status, value: 充值钱包[], bonusWallets: 赠金钱包[]}` |
| ② | **API key** | 账号路不可用时问 Host 的 `/dsh-peak-bar/balance`；Host 从 DSH 凭据服务解析 `DEEPSEEK_API_KEY` 直连官方端点，**只回传总额与币种，密钥不出 Host** |

不往任何第三方发数据。面板里会写明这次余额来自哪条路。

## 今日已用

账号接口给的是余额、不是账单，所以按**余额下降**观测累计：两次读取之间余额跌的差额算消费，
余额上升（充值/赠金）不计入也不抹除已记消费，按北京时间日分账。

账本由 Host 半写在 `<DSH_HOME>/.dsh-peak-bar.json`（默认 `~/.dsh/`），只留最近 14 天，原子写，
文件损坏时当空账本继续。放 Host 是因为桌面端每次启动端口可能不同、origin 一变 `localStorage` 就被清空。
Host 路由不可用时退回「本次运行统计」——丢的是历史，不是功能。

## 语言

**没有自己的语言开关**，跟随 DSH 的界面语言：

> DSH **设置 → 通用 → 语言** → `中文` / `English`

词典注册在插件自己的命名空间，`zh` / `en` 键齐全且 `zh` 回退到 `en`。切换无需重装或重启。
插件卡片的标题与描述来自 `locale/zh.json` / `locale/en.json`。

## 自定义颜色

插件**不声明** `--dsh-peak-bar-*` 自身，只在用到的地方写 `var(--dsh-peak-bar-x, 主题 token)`。
这是刻意的：主题把 `--dsw-alias-*` 挂在 `body` 上，若在 `html` 上声明，就会在 token 尚不存在的
元素上求值成非法值（早期版本正是这样丢掉描边）。因此**任何覆盖都直接生效**，不必比优先级。

| 变量 | 作用 | 默认值 |
|------|------|--------|
| `--dsh-peak-bar-bg` | 胶囊底色 | `var(--dsw-alias-button-elevated-fill, transparent)` |
| `--dsh-peak-bar-bg-hover` | 悬停底色 | `var(--dsw-alias-button-floating-hover)` |
| `--dsh-peak-bar-border` | 描边 | `var(--dsw-alias-border-l2)` |
| `--dsh-peak-bar-text` | 金额等主文字 | `var(--dsw-alias-label-primary)` |
| `--dsh-peak-bar-offpeak` | 「谷时」标签 | `var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))` |
| `--dsh-peak-bar-peak` | 「高峰」标签 | `var(--dsw-alias-brand-primary)` |
| `--dsh-peak-bar-countdown` | 倒计时数字 | `var(--dsw-alias-label-tertiary)` |
| `--dsh-peak-bar-label` | 「余额 / 今日已用」标签 | `var(--dsw-alias-label-tertiary)` |
| `--dsh-peak-bar-spent` | 今日已用金额 | `var(--dsw-alias-label-secondary)` |
| `--dsh-peak-bar-note` | 失败原因文字 | `var(--dsw-alias-label-tertiary)` |
| `--dsh-peak-bar-radius` | 圆角 | `999px` |
| `--dsh-peak-bar-font-size` | 字号 | `12px` |

只改几个变量时不必写全表，没提到的继续跟皮肤走。**引用皮肤 token 一律带字面量兜底**
（`var(--dsw-xxx, 兜底值)`）——莱茵生命皮肤里就有若干 token（如 `--dsw-radius-*`）并未定义。

```css
/* 皮肤作者：接管差异部分即可 */
:root {
  --dsh-peak-bar-bg: var(--dsw-specific-sidebar-fill, transparent);
  --dsh-peak-bar-border: var(--dsw-alias-border-l3);
  --dsh-peak-bar-radius: var(--dsw-radius-sm, 4px);
  --dsh-peak-bar-peak: var(--dsw-alias-brand-primary);
}

/* 三套现成配色，任选其一 */
:root { --dsh-peak-bar-bg:#2a1a10cc; --dsh-peak-bar-border:#ff8a3d55; --dsh-peak-bar-peak:#ff9d4d; --dsh-peak-bar-text:#ffe9d2 }  /* 莱茵生命橙 */
:root { --dsh-peak-bar-bg:#101010;   --dsh-peak-bar-border:#ffffff;   --dsh-peak-bar-text:#ffffff; --dsh-peak-bar-radius:6px }  /* 纯灰高对比 */
:root { --dsh-peak-bar-bg:#06222a;   --dsh-peak-bar-border:#1de9b644; --dsh-peak-bar-peak:#35e0d0; --dsh-peak-bar-countdown:#7fd7d0 }  /* 冷色青 */
```

## 位置

想自己钉住落点就覆盖座位类 —— **类名不是公开契约，改版可能变，请自行验证**：

```css
.dshPeakBarSeat { position: fixed; left: 50%; right: auto; transform: translateX(-50%) }  /* 真·整窗居中 */
.dshPeakBarSeat { position: absolute; left: auto; right: 132px; transform: none }         /* 紧贴按钮左侧 */
```

---

## 项目结构

```
dsh-peak-bar/
├── index.js            ★ Host 半：本机路由 + 原子写账本 + API key 余额路
├── client.js           ★ Client 半：胶囊、详情面板、词典、样式
├── cordis.patch.yml    注册进 profile 的 bundle patch
├── package.json        清单（dsh.bundle / dsh.client）
├── icon.svg            图标
├── locale/             插件卡片元数据（zh / en）
├── docs/               README 用的实机截图
├── tests/              三套离线测试（peak / render / host）
├── .github/workflows/  test.yml（三平台 × Node 20/22）、release.yml（推 tag 打包）
└── README / CHANGELOG / LICENSE
```

自检：`npm test` —— 三套测试全部离线跑，`host` 用临时 `DSH_HOME`，不碰真实的 `~/.dsh`。

## 已知限制

- 账号路与 API key 路**都不可用**时才显示失败原因，面板会列出两条路各自的原因。
- 账户读取在 Host 侧，**60 秒**轮询；页面重新可见时立即刷新一次。
- **法定节假日表只覆盖 2026 年**，2027 年起需补表，否则节假日会算成高峰（面板会提示）。
- 只在 **Windows 官方客户端 + DSH 0.2.0-rc.2** 实测；macOS / Linux 与纯浏览器模式未测。
- 「今日已用」是按余额差推算的**估计值**，不是平台账单，也不含其他厂商渠道的消费。
- 请求里的客户端版本是 `'unknown'`：官方客户端构建时内联，第三方插件拿不到。

---

## 设计取向

- **跟随优先，覆盖可选**：默认值全指向宿主语义 token，插件不发明自己的配色体系。
- **失败要说话**：宁可挂两字标记，也不静默显示 `--`；完整原因放到有空间的地方。
- **状态放 Host，页面只负责显示**：端口会变、origin 会变，`localStorage` 靠不住。

## 贡献

欢迎 Issue / PR，尤其是**你自己皮肤下的配色问题**与**新的节假日表**。

## 致谢

- [dsh-whale-widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) —— Host 持凭据与账本的分工、余额下降记账口径、API key 余额路的思路。
- [dsh-plugin-rhine-lab-theme](https://github.com/Galaxy-2001/Rhine-Lab-Codex-Theme) —— 「跟随皮肤」的判据以它定义的语义 token 与深浅两套值为准。
- DSH 自带的「账号与余额」卡片 —— 余额读取路径与返回结构。

`icon.svg` 为本项目自有，不打包任何第三方代码或素材。

## License

MIT © Woo3aN —— 见 [LICENSE](LICENSE)。
