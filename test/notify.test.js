import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  DEFAULT_SETTINGS,
  buildDigestMessage,
  buildDigestSections,
  buildThresholdMessage,
  buildWebhookPayload,
  buildWebhookUrl,
  compareMetrics,
  computeAccountMetrics,
  dueDigestSlots,
  evaluateThresholds,
  localTimeParts,
  maskUrl,
  normalizeSettings,
  sendWebhook,
  windowRemainingPercent,
} from "../src/notify.js";

const TYPE_LABELS = { newapi: "New API", sub2api: "Sub2API", opencode: "OpenCode Go", custom: "自定义" };

function packageAccount(overrides = {}) {
  return {
    id: "acc-pkg",
    name: "示例套餐 A",
    type: "custom",
    group: "示例分组",
    thresholds: {},
    ...overrides,
  };
}

function windowResult(percent, resetAt, extra = {}) {
  return {
    ok: true,
    plan: { name: "示例套餐 A", active: true },
    balance: null,
    windows: [
      {
        key: "5h",
        label: "5 小时",
        limit: 100,
        used: percent,
        remaining: 100 - percent,
        percent,
        unit: "%",
        resetAt,
        ...extra,
      },
    ],
  };
}

function threeWindowResult({ five, weekly, monthly, reset5h, resetWeekly, resetMonthly }) {
  const make = (key, label, percent, resetAt) => ({
    key,
    label,
    limit: 100,
    used: percent,
    remaining: 100 - percent,
    percent,
    unit: "%",
    resetAt,
  });
  return {
    ok: true,
    plan: { name: "OpenCode Go", active: true },
    balance: null,
    windows: [
      make("5h", "5 小时", five, reset5h),
      make("weekly", "本周", weekly, resetWeekly),
      make("monthly", "本月", monthly, resetMonthly),
    ],
  };
}

test("阈值：首次低于阈值触发一次，重复刷新不重复触发", () => {
  const account = packageAccount();
  const settings = { ...DEFAULT_SETTINGS, rules: { windowPercent: 20, balanceAmount: 10 } };
  const result = windowResult(85, "2026-10-12T00:00:00Z"); // 剩余 15% < 20%

  const first = evaluateThresholds([account], { [account.id]: result }, settings, {}, new Date("2026-10-11T00:00:00Z"));
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].kind, "window");
  assert.equal(first.events[0].windowKey, "5h");
  assert.equal(first.events[0].remainingPercent, 15);
  assert.equal(first.events[0].thresholdPercent, 20);

  // 同值再刷新两次都不应重复触发
  const second = evaluateThresholds([account], { [account.id]: result }, settings, first.state);
  assert.equal(second.events.length, 0);
  const third = evaluateThresholds([account], { [account.id]: result }, settings, second.state);
  assert.equal(third.events.length, 0);
});

test("阈值：余量恢复阈值之上后计数归零，再次低于阈值会重新触发", () => {
  const account = packageAccount();
  const settings = { ...DEFAULT_SETTINGS, rules: { windowPercent: 20, balanceAmount: 10 } };
  const low = windowResult(85, "2026-10-12T00:00:00Z");
  const high = windowResult(10, "2026-10-12T00:00:00Z");

  const first = evaluateThresholds([account], { [account.id]: low }, settings, {});
  assert.equal(first.events.length, 1);

  const recovered = evaluateThresholds([account], { [account.id]: high }, settings, first.state);
  assert.equal(recovered.events.length, 0);
  assert.equal(recovered.state[`${account.id}|window:5h`].notified, false);

  const again = evaluateThresholds([account], { [account.id]: low }, settings, recovered.state);
  assert.equal(again.events.length, 1, "恢复后再次触底应重新告警");
});

