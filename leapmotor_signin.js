// 零跑汽车 App 全自动签到 - Loon 脚本
//
// 2026-10-10 突破：xfx 有效期 6 小时（tokenExpired=21600），但刷新接口
//   GET appuser.leapmotor.cn/app-user/appuseroperate/getnewtokentoios
//   不校验 nonce/timespan 时间戳——19 小时前的签名请求原样重放仍返回 200 新 token（已实测），
//   且新 token 调 h5-info 验证有效。因此 cron 完全自给自足：
//   每次先重放存下的签名请求换新 xfx，再走签到流程，全程不用打开 App。
// accesstoken 为长效；若其过期导致重放失败，则通知打开 App 一次（自动抓到新签名请求）。
//
// 接口（已验证）：
// - GET  appuser.leapmotor.cn/app-user/appuseroperate/getnewtokentoios?accountId=..&deviceID=..&nonce=..&signStr=..&timespan=..
//      → {"code":200,"success":true,"data":{"token":"<新xfx>","refreshToken":"..","tokenExpired":"21600"}}
// - POST /app-usergrow/app/risk/sm_verify body=base64({"deviceId","eventId":"signIn","os":"ios","signInType":"1"})
//      → {"riskLevel":"PASS","riskType":"ai"}（deviceId 为空可能 400，必须抓到）
// - POST /app-usergrow/app/risk/signIn body=base64({"riskType":"ai","signType":"1"}) ← 不带极验字段
//      → {"code":200,"success":true} 即成功（前端在 riskLevel 非 REJECT 且未完成滑块时就是这么发的）
// - GET  /app-usergrow/app/user-growth/h5-info → data.signInState(1=已签到) / data.continuousSignInDays
//
// 三种触发：
// 1. http-request（/app/risk/*）：打开 App 进签到页时抓取 xfx 鉴权头 + deviceId
// 2. http-request（getnewtokentoios）：App 刷新 token 时抓取完整签名请求，供 cron 重放续期
// 3. cron：每天定时 → 先重放刷新 xfx → 查状态 → 未签到则尝试自动签到 → 通知结果

var KEY_AUTH = "leapmotor_sign_auth";
var KEY_REFRESH = "leapmotor_refresh_req";
var GATEWAY = "https://app-front-gateway.leapmotor.cn";
var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

// 需要抓取保存的鉴权头（大小写不敏感匹配）
var AUTH_HEADER_NAMES = ["token", "accesstoken", "x-access-token", "authorization", "xfx-cdn-cross-node", "cookie"];
// 重放时剔除的逐跳头（Loon 会自己设置）
var HOP_HEADERS = ["host", "content-length", "connection", "proxy-connection"];

// ---------------- 小工具 ----------------
function notify(title, sub, body) {
  try { $notification.post(title, sub || "", body || ""); }
  catch (e) { console.log("notify fail: " + e); }
}

// 服务端响应是明文 JSON（Charles 导出的 HAR 会把 body 转成 base64 存档，线上实际是明文；两种都兼容）
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
// 请求 body 是 base64(JSON)，JSON 为纯 ASCII，直接编码即可
function b64encode(s) {
  s = String(s);
  var out = "", i;
  for (i = 0; i < s.length; i += 3) {
    var b1 = s.charCodeAt(i) & 255,
        b2 = i + 1 < s.length ? s.charCodeAt(i + 1) & 255 : 0,
        b3 = i + 2 < s.length ? s.charCodeAt(i + 2) & 255 : 0;
    var n = (b1 << 16) | (b2 << 8) | b3;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] +
           (i + 1 < s.length ? B64[(n >> 6) & 63] : "=") +
           (i + 2 < s.length ? B64[n & 63] : "=");
  }
  return out;
}

