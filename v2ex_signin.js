// V2EX 每日自动签到 - Loon 脚本
//
// 原理：
//  - http-request 在你用 Safari 逛 V2EX 时自动抓取 Cookie（含登录态），存入持久化。
//    跑在你的手机上，走你的 IP，不存在服务端 VM 换 IP 掉登录的问题，
//    也不经过自动化浏览器，没有 Cloudflare Turnstile 拦截问题。
//  - cron 每天：GET /mission/daily → 解析领取链接 /mission/daily/redeem?once=xxx → 调领取。
//
// 两种触发：
//  1. http-request：Safari 打开 www.v2ex.com 任意页面时抓取 Cookie（仅在 Cookie 变化时通知，避免打扰）
//  2. cron：每天 07:00 执行签到

var KEY_AUTH = "v2ex_sign_auth";
var BASE = "https://www.v2ex.com";
var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";

function notify(title, sub, body) {
  try { $notification.post(title, sub || "", body || ""); }
  catch (e) { console.log("notify fail: " + e); }
}

// ---------------- 抓取模式（http-request 触发） ----------------
if (typeof $request !== "undefined" && $request) {
  try {
    var h = $request.headers || {}, ck = "";
    for (var k in h) {
      if (k.toLowerCase() === "cookie") { ck = h[k]; break; }
    }
    if (!ck || ck.length < 20) { $done({}); }
    else {
      var prev = "";
      try { prev = JSON.parse($persistentStore.read(KEY_AUTH) || "{}").cookie || ""; } catch (e) {}
      if (ck !== prev) {
        $persistentStore.write(JSON.stringify({
          cookie: ck,
          savedAt: new Date().toISOString()
        }), KEY_AUTH);
        console.log("V2EX 登录态已保存");
        notify("V2EX 签到", "登录信息获取成功", "定时任务已可使用");
      }
      $done({});
    }
  } catch (e) {
    console.log("保存登录态失败: " + e);
    $done({});
  }
} else {
  // ---------------- 定时签到模式（cron 触发） ----------------
  cronMain();
}

function reqHeaders(auth, referer) {
  return {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh-Hans;q=0.9",
    "Referer": referer || BASE + "/",
    "User-Agent": UA,
    "Cookie": auth.cookie
  };
}

function getPage(auth, path, cb) {
  $httpClient.get({ url: BASE + path, headers: reqHeaders(auth) }, function (err, resp, data) {
    cb(err, String(data || ""), (resp && resp.status) || 0);
  });
}

function isLoginPage(body) {
  return /<title>V2EX › Sign In<\/title>/.test(body) ||
         /sign in to continue/i.test(body) && /\/signin/.test(body);
}

function isCfChallenge(body) {
  return /Just a moment/.test(body) || /cf-challenge/.test(body) ||
         /challenge-platform/.test(body);
}

function isMissionPage(body) {
  // 正向确认：页面确实是已登录的签到页（而非错误页/半截页面），
  // 才敢把"无领取链接"推断为"今日已领取"
  return /每日登录奖励/.test(body) || /铜币/.test(body);
}

function cronMain() {
  var s = $persistentStore.read(KEY_AUTH);
  if (!s) {
    notify("V2EX 签到", "未找到登录信息", "请先用 Safari 打开 V2EX（登录状态）任意页面抓取一次");
    return $done();
  }
  var auth;
  try { auth = JSON.parse(s); } catch (e) {
    notify("V2EX 签到", "登录信息损坏", "请重新用 Safari 打开 V2EX 抓取一次");
    return $done();
  }

  getPage(auth, "/mission/daily", function (err, body, code) {
    if (err) {
      notify("V2EX 签到", "请求失败", "网络错误: " + err);
      return $done();
    }
    if (code === 403 || isCfChallenge(body)) {
      notify("V2EX 签到", "遇到 Cloudflare 验证", "请用 Safari 打开 V2EX 刷新一次登录态后重试");
      return $done();
    }
    if (isLoginPage(body)) {
      notify("V2EX 签到", "登录态失效", "请用 Safari 打开 V2EX 重新登录一次，脚本会自动重新抓取");
      return $done();
    }
    if (code >= 300 && code < 400) {
      // 签到页正常不应重定向：大概率被踢到登录页
      notify("V2EX 签到", "登录态失效", "请用 Safari 打开 V2EX 重新登录一次，脚本会自动重新抓取");
      return $done();
    }
    if (body.length < 500) {
      notify("V2EX 签到", "签到页加载异常", "页面内容过短(HTTP " + code + ")，请稍后手动检查");
      return $done();
    }
    var m = body.match(/\/mission\/daily\/redeem\?once=(\d+)/);
    if (!m) {
      // 无领取链接：只有正向确认是正常的签到页，才推断为已领取；否则如实报未知，绝不误报成功
      if (isMissionPage(body)) {
        notify("V2EX 签到", "今日已领取 ✅", "签到页无领取链接");
      } else {
        notify("V2EX 签到", "状态未知", "签到页内容异常，请手动打开 V2EX 检查");
      }
      return $done();
    }
    // 领取
    $httpClient.get({
      url: BASE + m[0],
      headers: reqHeaders(auth, BASE + "/mission/daily")
    }, function (err2, resp2, data2) {
      if (err2) {
        notify("V2EX 签到", "领取请求失败", "网络错误: " + err2);
        return $done();
      }
      // 复查确认：领取链接应消失
      getPage(auth, "/mission/daily", function (err3, body3) {
        if (!err3 && !/\/mission\/daily\/redeem\?once=\d+/.test(body3) && !isLoginPage(body3)) {
          notify("V2EX 签到", "🎉 签到成功", "今日登录奖励已领取");
        } else {
          notify("V2EX 签到", "签到结果未知", "领取后复查异常，请手动打开 V2EX 签到页检查");
        }
        return $done();
      });
    });
  });
}
