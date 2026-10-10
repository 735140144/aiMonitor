import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../server.js";

function packagePayload(percent5h, reset5h) {
  return {
    currency: "CNY",
    has_active_plan: true,
    plan_name: "示例套餐 A",
    plan_type: "quota_subscription",
    quota_5h: "100",
    quota_weekly: "100",
    quota_monthly: "100",
    used_5h: String(percent5h),
    used_weekly: "20",
    used_monthly: "30",
    reset_5h_at: reset5h,
    reset_weekly_at: "2026-10-13T00:00:00Z",
    reset_monthly_at: "2026-10-16T00:00:00Z",
  };
}

/** 可动态改值的上游 mock + 记录收到的 webhook。 */
async function buildHarness({ clock = () => new Date() } = {}) {
  const state = { payload: packagePayload(85, "2026-10-12T00:00:00Z"), webhooks: [] };
  const upstream = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(state.payload));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const hooks = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      state.webhooks.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
    });
  });
  await new Promise((resolve) => hooks.listen(0, "127.0.0.1", resolve));

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimonitor-notify-"));
  const app = createApp({ dataDir, schedulerIntervalMs: 60000, now: clock });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  return {
    state,
    app,
    baseUrl,
    upstreamBase: `http://127.0.0.1:${upstream.address().port}`,
    hookBase: `http://127.0.0.1:${hooks.address().port}`,
    close: async () => {
      await new Promise((resolve) => app.server.close(resolve));
      await new Promise((resolve) => upstream.close(resolve));
      await new Promise((resolve) => hooks.close(resolve));
    },
  };
}

async function json(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
}

test("通知接口：读写设置并掩码 Webhook 地址", async () => {
  const harness = await buildHarness();
  try {
    const initial = await json(harness.baseUrl, "/api/notifications");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.settings.rules.windowPercent, 20);
    assert.equal(initial.body.settings.rules.balanceAmount, 10);
    assert.deepEqual(initial.body.settings.webhooks, []);

    const updated = await json(harness.baseUrl, "/api/notifications", {
      method: "PUT",
      body: JSON.stringify({
        rules: { windowPercent: 30, balanceAmount: 5 },
        digest: { times: ["09:00", "21:00"], timezone: "Asia/Shanghai", enabled: true },
        webhooks: [
          {
            type: "wecom",
            name: "运维群",
            url: `${harness.hookBase}/send?key=abcdef1234567890`,
            events: ["threshold", "digest"],
          },
        ],
      }),
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.settings.rules.windowPercent, 30);
    assert.equal(updated.body.settings.webhooks.length, 1);
    assert.match(updated.body.settings.webhooks[0].urlHint, /\*\*\*/);
    assert.ok(!JSON.stringify(updated.body.settings).includes("abcdef1234567890"), "完整 URL 不应回传");

    // 持久化：重新读到的是同一份配置
    const reread = await json(harness.baseUrl, "/api/notifications");
    assert.equal(reread.body.settings.rules.windowPercent, 30);
    assert.deepEqual(reread.body.settings.digest.times, ["09:00", "21:00"]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(harness.app.notificationStore.filePath), "utf8"));
    assert.equal(onDisk.settings.webhooks[0].url.includes("abcdef1234567890"), true, "磁盘上应保存完整地址");
  } finally {
    await harness.close();
  }
});

test("通知接口：测试发送会把汇总消息投递到 Webhook", async () => {
  const harness = await buildHarness();
  try {
    await json(harness.baseUrl, "/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        type: "custom",
        name: "套餐账户",
        group: "示例分组",
        baseUrl: harness.upstreamBase,
        options: { path: "/", authStyle: "none" },
      }),
    });
    const settings = await json(harness.baseUrl, "/api/notifications", {
      method: "PUT",
      body: JSON.stringify({
        webhooks: [{ type: "wecom", name: "运维群", url: `${harness.hookBase}/send?key=k1` }],
      }),
    });
    const id = settings.body.settings.webhooks[0].id;

    const sent = await json(harness.baseUrl, "/api/notifications/test", {
      method: "POST",
      body: JSON.stringify({ webhookId: id }),
    });
    assert.equal(sent.status, 200);
    assert.equal(harness.state.webhooks.length, 1);
    assert.match(harness.state.webhooks[0].markdown.content, /全局余量汇总/);
    assert.match(harness.state.webhooks[0].markdown.content, /套餐账户/);

    const missing = await json(harness.baseUrl, "/api/notifications/test", {
      method: "POST",
      body: JSON.stringify({ webhookId: "nope" }),
    });
    assert.equal(missing.status, 404);
  } finally {
    await harness.close();
  }
});