test("阈值：短周期窗口刷新不会让尚未刷新的长周期窗口重复告警", () => {
  const account = packageAccount({ id: "oc", name: "OpenCode Go", type: "opencode" });
  const settings = { ...DEFAULT_SETTINGS, rules: { windowPercent: 20, balanceAmount: 10 } };

  // 5h 已触底、本月 100% 限流
  const before = threeWindowResult({
    five: 95,
    weekly: 50,
    monthly: 100,
    reset5h: "2026-10-11T01:00:00Z",
    resetWeekly: "2026-10-13T00:00:00Z",
    resetMonthly: "2026-10-16T00:00:00Z",
  });
  const first = evaluateThresholds([account], { [account.id]: before }, settings, {});
  assert.equal(first.events.length, 2, "5h 与本月应各告警一次");
  assert.deepEqual(first.events.map((event) => event.windowKey).sort(), ["5h", "monthly"]);

  // 5h 重置（余量回到 100%），但上游的月数据还是旧的（未刷新）
  const afterReset = threeWindowResult({
    five: 0,
    weekly: 40,
    monthly: 100,
    reset5h: "2026-10-11T06:00:00Z",
    resetWeekly: "2026-10-13T00:00:00Z",
    resetMonthly: "2026-10-16T00:00:00Z",
  });
  const second = evaluateThresholds([account], { [account.id]: afterReset }, settings, first.state);
  assert.equal(second.events.length, 0, "长周期窗口未刷新时不应重复告警");
  assert.equal(second.state[`${account.id}|window:monthly`].notified, true);
  assert.equal(second.state[`${account.id}|window:5h`].notified, false, "5h 重置后应解除");

  // 5h 再次触底 → 只发 5h，本月依然安静
  const fiveAgain = threeWindowResult({
    five: 90,
    weekly: 40,
    monthly: 100,
    reset5h: "2026-10-11T06:00:00Z",
    resetWeekly: "2026-10-13T00:00:00Z",
    resetMonthly: "2026-10-16T00:00:00Z",
  });
  const third = evaluateThresholds([account], { [account.id]: fiveAgain }, settings, second.state);
  assert.deepEqual(third.events.map((event) => event.windowKey), ["5h"]);
});

test("阈值：resetAt 前进到新一轮（即使仍低于阈值）会重新触发", () => {
  const account = packageAccount();
  const settings = { ...DEFAULT_SETTINGS, rules: { windowPercent: 20, balanceAmount: 10 } };
  const cycle1 = windowResult(95, "2026-10-12T00:00:00Z");
  const first = evaluateThresholds([account], { [account.id]: cycle1 }, settings, {});
  assert.equal(first.events.length, 1);

  // 新周期开始，数值仍低 → 属于“重置后再次触发”
  const cycle2 = windowResult(97, "2026-10-13T00:00:00Z");
  const second = evaluateThresholds([account], { [account.id]: cycle2 }, settings, first.state);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].remainingPercent, 3);
});

test("阈值：resetAt 已过期但数据未刷新（值仍低）不重复触发", () => {
  const account = packageAccount();
  const settings = { ...DEFAULT_SETTINGS, rules: { windowPercent: 20, balanceAmount: 10 } };
  const stale = windowResult(100, "2026-10-10T00:00:00Z");
  const first = evaluateThresholds([account], { [account.id]: stale }, settings, {}, new Date("2026-10-11T00:00:00Z"));
  assert.equal(first.events.length, 1);
  const second = evaluateThresholds(
    [account],
    { [account.id]: stale },
    settings,
    first.state,
    new Date("2026-10-12T00:00:00Z"),
  );
  assert.equal(second.events.length, 0);
});

