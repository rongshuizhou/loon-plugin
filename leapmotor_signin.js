// 零跑汽车 App 签到状态播报 - Loon 脚本
//
// 背景（2026-10-09 抓包 + 前端 JS 反编译 + 真机实测确认）：
//  - 签到接口 POST /app-usergrow/app/risk/signIn 强制要求极验验证字段
//    （实测：不带验证字段直接 400），验证 token 一次性、须人工完成滑块
//  - 因此 Loon 做不到全自动签到。本脚本为“状态播报 + 提醒”版：
//    每天查一次签到状态，告诉你连续第几天；没签就提醒你打开 App 手滑一下。
//
// 接口（已验证）：
//  - GET /app-usergrow/app/user-growth/h5-info → 明文 JSON
//    data.signInState: 1=今日已签到，0=未签到
//    data.continuousSignInDays: 连续签到天数
//  - 鉴权：请求头 xfx-cdn-cross-node（会轮换，约数小时一变，不绑设备/IP）
//    由 http-request 在你打开 App 时自动抓取保存。
//
// 两种触发：
//  1. http-request：打开零跑 App（进签到页）时抓取鉴权头，存入持久化
//  2. cron：每天定时查询状态并通知

var KEY_AUTH = "leapmotor_sign_auth";
var GATEWAY = "https://app-front-gateway.leapmotor.cn";
var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

// 需要抓取保存的鉴权头（大小写不敏感匹配）
var AUTH_HEADER_NAMES = ["token", "accesstoken", "x-access-token", "authorization", "xfx-cdn-cross-node", "cookie"];

// ---------------- 小工具 ----------------
function notify(title, sub, body) {
  try { $notification.post(title, sub || "", body || ""); }
  catch (e) { console.log("notify fail: " + e); }
}

// 服务端响应是明文 JSON（注意：Charles 导出的 HAR 会把 body 转成 base64 存档，
// 线上实际返回的是明文；为保险起见两种都尝试解析）
function parseResp(data) {
  var s = String(data == null ? "" : data);
  try { return JSON.parse(s); } catch (e) {}
  try { return JSON.parse(b64decode(s)); } catch (e) {}
  return null;
}
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
function b64decode(b64) {
  var clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, ""), bytes = [], i;
  for (i = 0; i + 3 < clean.length + 1; i += 4) {
    var n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) |
            ((clean[i + 2] === "=" ? 0 : B64.indexOf(clean[i + 2])) << 6) |
            (clean[i + 3] === "=" ? 0 : B64.indexOf(clean[i + 3]));
    bytes.push((n >> 16) & 255);
    if (clean[i + 2] !== "=") bytes.push((n >> 8) & 255);
    if (clean[i + 3] !== "=") bytes.push(n & 255);
  }
  var s = "", k = 0;
  while (k < bytes.length) {
    var b = bytes[k++];
    if (b < 0x80) s += String.fromCharCode(b);
    else if (b < 0xe0) s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[k++] & 0x3f));
    else if (b < 0xf0) s += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[k++] & 0x3f) << 6) | (bytes[k++] & 0x3f));
    else {
      var cp = (((b & 0x07) << 18) | ((bytes[k++] & 0x3f) << 12) | ((bytes[k++] & 0x3f) << 6) | (bytes[k++] & 0x3f)) - 0x10000;
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return s;
}

// ---------------- 抓取模式（http-request 触发） ----------------
if (typeof $request !== "undefined" && $request) {
  try {
    var url = $request.url || "";
    if (url.indexOf("/app/risk/") < 0) { $done({}); }
    else {
      var h = $request.headers || {}, keep = {};
      for (var k in h) {
        if (AUTH_HEADER_NAMES.indexOf(k.toLowerCase()) >= 0) keep[k] = h[k];
      }
      if (Object.keys(keep).length === 0) {
        console.log("该请求无鉴权头，跳过: " + url);
        $done({});
      } else {
        $persistentStore.write(JSON.stringify({
          headers: keep,
          savedAt: new Date().toISOString()
        }), KEY_AUTH);
        console.log("零跑登录态已保存");
        notify("零跑签到", "登录信息获取成功", "定时任务已可使用");
        $done({});
      }
    }
  } catch (e) {
    console.log("保存登录态失败: " + e);
    $done({});
  }
} else {
  // ---------------- 定时播报模式（cron 触发） ----------------
  cronMain();
}

function gwHeaders(auth) {
  var headers = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json; charset=UTF-8",
    "Origin": "https://apptec.leapmotor.com",
    "Referer": "https://apptec.leapmotor.com/",
    "User-Agent": UA,
    "isneedtoken": "true",
    "c-versions": "H5"
  };
  var kept = (auth && auth.headers) || {};
  for (var k in kept) headers[k] = kept[k];
  return headers;
}

function cronMain() {
  var authStr = $persistentStore.read(KEY_AUTH);
  if (!authStr) {
    notify("零跑签到", "未找到登录信息", "请先打开零跑 App 进签到页抓取一次");
    return $done();
  }
  var auth;
  try { auth = JSON.parse(authStr); }
  catch (e) {
    notify("零跑签到", "登录信息损坏", "请重新打开 App 抓取一次");
    return $done();
  }

  $httpClient.get({
    url: GATEWAY + "/app-usergrow/app/user-growth/h5-info",
    headers: gwHeaders(auth)
  }, function (err, resp, data) {
    var code = (resp && resp.status) || 0;
    if (err) {
      notify("零跑签到", "状态查询失败", "网络错误: " + err);
      return $done();
    }
    if (code === 401) {
      notify("零跑签到", "登录态失效", "请打开零跑 App 进签到页重新抓取一次");
      return $done();
    }
    var json = parseResp(data);
    if (!json || !json.data) {
      notify("零跑签到", "状态查询失败", "响应异常(HTTP " + code + ")");
      return $done();
    }
    var d = json.data;
    var days = d.continuousSignInDays ? "连续第 " + d.continuousSignInDays + " 天" : "";
    var draw = (d.continuousSignInDays && d.continuousSignInDays % 7 === 0)
      ? " · 🎰 今天有抽奖机会，记得去抽奖页点一下" : "";
    if (d.signInState === 1) {
      notify("零跑签到", "今日已签到 ✅", days + draw);
    } else {
      notify("零跑签到", "今日还未签到", (days ? days + " · " : "") + "打开零跑 App 完成滑块签到" + draw);
    }
    return $done();
  });
}
