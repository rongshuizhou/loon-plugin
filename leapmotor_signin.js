// 零跑汽车 App 签到 - Loon 脚本（尽力版）
//
// 真实流程（2026-10-09 抓包 + 前端 JS 反编译确认）：
//  1. POST /app-usergrow/app/risk/sm_verify
//     body = base64(JSON): {"deviceId":"...","eventId":"signIn","os":"ios","signInType":"1"}
//     → {"code":200,"data":{"riskLevel":"PASS","riskType":"ai"}}
//  2. 页面自动初始化极验验证（Geetest v4，bind 模式），onReady 即自动弹出，
//     必须人工完成滑块；完成后得到一次性验证 token
//  3. POST /app-usergrow/app/risk/signIn
//     body = base64(JSON): {"riskType":"ai","signType":"1",
//       "captchaOutput":"...","lotNumber":"...","passToken":"...","genTime":"..."}
//     → {"code":200,"success":true,"msg":"操作成功"}
//
// ⚠️ 关键限制（硬限制，非参数问题）：
//  - 极验验证在每次签到前都会初始化，验证 token 一次性、与本次挑战绑定，
//    脚本无法生成也无法复用 → Loon 做不到 100% 全自动。
//  - 本脚本为“尽力版”：定时尝试不带验证信息的签到；若服务端放行则成功，
//    若要求验证则如实通知，点开 App 手动滑一下即可。
//  - 鉴权靠 App 注入的 token 头（抓包工具会脱敏显示为 <redacted>），
//    不是 Cookie。http-request 会在你打开 App 时自动抓取保存。
//
// 两种触发：
//  1. http-request：打开零跑 App（进签到页）时抓取鉴权头 + deviceId，存入持久化
//  2. cron：每天定时执行签到流程

var KEY_AUTH = "leapmotor_sign_auth";
var GATEWAY = "https://app-front-gateway.leapmotor.cn";
var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

// ---------------- base64 工具（纯 JS，不依赖环境） ----------------
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function utf8Encode(s) {
  var bytes = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      var c2 = s.charCodeAt(++i);
      var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return bytes;
}
function utf8Decode(bytes) {
  var s = "", i = 0;
  while (i < bytes.length) {
    var b = bytes[i++];
    if (b < 0x80) s += String.fromCharCode(b);
    else if (b < 0xe0) s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (b < 0xf0) s += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    else {
      var cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      cp -= 0x10000;
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return s;
}
function b64encode(str) {
  var bytes = utf8Encode(str), out = "";
  for (var i = 0; i < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8) | (i + 2 < bytes.length ? bytes[i + 2] : 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? B64[n & 63] : "=");
  }
  return out;
}
function b64decode(b64) {
  var clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, ""), bytes = [];
  for (var i = 0; i + 3 < clean.length + 1; i += 4) {
    var c0 = B64.indexOf(clean[i]), c1 = B64.indexOf(clean[i + 1]);
    var c2 = clean[i + 2] === "=" ? 0 : B64.indexOf(clean[i + 2]);
    var c3 = clean[i + 3] === "=" ? 0 : B64.indexOf(clean[i + 3]);
    var n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    bytes.push((n >> 16) & 255);
    if (clean[i + 2] !== "=") bytes.push((n >> 8) & 255);
    if (clean[i + 3] !== "=") bytes.push(n & 255);
  }
  return utf8Decode(bytes);
}

// ---------------- 小工具 ----------------
function notify(title, sub, body) {
  try { $notification.post(title, sub || "", body || ""); }
  catch (e) { console.log("notify fail: " + e); }
}

// 需要抓取保存的鉴权头（大小写不敏感匹配）
var AUTH_HEADER_NAMES = ["token", "accesstoken", "x-access-token", "authorization", "xfx-cdn-cross-node", "cookie"];