// ---------------- 抓取模式（http-request 触发） ----------------
if (typeof $request !== "undefined" && $request) {
  try {
    var url = $request.url || "";
    if (url.indexOf("getnewtokentoios") >= 0) {
      // App 刷新 token：保存完整签名请求（URL+headers），供 cron 重放续期 xfx
      var had = !!$persistentStore.read(KEY_REFRESH);
      $persistentStore.write(JSON.stringify({
        url: url,
        headers: $request.headers || {},
        savedAt: new Date().toISOString()
      }), KEY_REFRESH);
      console.log("零跑刷新凭证已保存");
      if (!had) notify("零跑签到", "刷新凭证已保存", "xfx 可自动续期，无需每天打开 App");
      $done({});
    } else if (url.indexOf("/app/risk/") >= 0) {
      var h = $request.headers || {}, keep = {};
      for (var k in h) {
        if (AUTH_HEADER_NAMES.indexOf(k.toLowerCase()) >= 0) keep[k] = h[k];
      }
      if (Object.keys(keep).length === 0) {
        console.log("该请求无鉴权头，跳过: " + url);
        $done({});
      } else {
        // deviceId 藏在 sm_verify 的 base64 请求体里，风控预检需要它（Loon 里需打开"需要 Body"）
        var deviceId = "";
        try {
          var b = $request.body || "";
          if (b) {
            var j = JSON.parse(b64decode(b));
            if (j && j.deviceId) deviceId = j.deviceId;
          }
        } catch (e) {}
        var prev = {};
        try { prev = JSON.parse($persistentStore.read(KEY_AUTH) || "{}"); } catch (e) {}
        $persistentStore.write(JSON.stringify({
          headers: keep,
          deviceId: deviceId || prev.deviceId || "",
          savedAt: new Date().toISOString()
        }), KEY_AUTH);
        console.log("零跑登录态已保存" + (deviceId ? "" : "（本次未抓到 deviceId）"));
        notify("零跑签到", "登录信息获取成功", "定时任务已可使用");
        $done({});
      }
    } else { $done({}); }
  } catch (e) {
    console.log("保存登录态失败: " + e);
    $done({});
  }
} else {
  // ---------------- 定时签到模式（cron 触发） ----------------
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
function apiGet(auth, path, cb) {
  $httpClient.get({ url: GATEWAY + path, headers: gwHeaders(auth) }, function (err, resp, data) {
    cb(err, parseResp(data), (resp && resp.status) || 0);
  });
}
function apiPost(auth, path, b64body, cb) {
  $httpClient.post({ url: GATEWAY + path, headers: gwHeaders(auth), body: b64body }, function (err, resp, data) {
    cb(err, parseResp(data), (resp && resp.status) || 0);
  });
}
function readAuth() {
  var s = $persistentStore.read(KEY_AUTH);
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}
function dayText(d) {
  return d && d.continuousSignInDays ? "连续第 " + d.continuousSignInDays + " 天" : "";
}
function drawHint(d) {
  return (d && d.continuousSignInDays && d.continuousSignInDays % 7 === 0)
    ? " · 🎰 今天有抽奖机会，记得去抽奖页点一下" : "";
}
function authLost() {
  notify("零跑签到", "登录态失效", "请打开零跑 App 一次，自动重新抓取刷新凭证");
  $done();
}

// 重放保存的签名请求，换新 xfx。成功返回 true（已更新存储），失败返回 false（继续用旧 xfx）。
function refreshXfx(cb) {
  var rs = $persistentStore.read(KEY_REFRESH);
  if (!rs) return cb(false);
  var rr;
  try { rr = JSON.parse(rs); } catch (e) { return cb(false); }
  if (!rr || !rr.url) return cb(false);
  var headers = {};
  var src = rr.headers || {};
  for (var k in src) {
    if (HOP_HEADERS.indexOf(k.toLowerCase()) < 0) headers[k] = src[k];
  }
  $httpClient.get({ url: rr.url, headers: headers }, function (err, resp, data) {
    if (err) { console.log("刷新 xfx 失败: " + err); return cb(false); }
    var json = parseResp(data);
    var token = json && json.success && json.data && json.data.token;
    if (!token) { console.log("刷新 xfx 失败: 响应无 token"); return cb(false); }
    var auth = readAuth() || { headers: {} };
    auth.headers = auth.headers || {};
    var updated = false, k2;
    for (k2 in auth.headers) {
      if (k2.toLowerCase() === "xfx-cdn-cross-node") { auth.headers[k2] = token; updated = true; }
    }
    if (!updated) auth.headers["xfx-cdn-cross-node"] = token;
    auth.savedAt = new Date().toISOString();
    $persistentStore.write(JSON.stringify(auth), KEY_AUTH);
    console.log("xfx 已自动刷新");
    cb(true);
  });
}

function cronMain() {
  var auth = readAuth();
  if (!auth) {
    notify("零跑签到", "未找到登录信息", "请先打开零跑 App 一次抓取登录态");
    return $done();
  }
  // 每次先尝试刷新 xfx（静默失败则用旧的继续）
  refreshXfx(function () {
    checkAndSign(readAuth() || auth);
  });
}

function checkAndSign(auth) {
  // 0. 先查状态：已签到就不折腾
  apiGet(auth, "/app-usergrow/app/user-growth/h5-info", function (err, json, code) {
    if (err || code === 401) return authLost();
    var d = (json && json.data) || {};
    if (d.signInState === 1) {
      notify("零跑签到", "今日已签到 ✅", dayText(d) + drawHint(d));
      return $done();
    }
    // 1. 未签到 → 尝试全自动签到
    tryAutoSign(auth);
  });
}

function tryAutoSign(auth) {
  // 1. 风控预检（与前端顺序一致：先 sm_verify 再 signIn）
  var smBody = b64encode(JSON.stringify({
    deviceId: auth.deviceId || "", eventId: "signIn", os: "ios", signInType: "1"
  }));
  apiPost(auth, "/app-usergrow/app/risk/sm_verify", smBody, function (err, json, code) {
    if (err || code === 401) return authLost();
    var vd = (json && json.data) || {};
    if (!json || code !== 200) {
      notify("零跑签到", "自动签到失败", "风控预检异常" + (json && json.msg ? "：" + json.msg : "") + "，请打开 App 手动滑块签到");
      return $done();
    }
    if (vd.riskLevel === "REJECT") {
      notify("零跑签到", "被风控拦截", "请打开 App 手动完成签到");
      return $done();
    }
    // 2. 签到（不带极验字段 —— 前端在 riskLevel 非 REJECT 且未完成滑块时就是这么发的）
    var siBody = b64encode(JSON.stringify({ riskType: vd.riskType || "ai", signType: "1" }));
    apiPost(auth, "/app-usergrow/app/risk/signIn", siBody, function (err2, json2, code2) {
      if (err2 || code2 === 401) return authLost();
      if (json2 && (json2.success === true || json2.code === 200)) {
        // 成功 → 重新查状态，拿最新连续天数
        apiGet(auth, "/app-usergrow/app/user-growth/h5-info", function (err3, json3) {
          var d3 = (json3 && json3.data) || {};
          notify("零跑签到", "🎉 今日签到成功", dayText(d3) + drawHint(d3));
          return $done();
        });
      } else {
        var msg = (json2 && json2.msg) ? json2.msg : ("HTTP " + code2);
        notify("零跑签到", "自动签到没通过", msg + "，请打开 App 手动滑块签到");
        return $done();
      }
    });
  });
}