test("阈值：钱包余额跌破阈值触发，回升后计数归零", () => {
  const account = packageAccount({ id: "wallet", name: "钱包账户", type: "sub2api", group: "wallet-provider" });
  const settings = { ...DEFAULT_SETTINGS, rules: { windowPercent: 20, balanceAmount: 50 } };
  const low = { ok: true, plan: { name: "钱包余额", active: true }, windows: [], balance: { remaining: 43.91, currency: "USD" } };
  const high = { ok: true, plan: { name: "钱包余额", active: true }, windows: [], balance: { remaining: 88, currency: "USD" } };

  const first = evaluateThresholds([account], { [account.id]: low }, settings, {});
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].kind, "balance");
  assert.equal(first.events[0].remaining, 43.91);
  assert.equal(first.events[0].thresholdAmount, 50);

  const repeat = evaluateThresholds([account], { [account.id]: low }, settings, first.state);
  assert.equal(repeat.events.length, 0);

  const recovered = evaluateThresholds([account], { [account.id]: high }, settings, repeat.state);
  assert.equal(recovered.events.length, 0);

  const again = evaluateThresholds([account], { [account.id]: low }, settings, recovered.state);
  assert.equal(again.events.length, 1, "充值恢复后再次跌破应重新告警");
});

test("阈值：套餐账户不按钱包金额规则重复判定", () => {
  const account = packageAccount();
  const settings = { ...DEFAULT_SETTINGS, rules: { windowPercent: 20, balanceAmount: 10 } };
  const result = {
    ok: true,
    plan: { name: "套餐", active: true },
    balance: { remaining: 1, currency: "CNY" },
    windows: [{ key: "monthly", label: "本月", limit: 100, remaining: 50, percent: 50, unit: "%" }],
  };
  const { events } = evaluateThresholds([account], { [account.id]: result }, settings, {});
  assert.equal(events.length, 0);
});

test("阈值：账户级阈值覆盖全局设置", () => {
  const account = packageAccount({ thresholds: { windowPercent: 5 } });
  const settings = { ...DEFAULT_SETTINGS, rules: { windowPercent: 20, balanceAmount: 10 } };
  const result = windowResult(85, null); // 剩余 15%，高于账户阈值 5%
  const { events } = evaluateThresholds([account], { [account.id]: result }, settings, {});
  assert.equal(events.length, 0);
});

test("阈值：账户删除后清理其状态", () => {
  const account = packageAccount();
  const settings = { ...DEFAULT_SETTINGS, rules: { windowPercent: 20, balanceAmount: 10 } };
  const first = evaluateThresholds([account], { [account.id]: windowResult(90, null) }, settings, {});
  assert.ok(Object.keys(first.state).length > 0);
  const cleaned = evaluateThresholds([], {}, settings, first.state);
  assert.deepEqual(cleaned.state, {});
});

test("汇总：按分组、有效优先、余量低在前、限额在后", () => {
  const accounts = [
    packageAccount({ id: "a1", name: "低余量", group: "示例分组" }),
    packageAccount({ id: "a2", name: "高余量", group: "示例分组" }),
    packageAccount({ id: "a3", name: "已限流", group: "示例分组" }),
    packageAccount({ id: "a4", name: "请求失败", group: "示例分组" }),
    packageAccount({ id: "a5", name: "另一组高余量", group: "opencode" }),
  ];
  const results = {
    a1: windowResult(80, null),
    a2: windowResult(10, null),
    a3: { ok: true, plan: { active: true }, windows: [{ key: "monthly", label: "本月", percent: 100, remaining: 0, limit: 100, unit: "%" }] },
    a4: { ok: false, error: "上游 500" },
    a5: windowResult(30, null),
  };
  const sections = buildDigestSections(accounts, results, { typeLabels: TYPE_LABELS });
  const 示例分组 = sections.find((section) => section.group === "示例分组");
  assert.deepEqual(
    示例分组.items.map((item) => item.name),
    ["低余量", "高余量", "已限流", "请求失败"],
  );
  assert.equal(示例分组.items[0].status, "ok");
  assert.equal(示例分组.items[2].status, "limited");
  assert.equal(示例分组.items[3].status, "error");
  // 组间按“最差账户”排序：示例分组 最差是出错，排在 opencode 之前
  assert.equal(sections[0].group, "示例分组");
});

test("汇总：未设置分组时回退到账户类型", () => {
  const account = { id: "x", name: "无分组", type: "custom", group: "", thresholds: {} };
  const metrics = computeAccountMetrics(account, windowResult(10, null), { typeLabels: TYPE_LABELS });
  assert.equal(metrics.group, "自定义");
});