// ---------------- 抓取模式（http-request 触发） ----------------
if (typeof $request !== "undefined" && $request) {
  try {
    var url = $request.url || "";
    // 只处理风控/签到相关请求，这些一定带鉴权
    if (url.indexOf("/app/risk/") < 0) { $done({}); }
    else {
      var h = $request.headers || {}, keep = {};
      for (var k in h) {
        if (AUTH_HEADER_NAMES.indexOf(k.toLowerCase()) >= 0) keep[k] = h[k];
      }
      var deviceId = "";
      try {
        var b = $request.body || "";
        if (b) {
          var j = JSON.parse(b64decode(b));
          if (j && j.deviceId) deviceId = j.deviceId;
        }
      } catch (e) {}
      if (Object.keys(keep).length === 0) {
        console.log("该请求无鉴权头，跳过: " + url);
        $done({});
      } else {
        var prev = {};
        try { prev = JSON.parse($persistentStore.read(KEY_AUTH) || "{}"); } catch (e) {}
        // 合并保存：headers 取新值，deviceId 保留已有的（除非抓到新的）
        $persistentStore.write(JSON.stringify({
          headers: keep,
          deviceId: deviceId || prev.deviceId || "",
          savedAt: new Date().toISOString()
        }), KEY_AUTH);
        console.log("零跑登录态已保存");
        notify("零跑签到", "登录信息获取成功", "定时任务已可使用（极验验证仍需手动）");
        $done({});
      }
    }
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
  $httpClient.get({
    url: GATEWAY + path,
    headers: gwHeaders(auth)
  }, function (err, resp, data) {
    if (err) return cb("网络错误: " + err, null, 0);
    var code = (resp && resp.status) || 0;
    try { return cb(null, JSON.parse(b64decode(data)), code); }
    catch (e) { return cb("响应解析失败(HTTP " + code + ")", null, code); }
  });
}

function apiPost(auth, path, bodyObj, cb) {
  $httpClient.post({
    url: GATEWAY + path,
    headers: gwHeaders(auth),
    body: b64encode(JSON.stringify(bodyObj))
  }, function (err, resp, data) {
    if (err) return cb("网络错误: " + err, null, 0);
    var code = (resp && resp.status) || 0;
    try { return cb(null, JSON.parse(b64decode(data)), code); }
    catch (e) { return cb("响应解析失败(HTTP " + code + "): " + String(data).slice(0, 120), null, code); }
  });
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

  console.log("开始签到流程");

  // 0. 先查状态：signInState=1 表示今日已签到，continuousSignInDays 为连续天数
  apiGet(auth, "/app-usergrow/app/user-growth/h5-info", function (err0, info0) {
    var d0 = (!err0 && info0 && info0.data) || {};
    if (!err0 && d0.signInState === 1) {
      notify("零跑签到", "今日已签到 ✅", dayText(d0) + drawHint(d0));
      return $done();
    }

    // 1. 风控预检
    apiPost(auth, "/app-usergrow/app/risk/sm_verify",
      { deviceId: auth.deviceId || "", eventId: "signIn", os: "ios", signInType: "1" },
      function (err, json, code) {
        if (err) {
          notify("零跑签到", "风控预检失败", err + "（可能是登录态失效，请重进 App 抓取）");
          return $done();
        }
        if (!json || json.code !== 200) {
          notify("零跑签到", "风控预检异常", (json && (json.msg || json.message)) || ("HTTP " + code));
          return $done();
        }
        var level = json.data && json.data.riskLevel;
        var riskType = (json.data && json.data.riskType) || "ai";
        console.log("riskLevel=" + level + " riskType=" + riskType);
        if (level === "REJECT") {
          notify("零跑签到", "风控拒绝", "请手动打开签到页完成验证");
          return $done();
        }

        // 2. 尝试签到（不带极验 token；若服务端强制要求验证则会失败并如实通知）
        apiPost(auth, "/app-usergrow/app/risk/signIn",
          { riskType: riskType, signType: "1" },
          function (err2, res) {
            // 3. 复查最新状态，拿到连续天数
            apiGet(auth, "/app-usergrow/app/user-growth/h5-info", function (err3, info2) {
              var d2 = (!err3 && info2 && info2.data) || {};
              var days = dayText(d2);
              console.log("signIn: " + JSON.stringify(res).slice(0, 300) + " | " + days);
              if (d2.signInState === 1) {
                var ok = res && res.code === 200 && res.success;
                notify("零跑签到", ok ? "✅ 签到成功" : "今日已签到 ✅", days + drawHint(d2));
              } else {
                notify("零跑签到", "需要手动签到",
                  "极验验证需人工完成 (" + ((res && (res.msg || res.message)) || "未知原因") + ")，请打开 App 签到页滑一下");
              }
              return $done();
            });
          });
      });
  });
}

// "连续第 X 天"文案
function dayText(d) {
  var n = d && d.continuousSignInDays;
  return n ? "连续第 " + n + " 天" : "";
}

// 第 7 天（及之后每 7 天）提醒抽奖：抽奖是独立活动页，脚本点不了，只能提醒
function drawHint(d) {
  var n = d && d.continuousSignInDays;
  if (n && n % 7 === 0) return " · 🎰 今天有抽奖机会，记得去抽奖页点一下";
  return "";
}
