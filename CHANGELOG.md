# 更新日志

采用 Keep a Changelog 风格。

## [0.3.0] - 2026-10-09

### 新增

- 胶囊移到窗口标题栏正中：注册进 `shell.overlay`，Windows 上也能和最小化/关闭按钮同一行。
- 点击胶囊在主区域打开详情面板：峰谷状态、距下次切换倒计时、余额、计费规则说明。
- 读取失败时胶囊直接把原因写在上面，不再静默显示 `--`。
- 胶囊所有颜色改为 CSS 变量：**默认值全部是宿主语义 token**，因此默认即跟随当前皮肤与深浅色；改任意几个变量即可自定义，未改的继续跟皮肤走（见 README 的“跟随主题与皮肤 / 自定义颜色”）。
- 新增「今日已用」：按余额下降观测累计（充值/赠金不计入），**账本由 Host 半写入 `<DSH_HOME>/.dsh-peak-bar.json`**，因此跨重启、跨端口、多窗口都保留；Host 路由不可用时退回“本次运行统计”。显示不带符号、两位小数。
- 新增 Host 半（`index.js`）：本机路由与原子写文件的账本，带 loopback 信任栅栏；没有 HTTP 载体的 profile 下仍能激活。
- 新增 **API key 余额路**（Host 路由 `GET /dsh-peak-bar/balance`）：账号路不可用时，Host 从 DSH 凭据服务解析 `DEEPSEEK_API_KEY` 并直连官方 `/user/balance`；密钥不出 Host。余额与今日已用都标注来源。
- 胶囊里的两个数字加上标签：`谷时 … 余额 ¥20.79 今日已用 ¥0.20`；今日已用不带符号、两位小数。
- “谷时”改用主题的成功色（`--dsw-alias-state-success-primary`，莱茵生命皮肤下即绿色），皮肤没定义时退回中性灰。
- `npm test` 现在跑全部三套测试（此前漏了 `tests/host.test.mjs`，改坏 Host 半边也不会报红）；`files` 一并收录 `tests/`，发布后测试可复现。
- 动效时长与缓动改用主题的 `--ds-transition-duration` / `--ds-ease-in-out`，并尊重“减少动态效果”。
- 完整的 zh/en 本地化（倒计时单位与全部失败原因都走词典，不再是硬编码中文）。
- 插件卡片的 locale 元数据。
- 图标换成中性配色（不再使用莱茵生命皮肤的橙/棕）；README 增补「致谢」一节。

### 变更

- **包名与仓库名改为 `dsh-peak-bar`（原名 `dsh-rhine-statusbar`）——破坏性变更。** 胶囊的颜色早已与特定皮肤解耦、跟随任意皮肤，所以去掉 `rhine`。同时改掉全部内部标识：客户端模块 id、本机路由（`/dsh-peak-bar/spend`、`/dsh-peak-bar/balance`）、CSS 变量与类名前缀（`--dsh-peak-bar-*`、`dshPeakBar*`）、账本文件名（`.dsh-peak-bar.json`）、环境变量（`DSH_PEAK_BAR_BALANCE_URL`）。
  **升级须知**：`node_modules` 下旧包名目录不再被引用，需删掉 `dsh-rhine-statusbar` 并重新安装一次；账本文件名随之改变，旧的 `.dsh-rhine-statusbar.json` 不会被读取（如需保留「今日已用」历史，手动改名为 `.dsh-peak-bar.json`）。

### 修复

- 账号返回是两层 `{ok, value}`，旧代码直接从外层取钱包，导致余额永远显示 `--`。
- `remote.account` 是独立的 cordis 服务，旧代码只注入 `remote`，会抛 `cannot get property "remote.account"`。
- 颜色变量曾声明在 `html` 上，而主题把 `--dsw-alias-*` 挂在 `body` 上，导致 `border` 变成非法值、**胶囊丢失描边与底色**；改为在使用处 `var(--dsh-peak-bar-x, 主题 token)` 惰性回退。
- 工具提示（原生 `title`）里含每秒变化的倒计时，导致悬停时**提示每秒闪一次**；倒计时只留在可见文字里。
- `apply()` 抛错会让胶囊无声消失；现在注册一个显示失败原因的兜底条目（该分支不依赖已注册的词典，自带 zh/en 两行并按活动语言选择）。
- 节假日表到期后不再“自信作答”：超过覆盖范围（`2026-12-31`）时面板会提示峰谷判定可能不准。
- API key 路回传 `is_available=false` 时，面板会注明该余额被平台标记为不可用。
- 皮肤自定义示例里的 `var(--dsw-radius-sm)` 补上字面量兜底（莱茵生命皮肤并未定义 `--dsw-radius-*`，裸引用会整条失效）。
- 署名去掉占位符，改为 `Woo3aN`。
- 悬停提示重复了面板标题：原先是 `峰谷 · 余额: 谷时 · 余额 ¥20.79 …`，同一个词出现两次还夹着半角冒号；现在按“每个数字只出现一次”拼装，并把“本次运行统计”的长括号收成一个词（`（未持久化）`），完整原因留在面板里。
- **点击胶囊打不开面板**：`layout` 从未被注入，而代码却直接读 `props.ctx.layout` —— cordis 拒绝读取未注入的服务（读取即抛错），错误从 React 的 `onClick` 里逃出去，表现就是**点了完全没反应**。现在 `layout` 走自己的可选注入作用域（与 `remote.account` 同一套写法），调用包在 `try/catch` 里，并且**只在真的能打开时才在提示里写“点击查看详情”**，否则明说“详情面板暂不可用”。