test("汇总：消息包含分组标题、数量与各账户余量", () => {
  const accounts = [packageAccount({ id: "a1", name: "账户甲", group: "示例分组" })];
  const results = { a1: windowResult(80, null) };
  const sections = buildDigestSections(accounts, results, { typeLabels: TYPE_LABELS });
  const message = buildDigestMessage(sections, { now: new Date("2026-10-11T01:00:00Z"), timezone: "Asia/Shanghai" });
  assert.match(message.markdown, /全局余量汇总/);
  assert.match(message.markdown, /共 1 个账户/);
  assert.match(message.markdown, /\*\*示例分组\*\*（1 个）/);
  assert.match(message.markdown, /账户甲：.*20\.0%/);
});

test("阈值消息包含账户、窗口、剩余、阈值与重置时间", () => {
  const account = packageAccount();
  const settings = { ...DEFAULT_SETTINGS, rules: { windowPercent: 20, balanceAmount: 10 } };
  const { events } = evaluateThresholds(
    [account],
    { [account.id]: windowResult(85, "2026-10-12T00:00:00Z") },
    settings,
    {},
  );
  const message = buildThresholdMessage(events, { now: new Date("2026-10-11T01:00:00Z"), timezone: "Asia/Shanghai" });
  assert.match(message.markdown, /余量告警/);
  assert.match(message.markdown, /示例套餐 A/);
  assert.match(message.markdown, /5 小时：剩余 15\.0%，低于阈值 20%/);
  assert.match(message.markdown, /重置/);
});

test("窗口余量百分比计算：百分比窗口与金额窗口都能算", () => {
  assert.equal(windowRemainingPercent({ unit: "%", remaining: 78, percent: 22 }), 78);
  assert.ok(Math.abs(windowRemainingPercent({ limit: 39, remaining: 16.01 }) - 41.0513) < 0.001);
  assert.equal(windowRemainingPercent({ percent: 90 }), 10);
  assert.equal(windowRemainingPercent({}), null);
});

/* ------------------------------ Webhook ------------------------------ */

test("Webhook：钉钉 payload 与加签 URL", () => {
  const webhook = {
    type: "dingtalk",
    url: "https://oapi.dingtalk.com/robot/send?access_token=abc",
    secret: "SEC-test",
  };
  const payload = buildWebhookPayload(webhook, "标题", "正文");
  assert.equal(payload.msgtype, "markdown");
  assert.equal(payload.markdown.title, "标题");
  assert.equal(payload.markdown.text, "正文");

  const url = new URL(buildWebhookUrl(webhook, new Date("2026-10-11T01:00:00Z")));
  assert.equal(url.searchParams.get("access_token"), "abc");
  assert.equal(url.searchParams.get("timestamp"), String(new Date("2026-10-11T01:00:00Z").getTime()));
  assert.ok(url.searchParams.get("sign").length > 10);
});