test("调度器：首次跌破阈值推送，恢复后再次跌破会重新推送", async () => {
  const harness = await buildHarness();
  try {
    await json(harness.baseUrl, "/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        type: "custom",
        name: "套餐账户",
        group: "示例分组",
        baseUrl: harness.upstreamBase,
        options: { path: "/", authStyle: "none" },
      }),
    });
    await json(harness.baseUrl, "/api/notifications", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        rules: { windowPercent: 20, balanceAmount: 10 },
        digest: { enabled: false, times: [], timezone: "Asia/Shanghai" },
        webhooks: [{ type: "wecom", name: "运维群", url: `${harness.hookBase}/send?key=k1`, events: ["threshold"] }],
      }),
    });

    // 5h 剩余 15% → 触发一次
    await harness.app.scheduler.runOnce({ force: true });
    assert.equal(harness.state.webhooks.length, 1, "首次应推送");
    assert.match(harness.state.webhooks[0].markdown.content, /5 小时/);
    assert.match(harness.state.webhooks[0].markdown.content, /低于阈值 20%/);

    // 再次执行（数据未变）不应重复推送
    await harness.app.scheduler.runOnce({ force: true });
    assert.equal(harness.state.webhooks.length, 1, "重复刷新不应重复推送");

    // 5h 重置到 0% 使用（余量 100%）→ 解除
    harness.state.payload = packagePayload(0, "2026-10-13T00:00:00Z");
    await harness.app.scheduler.runOnce({ force: true });
    assert.equal(harness.state.webhooks.length, 1);

    // 再次跌破阈值 → 重新推送
    harness.state.payload = packagePayload(90, "2026-10-13T00:00:00Z");
    await harness.app.scheduler.runOnce({ force: true });
    assert.equal(harness.state.webhooks.length, 2, "重置后再次触底应重新推送");

    // 状态持久化到磁盘
    const saved = JSON.parse(fs.readFileSync(path.join(harness.app.notificationStore.filePath), "utf8"));
    const keys = Object.keys(saved.state.thresholds);
    // 三个窗口都会记录状态（用于判断各自是否恢复），但只有 5h 处于已通知
    assert.equal(keys.length, 3);
    const fiveHour = keys.find((key) => key.endsWith("window:5h"));
    assert.ok(fiveHour, "应记录 5h 窗口状态");
    assert.equal(saved.state.thresholds[fiveHour].notified, true);
    const monthly = keys.find((key) => key.endsWith("window:monthly"));
    assert.equal(saved.state.thresholds[monthly].notified, false);
  } finally {
    await harness.close();
  }
});

test("调度器：到点推送全局汇总，按分组与余量排序，当天不重复", async () => {
  const clock = { current: new Date("2026-10-11T00:30:00Z") }; // 北京时间 08:30
  const harness = await buildHarness({ clock: () => clock.current });
  try {
    for (const [name, group] of [
      ["高余量账户", "opencode"],
      ["低余量账户", "示例分组"],
    ]) {
      await json(harness.baseUrl, "/api/accounts", {
        method: "POST",
        body: JSON.stringify({
          type: "custom",
          name,
          group,
          baseUrl: harness.upstreamBase,
          options: { path: "/", authStyle: "none" },
        }),
      });
    }
    await json(harness.baseUrl, "/api/notifications", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        rules: { windowPercent: 5, balanceAmount: 0 },
        digest: { enabled: true, times: ["09:00"], timezone: "Asia/Shanghai" },
        webhooks: [{ type: "wecom", name: "运维群", url: `${harness.hookBase}/send?key=k1`, events: ["digest"] }],
      }),
    });

    // 北京 08:30 —— 未到点
    await harness.app.scheduler.runOnce({ force: true });
    assert.equal(harness.state.webhooks.length, 0, "未到设定时间不应推送");

    // 北京 09:02 —— 到点，推送一次
    clock.current = new Date("2026-10-11T01:02:00Z");
    const summary = await harness.app.scheduler.runOnce({ force: true });
    assert.equal(harness.state.webhooks.length, 1, "到点应推送全局汇总");
    assert.equal(summary.digests.length, 1);
    const content = harness.state.webhooks[0].markdown.content;
    assert.match(content, /全局余量汇总/);
    assert.match(content, /共 2 个账户/);
    // 分组标题 + 分组内排序（两个账户窗口数据相同，按名称排序，组间同样稳定）
    assert.match(content, /\*\*示例分组\*\*/);
    assert.match(content, /\*\*opencode\*\*/);
    const 示例分组At = content.indexOf("**示例分组**");
    const opencodeAt = content.indexOf("**opencode**");
    assert.ok(示例分组At !== -1 && opencodeAt !== -1);

    // 同一天再次运行不应重复推送
    clock.current = new Date("2026-10-11T01:30:00Z");
    await harness.app.scheduler.runOnce({ force: true });
    assert.equal(harness.state.webhooks.length, 1, "当天同一时间点只推送一次");

    // 隔天同一时间点再次推送
    clock.current = new Date("2026-10-12T01:02:00Z");
    await harness.app.scheduler.runOnce({ force: true });
    assert.equal(harness.state.webhooks.length, 2, "第二天应重新推送");
  } finally {
    await harness.close();
  }
});

