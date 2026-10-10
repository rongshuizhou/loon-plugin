// NodeSeek 每日自动签到 - Loon 脚本
//
// 原理：
//  - http-request 在你用 Safari 逛 NodeSeek 时自动抓取 Cookie（含登录态），存入持久化。
//    跑在你的手机上，走你的 IP 与真实 Safari 指纹，不经过自动化浏览器，
//    没有 Cloudflare Turnstile 拦截问题（之前拦截的是自动化浏览器，不是带有效 Cookie 的接口请求）。
//  - cron 每天：GET /api/notification/unread-count 验登录态
//      → GET /api/attendance/board?page=1 查今日状态（record 为 null = 未签）
//      → POST /api/attendance?random=true 试试手气签到
//
// 两种触发：
//  1. http-request：Safari 打开 www.nodeseek.com 任意页面时抓取 Cookie（仅在 Cookie 变化时通知）
//  2. cron：每天 07:00 执行签到

var KEY_AUTH = "nodeseek_sign_auth";
var BASE = "https://www.nodeseek.com";
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
        console.log("NodeSeek 登录态已保存");
        notify("NodeSeek 签到", "登录信息获取成功", "定时任务已可使用");
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

function apiHeaders(auth) {
  return {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh-Hans;q=0.9",
    "Referer": BASE + "/board",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": UA,
    "Cookie": auth.cookie
  };
}

// cb(errMsg, statusCode, jsonOrNull, rawText)
function api(auth, method, path, cb) {
  var opt = { url: BASE + path, headers: apiHeaders(auth) };
  var done = function (err, resp, data) {
    if (err) return cb("网络错误: " + err, 0, null, "");
    var code = (resp && resp.status) || 0;
    var text = String(data || "");
    // Cloudflare 挑战：403 或返回 HTML
    if (code === 403 || text.replace(/^\s+/, "").charAt(0) === "<") {
      return cb("遇到 Cloudflare 挑战，请用 Safari 打开 NodeSeek 刷新一次登录态", code, null, text);
    }
    var json = null;
    try { json = JSON.parse(text); } catch (e) {
      return cb("响应不是 JSON(HTTP " + code + ")", code, null, text);
    }
    cb(null, code, json, text);
  };
  if (method === "POST") $httpClient.post(opt, done);
  else $httpClient.get(opt, done);
}

function cronMain() {
  var s = $persistentStore.read(KEY_AUTH);
  if (!s) {
    notify("NodeSeek 签到", "未找到登录信息", "请先用 Safari 打开 NodeSeek（登录状态）任意页面抓取一次");
    return $done();
  }
  var auth;
  try { auth = JSON.parse(s); } catch (e) {
    notify("NodeSeek 签到", "登录信息损坏", "请重新用 Safari 打开 NodeSeek 抓取一次");
    return $done();
  }

  // 1. 验登录态（未登录时站点返回 500）
  api(auth, "GET", "/api/notification/unread-count", function (err, code, json) {
    if (err) {
      notify("NodeSeek 签到", "签到失败", err);
      return $done();
    }
    if (code === 500) {
      notify("NodeSeek 签到", "登录态失效", "请用 Safari 打开 NodeSeek 重新登录一次，脚本会自动重新抓取");
      return $done();
    }
    // 2. 查今日签到状态
    api(auth, "GET", "/api/attendance/board?page=1", function (err2, code2, board) {
      if (err2) {
        notify("NodeSeek 签到", "签到失败", "读取签到状态失败: " + err2);
        return $done();
      }
      if (board && board.success === false) {
        notify("NodeSeek 签到", "签到失败", "站点返回: " + (board.message || "未知错误"));
        return $done();
      }
      var record = board && board.record;
      if (record && typeof record === "object") {
        var gain = record.gain;
        var extra = (gain != null ? "今日已获得 " + gain + " 个鸡腿" : "今日已签到");
        if (board.order) extra += "，排名第 " + board.order;
        notify("NodeSeek 签到", "今日已签到 ✅", extra);
        return $done();
      }
      // 3. 试试手气签到
      api(auth, "POST", "/api/attendance?random=true", function (err3, code3, resp) {
        if (err3) {
          notify("NodeSeek 签到", "签到失败", "签到请求失败: " + err3);
          return $done();
        }
        if (resp && resp.success === false) {
          var msg = String((resp && resp.message) || "");
          if (/已签|already/i.test(msg)) {
            notify("NodeSeek 签到", "今日已签到 ✅", msg);
          } else {
            notify("NodeSeek 签到", "签到被拒绝", msg || "未知原因");
          }
          return $done();
        }
        // 4. 复查确认
        api(auth, "GET", "/api/attendance/board?page=1", function (err4, code4, board2) {
          var r2 = board2 && board2.record;
          if (!err4 && r2 && typeof r2 === "object") {
            var g2 = r2.gain;
            var e2 = (g2 != null ? "获得 " + g2 + " 个鸡腿" : "签到成功");
            if (board2.order) e2 += "，排名第 " + board2.order;
            notify("NodeSeek 签到", "🎉 签到成功", e2);
          } else {
            notify("NodeSeek 签到", "🎉 签到成功", "签到请求已提交");
          }
          return $done();
        });
      });
    });
  });
}
