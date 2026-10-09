# 零跑汽车 App 签到（Loon · 尽力版）

## ⚠️ 先说结论

**做不到 100% 全自动。** 2026-10-09 的抓包 + 前端 JS 反编译确认：

1. 每次点签到前，页面都会自动初始化**极验验证（Geetest v4）**并弹出滑块，必须人工完成；
2. 验证通过后产生的 `captchaOutput / lotNumber / passToken / genTime` 是一次性的、与本次挑战绑定的，脚本无法生成也无法复用；
3. 所以 Loon 脚本只能做到“尽力尝试 + 如实通知”，省不掉那一下滑块。

这份 HAR 没白抓——它纠正了之前分析里的几处错误（见下表），插件已按真实流程重写。

## 真实流程（已验证）

| 步骤 | 接口 | 方法 | 说明 |
|---|---|---|---|
| 1. 风控预检 | `/app-usergrow/app/risk/sm_verify` | POST | body = base64(JSON)：`{"deviceId":"…","eventId":"signIn","os":"ios","signInType":"1"}` → `{"riskLevel":"PASS","riskType":"ai"}` |
| 2. 极验验证 | Geetest v4（`captcha_id=8343e4c7d1731e86f4762cc123239639`） | — | 页面自动弹出，**必须人工完成滑块** |
| 3. 签到 | `/app-usergrow/app/risk/signIn` | POST | body = base64(JSON)：`{"riskType":"ai","signType":"1","captchaOutput":"…","lotNumber":"…","passToken":"…","genTime":"…"}` → `{"code":200,"success":true,"msg":"操作成功"}` |

补充说明：

- body 是 **base64(JSON)**，不是之前猜的 base64(表单字符串)。
- 鉴权靠 App 注入的 token 头（`isneedtoken: true`；抓包工具会脱敏显示为 `<redacted>`），**不是 Cookie**——H5 请求里根本没有 Cookie。
- 旧分析里的 `GET /app/risk/check_verify`、`/app/user-sign/sign-homepage-info` 在本次抓包的签到流程里没出现（可能是旧版接口或其它页面用的）。
- 前端逻辑：`riskLevel !== "REJECT"` 且极验有验证结果时才把验证字段带上；`REJECT` 时直接拒绝。

## 脚本行为（cron）

1. 先查 `h5-info` 状态：`signInState=1` 表示今日已签到，直接通知“今日已签到 ✅”并带上连续天数；
2. 未签到 → 风控预检（`sm_verify`）→ `REJECT` 则通知手动处理；
3. 不带极验 token 尝试签到 → 成功则报“✅ 签到成功”；
4. 失败则如实通知“需要手动签到”，打开 App 签到页滑一下即可。
5. 每次通知都会带上 **连续第 X 天**（取自 `h5-info` 的 `continuousSignInDays`）。

## 关于第 7 天抽奖

- 签到满 7 天（及之后每 7 天）时，通知会额外提醒“🎰 今天有抽奖机会，记得去抽奖页点一下”。
- **自动抽奖目前做不到**：抽奖是个独立的活动页（签到奖励里的 `luckyDrawLink` 跳过去），这次抓包里没点过抽奖，没有它的接口。如果哪天你抽奖时抓一份包（点抽奖按钮那一刻的请求），发我看看能不能自动。

## 配置步骤

### 1. 上传脚本到 Gist

1. 打开 [gist.github.com](https://gist.github.com)，新建 Gist，粘贴 `leapmotor_signin.js`
2. 点 **Raw** 复制 raw 地址
3. 把 `leapmotor.plugin` 里的 `https://RAW_URL_HERE/leapmotor_signin.js` 换成你的 raw 地址

### 2. Loon 导入插件

Loon → 配置 → 插件 → 从 URL 导入 plugin 的 raw 地址（或手动按文件里的 `[Script]` 段配置）。

别忘了 Loon → 配置 → MITM 打开，并安装信任证书。

### 3. 抓登录态

打开零跑 App → 进签到页，收到“登录信息获取成功”通知即 OK。
此后每次打开 App 进签到页都会自动刷新保存的鉴权信息。

## 常见问题

- **提示“未找到登录信息”**：先做第 3 步
- **提示“风控预检失败”**：鉴权过期了，重进 App 抓取一次
- **提示“需要手动签到”**：极验要求人工验证，打开 App 签到页滑一下就行
- **每天 9:05 定时跑**：Loon cron `5 9 * * *`，可在插件里改时间

## 风险提示

自动签到可能违反零跑用户协议，有被限制风险，请自行权衡。