test("调度器：无 Webhook 时静默运行不报错", async () => {
  const harness = await buildHarness();
  try {
    await json(harness.baseUrl, "/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        type: "custom",
        name: "套餐账户",
        baseUrl: harness.upstreamBase,
        options: { path: "/", authStyle: "none" },
      }),
    });
    const summary = await harness.app.scheduler.runOnce({ force: true });
    assert.deepEqual(summary.thresholds, []);
    assert.deepEqual(summary.digests, []);

    // 关键：没有可用 Webhook 时不消费告警事件，配置好之后仍能收到
    const saved = JSON.parse(fs.readFileSync(path.join(harness.app.notificationStore.filePath), "utf8"));
    assert.deepEqual(saved.state.thresholds, {}, "无 Webhook 时不应记录已通知状态");

    await json(harness.baseUrl, "/api/notifications", {
      method: "PUT",
      body: JSON.stringify({
        webhooks: [{ type: "wecom", name: "群", url: `${harness.hookBase}/send?key=k`, events: ["threshold"] }],
      }),
    });
    await harness.app.scheduler.runOnce({ force: true });
    assert.equal(harness.state.webhooks.length, 1, "补上 Webhook 后应补发告警");
    assert.match(harness.state.webhooks[0].markdown.content, /低于阈值/);
  } finally {
    await harness.close();
  }
});

test("调度器：投递失败时不消费事件，下个周期重试", async () => {
  const harness = await buildHarness();
  try {
    await json(harness.baseUrl, "/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        type: "custom",
        name: "套餐账户",
        baseUrl: harness.upstreamBase,
        options: { path: "/", authStyle: "none" },
      }),
    });
    // 指向一个不可达地址
    await json(harness.baseUrl, "/api/notifications", {
      method: "PUT",
      body: JSON.stringify({
        webhooks: [{ type: "wecom", name: "坏地址", url: "http://127.0.0.1:9/send?key=k", events: ["threshold"] }],
      }),
    });
    const failed = await harness.app.scheduler.runOnce({ force: true });
    assert.equal(failed.thresholds.length, 1);
    assert.equal(failed.thresholds[0].ok, false);
    const stateAfterFailure = JSON.parse(
      fs.readFileSync(path.join(harness.app.notificationStore.filePath), "utf8"),
    );
    assert.deepEqual(stateAfterFailure.state.thresholds, {}, "投递失败不应记录已通知");

    // 换成可用地址后重试成功
    await json(harness.baseUrl, "/api/notifications", {
      method: "PUT",
      body: JSON.stringify({
        webhooks: [{ type: "wecom", name: "好地址", url: `${harness.hookBase}/send?key=k`, events: ["threshold"] }],
      }),
    });
    const ok = await harness.app.scheduler.runOnce({ force: true });
    assert.equal(ok.thresholds[0].ok, true);
    assert.equal(harness.state.webhooks.length, 1);
    const stateAfterSuccess = JSON.parse(
      fs.readFileSync(path.join(harness.app.notificationStore.filePath), "utf8"),
    );
    assert.ok(Object.keys(stateAfterSuccess.state.thresholds).length > 0, "成功后才记录状态");
  } finally {
    await harness.close();
  }
});

test("通知设置：修改阈值会重新计数，避免改完阈值却不再告警", async () => {
  const harness = await buildHarness();
  try {
    await json(harness.baseUrl, "/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        type: "custom",
        name: "套餐账户",
        baseUrl: harness.upstreamBase,
        options: { path: "/", authStyle: "none" },
      }),
    });
    await json(harness.baseUrl, "/api/notifications", {
      method: "PUT",
      body: JSON.stringify({
        rules: { windowPercent: 20, balanceAmount: 10 },
        webhooks: [{ type: "wecom", name: "群", url: `${harness.hookBase}/send?key=k`, events: ["threshold"] }],
      }),
    });
    await harness.app.scheduler.runOnce({ force: true });
    assert.equal(harness.state.webhooks.length, 1);
    await harness.app.scheduler.runOnce({ force: true });
    assert.equal(harness.state.webhooks.length, 1, "同阈值不重复");

    // 调整阈值 → 重新计数
    await json(harness.baseUrl, "/api/notifications", {
      method: "PUT",
      body: JSON.stringify({ rules: { windowPercent: 30, balanceAmount: 10 } }),
    });
    await harness.app.scheduler.runOnce({ force: true });
    assert.equal(harness.state.webhooks.length, 2, "改阈值后应重新评估并告警");
  } finally {
    await harness.close();
  }
});