test("Webhook：企业微信不需要加签，飞书签名字段在 body 里", () => {
  const wecom = { type: "wecom", url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k", secret: "ignored" };
  assert.equal(buildWebhookUrl(wecom, new Date()), wecom.url);
  assert.equal(buildWebhookPayload(wecom, "t", "body").markdown.content, "body");

  const feishu = buildWebhookPayload({ type: "feishu" }, "标题", "正文");
  assert.equal(feishu.msg_type, "interactive");
  assert.equal(feishu.card.header.title.content, "标题");
  assert.equal(feishu.card.elements[0].text.content, "正文");
});

test("Webhook：钉钉与飞书使用不同的加签算法", async () => {
  const crypto = await import("node:crypto");
  const secret = "SECtestsecret";
  const at = new Date(1600000000000);
  const stringToSign = `${at.getTime()}\n${secret}`;
  const expectedDingTalk = crypto.createHmac("sha256", secret).update(stringToSign).digest("base64");

  const dingUrl = new URL(
    buildWebhookUrl(
      { type: "dingtalk", url: "https://oapi.dingtalk.com/robot/send?access_token=t", secret },
      at,
    ),
  );
  assert.equal(dingUrl.searchParams.get("sign"), expectedDingTalk, "钉钉 key=secret, data=timestamp\\nsecret");

  // 飞书签名走 body，算法 key/data 与钉钉相反
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code: 0, msg: "success" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await sendWebhook(
      { type: "feishu", url: `http://127.0.0.1:${server.address().port}/hook`, secret },
      { title: "T", markdown: "M" },
      { now: at },
    );
    // 飞书的时间戳单位是秒，签名里的 stringToSign 必须与发送的值一致
    const feishuTimestamp = String(Math.floor(at.getTime() / 1000));
    const expectedFeishu = crypto
      .createHmac("sha256", `${feishuTimestamp}\n${secret}`)
      .update("")
      .digest("base64");
    assert.equal(seen[0].timestamp, feishuTimestamp);
    assert.equal(seen[0].sign, expectedFeishu, "飞书 key=timestamp\\nsecret, data=空");
    assert.notEqual(seen[0].sign, expectedDingTalk);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Webhook：真实 POST 到 mock 服务并识别业务错误码", async () => {
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      seen.push({ url: request.url, body });
      response.writeHead(200, { "Content-Type": "application/json" });
      if (request.url.includes("fail=1")) response.end(JSON.stringify({ errcode: 310000, errmsg: "invalid token" }));
      else response.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const ok = await sendWebhook({ type: "wecom", url: `${base}/hook?key=abc` }, { title: "T", markdown: "M" });
    assert.equal(ok.ok, true);
    assert.equal(seen[0].body.msgtype, "markdown");
    assert.equal(seen[0].body.markdown.content, "M");

    await assert.rejects(
      () => sendWebhook({ type: "wecom", url: `${base}/hook?fail=1` }, { title: "T", markdown: "M" }),
      /invalid token/,
    );
    await assert.rejects(
      () => sendWebhook({ type: "feishu", url: "http://127.0.0.1:9/hook" }, { title: "T", markdown: "M" }),
      /Webhook 请求失败/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* ------------------------------ 定时槽位 ------------------------------ */

test("定时汇总：到点触发、当天只发一次、超出补发窗口记为跳过", () => {
  const settings = {
    enabled: true,
    rules: DEFAULT_SETTINGS.rules,
    digest: { enabled: true, times: ["09:00", "18:00"], timezone: "Asia/Shanghai" },
    webhooks: [],
  };
  // 北京时间 08:59（UTC 00:59）
  assert.deepEqual(dueDigestSlots(settings, {}, new Date("2026-10-11T00:59:00Z")).due, []);
  // 北京时间 09:01
  const first = dueDigestSlots(settings, {}, new Date("2026-10-11T01:01:00Z"));
  assert.deepEqual(first.due.map((item) => item.slot), ["09:00"]);
  // 已发送后不再重复
  const sent = { digests: { "2026-10-11@09:00": { sentAt: "2026-10-11T01:01:00Z" } } };
  assert.deepEqual(dueDigestSlots(settings, sent, new Date("2026-10-11T01:05:00Z")).due, []);
  // 第二天同一时间点重新触发
  assert.deepEqual(dueDigestSlots(settings, sent, new Date("2026-10-12T01:01:00Z")).due.map((i) => i.slot), ["09:00"]);
  // 超过补发窗口（>30 分钟）记入 consumed 而不是 due
  const late = dueDigestSlots(settings, {}, new Date("2026-10-11T03:00:00Z"));
  assert.deepEqual(late.due.map((item) => item.slot), ["18:00"].filter(() => false));
  assert.deepEqual(late.consumed.map((item) => item.slot), ["09:00"]);
});

test("定时汇总：关闭开关时不产生槽位", () => {
  const settings = {
    enabled: false,
    rules: DEFAULT_SETTINGS.rules,
    digest: { enabled: true, times: ["09:00"], timezone: "Asia/Shanghai" },
    webhooks: [],
  };
  assert.deepEqual(dueDigestSlots(settings, {}, new Date("2026-10-11T01:01:00Z")).due, []);
  const digestOff = { ...settings, enabled: true, digest: { ...settings.digest, enabled: false } };
  assert.deepEqual(dueDigestSlots(digestOff, {}, new Date("2026-10-11T01:01:00Z")).due, []);
});

test("时区换算：Asia/Shanghai 与 UTC 的日期时间解析正确", () => {
  const at = new Date("2026-10-11T01:01:00Z");
  assert.deepEqual(localTimeParts(at, "Asia/Shanghai"), { date: "2026-10-11", time: "09:01" });
  assert.deepEqual(localTimeParts(at, "UTC"), { date: "2026-10-11", time: "01:01" });
});

/* ------------------------------ 设置 ------------------------------ */

test("设置：校验通知类型、时间点格式，并保留未修改的 URL 与密钥", () => {
  const initial = normalizeSettings({
    rules: { windowPercent: 15, balanceAmount: 20 },
    digest: { times: "09:00, 18:30, 99:99", timezone: "Asia/Shanghai" },
    webhooks: [{ type: "dingtalk", name: "运维群", url: "https://oapi.dingtalk.com/robot/send?access_token=t1", secret: "s1" }],
  });
  assert.equal(initial.rules.windowPercent, 15);
  assert.deepEqual(initial.digest.times, ["09:00", "18:30"]);
  assert.equal(initial.webhooks.length, 1);

  // 不带 url/secret 的更新应保留原值
  const updated = normalizeSettings(
    {
      rules: { windowPercent: 25 },
      webhooks: [{ id: initial.webhooks[0].id, type: "dingtalk", name: "运维群 2", url: "", enabled: false }],
    },
    initial,
  );
  assert.equal(updated.rules.windowPercent, 25);
  assert.equal(updated.rules.balanceAmount, 20, "未提供的字段沿用旧值");
  assert.equal(updated.webhooks[0].url, initial.webhooks[0].url);
  assert.equal(updated.webhooks[0].secret, "s1");
  assert.equal(updated.webhooks[0].name, "运维群 2");
  assert.equal(updated.webhooks[0].enabled, false);

  assert.throws(() => normalizeSettings({ webhooks: [{ type: "slack", url: "https://x" }] }, initial), /不支持的通知类型/);
  assert.throws(() => normalizeSettings({ webhooks: [{ type: "wecom", url: "ftp://x" }] }, initial), /http/);
});

test("设置：URL 掩码保留可辨识前缀", () => {
  const masked = maskUrl("https://oapi.dingtalk.com/robot/send?access_token=abcdef1234567890");
  assert.match(masked, /abcd\*\*\*890/);
  assert.ok(!masked.includes("abcdef1234567890"));
});

test("排序比较函数：限额与错误排在有效账户之后", () => {
  const ok = computeAccountMetrics({ id: "1", name: "A", type: "custom" }, windowResult(90, null), { typeLabels: TYPE_LABELS });
  const okBetter = computeAccountMetrics({ id: "2", name: "B", type: "custom" }, windowResult(10, null), { typeLabels: TYPE_LABELS });
  const limited = computeAccountMetrics(
    { id: "3", name: "C", type: "custom" },
    { ok: true, plan: { active: true }, windows: [{ key: "monthly", label: "本月", percent: 100, remaining: 0, limit: 100, unit: "%" }] },
    { typeLabels: TYPE_LABELS },
  );
  const error = computeAccountMetrics({ id: "4", name: "D", type: "custom" }, { ok: false, error: "x" }, { typeLabels: TYPE_LABELS });
  const sorted = [error, limited, okBetter, ok].sort(compareMetrics);
  assert.deepEqual(sorted.map((item) => item.name), ["A", "B", "C", "D"]);
});
